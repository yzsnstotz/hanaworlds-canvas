import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export class SupplyFailure extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
// This is an observer of the mechanism's existing product renderer. It never
// creates a Context, Gateway, provider, profile, browser page or fake transport.
export async function productBrowser() {
  const envRoot = process.env.SEGFLOW_ENV_DIR;
  const rawPort = process.env.SEGFLOW_PORT_HANAWORLDS_DESKTOP;
  if (!envRoot || !rawPort) throw new SupplyFailure('CANVAS_VERIFY_ENV_MISSING',
    'SEGFLOW_ENV_DIR and SEGFLOW_PORT_HANAWORLDS_DESKTOP must come from the declared HANAWORLDS_DESKTOP environment');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3080)
    throw new SupplyFailure('CANVAS_VERIFY_PORT_INVALID', 'A this-run permitted loopback service port is required');
  const budget = Number(process.env.CANVAS_CLIENT_VERIFY_WAIT_MS ?? 30000);
  if (!Number.isFinite(budget) || budget <= 0)
    throw new SupplyFailure('CANVAS_VERIFY_BUDGET_INVALID', 'CANVAS_CLIENT_VERIFY_WAIT_MS must be positive');
  const root = await realpath(envRoot);
  const product = JSON.parse(await readFile(join(root, 'product-environment.json'), 'utf8'));
  for (const field of ['app', 'dshHome', 'profile', 'electronUserData']) {
    if (typeof product[field] !== 'string' || !resolve(product[field]).startsWith(root + sep) ||
      !(await realpath(product[field])).startsWith(root + sep))
      throw new SupplyFailure('CANVAS_VERIFY_PROFILE_OUTSIDE_RUN', `Product ${field} is not isolated to this mechanism run`);
  }
  const packageRoot = await realpath(join(product.profile, 'node_modules', 'hanaworlds-canvas'));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(packageRoot, 'lib/build-source.json'), 'utf8'));
  const artifacts = {};
  for (const [file, expected] of Object.entries(build.artifacts)) {
    const digest = createHash('sha256').update(await readFile(join(packageRoot, file))).digest('hex');
    assert.equal(digest, expected, `Installed Canvas artifact drift: ${file}`); artifacts[file] = digest;
  }
  let discovery;
  try { discovery = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(budget) }); }
  catch (error) { throw new SupplyFailure('CANVAS_VERIFY_SERVICE_UNAVAILABLE', `Declared renderer discovery failed: ${error.name}`); }
  assert.equal(discovery.ok, true, `Renderer discovery HTTP ${discovery.status}`);
  const pages = (await discovery.json()).filter(x => x.type === 'page' && x.url.startsWith('dsh-app://app/'));
  assert.equal(pages.length, 1, 'Exactly one actual primary product renderer is required');
  const endpoint = new URL(pages[0].webSocketDebuggerUrl);
  assert.equal(endpoint.protocol, 'ws:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(Number(endpoint.port), port, 'CDP target must be the mechanism service');
  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new SupplyFailure('CANVAS_VERIFY_CONNECT_WAIT', `CDP connect exceeded ${budget} ms`)); }, budget);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new SupplyFailure('CANVAS_VERIFY_CONNECT_FAILED', 'Actual renderer CDP failed')); }, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data), task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error || value.result?.exceptionDetails) task.fail(new Error(JSON.stringify(value.error ?? value.result.exceptionDetails)));
    else task.done(value.result);
  });
  const rejectAll = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.fail(new SupplyFailure('CANVAS_VERIFY_RENDERER_CLOSED', 'Actual renderer closed during observation')); } pending.clear(); };
  socket.addEventListener('close', rejectAll); socket.addEventListener('error', rejectAll);
  const evaluate = expression => new Promise((done, fail) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); fail(new SupplyFailure('CANVAS_VERIFY_CASE_WAIT', `Actual client evaluation exceeded ${budget} ms`)); }, budget);
    pending.set(id, { done: result => done(result.result.value), fail, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  try {
    const installed = await evaluate(`(() => {
      if (!window.__ModuleLoader__) throw new Error('CANVAS_OFFICIAL_CLIENT_LOADER_MISSING');
      const entry = window.hanaworldsCanvasVerification;
      if (!entry || entry.profileVersion !== 'canvas-client-verification/v1') throw new Error('CANVAS_VERIFICATION_ENTRY_MISSING');
      return entry.inspect();
    })()`);
    assert.equal(installed.packageRoot, packageRoot, 'Client observer must identify the actual installed package');
    assert.deepEqual(installed.artifacts, artifacts, 'Host/client evidence must name the same installed bytes');
    assert.deepEqual(manifest.peerDependencies, { '@deepseek-ai/cordis': '4.0.5-alpha.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2', react: '18.3.1', zod: '4.4.3' });
    assert.equal(installed.loader.packageName, '@deepseek-ai/cordis-plugin-loader');
    assert.equal(installed.manager.packageName, '@deepseek-ai/dsh-plugin-manager');
    assert.match(installed.manager.tgzSHA256, /^[a-f0-9]{64}$/);
    assert.equal(installed.manager.tgzSHA256, installed.loader.tgzSHA256);
    assert.equal(installed.manager.selectedBundle, 'hanaworlds-canvas');
    assert.equal(installed.host.rootRef, installed.loader.rootRef);
    for (const key of ['hanaworldsCanvasV5', 'hanaworldsCanvasRegionV1', 'hanaworldsWorkshopV3', 'hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1', 'hanaworldsWorldFacts']) {
      const provider = installed.providers[key];
      assert.equal(provider.state, 'ACTIVE', `${key} must be an actual ACTIVE provider`);
      assert.equal(provider.rootRef, installed.host.rootRef);
      assert.ok(provider.instanceRef && provider.fiberRef && provider.registrationRef);
      assert.equal(provider.origin, 'OFFICIAL_LOADER', 'No test-made Context/Service/fixture counterpart');
    }
    return {
      inspect: installed, evaluate,
      async run(id, mode) {
        // The documented test entry renders one button per example. Clicking
        // the actual DOM invokes its installed-provider path; no Node callback
        // or Remote/Gateway is substituted.
        return evaluate(`(async () => {
          const id=${JSON.stringify(id)}, mode=${JSON.stringify(mode)};
          const entry=window.hanaworldsCanvasVerification;
          const button=[...document.querySelectorAll('[data-canvas-verification-case]')]
            .find(b=>b.dataset.canvasVerificationCase===id && b.dataset.canvasVerificationMode===mode);
          if(!button) throw new Error('CANVAS_CASE_BUTTON_MISSING: '+id+'/'+mode);
          button.click();
          const value=await entry.result(id,mode);
          const panels=[...document.querySelectorAll('.hw-canvas-display')];
          return {value,dom:{text:panels.map(p=>p.innerText).join(' '),canvasPanels:panels.length}};
        })()`);
      },
      close() { socket.close(); rejectAll(); },
    };
  } catch (error) { socket.close(); throw error; }
}
