import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { launchOwned, stopOwned, redactor, verifyPortReleased } from '../../tools/client-verification/processes.mjs';

// MODULE_REAL_BROWSER + CONTRACT_DOCUMENT_PEERS, never OFFICIAL_LOADER/REAL_HOST.
// This test carrier transports the actual installed Display service's results.
// React, Cordis, registry, Remote, Canvas's shipped bundle and DOM are real.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => item instanceof Error
  ? { name: item.name, code: item.code, message: item.message, details: item.details } : item);
const literal = value => JSON.stringify(value);

function connect(endpoint, budget) {
  const socket = new WebSocket(endpoint), pending = new Map(); let serial = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const row = JSON.parse(event.data), task = pending.get(row.id);
    if (!task) return;
    pending.delete(row.id); clearTimeout(task.timer);
    if (row.error || row.result?.exceptionDetails) task.reject(new Error(json(row.error ?? row.result.exceptionDetails)));
    else task.resolve(row.result);
  });
  return {
    opened,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`MODULE_CDP_TIMEOUT ${method}; budget=${budget}`));
        }, budget);
        pending.set(id, { resolve, reject, timer }); socket.send(json({ id, method, params }));
      });
    },
    close() {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('MODULE_CDP_CLOSED')); }
      pending.clear(); socket.close();
    },
  };
}

export async function openModuleBrowser({ directory, packageRoot, fixture, budget, stopBudget, chromium }) {
  const require = createRequire(join(packageRoot, 'package.json'));
  const { Context } = require('@deepseek-ai/cordis');
  const { TypertRegistry } = require('@deepseek-ai/dsh-typert-registry');
  const { TypertGatewayService } = require('@deepseek-ai/dsh-api-gateway');
  const host = new Context();
  await host.plugin(TypertRegistry);
  host.provide('hanaworldsCanvasV5', fixture.canvas);
  host.provide('hanaworldsCanvasRegionV1', fixture.region);
  const display = await import(pathToFileURL(join(packageRoot, 'lib/src/display-host.mjs')));
  await host.plugin(display.default);
  const gateway = new TypertGatewayService(host, { websocketHeartbeatIntervalMs: budget, streamInboxBytes: 262144 });
  const clientRoot = name => join(require.resolve(`@deepseek-ai/${name}/package.json`), '..', 'lib/types/client/index.js');
  const bundle = await readFile(join(packageRoot, 'lib/client.js'));
  const script = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Context, Service } from '@deepseek-ai/cordis';
