import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasV5, CanvasStore, CanvasConfigSupply } from '../src/index.mjs';
import { supplyFixturePeers, supplySessionRef, supplyWorldRef } from './config-supply-fixture.mjs';

/*
 * Independent Canvas preparation page for the Stage 1 validation configuration supply.
 * Input: a worldRef. Output: Canvas's real supply observation, its two consumer-port outcomes,
 * and the durable change/invalidation history. Only the peers are FIXTURE (marked on the page);
 * the page has no policy editing and never writes a World.
 */
const MAX_BODY = 1024;
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>校验配置供给 · Canvas</title><link rel="stylesheet" href="/assets/supply.css"></head><body><main id="root"><h1>Stage 1 校验配置供给 · Canvas</h1><p class="layer">本页层级：<span class="real">SOURCE</span> Canvas 代码 + <span class="fixture">FIXTURE</span> 对端输入 · <b>REAL 供给 0</b> · 不是 TO_TEST</p><p class="note">输入 World，读取 Canvas 对该 World 的 CompilationConfig 供给：每项来源、适用域、revision、变更失效记录。Safety 规则不由 Canvas 声明或供给。<span class="fixture">FIXTURE</span> 只标在对端输入上。</p><form id="read"><label>World <input id="world" name="world" value="${supplyWorldRef}" autocomplete="off"></label><button>读取供给</button></form><section id="fixture"></section><section id="out"></section></main><script src="/assets/supply.js" defer></script></body></html>`;
const css = `body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f7f7f5;color:#1d1d1b}main{max-width:1000px;margin:0 auto;padding:16px}h1{font-size:20px}h2{font-size:16px;margin:18px 0 6px}.note{color:#555}.fixture{background:#ffd54a;color:#3a2a00;font-weight:700;padding:1px 6px;border-radius:4px;font-size:12px}.real{background:#cfe8d6;color:#123;font-weight:700;padding:1px 6px;border-radius:4px;font-size:12px}form{display:flex;gap:8px;align-items:center;margin:12px 0}input{font:inherit;padding:4px 8px;min-width:260px}button{font:inherit;padding:4px 12px;cursor:pointer}table{border-collapse:collapse;width:100%;background:#fff;margin:4px 0 10px}td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top;font-size:13px}th{background:#eee}.SUPPLIED{color:#0a6b2e;font-weight:700}.MISSING,.SOURCE_MISSING,.NOT_BOUND{color:#a11;font-weight:700}code{font-size:12px;word-break:break-all}.box{background:#fff;border:1px solid #ddd;padding:8px;margin:6px 0}.fixbox{border:2px dashed #e0b400;background:#fffbe6;padding:8px;margin:8px 0}.fixbox button{margin:2px}.layer{background:#fff;border:2px solid #1d1d1b;padding:6px 10px;font-size:15px}`;
const client = `const $=s=>document.querySelector(s);const esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const j=v=>v===null||v===undefined?'—':'<code>'+esc(typeof v==='string'?v:JSON.stringify(v))+'</code>';
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})});return r.json();}
function profile(name,p,port){let h='<h2>'+name+' · <span class="'+p.status+'">'+p.status+'</span></h2><div class="box">revision '+j(p.revision)+' · digest '+j(p.digest)+'</div>';
h+='<div class="box">消费口 '+esc(port.key)+'.read(worldRef)：'+(port.ok?'<span class="SUPPLIED">返回</span> '+j(port.value):'<span class="MISSING">拒绝</span> '+j(port.error)+(port.missingSources?' · 缺 '+port.missingSources.map(m=>esc(m.field)).join(', '):''))+'</div>';
if(p.fields){h+='<table><tr><th>字段</th><th>状态</th><th>值</th><th>来源</th><th>缺什么</th></tr>';for(const [f,r] of Object.entries(p.fields))h+='<tr><td>'+esc(f)+'</td><td class="'+r.status+'">'+r.status+'</td><td>'+j(r.value)+'</td><td>'+(r.provenance?esc(r.provenance.kind)+(r.provenance.kind==='ENGINE_FACT'?' <span class="fixture">FIXTURE 输入</span>':'')+'<br>'+j(r.provenance.ref)+'<br>rev '+j(r.provenance.sourceRevision)+(r.provenance.basis?'<br>依据 '+esc(r.provenance.basis.kind)+' '+esc(r.provenance.basis.id)+' · '+j(r.provenance.basis.ref)+' @ '+j(r.provenance.basis.sourceRevision)+'<br>“'+esc(r.provenance.basis.text)+'”':''):esc(r.sourceKind??''))+'</td><td>'+(r.status==='MISSING'?esc(r.reason)+'<br>'+esc(r.need)+(r.cause?'<br>cause '+esc(r.cause):'')+(r.impact?'<br>影响：'+esc(r.impact):''):'')+'</td></tr>';h+='</table>';}
return h;}
function render(d){if(d.error){$('#out').innerHTML='<div class="box MISSING">'+j(d.error)+'</div>';return;}const c=d.report.current;
let h='<h2>来源权威 <span class="real">REAL Canvas 代码</span></h2><div class="box">authority '+j(d.report.authority)+' · '+j(d.report.profileVersion)+' · World '+j(d.report.worldRef)+' · contracts '+j(c.contracts)+' · Canvas 声明记录 '+j(c.declaration)+'</div>';
h+='<h2>适用域（Canvas 自己的选择表；连接来自 <span class="fixture">FIXTURE 输入</span>）</h2><div class="box">'+(c.domain?Object.entries(c.domain).map(([k,v])=>esc(k)+' '+j(v)).join('<br>')+'<br>sessions '+j(c.sessionRefs):'<span class="NOT_BOUND">NOT_BOUND</span>：该 World 没有被任何 Session 绑定')+'</div>';
h+='<div class="box">本次观察 #'+esc(c.observedSequence)+' '+j(c.observationDigest)+' · '+esc(c.observedAt)+(c.sources?' · Catalogue <span class="fixture">FIXTURE 输入</span> '+j(c.sources.catalogue):'')+'</div>';
h+='<h2>Safety 规则</h2><div class="box">来源：<b>玩家确认</b>（skill 提案 → 玩家确认 → 合约纯函数）。Canvas 不声明、不供给 SafetyProfile，也没有 hanaworldsSafetyProfile 服务。</div>';
h+='<h2>引擎守卫（按写操作 × stage；声明来自当前连接 <span class="fixture">FIXTURE 输入</span>）</h2><div class="box">声明 '+(d.engine.declaration?j(d.engine.declaration):'<span class="MISSING">无（null）</span>')+'</div><table><tr><th>操作</th><th>状态</th><th>未覆盖（guard @ stage）</th></tr>'+d.engine.operations.map(r=>'<tr><td>'+esc(r.operation)+'</td><td class="'+(r.unmet.length?'MISSING':'SUPPLIED')+'">'+esc(r.status)+'</td><td>'+(r.unmet.length?r.unmet.map(u=>'<code>'+esc(u.guard)+' @ '+esc(u.stage)+'</code> · '+esc(u.finding)).join('<br>'):'—')+'</td></tr>').join('')+'</table><div class="box">未覆盖任一项时该操作在任何写入前被拒（CAPABILITY_UNAVAILABLE）。回滚被引擎拒绝时事务记为待人工恢复（RESTORE_FAILED，带 guardRefusal 与 applyFailure），不报成功。</div>';
h+=profile('CompilationConfig',c.profiles.compilationConfig,d.ports.compilerConfig);
h+='<h2>变更 / 失效记录（持久，'+d.report.history.length+' 条）</h2><table><tr><th>#</th><th>观察</th><th>被取代</th><th>原因</th></tr>';for(const r of [...d.report.history].reverse())h+='<tr><td>'+esc(r.observedSequence)+'</td><td>'+j(r.observationDigest.slice(0,16))+'</td><td>'+esc(r.supersededAt)+'</td><td>'+esc(r.invalidationReasons.join(', '))+'</td></tr>';h+='</table>';$('#out').innerHTML=h;}
function renderFixture(f){$('#fixture').innerHTML='<div class="fixbox"><span class="fixture">FIXTURE</span> 对端输入（不是配置来源权威）：'+j(f)+'<br><button data-a="sourceRevision">改 FIXTURE 世界源 revision</button><button data-a="backend">FIXTURE 世界源声明/撤回写入后端</button><button data-a="rebind">FIXTURE 新连接 incarnation 并重选</button><button data-a="unbind">经 Canvas 解绑</button></div>';
for(const b of document.querySelectorAll('#fixture button'))b.onclick=async()=>{const r=await post('/api/fixture/'+b.dataset.a);if(r.fixture)renderFixture(r.fixture);await read();};}
async function read(){const w=$('#world').value;const r=await fetch('/api/supply?worldRef='+encodeURIComponent(w));const d=await r.json();if(d.fixture)renderFixture(d.fixture);render(d);}
$('#read').onsubmit=e=>{e.preventDefault();read();};fetch('/api/fixture').then(r=>r.json()).then(d=>renderFixture(d.fixture));`;

