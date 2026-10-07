import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasV5, CanvasStore } from '../src/index.mjs';

export const objectsRunRoot = join(homedir(), '.cache', 'hanaworlds-runs', 'F-CANVAS-OBJECTS-HISTORY-01', 'objects-web');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>对象与历史 · Canvas</title><link rel="stylesheet" href="/assets/objects.css"></head><body><div id="root"></div><script src="/assets/objects.js" defer></script></body></html>`;

/** Independent Canvas-owned read surface; no Adapter, world writes, or App profile. */
export async function createObjectsWebServer({ storeDirectory, assetsDirectory }) {
  // Capture assets before accepting traffic; a missing build is a startup error.
  const [js, css] = await Promise.all(['objects.js', 'objects.css'].map(name => readFile(join(assetsDirectory, name))));
  const canvas = new CanvasV5({ store: await CanvasStore.open(storeDirectory) });
  const reply = (res, status, value, contentType = 'application/json; charset=utf-8', head = false) => {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" });
    res.end(head ? undefined : typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  return createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD'); return reply(res, 405, { error: 'READ_ONLY' });
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(302, { Location: '/objects' }); return res.end(); }
      if (url.pathname === '/objects') return reply(res, 200, html, 'text/html; charset=utf-8', head);
      if (url.pathname === '/assets/objects.js') return reply(res, 200, js, 'text/javascript; charset=utf-8', head);
      if (url.pathname === '/assets/objects.css') return reply(res, 200, css, 'text/css; charset=utf-8', head);
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
  const server = await createObjectsWebServer({ storeDirectory: join(objectsRunRoot, 'data'), assetsDirectory: join(objectsRunRoot, 'assets') });
  server.on('error', error => { console.error(`Canvas objects service: ${error.code ?? error.message}`); process.exitCode = 1; });
  server.listen(47601, '127.0.0.1', () => console.log('Canvas objects ready: http://127.0.0.1:47601/objects'));
  const stop = () => server.close(error => { if (error) { console.error(error.message); process.exitCode = 1; } });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
