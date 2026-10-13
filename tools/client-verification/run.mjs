// No-argument product runner: independent public supply -> normal Web CLI ->
// original authentication -> actual Chromium -> locked tests -> owned cleanup.
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { RunnerFailure, positive, redactor, launchOwned, stopOwned, verifyPortReleased, confined } from './processes.mjs';
import { sourceRoot, cardRoot, readSupply, retainOfficialSource, prepareObservation } from './prepare.mjs';
import { startAuthenticatedBrowser, cleanLoopback } from './chromium.mjs';

export function runnerSettings(env = process.env) {
  const port = Number(env.CANVAS_CLIENT_VERIFY_PORT ?? 0);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 3080)
    throw new RunnerFailure('CANVAS_VERIFY_PORT_INVALID', 'CANVAS_CLIENT_VERIFY_PORT must be 0 or a valid non-3080 loopback port.');
  return { prepareMs: positive(env.HANAWORLDS_HOST_PREPARE_TIMEOUT_MS, 'HANAWORLDS_HOST_PREPARE_TIMEOUT_MS', 120000),
    stopMs: positive(env.HANAWORLDS_HOST_PREPARE_STOP_TIMEOUT_MS, 'HANAWORLDS_HOST_PREPARE_STOP_TIMEOUT_MS', 10000),
    waitMs: positive(env.CANVAS_CLIENT_VERIFY_WAIT_MS, 'CANVAS_CLIENT_VERIFY_WAIT_MS', 30000),
    managerOutputBytes: positive(env.CANVAS_CLIENT_VERIFY_MANAGER_OUTPUT_BYTES, 'CANVAS_CLIENT_VERIFY_MANAGER_OUTPUT_BYTES', 4 * 1024 * 1024),
    port, chromium: env.CANVAS_CLIENT_VERIFY_CHROMIUM,
    supplierEntry: resolve(env.HANAWORLDS_HOST_SUPPLIER_ENTRY ??
      join(homedir(), 'work', 'projects', 'hana-world-mvp', 'plugins', 'hanaworlds-desktop', 'packaging', 'official-host-supply.mjs')) };
}
function publicFailure(error, redact) {
  return { name: error?.name ?? 'Error', code: error?.code ?? 'CANVAS_VERIFY_RUNNER_FAILED',
    message: redact.text(error?.message ?? String(error)), details: JSON.parse(redact.text(JSON.stringify(error?.details ?? {}))) };
}
async function preparePublicSupplier(root, settings, owned, redact) {
  try { await access(settings.supplierEntry); }
  catch { throw new RunnerFailure('CANVAS_VERIFY_PUBLIC_SUPPLIER_ENTRY_MISSING', 'The documented public Host supplier entry is unavailable.', { supplierEntry: settings.supplierEntry }); }
  const supplierEnvironment = { PATH: process.env.PATH, HOME: join(root, 'supplier-home'), TMPDIR: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'), XDG_CACHE_HOME: join(root, 'cache'),
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await Promise.all(Object.values(supplierEnvironment).filter(value => typeof value === 'string' && value.startsWith(root + '/')).map(path => mkdir(path, { recursive: true })));
  const callPath = join(root, 'call-public-supplier.mjs');
  await writeFile(callPath, `import {writeFile} from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nconst [entry,root,prepare,stop]=process.argv.slice(2);\nconst {prepareOfficialHostSupply}=await import(pathToFileURL(entry).href);\nif(typeof prepareOfficialHostSupply!=='function')throw new Error('CANVAS_VERIFY_PUBLIC_SUPPLIER_API_MISSING');\nconst supplied=await prepareOfficialHostSupply({root,commandTimeoutMs:Number(prepare),commandStopTimeoutMs:Number(stop)});\nawait writeFile(root+'/public-api-result.json',JSON.stringify(supplied,null,2));\n`);
  const child = await launchOwned({ file: process.execPath,
    args: [callPath, settings.supplierEntry, root, String(settings.prepareMs), String(settings.stopMs)],
    cwd: root, env: supplierEnvironment, root, label: 'public-supplier', redact });
  owned.push(child);
  try { await child.complete(settings.prepareMs); }
  catch (error) { throw new RunnerFailure('CANVAS_VERIFY_PUBLIC_SUPPLIER_FAILED', 'The actual public supplier could not prepare its same-source official installation; retain its original logs.',
    { cause: error.code, supplierEntry: settings.supplierEntry, stdoutPath: child.stdoutPath, stderrPath: child.stderrPath, actualExit: child.exit }); }
  return { receiptPath: join(root, 'official-host-supply.json'), process: child };
}
async function packCanvas(prepared, settings, owned, redact) {
  const archives = join(prepared.root, 'canvas-archives'); await mkdir(archives);
  const child = await launchOwned({ file: 'npm', args: ['pack', '--pack-destination', archives], cwd: sourceRoot,
    env: prepared.supply.commands.start.env, root: prepared.root, label: 'production-canvas-pack', redact });
  owned.push(child); await child.complete(settings.prepareMs);
  const archivesWritten = (await readdir(archives)).filter(file => file.endsWith('.tgz'));
  if (archivesWritten.length !== 1) throw new RunnerFailure('CANVAS_VERIFY_PRODUCTION_TGZ_AMBIGUOUS', 'Normal npm pack did not produce exactly one Canvas production archive.');
  return confined(prepared.root, join(archives, archivesWritten[0]), 'fresh production Canvas tgz');
}
function normalStart(supply, settings) {
  const command = supply.commands.start;
  const args = [...command.args];
  for (const [option, expected] of [['--profile', 'web'], ['--host', '127.0.0.1']]) {
    const index = args.indexOf(option);
    if (index < 0 || args[index + 1] !== expected)
      throw new RunnerFailure('CANVAS_VERIFY_NORMAL_WEB_COMMAND_REQUIRED', 'The public supplier must supply its normal loopback Web-profile command.');
  }
  if (!args.includes('--no-open')) throw new RunnerFailure('CANVAS_VERIFY_NORMAL_WEB_COMMAND_REQUIRED', 'Normal Web startup must use --no-open.');
  const portIndex = args.indexOf('--port');
  if (portIndex < 0) throw new RunnerFailure('CANVAS_VERIFY_NORMAL_WEB_COMMAND_REQUIRED', 'The generated command must expose its normal port option.');
  args[portIndex + 1] = String(settings.port);
  return { ...command, args };
}

export async function runVerification(options = {}) {
  const settings = runnerSettings(); // Validate public budgets before creating a profile.
  if (process.version !== 'v24.13.1')
    throw new RunnerFailure('CANVAS_VERIFY_NODE_VERSION_REQUIRED', 'This approved runner requires Node24.13.1.', { actual: process.version });
  const evidenceRoot = join(cardRoot, 'evidence', 'd91'); await mkdir(evidenceRoot, { recursive: true });
  // preparedRoot is an internal same-run continuation hook; the public command takes no arguments.
  const root = options.preparedRoot ? await confined(cardRoot, options.preparedRoot, 'actual prepared continuation root') :
    await mkdtemp(join(evidenceRoot, 'web-run-'));
  const redact = redactor(), owned = [], cleanupFailures = [], cleanup = [], addresses = new Set();
  const result = { format: 'canvas-web-run/v1', runRoot: root, startedAt: new Date().toISOString(),
    settings: { ...settings, chromium: settings.chromium ?? 'automatic actual executable discovery' },
    phases: { supplier: 'NOT_RUN', sourceIsolation: 'NOT_RUN', install: 'NOT_RUN', web: 'NOT_RUN', authentication: 'NOT_RUN',
      counterpartSupply: 'NOT_RUN', lockedClientTests: 'NOT_RUN' }, primaryFailure: null, cleanupFailures };
  let browser;
  try {
    result.phases.supplier = 'RUNNING';
    if (!options.preparedRoot) await preparePublicSupplier(root, settings, owned, redact);
    result.phases.supplier = 'PASS';
    result.phases.sourceIsolation = 'RUNNING';
    const prepared = await readSupply(root);
    result.phases.sourceIsolation = 'PASS';
    result.supplyReceipt = join(root, 'official-host-supply.json'); result.usagePath = prepared.supply.usagePath;
    const nodeVersion = await launchOwned({ file: prepared.supply.commands.start.file, args: ['--version'],
      cwd: root, env: prepared.supply.commands.start.env, root, label: 'official-cli-node-version', redact });
    owned.push(nodeVersion); await nodeVersion.complete(settings.prepareMs);
    if ((await readFile(nodeVersion.stdoutPath, 'utf8')).trim() !== 'v24.13.1')
      throw new RunnerFailure('CANVAS_VERIFY_NODE_VERSION_REQUIRED', 'The actual public CLI command environment must resolve Node24.13.1.');
    const version = await launchOwned({ file: 'pnpm', args: ['--version'], cwd: root, env: prepared.supply.commands.start.env, root, label: 'pnpm-version', redact });
    owned.push(version); await version.complete(settings.prepareMs);
    if ((await readFile(version.stdoutPath, 'utf8')).trim() !== '11.28.5')
      throw new RunnerFailure('CANVAS_VERIFY_PNPM_VERSION_REQUIRED', 'The actual public command environment must resolve pnpm11.28.5.');
    const officialSource = await retainOfficialSource(prepared, { timeoutMs: settings.prepareMs, owned, redact });
    result.phases.install = 'RUNNING';
    const canvasTgz = await packCanvas(prepared, settings, owned, redact);
    const observation = await prepareObservation({ prepared, root, tgz: canvasTgz, timeoutMs: settings.prepareMs,
      outputBytes: settings.managerOutputBytes, owned, redact });
    result.phases.install = 'PASS'; result.install = observation;
    const dump = await launchOwned({ ...prepared.supply.commands.dumpConfig, root, label: 'normal-web-dump-config', redact });
    owned.push(dump); await dump.complete(settings.prepareMs);
    result.phases.web = 'RUNNING';
    const command = normalStart(prepared.supply, settings);
    const host = await launchOwned({ ...command, root, label: 'normal-web-cli', redact, readyMatch: line => {
      for (const match of line.matchAll(/https?:\/\/127\.0\.0\.1:\d+[^\s"'<>]*/g)) {
        let candidate; try { candidate = new URL(match[0]); } catch { continue; }
        const token = candidate.searchParams.get('token');
        if (token) { redact.add(token); cleanLoopback(candidate.href, 'actual printed Web login URL'); return candidate.href; }
      }
      return null;
    } }); owned.push(host);
    const loginURL = await host.ready(settings.waitMs);
    addresses.add(cleanLoopback(loginURL, 'actual Web CLI').href);
    result.phases.web = 'PASS'; result.phases.authentication = 'RUNNING';
    browser = await startAuthenticatedBrowser({ root, env: command.env, owned, redact, loginURL,
      budget: settings.waitMs, executable: settings.chromium });
    addresses.add(browser.cdpUrl); result.authentication = browser.authentication;
    result.phases.authentication = 'PASS'; result.phases.counterpartSupply = 'RUNNING';
    const inspection = await browser.cdp.send('Runtime.evaluate', { expression: 'window.hanaworldsCanvasVerification.inspect()', awaitPromise: true, returnByValue: true });
    const actual = inspection.result?.value;
    const required = ['hanaworldsCanvasV5', 'hanaworldsCanvasRegionV1', 'hanaworldsWorkshopV3',
      'hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1', 'hanaworldsWorldFacts'];
    const missing = required.filter(key => actual?.providers?.[key]?.state !== 'ACTIVE');
    if (missing.length) throw new RunnerFailure('CANVAS_VERIFY_COUNTERPART_SUPPLY_MISSING', 'The actual normal Loader composite lacks required real public providers.', { missing });
    result.phases.counterpartSupply = 'PASS';
    const resources = { runRoot: root, dshHome: prepared.dshHome, profile: prepared.profile,
      installationAnchor: prepared.installationAnchor, browserUserData: browser.browserUserData,
      webUrl: browser.webUrl, cdpUrl: browser.cdpUrl, canvasTgz, officialSource };
    const locator = join(root, 'client-resources.json');
    await writeFile(locator, JSON.stringify(resources, null, 2)); result.resources = locator;
    result.phases.lockedClientTests = 'RUNNING';
    const testFiles = (await readdir(join(sourceRoot, 'test', 'client-verification')))
      .filter(file => file.endsWith('.test.mjs')).sort().map(file => `test/client-verification/${file}`);
    const tests = await launchOwned({ file: process.execPath, args: ['--test', ...testFiles], cwd: sourceRoot,
      env: { ...command.env, CANVAS_CLIENT_VERIFY_RESOURCES: locator, CANVAS_CLIENT_VERIFY_WAIT_MS: String(settings.waitMs) },
      root, label: 'locked-client-tests', redact });
    owned.push(tests); await tests.complete(); result.phases.lockedClientTests = 'PASS';
  } catch (error) {
    result.primaryFailure = publicFailure(error, redact);
    for (const key of Object.keys(result.phases)) if (result.phases[key] === 'RUNNING') result.phases[key] = 'FAIL';
  } finally {
    browser?.cdp.close();
    for (const process of owned) if (process.listener) addresses.add(process.listener);
    for (const process of [...owned].reverse()) {
      try { cleanup.push(await stopOwned(process, settings.stopMs)); }
      catch (error) { cleanupFailures.push(publicFailure(error, redact)); }
    }
    for (const address of addresses) {
      try { cleanup.push(await verifyPortReleased(address)); }
      catch (error) { cleanupFailures.push(publicFailure(error, redact)); }
    }
    result.processes = owned.map(process => process.receipt()); result.cleanup = cleanup;
    result.endedAt = new Date().toISOString();
    result.result = result.primaryFailure || cleanupFailures.length ? 'FAIL' : 'PASS';
    result.evidencePath = join(root, 'runner-result.json');
    await writeFile(result.evidencePath, JSON.stringify(result, null, 2));
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new RunnerFailure('CANVAS_VERIFY_NO_ARGUMENTS', 'Use node tools/client-verification/run.mjs with no arguments.');
  try {
    const result = await runVerification();
    console.log(JSON.stringify({ result: result.result, phases: result.phases, runRoot: result.runRoot,
      evidencePath: result.evidencePath, primaryFailure: result.primaryFailure, cleanupFailures: result.cleanupFailures }, null, 2));
    process.exitCode = result.result === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(publicFailure(error, redactor()))); process.exitCode = 1;
  }
}
