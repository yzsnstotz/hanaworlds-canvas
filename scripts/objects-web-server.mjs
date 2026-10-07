import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { openUndoHost } from './undo-host.mjs';

export const objectsRunRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-OBJECTS-HISTORY-01', 'objects-web');
export const undoRunRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-UNDO-01', 'undo-web');
const undoHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>撤回与重做 · Canvas</title><link rel="stylesheet" href="/assets/objects.css"><link rel="stylesheet" href="/assets/undo.css"></head><body><div id="root"></div><script src="/assets/undo.js" defer></script></body></html>`;
const MAX_BODY = 4096;
async function jsonBody(req) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > MAX_BODY) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(new Error('SCHEMA_INVALID'), { status: 400 }); }
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>对象与历史 · Canvas</title><link rel="stylesheet" href="/assets/objects.css"></head><body><div id="root"></div><script src="/assets/objects.js" defer></script></body></html>`;

/**
 * Canvas-owned development host. /objects stays a read surface (no Adapter, no
 * world writes, no App profile). /undo acts only on its own isolated example,
 * through Canvas's public Undo/Redo/UndoRegionCommit with a fixture world.
 */
export async function createObjectsWebServer({ storeDirectory, assetsDirectory, sampleStoreDirectory, undoDirectory }) {
  // Capture assets before accepting traffic; a missing build or example is a startup error.
  const [js, css] = await Promise.all(['objects.js', 'objects.css'].map(name => readFile(join(assetsDirectory, name))));
  const [undoJs, undoCss] = undoDirectory ?
    await Promise.all(['undo.js', 'undo.css'].map(name => readFile(join(assetsDirectory, name)))) : [];
  const undo = undoDirectory ? await openUndoHost(undoDirectory) : null;
  const canvas = new CanvasV5({ store: await CanvasStore.open(storeDirectory) });
  if (sampleStoreDirectory) await readFile(join(sampleStoreDirectory, 'canvas-v5.json'));
  const example = sampleStoreDirectory ? new CanvasV5({ store: await CanvasStore.open(sampleStoreDirectory) }) : null;
  const reply = (res, status, value, contentType = 'application/json; charset=utf-8', head = false) => {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" });
    res.end(head ? undefined : typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  return createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return reply(res, 400, { error: 'INVALID_URL' }); }
    const action = undo && /^\/api\/undo\/(undo|redo)$/.exec(url.pathname)?.[1];
    if (req.method === 'POST' && action) {
      try {
        // Same-origin page clicks only: exact Host/Origin and a JSON body naming one object.
        const host = req.headers.host;
        if (!/^127\.0\.0\.1:\d+$/.test(host ?? '') || req.headers.origin !== `http://${host}` ||
            !String(req.headers['content-type']).startsWith('application/json'))
          return reply(res, 403, { error: 'SAME_ORIGIN_REQUIRED' });
        const body = await jsonBody(req);
        if (typeof body?.objectRef !== 'string' || !body.objectRef || Object.keys(body).length !== 1)
          return reply(res, 400, { error: 'SCHEMA_INVALID' });
        const outcome = await undo.perform(body.objectRef, action);
        const { request: _request, ...visible } = outcome;
        return reply(res, outcome.error ? 409 : 200, { ...visible, view: await undo.readView() });
      } catch (error) {
        return reply(res, error.status ?? 503, { error: error.status ? error.message : error.publicError?.code ?? 'CANVAS_STORAGE_UNAVAILABLE' });
      }
    }
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD'); return reply(res, 405, { error: 'READ_ONLY' });
    }
    try {
      if (url.pathname === '/') { res.writeHead(302, { Location: '/objects' }); return res.end(); }
      if (url.pathname === '/objects') return reply(res, 200, html, 'text/html; charset=utf-8', head);
      if (url.pathname === '/assets/objects.js') return reply(res, 200, js, 'text/javascript; charset=utf-8', head);
      if (url.pathname === '/assets/objects.css') return reply(res, 200, css, 'text/css; charset=utf-8', head);
      if (undo && url.pathname === '/undo') return reply(res, 200, undoHtml, 'text/html; charset=utf-8', head);
      if (undo && url.pathname === '/assets/undo.js') return reply(res, 200, undoJs, 'text/javascript; charset=utf-8', head);
      if (undo && url.pathname === '/assets/undo.css') return reply(res, 200, undoCss, 'text/css; charset=utf-8', head);
      if (undo && url.pathname === '/api/undo') return reply(res, 200, await undo.readView(), undefined, head);
      if (url.pathname === '/api/example') {
        if (!example) return reply(res, 503, { error: 'EXAMPLE_NOT_PREPARED' }, undefined, head);
        return reply(res, 200, { source: 'ISOLATED_DURABLE_FIXTURE',
          ...await example.readObjectsHistory('objects-history-fixture-session') }, undefined, head);
      }
      if (url.pathname === '/api/sessions') {
        await canvas.store.busy;
        return reply(res, 200, Object.keys(canvas.store.snapshot.sessions).sort(), undefined, head);
      }
      if (url.pathname === '/api/objects') {
        const values = url.searchParams.getAll('session');
        if (values.length > 1 || values[0] === '') return reply(res, 400, { error: 'INVALID_SESSION' }, undefined, head);
        return reply(res, 200, await canvas.readObjectsHistory(values[0] ?? null), undefined, head);
      }
      return reply(res, 404, { error: 'NOT_FOUND' }, undefined, head);
    } catch (error) {
      return reply(res, 503, { error: error.publicError?.code ?? 'CANVAS_STORAGE_UNAVAILABLE' }, undefined, head);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // --port exists only for pre-switch checks on a free port; the registered entry is 47601.
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47601;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
  // Objects stores stay where F-CANVAS-OBJECTS-HISTORY-01 produced them (read only);
  // this host's assets and the /undo isolated example live in its own run directory.
  const server = await createObjectsWebServer({ storeDirectory: join(objectsRunRoot, 'data'), assetsDirectory: join(undoRunRoot, 'assets'),
    sampleStoreDirectory: join(objectsRunRoot, 'isolated-example'), undoDirectory: join(undoRunRoot, 'isolated-example') });
  server.on('error', error => { console.error(`Canvas web service: ${error.code ?? error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Canvas web ready: http://127.0.0.1:${port}/objects · http://127.0.0.1:${port}/undo`));
  const stop = () => server.close(error => { if (error) { console.error(error.message); process.exitCode = 1; } });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