async function portOutcome(key, read) {
  try { return { key, ok: true, value: await read() }; }
  catch (error) { return { key, ok: false, error: error.publicError ?? { code: error.message },
    missingSources: error.missingSources ?? null }; }
}

export async function createConfigSupplyServer(runDirectory) {
  const storeDirectory = join(runDirectory, 'canvas-store');
  const stateFile = join(runDirectory, 'fixture-state.json');
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  let saved = {};
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const peers = await supplyFixturePeers(saved);
  const persist = () => writeFile(stateFile, JSON.stringify({ incarnation: peers.incarnation,
    sourceRevision: peers.sourceRevision, backendDeclared: peers.backendDeclared }), { mode: 0o600 });
  const canvas = new CanvasV5({ store: await CanvasStore.open(storeDirectory), adapter: peers.adapter,
    worldFacts: peers.worldFacts, sessions: peers.sessions });
  const supply = new CanvasConfigSupply(canvas);
  let counter = 0;
  const context = async () => (await canvas.call('ReadWorldSelectionContext', {
    contractVersion: 'canvas/v7', sessionRef: supplySessionRef, requestId: `page-context-${Date.now()}-${++counter}`,
    worldRef: supplyWorldRef })).result.selection;
  // Bind the FIXTURE World through Canvas's public SelectWorldConnection.
  async function select() {
    const selection = await context();
    const bound = selection.status === 'BOUND';
    if (bound && selection.context.localContext.connectionIncarnationRef === peers.incarnation) return null;
    const response = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
      sessionRef: supplySessionRef, requestId: `page-select-${Date.now()}-${++counter}`, worldRef: supplyWorldRef,
      connectionRef: 'supply-fixture-connection', connectionIncarnationRef: peers.incarnation,
      expectedRevision: bound ? selection.context.selectionRevision : selection.sessionRevision,
      expectedContext: bound ? selection.context.localContext : null });
    return response.error;
  }
  async function unbind() {
    const selection = await context();
    if (selection.status !== 'BOUND') return null;
    return (await canvas.call('UnselectWorldConnection', { contractVersion: 'canvas/v7',
      sessionRef: supplySessionRef, requestId: `page-unbind-${Date.now()}-${++counter}`, worldRef: supplyWorldRef,
      expectedRevision: selection.context.selectionRevision,
      expectedContext: selection.context.localContext })).error;
  }
  const startError = await select();
  if (startError) throw new Error(`FIXTURE_SELECT_FAILED:${startError.code}`);
  const reply = (res, status, value, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" });
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  };
  const actions = {
    sourceRevision: async () => { peers.sourceRevision = `fixture-source-${Date.now()}`; await persist(); },
    backend: async () => { peers.backendDeclared = !peers.backendDeclared; await persist(); },
    rebind: async () => { peers.incarnation = `supply-fixture-incarnation-${Date.now()}`; await persist();
      const error = await select(); if (error) throw Object.assign(new Error(error.code), { publicError: error }); },
    unbind: async () => { const error = await unbind();
      if (error) throw Object.assign(new Error(error.code), { publicError: error }); },
  };
  return createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return reply(res, 400, { error: 'INVALID_URL' }); }
    try {
      const action = /^\/api\/fixture\/(\w+)$/.exec(url.pathname)?.[1];
      if (req.method === 'POST' && action && actions[action]) {
        const host = req.headers.host;
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '') || req.headers.origin !== `http://${host}`)
          return reply(res, 403, { error: 'SAME_ORIGIN_REQUIRED' });
        let size = 0; for await (const part of req) if ((size += part.length) > MAX_BODY)
          return reply(res, 413, { error: 'BODY_TOO_LARGE' });
        await actions[action]();
        return reply(res, 200, { fixture: peers.describe() });
      }
      if (req.method !== 'GET') return reply(res, 405, { error: 'READ_ONLY' });
      if (url.pathname === '/') { res.writeHead(302, { Location: '/supply' }); return res.end(); }
      if (url.pathname === '/supply') return reply(res, 200, page, 'text/html; charset=utf-8');
      if (url.pathname === '/assets/supply.js') return reply(res, 200, client, 'text/javascript; charset=utf-8');
      if (url.pathname === '/assets/supply.css') return reply(res, 200, css, 'text/css; charset=utf-8');
      if (url.pathname === '/api/fixture') return reply(res, 200, { fixture: peers.describe() });
      if (url.pathname === '/api/supply') {
        const worldRef = url.searchParams.get('worldRef') ?? '';
        const report = await supply.read(worldRef);
        const ports = {
          compilerConfig: await portOutcome('hanaworldsCompilerConfig', () => supply.readCompilerConfig(worldRef)) };
        return reply(res, 200, { report, ports, engine: canvas.readEngineSafety(supplySessionRef),
          fixture: peers.describe() });
      }
      return reply(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      return reply(res, 409, { error: error.publicError ?? { code: error.message } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runDirectory = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('usage: config-supply-web-server.mjs <run-dir> [port]');
  const port = Number(process.argv[3] ?? 47613);
  const server = await createConfigSupplyServer(runDirectory);
  server.listen(port, '127.0.0.1', () =>
    console.log(`Canvas config supply page: http://127.0.0.1:${port}/supply (pid ${process.pid})`));
}
