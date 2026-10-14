import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RunnerFailure, confined, launchOwned, deadline } from './processes.mjs';

async function chromiumExecutable(configured) {
  const candidates = configured ? [configured] : process.platform === 'darwin' ?
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] :
    ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const path of candidates) { try { await access(path, constants.X_OK); return await realpath(path); } catch {} }
  throw new RunnerFailure('CANVAS_VERIFY_CHROMIUM_MISSING', 'No actual Chromium executable is available for the isolated headless browser.', { candidates });
}
export function cleanLoopback(input, label) {
  let url;
  try { url = new URL(input); } catch { throw new RunnerFailure('CANVAS_VERIFY_LISTENER_INVALID', `${label} did not supply an actual absolute URL.`); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 3080 || url.username || url.password)
    throw new RunnerFailure('CANVAS_VERIFY_LISTENER_INVALID', `${label} must be a this-run loopback listener on a non-3080 port.`);
  return new URL(url.origin + '/');
}
async function connect(endpoint, budget, redact) {
  const socket = new WebSocket(endpoint);
  try {
    await deadline(new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', () => fail(new RunnerFailure('CANVAS_VERIFY_BROWSER_CDP_CONNECT_FAILED', 'The actual browser CDP connection failed.')), { once: true });
    }), budget, 'CANVAS_VERIFY_BROWSER_CDP_CONNECT_TIMEOUT', 'The actual browser CDP connection exceeded its observation budget.');
  } catch (error) { socket.close(); throw error; }
  let serial = 0;
  const pending = new Map(), waiting = new Map();
  const close = () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.fail(new RunnerFailure('CANVAS_VERIFY_BROWSER_CLOSED', 'The owned browser closed during observation.')); }
    pending.clear();
    for (const tasks of waiting.values()) for (const task of tasks) task.fail(new RunnerFailure('CANVAS_VERIFY_BROWSER_CLOSED', 'The owned browser closed before navigation completed.'));
    waiting.clear();
  };
  socket.addEventListener('close', close); socket.addEventListener('error', close);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method) {
      const tasks = waiting.get(message.method);
      if (tasks) { waiting.delete(message.method); for (const task of tasks) task.done(message.params); }
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error || message.result?.exceptionDetails)
      task.fail(new RunnerFailure('CANVAS_VERIFY_BROWSER_CDP_REJECTED', `Actual browser ${task.method} failed.`,
        { method: task.method, protocolCode: message.error?.code ?? null,
          originalFailure: redact.text(message.error?.message ?? message.result?.exceptionDetails?.exception?.description ??
            message.result?.exceptionDetails?.text ?? 'Actual browser request was rejected') }));
    else task.done(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((done, fail) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); fail(new RunnerFailure('CANVAS_VERIFY_BROWSER_CDP_TIMEOUT', `Actual browser ${method} exceeded its observation budget.`, { timeoutMs: budget })); }, budget);
        pending.set(id, { method, timer, done, fail }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    event(method) {
      let task;
      const promise = new Promise((done, fail) => {
        task = { done, fail };
        const tasks = waiting.get(method) ?? new Set(); tasks.add(task); waiting.set(method, tasks);
      });
      return deadline(promise, budget, 'CANVAS_VERIFY_BROWSER_EVENT_TIMEOUT', `Actual browser ${method} did not arrive.`)
        .finally(() => waiting.get(method)?.delete(task));
    },
    close() { socket.close(); close(); },
  };
}
export async function startAuthenticatedBrowser({ root, env, owned, redact, loginURL, budget, executable }) {
  const webUrl = cleanLoopback(loginURL, 'normal Web CLI');
  const unauthenticated = await fetch(webUrl, { redirect: 'manual', signal: AbortSignal.timeout(budget) });
  if (unauthenticated.status !== 401)
    throw new RunnerFailure('CANVAS_VERIFY_ORIGINAL_AUTHENTICATION_REQUIRED', 'The actual normal Web root did not reject unauthenticated access.', { status: unauthenticated.status });
  const browserUserData = join(root, 'browser-user-data'); await mkdir(browserUserData);
  const binary = await chromiumExecutable(executable);
  const browser = await launchOwned({ file: binary, args: ['--headless=new', '--enable-automation', '--incognito',
    '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${browserUserData}`, 'about:blank'], cwd: root, env, root, label: 'chromium', redact,
    readyMatch: line => {
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(line);
      return match?.[1];
    } });
  owned.push(browser);
  const endpoint = await browser.ready(budget);
  const discovery = new URL(endpoint);
  const cdpUrl = cleanLoopback('http://' + discovery.host + '/', 'owned Chromium CDP');
  browser.listener = cdpUrl.href;
  const response = await fetch(new URL('json/list', cdpUrl), { signal: AbortSignal.timeout(budget) });
  if (!response.ok) throw new RunnerFailure('CANVAS_VERIFY_BROWSER_DISCOVERY_FAILED', 'The actual owned browser discovery endpoint failed.', { status: response.status });
  const pages = (await response.json()).filter(page => page.type === 'page' && page.url === 'about:blank');
  if (pages.length !== 1) throw new RunnerFailure('CANVAS_VERIFY_BROWSER_TARGET_AMBIGUOUS', 'The new isolated browser has no unique original page target.');
  const target = new URL(pages[0].webSocketDebuggerUrl);
  if (target.protocol !== 'ws:' || target.host !== discovery.host)
    throw new RunnerFailure('CANVAS_VERIFY_BROWSER_TARGET_OUTSIDE_RUN', 'Browser discovery returned a different CDP listener.');
  const cdp = await connect(target.href, budget, redact);
  try {
    await cdp.send('Page.enable'); await cdp.send('Network.enable');
    const loaded = cdp.event('Page.loadEventFired');
    loaded.catch(() => {}); // The primary navigation error remains authoritative if navigate rejects.
    // Authentication occurs through the original Web token-to-cookie redirect in Chromium.
    await cdp.send('Page.navigate', { url: loginURL }); await loaded;
    const commandLine = await cdp.send('Browser.getBrowserCommandLine');
    const verifiedFlags = ['--use-mock-keychain', '--password-store=basic'];
    for (const flag of verifiedFlags) if (!commandLine.arguments.includes(flag))
      throw new RunnerFailure('CANVAS_VERIFY_BROWSER_PERMISSION_POLICY_INVALID',
        'The actual isolated browser command line is missing its approved permission policy.', { missingFlag: flag });
    const actualFlag = commandLine.arguments.find(argument => argument.startsWith('--user-data-dir='));
    if (!actualFlag || await realpath(actualFlag.slice('--user-data-dir='.length)) !== await realpath(browserUserData))
      throw new RunnerFailure('CANVAS_VERIFY_BROWSER_ISOLATION_INVALID', 'The actual browser command line has a different user-data root.');
    await confined(root, actualFlag.slice('--user-data-dir='.length), 'actual browser user-data');
    await writeFile(join(root, 'browser-command-line.json'), JSON.stringify({
      arguments: commandLine.arguments, browserUserData, verifiedFlags }, null, 2));
    const { cookies } = await cdp.send('Network.getCookies', { urls: [webUrl.href] });
    const cookieName = 'dsh-auth-' + createHash('sha256').update(webUrl.host).digest('base64url');
    const cookie = cookies.find(value => value.name === cookieName);
    if (!cookie || !cookie.httpOnly || cookie.sameSite !== 'Strict' || cookie.path !== '/')
      throw new RunnerFailure('CANVAS_VERIFY_ORIGINAL_AUTH_COOKIE_MISSING', 'The actual browser has no original authority-bound HttpOnly/SameSite cookie.');
    redact.add(cookie.value);
    let payload;
    try { payload = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString('utf8')); } catch {}
    if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.value) || payload?.authority !== webUrl.host ||
        !Number.isInteger(payload.issuedAt) || payload.issuedAt > Date.now() || payload.expiresAt <= Date.now())
      throw new RunnerFailure('CANVAS_VERIFY_ORIGINAL_AUTH_COOKIE_INVALID', 'The original cookie serialization or authority did not verify.');
    const page = await cdp.send('Runtime.evaluate', { expression: `(async()=>({url:location.href,status:(await fetch(location.href,{credentials:'include'})).status}))()`, awaitPromise: true, returnByValue: true });
    if (page.result?.value?.url !== webUrl.href || page.result?.value?.status !== 200)
      throw new RunnerFailure('CANVAS_VERIFY_ORIGINAL_AUTH_EXCHANGE_FAILED', 'Normal navigation did not leave a clean root whose cookie is accepted.');
    await cdp.send('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{const ready=()=>!!window.hanaworldsCanvasVerification&&document.querySelector('[data-canvas-verification-case]');if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve(true);}});observer.observe(document,{childList:true,subtree:true});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('CANVAS_VERIFICATION_ENTRY_MISSING'));},${budget});})`, awaitPromise: true, returnByValue: true });
    return { browser, cdp, webUrl: webUrl.href, cdpUrl: cdpUrl.href, browserUserData,
      authentication: { unauthenticatedStatus: 401, authenticatedStatus: 200, cleanRoot: true,
        cookieName, httpOnly: true, sameSite: 'Strict', authority: webUrl.host, issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt, privateBrowser: true } };
  } catch (error) { cdp.close(); throw error; }
}
