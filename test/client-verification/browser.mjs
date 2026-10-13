import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const approved = {
  tag: 'dsh-v0.2.1-alpha.2', commit: 'd743267388641bc76f17c45ce8b4c231aed1d32c',
  archiveSHA256: 'f277ff1f70eda785522aec3fcdcf9d658fafb3c0d30036f810dec76d400c0e51',
  lockSHA256: 'b45f8695fb0dca90d3ed07afc766e923356539962706ee36ac8cdb396e6d734d',
};
const peers = { '@deepseek-ai/cordis': '4.0.5-alpha.1',
  '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2', react: '18.3.1', zod: '4.4.3' };
const officialInputs = {
  '@deepseek-ai/dsh-web-frontend': 'apps/web/package.json',
  '@deepseek-ai/dsh-web-app': 'packages/bundle/web-app/package.json',
  '@deepseek-ai/dsh-client-modules': 'packages/client/modules/package.json',
};

export class SupplyFailure extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
async function confined(root, input, label) {
  if (typeof input !== 'string' || !resolve(input).startsWith(root + sep))
    throw new SupplyFailure('CANVAS_VERIFY_RESOURCE_OUTSIDE_RUN', `${label} must be inside this card's isolated run`);
  const path = await realpath(input);
  if (!path.startsWith(root + sep)) throw new SupplyFailure('CANVAS_VERIFY_RESOURCE_SYMLINK_OUTSIDE_RUN', `${label} resolves outside this run`);
  return path;
}
function loopbackURL(input, label) {
  let url;
  try { url = new URL(input); } catch { throw new SupplyFailure('CANVAS_VERIFY_URL_INVALID', `${label} must be an absolute URL`); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 3080
    || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new SupplyFailure('CANVAS_VERIFY_URL_INVALID', `${label} must be a clean this-run loopback HTTP root with an explicit port`);
  return url;
}

// The future no-argument run.mjs prepares/starts/authenticates/stops the normal
// official CLI Web profile, then passes CANVAS_CLIENT_VERIFY_RESOURCES privately.
// This JSON is ONLY a resource locator, never a ready/ACTIVE/authentication
// receipt. Tests attach to its already running browser; no page, Context,
// Gateway, transport, provider, Vite server or Desktop receipt is manufactured.
// Locator fields: runRoot,dshHome,profile,installationAnchor,browserUserData,webUrl,cdpUrl,canvasTgz,
// officialSource:{tag,commit,archive,lockfile}. All filesystem resources belong
// to this card's isolated run; no token/cookie values belong in this record.
export async function productBrowser() {
  const cardRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const resourceFile = process.env.CANVAS_CLIENT_VERIFY_RESOURCES;
  if (!resourceFile) throw new SupplyFailure('CANVAS_VERIFY_WEB_RESOURCES_MISSING',
    'The no-argument card runner must supply CANVAS_CLIENT_VERIFY_RESOURCES for its actual official CLI Web profile');
  const resources = JSON.parse(await readFile(await confined(cardRoot, resourceFile, 'resource locator'), 'utf8'));
  const root = await confined(cardRoot, resources.runRoot, 'runRoot');
  const home = await confined(root, resources.dshHome, 'dshHome');
  const profile = await confined(root, resources.profile, 'profile');
  const installationAnchor = await confined(root, resources.installationAnchor, 'actual CLI installation package.json');
  const officialRequire = createRequire(installationAnchor);
  const browserUserData = await confined(root, resources.browserUserData, 'browserUserData');
  const canvasTgz = await confined(root, resources.canvasTgz, 'canvasTgz');
  assert.notEqual(home, profile, 'The real dshHome and installed profile have distinct resource identities');
  const webURL = loopbackURL(resources.webUrl, 'webUrl'), cdpURL = loopbackURL(resources.cdpUrl, 'cdpUrl');
  assert.notEqual(webURL.port, cdpURL.port, 'Product Web and browser discovery are distinct this-run services');
  const budget = Number(process.env.CANVAS_CLIENT_VERIFY_WAIT_MS ?? 30000);
  if (!Number.isFinite(budget) || budget <= 0)
    throw new SupplyFailure('CANVAS_VERIFY_BUDGET_INVALID', 'CANVAS_CLIENT_VERIFY_WAIT_MS must be positive');

  const source = resources.officialSource;
  assert.equal(source?.tag, approved.tag); assert.equal(source?.commit, approved.commit);
  const archive = await confined(root, source.archive, 'approved official source archive');
  const lockfile = await confined(root, source.lockfile, 'original official lock');
  assert.equal(sha256(await readFile(archive)), approved.archiveSHA256, 'Actual source archive bytes must equal the approved official archive');
  assert.equal(sha256(await readFile(lockfile)), approved.lockSHA256, 'Original approved lock bytes cannot be substituted');
  // Read key inputs FROM the pinned actual source archive, independently of
  // locator assertions. Archive supply does not need a .git directory.
  const { stdout: listing } = await exec('tar', ['-tf', archive], { timeout: budget, maxBuffer: Infinity });
  const lockEntries = listing.split('\n').filter(path => /(^|\/)pnpm-lock\.yaml$/.test(path));
  lockEntries.sort((a, b) => a.split('/').length - b.split('/').length);
  assert.ok(lockEntries.length, 'Approved source archive must contain its original root lock');
  const archiveLock = lockEntries[0], prefix = archiveLock.slice(0, -'pnpm-lock.yaml'.length);
  const archived = async path => (await exec('tar', ['-xOf', archive, prefix + path],
    { timeout: budget, maxBuffer: Infinity, encoding: 'buffer' })).stdout;
  assert.equal(sha256(await archived('pnpm-lock.yaml')), approved.lockSHA256, 'Archive itself must contain the approved original lock');
  const official = {};
  for (const [name, sourceInput] of Object.entries(officialInputs)) {
    const packageJson = await confined(root, officialRequire.resolve(`${name}/package.json`), `${name} actual CLI-anchor resolution`);
    const packageRoot = dirname(packageJson);
    const installed = JSON.parse(await readFile(packageJson, 'utf8'));
    const original = JSON.parse((await archived(sourceInput)).toString('utf8'));
    assert.equal(original.name, name); assert.equal(original.version, '0.2.1-alpha.2');
    assert.equal(installed.name, original.name); assert.equal(installed.version, original.version);
    assert.deepEqual(installed.repository, original.repository, 'Installed official entry must resolve from the approved source package');
    official[name] = packageRoot;
  }
  const packageRoot = await confined(root, join(profile, 'node_modules', 'hanaworlds-canvas'), 'installed Canvas');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.peerDependencies, peers);
  const require = createRequire(join(packageRoot, 'package.json'));
  for (const [name, version] of Object.entries(peers)) {
    const installedPath = await confined(root, require.resolve(`${name}/package.json`), `resolved peer ${name}`);
    const installedPeer = JSON.parse(await readFile(installedPath, 'utf8'));
    assert.equal(installedPeer.name, name); assert.equal(installedPeer.version, version);
  }
  const build = JSON.parse(await readFile(join(packageRoot, 'lib/build-source.json'), 'utf8'));
  const artifacts = {};
  for (const [file, expected] of Object.entries(build.artifacts)) {
    const digest = sha256(await readFile(await confined(packageRoot, join(packageRoot, file), `Canvas artifact ${file}`)));
    assert.equal(digest, expected, `Installed Canvas artifact drift: ${file}`); artifacts[file] = digest;
  }
  const tgzSHA256 = sha256(await readFile(canvasTgz));
  const canvasArchive = async file => (await exec('tar', ['-xOf', canvasTgz, `package/${file}`],
    { timeout: budget, maxBuffer: Infinity, encoding: 'buffer' })).stdout;
  assert.equal(sha256(await canvasArchive('lib/build-source.json')),
    sha256(await readFile(join(packageRoot, 'lib/build-source.json'))), 'Installed artifact table must belong to the same production tgz');
  const packedClient = await canvasArchive('lib/client.js');
  assert.equal(sha256(packedClient), artifacts['lib/client.js'], 'Installed Canvas client bytes must equal the manager-installed production tgz');
  assert.ok(!packedClient.includes(Buffer.from('hanaworldsCanvasVerification')), 'Observation entry must stay out of the production Canvas client');
  const { stdout: canvasMembers } = await exec('tar', ['-tf', canvasTgz], { timeout: budget, maxBuffer: Infinity });
  assert.ok(!canvasMembers.split('\n').some(member => /^package\/(tools|test)\//.test(member)), 'Production tgz cannot be replaced by a test or observation package');
  const unauthenticated = await fetch(webURL, { redirect: 'manual', signal: AbortSignal.timeout(budget) });
  assert.equal(unauthenticated.status, 401, 'Official web-app must require its original local token/cookie authentication');
  let discovery;
  try { discovery = await fetch(new URL('json/list', cdpURL), { signal: AbortSignal.timeout(budget) }); }
  catch { throw new SupplyFailure('CANVAS_VERIFY_WEB_BROWSER_UNAVAILABLE', 'Actual this-run Web browser discovery failed'); }
  assert.equal(discovery.ok, true, `Web browser discovery HTTP ${discovery.status}`);
  const pages = (await discovery.json()).filter(x => {
    if (x.type !== 'page') return false;
    try { const url = new URL(x.url); return url.origin === webURL.origin && url.pathname === '/'; } catch { return false; }
  });
  assert.equal(pages.length, 1, 'Exactly one actual official Web product root page is required');
  const pageURL = new URL(pages[0].url);
  assert.ok(pageURL.search === '' && pageURL.hash === '', 'Original token exchange must leave a clean authenticated product URL');
  const endpoint = new URL(pages[0].webSocketDebuggerUrl);
  assert.equal(endpoint.protocol, 'ws:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.port, cdpURL.port, 'CDP target must be this card browser, never Desktop App discovery');
  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new SupplyFailure('CANVAS_VERIFY_CONNECT_WAIT', `CDP connect exceeded ${budget} ms`)); }, budget);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new SupplyFailure('CANVAS_VERIFY_CONNECT_FAILED', 'Actual Web renderer CDP failed')); }, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data), task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.fail(new SupplyFailure('CANVAS_VERIFY_CDP_FAILED', `Actual CDP ${task.method} was rejected`));
    else if (value.result?.exceptionDetails) task.fail(new Error(JSON.stringify(value.result.exceptionDetails)));
    else task.done(value.result);
  });
  const rejectAll = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.fail(new SupplyFailure('CANVAS_VERIFY_RENDERER_CLOSED', 'Actual Web renderer closed during observation')); } pending.clear(); };
  socket.addEventListener('close', rejectAll); socket.addEventListener('error', rejectAll);
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); fail(new SupplyFailure('CANVAS_VERIFY_CASE_WAIT', `Actual ${method} exceeded ${budget} ms`)); }, budget);
    pending.set(id, { method, done, fail, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  try {
    const launched = await send('Browser.getBrowserCommandLine');
    const flag = launched.arguments.find(value => value.startsWith('--user-data-dir='));
    assert.ok(flag, 'Actual headless browser command must expose its own isolated user-data directory');
    assert.equal(await realpath(flag.slice('--user-data-dir='.length)), browserUserData);
    const cookies = await send('Network.getCookies', { urls: [webURL.href] });
    const cookieName = 'dsh-auth-' + createHash('sha256').update(webURL.host).digest('base64url');
    const cookie = cookies.cookies.find(value => value.name === cookieName);
    // Cookie values are inspected only in memory, never returned or logged.
    assert.ok(cookie, 'Actual product browser must own the original authority-bound authentication cookie');
    assert.ok(cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/', 'Original HttpOnly/SameSite=Strict cookie attributes are required');
    assert.ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.value), 'Actual cookie must have the official signed versioned format');
    let cookiePayload;
    try { cookiePayload = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new SupplyFailure('CANVAS_VERIFY_AUTH_COOKIE_INVALID', 'Actual browser cookie payload cannot be decoded'); }
    assert.equal(cookiePayload.authority, webURL.host); assert.ok(cookiePayload.expiresAt > Date.now());
    assert.ok(Number.isInteger(cookiePayload.issuedAt) && cookiePayload.issuedAt <= Date.now(),
      'Original SDK cookie serialization must carry its actual issue timestamp');
    const page = await evaluate(`(async () => {
      const response = await fetch(location.href, {credentials:'include'});
      return {url:location.href,status:response.status,html:await response.text(),
        boot:window.__DSH_BOOT__,loaderMode:window.__ModuleLoader__?.mode,
        scripts:[...document.querySelectorAll('script[src]')].map(node=>node.src)};
    })()`);
    assert.ok(page.url === webURL.href, 'Actual page must remain at this run clean product root after authentication');
    assert.equal(page.status, 200, 'Actual cookie must be accepted by the original web-app');
    assert.equal(page.loaderMode, 'live'); assert.ok(page.boot?.rev && Array.isArray(page.boot.entries));
    const frontendRoot = official['@deepseek-ai/dsh-web-frontend'];
    const frontendHtml = await readFile(join(frontendRoot, 'dist/index.html'), 'utf8');
    const frontendScripts = [...frontendHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
    assert.ok(frontendScripts.length, 'Approved official frontend dist must contain its production shell entry');
    assert.ok(!page.scripts.some(src => /\/@vite\/client|\/src\//.test(new URL(src).pathname)), 'A standalone Vite source page cannot be the product client');
    for (const relative of frontendScripts) {
      const url = new URL(relative, webURL); assert.equal(url.origin, webURL.origin);
      assert.ok(page.scripts.includes(url.href), 'Actual Web DOM must load the installed official production frontend entry');
      const file = await confined(join(frontendRoot, 'dist'), join(frontendRoot, 'dist', relative), 'official frontend script');
      const expected = sha256(await readFile(file));
      const observed = await evaluate(`(async()=>{const response=await fetch(${JSON.stringify(url.href)},{credentials:'include'});
        if(!response.ok) throw new Error('CANVAS_OFFICIAL_FRONTEND_FETCH_FAILED');
        const bytes=await response.arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
          .map(value=>value.toString(16).padStart(2,'0')).join('');})()`);
      assert.equal(observed, expected, 'Actual served frontend shell bytes must equal the installed official dist artifact');
    }
    const installed = await evaluate(`(() => {
      const entry=window.hanaworldsCanvasVerification;
      if(!entry || entry.profileVersion!=='canvas-client-verification/v1') throw new Error('CANVAS_VERIFICATION_ENTRY_MISSING');
      return entry.inspect();
    })()`);
    assert.equal(installed.packageRoot, packageRoot);
    assert.deepEqual(installed.artifacts, artifacts, 'Actual Host/client and installed production package must identify the same bytes');
    assert.equal(installed.loader.packageName, '@deepseek-ai/cordis-plugin-loader');
    assert.equal(installed.manager.packageName, '@deepseek-ai/dsh-plugin-manager');
    assert.equal(installed.manager.tgzSHA256, tgzSHA256); assert.equal(installed.loader.tgzSHA256, tgzSHA256);
    assert.equal(installed.manager.selectedBundle, 'hanaworlds-canvas'); assert.equal(installed.host.rootRef, installed.loader.rootRef);
    for (const key of ['hanaworldsCanvasV5', 'hanaworldsCanvasRegionV1', 'hanaworldsWorkshopV3', 'hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1', 'hanaworldsWorldFacts']) {
      const provider = installed.providers[key];
      assert.equal(provider.state, 'ACTIVE', `${key} must be an actual ACTIVE provider`);
      assert.equal(provider.rootRef, installed.host.rootRef); assert.ok(provider.instanceRef && provider.fiberRef && provider.registrationRef);
      assert.equal(provider.origin, 'OFFICIAL_LOADER', 'No test-made Context/Service/fixture counterpart');
    }
    const sourceEvidence = installed.clientSource, client = installed.client;
    assert.equal(sourceEvidence.clientModulesProvider.state, 'ACTIVE');
    assert.equal(sourceEvidence.clientModulesProvider.origin, 'OFFICIAL_LOADER');
    assert.equal(sourceEvidence.clientModulesProvider.rootRef, installed.host.rootRef);
    assert.ok(sourceEvidence.clientModulesProvider.instanceRef && sourceEvidence.clientModulesProvider.fiberRef
      && sourceEvidence.clientModulesProvider.registrationRef, 'Actual Host ClientModules service must have its own current official registration identity');
    assert.equal(sourceEvidence.graphRef, page.boot.rev); assert.equal(client.graphRef, page.boot.rev);
    assert.equal(client.modulesVersion, 'client'); assert.equal(client.fiberState, 2);
    assert.equal(client.loaderUsesModules, true); assert.equal(client.moduleNamespaceMatches, true); assert.equal(client.callbackMatches, true);
    assert.ok(client.loaderEntryId && Number.isInteger(client.fiberUid));
    assert.deepEqual(page.boot.entries.find(row => row.id === 'hanaworlds-canvas'), sourceEvidence.graphRow);
    assert.equal(sourceEvidence.artifactPath, join(packageRoot, 'lib/client.js'));
    assert.equal(sourceEvidence.artifactSHA256, artifacts['lib/client.js']); assert.equal(client.bundleSHA256, sourceEvidence.bundleSHA256);
    const canvasBundleURL = new URL(sourceEvidence.graphRow.url, webURL);
    assert.equal(canvasBundleURL.origin, webURL.origin);
    const actualBundleSHA256 = await evaluate(`(async()=>{
      const response=await fetch(${JSON.stringify(canvasBundleURL.href)},{credentials:'include'});
      if(!response.ok) throw new Error('CANVAS_PRODUCT_BUNDLE_FETCH_FAILED');
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))]
        .map(value=>value.toString(16).padStart(2,'0')).join('');})()`);
    assert.equal(actualBundleSHA256, sourceEvidence.bundleSHA256, 'Independent actual page fetch must agree with the official Host ClientModules bundle bytes');
    return {
      inspect: installed, evaluate,
      async run(id, mode) {
        return evaluate(`(async () => {
          const id=${JSON.stringify(id)},mode=${JSON.stringify(mode)},entry=window.hanaworldsCanvasVerification;
          const button=[...document.querySelectorAll('[data-canvas-verification-case]')]
            .find(node=>node.dataset.canvasVerificationCase===id && node.dataset.canvasVerificationMode===mode);
          if(!button) throw new Error('CANVAS_CASE_BUTTON_MISSING: '+id+'/'+mode);
          button.click();const value=await entry.result(id,mode);
          const panels=[...document.querySelectorAll('.hw-canvas-display')]
            .filter(node=>node.getClientRects().length>0 && !node.closest('[data-canvas-verification-tool]'));
          return {value,dom:{text:panels.map(node=>node.innerText).join(' '),canvasPanels:panels.length}};
        })()`);
      },
      close() { socket.close(); rejectAll(); },
    };
  } catch (error) { socket.close(); throw error; }
}