import * as registry from ${literal(clientRoot('dsh-typert-registry'))};
import * as remotePlugin from ${literal(clientRoot('dsh-api-gateway'))};
window.React=React;
window.moduleCarrierResponses=[];
window.__ModuleLoader__={load(entry){window.canvasModule=entry.factory(id=>{if(id==='react')return React;throw new Error('UNEXPECTED_CLIENT_EXTERNAL '+id);});}};
const client=new Context(), registrations=[], effects=[];
await client.plugin(registry);
const connection={isLoopback:true,generation:{getSnapshot:()=>undefined},registerGenerationSource:()=>()=>{},
 start:()=>({stop(){}}),rpc:{
 call:async(path,endpoint,body,signal)=>{const response=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({path,endpoint,body}),signal})).json();window.moduleCarrierResponses.push({endpoint,response});return response;},
 open:(path,endpoint,body,signal)=>(async function*(){
  const response=await fetch('/stream',{method:'POST',body:JSON.stringify({path,endpoint,body}),signal});
  const reader=response.body.getReader(), decoder=new TextDecoder();let partial='';
  try{while(true){const {done,value}=await reader.read();if(done)break;partial+=decoder.decode(value,{stream:true});
   let line;while((line=partial.indexOf('\\n'))>=0){const item=partial.slice(0,line);partial=partial.slice(line+1);if(item)yield JSON.parse(item);}}}
  finally{await reader.cancel();}
 })()
}};
client.provide('connection',connection);await client.plugin(remotePlugin);
new class extends Service{
 constructor(){super(client,'slots');}
 inject(_name,register){return this.ctx.effect(register);}
 register(options,component){return this.ctx.effect(()=>{const row={options,component};registrations.push(row);return()=>registrations.splice(registrations.indexOf(row),1);});}
}();
client.provide('layout',{});client.provide('sessions',{});
let root=null,fiber=null,reads=0;
const sessionRef=${literal(fixture.sessionRef)};
const useSessions=select=>select({byId:{[sessionRef]:{id:sessionRef,retainedBy:{mainView:1}}}});
window.moduleFixture={classification:'MODULE_REAL_BROWSER + CONTRACT_DOCUMENT_PEERS',
 async mount(){
  fiber=client.plugin(window.canvasModule);await fiber;
  const nav=registrations.find(row=>row.options.name==='sidebar.panellist');
  const main=registrations.find(row=>row.options.name==='main');
  if(!nav||!main)throw new Error('PUBLIC_PANEL_REGISTRATION_MISSING');
  const button=document.createElement('button');button.id='module-navigation';button.textContent=nav.options.label();
  button.onclick=()=>{root?.unmount();root=createRoot(document.getElementById('panel'));root.render(React.createElement(main.component,{useSessions}));};
  document.getElementById('navigation').replaceChildren(button);return true;
 },
 async dispose(){root?.unmount();root=null;await fiber?.dispose();await client.fiber.dispose();document.getElementById('navigation').replaceChildren();},
 snapshot(){return {classification:this.classification,text:document.querySelector('.hw-canvas-display')?.innerText??'',
  panels:document.querySelectorAll('.hw-canvas-display').length,slots:registrations.length,
  styles:document.querySelectorAll('style[data-hanaworlds-canvas]').length,
  labels:[...document.querySelectorAll('.hw-canvas-objects h3,.hw-canvas-timeline h3')].map(node=>node.textContent),
  buttons:[...document.querySelectorAll('.hw-canvas-display button')].map(node=>({text:node.textContent,disabled:node.disabled}))};}
};
window.moduleCarrierReady=true;
`;
  let built;
  try { built = await build({ stdin: { contents: script, resolveDir: packageRoot, sourcefile: 'module-test-carrier.mjs' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false }); }
  catch (error) { await host.fiber.dispose(); throw error; }
  const carrier = built.outputFiles[0].contents;
  const streams = new Set(), streamClosures = new Set(), calls = [], faults = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/carrier.js') { response.setHeader('content-type', 'text/javascript'); return response.end(carrier); }
      if (request.url === '/client.js') { response.setHeader('content-type', 'text/javascript'); return response.end(bundle); }
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); return response.end(`<!doctype html><html lang="zh"><body><nav id="navigation"></nav><div id="panel"></div><script type="module">import '/carrier.js';await new Promise(resolve=>{if(window.moduleCarrierReady)return resolve();addEventListener('load',resolve,{once:true});});await import('/client.js');await window.moduleFixture.mount();</script></body></html>`); }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw), [namespace, method] = input.endpoint.split('/');
      assert.equal(namespace, 'hanaworldsCanvasDisplay', 'Only the real public Canvas Display namespace');
      const callRow = { endpoint: input.endpoint, args: input.body.args }; calls.push(callRow);
      if (request.url === '/rpc') {
        response.setHeader('content-type', 'application/json');
        try {
          const value = await gateway.invoke({ namespace, method, args: input.body.args });
          callRow.value = value; return response.end(json({ ok: true, value }));
        } catch (error) { faults.push(error); callRow.error = JSON.parse(json(error)); return response.end(json({ ok: false, error })); }
      }
      assert.equal(request.url, '/stream');
      const abort = new AbortController(); streams.add(abort);
      response.on('close', () => { abort.abort(); streams.delete(abort); if (!streams.size) for (const notify of streamClosures) notify(); });
      response.setHeader('content-type', 'application/x-ndjson'); response.flushHeaders();
      for await (const item of await gateway.stream({ namespace, method, args: input.body.args, signal: abort.signal }))
        response.write(json(item) + '\n');
      response.end();
    } catch (error) { if (!response.destroyed) { response.statusCode = 500; response.end(json({ message: error.message })); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const webUrl = `http://127.0.0.1:${server.address().port}/`;
  assert.notEqual(server.address().port, 3080);
  const browserRoot = join(directory, 'browser'); await mkdir(browserRoot);
  let owned;
  try { owned = await launchOwned({ file: chromium, args: ['--headless=new', '--enable-automation', '--incognito',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${browserRoot}`, 'about:blank'], cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, root: directory,
    label: 'module-chromium', redact: redactor(),
    readyMatch: line => /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(line)?.[1] }); }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await host.fiber.dispose(); throw error; }
  let cdp;
  const close = async () => {
    cdp?.close(); for (const abort of streams) abort.abort();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { await host.fiber.dispose(); } finally { await stopOwned(owned, stopBudget); }
    const released = await verifyPortReleased(webUrl);
    await writeFile(join(directory, 'cleanup.json'), json({ released, streams: streams.size, process: owned.receipt() }));
  };
  try {
    const endpoint = await owned.ready(budget), origin = 'http://' + new URL(endpoint).host;
    const pages = await (await fetch(origin + '/json/list')).json();
    assert.equal(pages.filter(page => page.type === 'page').length, 1);
    cdp = connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl, budget); await cdp.opened;
    await cdp.send('Page.enable'); await cdp.send('Page.navigate', { url: webUrl });
    const evaluate = async expression => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    const wait = async expression => evaluate(`new Promise((resolve,reject)=>{
      const read=()=>(${expression});if(read())return resolve(true);
      const observer=new MutationObserver(()=>{if(read()){observer.disconnect();clearTimeout(timer);resolve(true);}});
      observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('MODULE_DOM_EXPECTATION_NOT_MET '+${literal(expression)}));},${budget});})`);
    await wait("!!document.getElementById('module-navigation')");
    const actual = await evaluate(`(async()=>{const bytes=await(await fetch('/client.js')).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');})()`);
    assert.equal(actual, hash(bundle), 'Browser fetched the exact installed production client bytes');
    await writeFile(join(directory, 'browser-artifact.json'), json({ classification: 'MODULE_REAL_BROWSER + CONTRACT_DOCUMENT_PEERS',
      packageRoot, bundleSHA256: actual, webUrl, browserRoot }));
    return { evaluate, wait, calls, faults, streams, close,
      waitStreamsClosed: async () => {
        if (!streams.size) return;
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); streamClosures.delete(done); resolve(); };
          const timer = setTimeout(() => { streamClosures.delete(done); reject(new Error('MODULE_UNLOAD_STREAM_NOT_RELEASED')); }, budget);
          streamClosures.add(done);
        });
      },
      snapshot: () => evaluate('window.moduleFixture.snapshot()'),
      click: async (label, navigation = false) => evaluate(`(()=>{const candidates=[...document.querySelectorAll(${literal(navigation ? '#navigation button' : '.hw-canvas-display button')})].filter(node=>node.textContent.trim()===${literal(label)}&&!node.disabled);if(candidates.length!==1)throw new Error('MODULE_CONTROL_COUNT '+candidates.length);candidates[0].click();return true;})()`),
      dispose: () => evaluate('window.moduleFixture.dispose()'),
    };
  } catch (error) { await close(); throw error; }
}
