// Pre-switch REAL_UI walk: real Chrome, real page bytes, real clicks via CDP. Locates
// elements by visible text only (what a person sees); records screenshots + page text.
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
const [base, out] = process.argv.slice(2);
const profile = await mkdtemp(join(out, '.chrome-profile-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,1000', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => { let buf = '';
  chrome.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) resolve(m[1]); });
  chrome.on('exit', code => reject(new Error(`chrome exited ${code}`))); });
const browser = new WebSocket(wsUrl); await new Promise(r => browser.onopen = r);
let id = 0; const waiters = new Map();
browser.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise(r => { const n = ++id; waiters.set(n, r); browser.send(JSON.stringify({ id: n, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
await s('Page.enable'); await s('Runtime.enable');
await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evaluate = async expression => (await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
const waitText = async (text, ms = 8000) => { const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) return; await sleep(100); }
  throw new Error(`text not visible: ${text}`); };
const log = [];
const shot = async name => { await sleep(300);
  const { result } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(out, `${name}.png`), Buffer.from(result.data, 'base64'));
  const text = await evaluate('document.body.innerText'); await writeFile(join(out, `${name}.txt`), text);
  log.push({ step: name, at: new Date().toISOString(), url: await evaluate('location.href') }); };
const click = async label => { // real mouse click at the visible element's centre
  const box = await evaluate(`(() => { const el = [...document.querySelectorAll('button,a')].find(e => e.innerText.trim().split('\\n')[0].replace(/\\s*[↗↺]$/, '').trim() === ${JSON.stringify(label)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!el.disabled }; })()`);
  if (!box) throw new Error(`no control: ${label}`); if (box.disabled) throw new Error(`disabled: ${label}`);
  for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  log.push({ click: label, at: new Date().toISOString() }); };
try {
  await s('Page.navigate', { url: `${base}/undo` }); await waitText('示例数据 · 隔离环境'); await waitText('示例改动 2');
  await shot('01-open-undo');
  await click('示例改动 2'); await waitText('对应格子（读回）'); await shot('02-select-cell-entry');
  await click('撤回'); await waitText('已撤回：Canvas 事务已验证'); await shot('03-after-undo');
  await click('重做'); await waitText('已重做：Canvas 事务已验证'); await shot('04-after-redo');
  await s('Page.navigate', { url: `${base}/undo` }); await waitText('示例改动 1');
  await click('示例改动 1'); await waitText('不能撤回：'); await shot('05-reopened-named-refusal');
  await click('对象与历史'); await waitText('4 笔记录'); await shot('06-objects-still-available');
} finally {
  await writeFile(join(out, 'walk-log.json'), JSON.stringify(log, null, 2));
  chrome.kill(); await sleep(500); await rm(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(log));
