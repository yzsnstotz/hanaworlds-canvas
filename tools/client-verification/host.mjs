// Test tooling loaded as its own ordinary Loader entry in the official installation.
// This module is deliberately outside Canvas's published files and client entry.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { Context, symbols } from '@deepseek-ai/cordis';
import { Loader, Entry } from '@deepseek-ai/cordis-plugin-loader';
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager';
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { verificationHostContribution } from './remote.mjs';
export { verificationDescriptors, verificationHostContribution,
  verificationClientContribution } from './remote.mjs';

const SERVICE = 'hanaworldsCanvasVerification';
// Public FiberState enum in Cordis src/fiber.ts: ACTIVE is the third variant.
const ACTIVE = 2;
const observationChannel = channel('hanaworlds-canvas/contract-call');
const require = createRequire(import.meta.url);
const original = value => value?.[symbols.original] ?? value;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const errorRecord = error => ({ name: error?.name ?? 'Error', code: error?.code ?? null,
  message: error?.message ?? String(error), data: json(error?.data ?? error?.publicError ?? null) });
const writeOperations = new Set(['ApplyCompiledTransaction', 'ApplyHistoryTransaction',
  'RestoreTransaction', 'WriteRegion']);

async function packedDigest(tgzPath, file) {
  return new Promise((complete, reject) => {
    const child = spawn('tar', ['-xOf', tgzPath, `package/${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    child.stdout.on('data', bytes => hash.update(bytes));
    // Drain diagnostics without imposing a hidden byte budget on package evidence.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? complete(hash.digest('hex')) :
      reject(new SupplyError('PACKAGE_TGZ_ARTIFACT_UNAVAILABLE', `The actual tgz cannot supply ${file}.`, { artifact: file, exitCode: code })));
  });
}

export class SupplyError extends RemoteError {
  constructor(code, message, details = {}) {
    super(`canvas-verification/${code}`, message, { code, ...details });
    this.name = 'SupplyError';
    this.code = code;
  }
}

function requirePath(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value)
    throw new SupplyError('OBSERVER_CONFIG_REQUIRED', `The installation must supply an absolute ${field}.`, { field });
  return value;
}

/** Observation uses registration identities and public services from this Loader context. */
export function createObserver(ctx, config) {
  if (!(ctx instanceof Context))
    throw new SupplyError('OFFICIAL_CONTEXT_REQUIRED', 'The observer must receive the official Loader Context.');
  const settings = {
    packageRoot: requirePath(config?.packageRoot, 'packageRoot'),
    tgzPath: requirePath(config?.tgzPath, 'tgzPath'),
    managerReceiptPath: requirePath(config?.managerReceiptPath, 'managerReceiptPath'),
  };
  const identities = new WeakMap();
  const identity = (object, kind) => {
    object = original(object);
    if (!object || (typeof object !== 'object' && typeof object !== 'function'))
      throw new SupplyError('IDENTITY_UNAVAILABLE', `No actual ${kind} object was observed.`);
    if (!identities.has(object)) identities.set(object, `${kind}:${randomUUID()}`);
    return identities.get(object);
  };
  const events = [], adapterCalls = [], worldWrites = [], publicCalls = [], remoteErrors = [];
  const eventOwners = new WeakMap();
  const confirmedPlacements = new Map();
  let capture = null;

  function registration(key, required = true) {
    const label = ctx[Context.isolate][key];
    const impl = label && ctx.reflect.store[label];
    if (!impl || impl.fiber.state !== ACTIVE || !ctx.get(key)) {
      if (!required) return null;
      throw new SupplyError('PROVIDER_UNAVAILABLE', `No ACTIVE ${key} service is registered.`, { service: key });
    }
    const fiber = impl.fiber;
    const runtime = fiber.runtime;
    if (impl.name !== key || fiber.ctx.root !== ctx.root || !runtime ||
        ctx.registry.get(runtime.callback) !== runtime || ![...runtime.fibers].includes(fiber) ||
        original(ctx.get(key)) !== original(impl.value))
      throw new SupplyError('PROVIDER_IDENTITY_INVALID', `${key} does not belong to this active Cordis registry.`, { service: key });
    fiber.assertActive();
    return impl;
  }

  function loaderRecord(fiber) {
    const loader = original(ctx.get('loader'));
    if (!(loader instanceof Loader) || loader.ctx.root !== ctx.root)
      throw new SupplyError('OFFICIAL_LOADER_REQUIRED', 'No official Loader instance owns this context.');
    const id = loader.locate(fiber);
    let entry;
    try { entry = id && loader.resolve(id); } catch {}
    if (!(entry instanceof Entry) || original(entry.loader) !== loader || !entry.fiber ||
        !entry.moduleNamespace || entry.disabled)
      throw new SupplyError('LOADER_ENTRY_UNAVAILABLE', 'The provider is not owned by a live official Loader entry.');
    let owner = fiber;
    while (owner !== entry.fiber) {
      const parent = owner.parent?.fiber;
      if (!parent || parent === owner)
        throw new SupplyError('LOADER_ANCESTRY_INVALID', 'The registration fiber is outside its Loader entry.');
      owner = parent;
    }
    const plugin = loader.unwrapExports(entry.moduleNamespace);
    if (entry.fiber.runtime?.callback !== ctx.registry.resolve(plugin) ||
        entry.fiber.state !== ACTIVE || original(entry.ctx[Entry.key]) !== original(entry))
      throw new SupplyError('LOADER_RUNTIME_INVALID', 'Loader module and runtime identities do not agree.');
    return { loader, entry };
  }

  function provider(key, options = {}) {
    const impl = registration(key, options.required !== false);
    if (!impl) return null;
    const { loader, entry } = loaderRecord(impl.fiber);
    return {
      service: key, registered: true, active: true, state: 'ACTIVE',
      rootRef: identity(impl.fiber.ctx.root, 'root'),
      instanceRef: identity(impl.value, 'instance'),
      fiberRef: identity(impl.fiber, 'fiber'),
      registrationRef: identity(impl, 'registration'),
      runtimeRef: identity(impl.fiber.runtime, 'runtime'),
      loaderRef: identity(loader, 'loader'), entryRef: identity(entry, 'entry'),
      entryId: entry.id, entryName: entry.options.name, fiberUid: impl.fiber.uid,
      loaderCreatedContext: true, origin: 'OFFICIAL_LOADER',
    };
  }

  function service(key, method) {
    registration(key);
    const value = ctx.get(key);
    if (method && typeof value?.[method] !== 'function')
      throw new SupplyError('PROVIDER_METHOD_UNAVAILABLE', `${key}.${method} is not supplied.`, { service: key, method });
    return value;
  }

  // Loader proof for the observer itself is checked on each inspection after apply is ACTIVE.
  // It is a sibling entry: there is no inject dependency on Canvas and no Canvas-owned hook.
  const disposeEvents = ctx.on('internal/dispatch', (_mode, event, args) => {
    if (!capture) return;
    const payload = args?.[0];
    if (payload?.contractVersion !== 'canvas/v7' || payload.event !== event) return;
    try {
      const observed = eventOwners.get(payload);
      if (!observed || observed.token !== capture ||
          registration(observed.key) !== observed.impl)
        throw new SupplyError('EVENT_OWNER_UNAVAILABLE', 'The actual Cordis event has no matching registered Canvas emitter.');
      eventOwners.delete(payload);
      events.push(json(payload));
    } catch (error) { capture.failure = error; }
  }, { global: true });
  const observePort = message => {
    if (!['result', 'failure', 'event', 'display-failure', 'observation-failure'].includes(message?.phase)) return;
    if (!capture && !(message.service === 'hanaworldsCanvasV5' && message.operation === 'ApplyRecoverableCommit' && message.phase === 'result')) return;
    try {
      const owners = ['hanaworldsCanvasV5', 'hanaworldsCanvasRegionV1', 'hanaworldsCanvasDisplay']
        .map(key => ({ key, impl: registration(key, false) })).filter(row => row.impl);
      const owner = owners.find(row => original(row.impl.value) === original(message.owner));
      if (!owner)
        throw new SupplyError('OBSERVATION_OWNER_INVALID',
          'A contract-call observation did not come from the registered Canvas instance.');
      if (message.phase === 'observation-failure') {
        if (capture) capture.failure = new SupplyError('OBSERVATION_COPY_FAILED', 'The actual invocation evidence could not be copied.', json(message.error));
        return;
      }
      if (message.service === 'hanaworldsCanvasV5' && message.operation === 'ApplyRecoverableCommit' &&
          message.request?.regionInspectionBinding?.build && message.response?.result?.status === 'VERIFIED') {
        loaderRecord(owner.impl.fiber);
        confirmedPlacements.set(message.request.transactionId, { request: json(message.request), response: json(message.response), provider: provider(owner.key) });
      }
      if (!capture) return;
      if (message.phase === 'display-failure') {
        if (owner.key !== 'hanaworldsCanvasDisplay') throw new SupplyError('DISPLAY_OWNER_INVALID', 'Display failure must belong to the actual Display service.');
        loaderRecord(owner.impl.fiber);
        remoteErrors.push({ operation: message.operation, code: message.error?.code,
          message: message.error?.message, details: json(message.error?.details) });
        return;
      }
      if (owner.key === 'hanaworldsCanvasDisplay') throw new SupplyError('OBSERVATION_OWNER_INVALID', 'Display may observe only its own actual failures.');
      if (message.phase === 'event') {
        const payload = message.event ?? message.payload;
        if (!payload || typeof payload !== 'object')
          throw new SupplyError('EVENT_PAYLOAD_UNAVAILABLE', 'The actual emitter supplied no event payload object.');
        eventOwners.set(payload, { ...owner, token: capture });
        return;
      }
      const row = { service: message.service, operation: message.operation, phase: message.phase,
        request: json(message.request), response: json(message.response),
        error: message.error ? errorRecord(message.error) : null,
        ownerRef: identity(owner.impl.value, 'instance') };
      if (message.service === 'hanaworldsCanvasV5') publicCalls.push(row);
      if (['hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1'].includes(message.service)) {
        adapterCalls.push(row);
        if (writeOperations.has(message.operation)) worldWrites.push(row);
      }
    } catch (error) { if (capture) capture.failure = error; else ctx.logger.error(error); }
  };
  observationChannel.subscribe(observePort);
  ctx.effect(() => () => { observationChannel.unsubscribe(observePort); disposeEvents(); });

  function begin(scope = {}) {
    if (capture) throw new SupplyError('OBSERVATION_BUSY', 'An actual invocation is already being observed.');
    registration('hanaworldsCanvasV5');
    const token = { id: randomUUID(), scope: json(scope), eventStart: events.length,
      adapterStart: adapterCalls.length, writeStart: worldWrites.length, publicStart: publicCalls.length, remoteErrorStart: remoteErrors.length, failure: null };
    capture = token;
    return token;
  }
  function finish(token = capture) {
    if (!capture || token !== capture)
      throw new SupplyError('OBSERVATION_TOKEN_INVALID', 'No matching invocation capture is active.');
    capture = null;
    if (token.failure) throw token.failure;
    return { scope: token.scope, events: json(events.slice(token.eventStart)),
      adapterCalls: json(adapterCalls.slice(token.adapterStart)),
      worldWrites: json(worldWrites.slice(token.writeStart)), publicCalls: json(publicCalls.slice(token.publicStart)), remoteErrors: json(remoteErrors.slice(token.remoteErrorStart)) };
  }

  async function readDurable() {
    const canvas = service('hanaworldsCanvasV5');
    await canvas.ready;
    if (canvas.storageState !== 'READY' || typeof canvas.store?.directory !== 'string')
      throw new SupplyError('CANVAS_DURABLE_UNAVAILABLE', 'Canvas has no ready durable store.',
        { storageState: canvas.storageState ?? null, storageFailure: json(canvas.storageFailure) });
    const directory = await realpath(canvas.store.directory);
    const file = join(directory, 'canvas-v7.json');
    try {
      const bytes = await readFile(file);
      return { exists: true, path: file, sha256: digest(bytes), bytes: bytes.length,
        state: JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, path: file, sha256: null, bytes: 0, state: null };
      throw new SupplyError('CANVAS_DURABLE_READ_FAILED', 'Canvas durable bytes could not be read.', errorRecord(error));
    }
  }

  async function supplyEvidence(managerBundle) {
    let receipt;
    try { receipt = JSON.parse(await readFile(settings.managerReceiptPath, 'utf8')); }
    catch (error) { throw new SupplyError('MANAGER_RECEIPT_UNAVAILABLE', 'The normal installation receipt is missing or unreadable.', errorRecord(error)); }
    if (receipt.format !== 'canvas-observer-install/v1' || receipt.packageName !== 'hanaworlds-canvas' ||
        receipt.tgzPath !== settings.tgzPath || receipt.packageRoot !== settings.packageRoot ||
        receipt.managerResult?.exitCode !== 0)
      throw new SupplyError('MANAGER_RECEIPT_INVALID', 'The receipt is not a successful normal Canvas installation.');
    requirePath(receipt.managerResult.logPath, 'managerResult.logPath');
    const installLog = await readFile(receipt.managerResult.logPath);
    const tgzBytes = await readFile(settings.tgzPath);
    const tgzSha256 = digest(tgzBytes);
    if (receipt.tgzSha256 !== tgzSha256)
      throw new SupplyError('TGZ_SHA_MISMATCH', 'The retained Canvas tgz differs from the manager installation receipt.');
    const manager = service('pluginManager', 'listBundles');
    if (!(original(manager) instanceof PluginManager))
      throw new SupplyError('OFFICIAL_MANAGER_REQUIRED', 'The registered manager is not the official PluginManager instance.');
    const managerProfile = original(manager).ctx.get('profile');
    if (!managerProfile || await realpath(managerProfile.dir) !== await realpath(receipt.profileDir) ||
        await realpath(managerProfile.installAnchor) !== await realpath(receipt.installAnchor))
      throw new SupplyError('MANAGER_PROFILE_MISMATCH', 'The actual manager is operating a different installation/profile.');
    if (!receipt.managerBundle) {
      if (!managerBundle?.installed || managerBundle.name !== receipt.packageName ||
          managerBundle.source !== `file:${settings.tgzPath}`)
        throw new SupplyError('MANAGER_INSTALL_BUNDLE_UNAVAILABLE', 'The actual manager has no matching installed Canvas tgz bundle.');
      const installedManifest = JSON.parse(await readFile(join(settings.packageRoot, 'package.json'), 'utf8'));
      if (installedManifest.name !== managerBundle.name || installedManifest.version !== managerBundle.version)
        throw new SupplyError('PACKAGE_IDENTITY_MISMATCH', 'Actual installed package and observed manager row disagree.');
      // The CLI records the real command result; only this live manager observation adds its row.
      receipt.managerBundle = json(managerBundle);
      const temporary = `${settings.managerReceiptPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, settings.managerReceiptPath);
    }
    if (!receipt.managerBundle.installed || receipt.managerBundle.name !== receipt.packageName ||
        receipt.managerBundle.source !== `file:${settings.tgzPath}`)
      throw new SupplyError('MANAGER_RECEIPT_INVALID', 'The retained manager row is not the installed Canvas tgz bundle.');
    if (!managerBundle?.installed)
      return { tgzSha256, tgzPath: settings.tgzPath, managerTgzSha256: receipt.tgzSha256,
        managerResult: json(receipt.managerResult), installLogSha256: digest(installLog),
        installBundle: json(receipt.managerBundle), artifacts: {} };
    if (managerBundle.version !== receipt.managerBundle.version ||
        managerBundle.source !== receipt.managerBundle.source)
      throw new SupplyError('MANAGER_BUNDLE_MISMATCH', 'The current manager bundle differs from the observed installation.');
    const packageRoot = await realpath(settings.packageRoot);
    if (!(await stat(packageRoot)).isDirectory())
      throw new SupplyError('PACKAGE_ROOT_UNAVAILABLE', 'The manager-installed Canvas package directory is missing.');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== receipt.packageName || manifest.version !== managerBundle.version)
      throw new SupplyError('PACKAGE_IDENTITY_MISMATCH', 'The installed package identity differs from the manager bundle.');
    const provenancePath = join(packageRoot, 'lib/build-source.json');
    const provenanceBytes = await readFile(provenancePath);
    if (digest(provenanceBytes) !== await packedDigest(settings.tgzPath, 'lib/build-source.json'))
      throw new SupplyError('PACKAGE_PROVENANCE_MISMATCH', 'Installed build-source is not from the actual manager tgz.');
    const provenance = JSON.parse(provenanceBytes);
    if (provenance.format !== 'canvas-build-source/v2' || provenance.supplier?.name !== manifest.name ||
        !provenance.artifacts || !Object.keys(provenance.artifacts).length)
      throw new SupplyError('PACKAGE_PROVENANCE_INVALID', 'Installed Canvas build provenance is missing.');
    const files = new Set(['package.json', manifest.dsh?.bundle?.patch, manifest.exports?.['./client'],
      ...Object.keys(provenance.artifacts)]);
    const collect = value => {
      if (typeof value === 'string' && value.startsWith('./')) files.add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(manifest.exports);
    // Include the implementation behind the entry, not just its re-export wrapper.
    files.add('./lib/src/local-v5.mjs'); files.add('./lib/src/world-facts-reader.mjs');
    files.add('./lib/src/region-v1.mjs'); files.add('./lib/src/display-host.mjs');
    const artifacts = {}, artifactEvidence = {};
    for (const declared of files) {
      if (typeof declared !== 'string')
        throw new SupplyError('PACKAGE_ARTIFACT_UNDECLARED', 'Canvas must declare its bundle patch and client artifact.');
      const path = resolve(packageRoot, declared);
      const name = relative(packageRoot, path);
      if (name.startsWith('..') || isAbsolute(name))
        throw new SupplyError('PACKAGE_ARTIFACT_OUTSIDE_ROOT', 'A package artifact points outside its installed root.');
      const bytes = await readFile(path);
      const sha256 = digest(bytes);
      if (sha256 !== await packedDigest(settings.tgzPath, name))
        throw new SupplyError('PACKAGE_BYTES_MISMATCH', `Installed ${name} differs from the exact manager tgz.`, { artifact: name });
      if (Object.hasOwn(provenance.artifacts, name)) {
        if (sha256 !== provenance.artifacts[name])
          throw new SupplyError('PACKAGE_BUILD_DRIFT', `Actual installed ${name} differs from its build provenance.`, { artifact: name });
        artifacts[name] = sha256;
      }
      artifactEvidence[name] = { path, exists: true, bytes: bytes.length, sha256, matchesTgz: true };
    }
    const canvas = registration('hanaworldsCanvasV5', false);
    if (canvas) {
      const { entry } = loaderRecord(canvas.fiber);
      const entryFile = manifest.exports?.['.']?.import;
      if (typeof entryFile !== 'string')
        throw new SupplyError('PACKAGE_ENTRY_UNAVAILABLE', 'The installed Canvas ESM entry is missing.');
      const namespace = await import(pathToFileURL(resolve(packageRoot, entryFile)).href);
      const loader = original(ctx.get('loader'));
      if (ctx.registry.resolve(loader.unwrapExports(namespace)) !== entry.fiber.runtime.callback)
        throw new SupplyError('PACKAGE_RUNTIME_MISMATCH', 'The live Loader Canvas runtime is not this installed package entry.');
    }
    return { packageRoot, tgzPath: settings.tgzPath, tgzSha256, managerTgzSha256: receipt.tgzSha256,
      managerReceiptPath: settings.managerReceiptPath, managerResult: json(receipt.managerResult),
      installLogSha256: digest(installLog),
      installBundle: json(receipt.managerBundle), artifacts, artifactEvidence };
  }

  async function clientSourceEvidence(supply, bundle) {
    const modules = service('clientModules', 'graph');
    const graph = modules.graph();
    const rows = graph.entries.filter(row => row.id === 'hanaworlds-canvas');
    if (!bundle?.installed) {
      if (rows.length) throw new SupplyError('CLIENT_MODULE_UNLOAD_INCOMPLETE', 'Canvas remains in the actual client graph after uninstall.');
      return null;
    }
    if (rows.length !== 1) throw new SupplyError('CLIENT_GRAPH_UNAVAILABLE', 'Exactly one actual Canvas client entry is required.');
    const row = rows[0];
    const path = await realpath(modules.clientPath(row.id));
    if (path !== await realpath(join(settings.packageRoot, 'lib/client.js')))
      throw new SupplyError('CLIENT_ARTIFACT_SOURCE_MISMATCH', 'ClientModules is serving a different Canvas artifact.');
    const baseline = modules.artifactBaseline(row.id);
    const current = await stat(path);
    if (!baseline || baseline.mtimeMs !== current.mtimeMs || baseline.ctimeMs !== current.ctimeMs || baseline.size !== current.size)
      throw new SupplyError('CLIENT_ARTIFACT_GENERATION_MISMATCH', 'The current client graph differs from its actual captured artifact generation.');
    const response = await modules.fetchBundle(new Request(new URL(row.url, 'http://127.0.0.1')));
    if (!response.ok) throw new SupplyError('CLIENT_BUNDLE_UNAVAILABLE', 'The actual carrier cannot serve the advertised client bundle.');
    const bytes = Buffer.from(await response.arrayBuffer());
    return { graphRef: graph.rev, graphRow: json(row), packageRoot: supply.packageRoot,
      artifactPath: path, artifactSHA256: supply.artifacts['lib/client.js'],
      bundleSHA256: digest(bytes), clientModulesProvider: provider('clientModules') };
  }

  async function inspect() {
    try {
      const { loader, entry } = loaderRecord(ctx.fiber);
      const loaderPackage = JSON.parse(await readFile(require.resolve('@deepseek-ai/cordis-plugin-loader/package.json'), 'utf8'));
      const managerPackage = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-plugin-manager/package.json'), 'utf8'));
      const manager = service('pluginManager', 'listBundles');
      const bundles = await manager.listBundles();
      const bundle = bundles.find(row => row.name === 'hanaworlds-canvas') ?? null;
      const supply = await supplyEvidence(bundle);
      const keys = ['hanaworldsCanvasV5', 'hanaworldsCanvasRegionV1', 'hanaworldsCanvasDisplay',
        'hanaworldsWorkshopV3', 'hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1', 'hanaworldsWorldFacts'];
      const providers = Object.fromEntries(keys.map(key => [key, provider(key, { required: false })]));
      return { observer: provider(SERVICE), packageRoot: supply.packageRoot ?? settings.packageRoot,
        loader: { packageName: loaderPackage.name, version: loaderPackage.version, rootRef: identity(loader.ctx.root, 'root'),
          loaderRef: identity(loader, 'loader'), observerEntryRef: identity(entry, 'entry'), tgzSHA256: supply.tgzSha256 },
        manager: { packageName: managerPackage.name, version: managerPackage.version, selectedBundle: bundle?.name ?? null,
          provider: provider('pluginManager'), tgzSHA256: supply.managerTgzSha256, bundle: json(bundle),
          installResult: supply.managerResult },
        host: { rootRef: identity(ctx.root, 'root') },
        tgzSha256: supply.tgzSha256, managerTgzSha256: supply.managerTgzSha256,
        managerBundle: json(bundle), bundle: json(bundle), installed: bundle?.installed ?? false,
        enabled: bundle?.enabled ?? false, artifacts: supply.artifacts,
        clientSource: await clientSourceEvidence(supply, bundle),
        supply, providers, events: json(events), adapterCalls: json(adapterCalls), worldWrites: json(worldWrites) };
    } catch (error) {
      if (error instanceof SupplyError) throw error;
      throw new SupplyError('SUPPLY_INSPECTION_FAILED', 'Actual Loader/manager/package inspection failed.', errorRecord(error));
    }
  }

  async function observeCall(serviceKey, operation, request, invoke) {
    service(serviceKey);
    if (typeof invoke !== 'function')
      throw new SupplyError('INVOCATION_REQUIRED', 'Observation requires the actual invocation callback.');
    const token = begin({ serviceKey, operation, request });
    let response, failure;
    try { response = await invoke(); } catch (error) { failure = error; }
    const observed = finish(token);
    if (failure) throw Object.assign(failure, { observation: observed });
    return { response, ...observed };
  }

  return { ctx, config: settings, service, getService: service, provider, registration,
    inspect, readDurable, begin, finish, observeCall, events, adapterCalls, worldWrites,
    confirmedPlacements, original };
}

export class CanvasVerificationService extends TypertRemoteService {
  constructor(ctx, observer, executor) {
    super(ctx, SERVICE);
    this.observer = observer;
    this.executor = executor;
    this.queue = Promise.resolve();
    for (const name of ['inspect', 'invoke'])
      Remote(this[name], { kind: 'method', name, private: false, static: false,
        addInitializer: initializer => initializer.call(this) });
  }
  inspect() { return this.observer.inspect(); }
  invoke(caseId, mode) {
    const run = this.queue.then(async () => {
      const invoke = typeof this.executor === 'function' ? this.executor : this.executor?.invoke;
      if (typeof invoke !== 'function')
        throw new SupplyError('EXECUTOR_UNAVAILABLE', 'The installed verification executor has no invoke entry.');
      return Reflect.apply(invoke, this.executor, [caseId, mode]);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Optional runner readiness read; it never creates or installs a provider. */
export async function readyComposite(observer) {
  const canvas = observer.service('hanaworldsCanvasV5');
  await canvas.ready;
  if (canvas.storageState !== 'READY')
    throw new SupplyError('CANVAS_DURABLE_UNAVAILABLE', 'The normal Canvas provider did not initialize storage.',
      { storageFailure: json(canvas.storageFailure) });
  for (const key of ['hanaworldsCanvasRegionV1', 'hanaworldsCanvasDisplay', 'hanaworldsWorkshopV3',
    'hanaworldsWorldAdapterV6', 'hanaworldsWorldAdapterRegionV1', 'hanaworldsWorldFacts'])
    observer.provider(key);
  return observer.inspect();
}

export const name = 'hanaworlds-canvas-verification-observer';
// Canvas is deliberately absent: uninstalling Canvas cannot dispose this observer.
export const inject = ['loader', 'typert'];
export async function apply(ctx, config) {
  const observer = createObserver(ctx, config);
  let createExecutor;
  try { ({ createExecutor } = await import('./executor.mjs')); }
  catch (error) { throw new SupplyError('EXECUTOR_MODULE_UNAVAILABLE', 'The own verification executor module is missing.', errorRecord(error)); }
  if (typeof createExecutor !== 'function')
    throw new SupplyError('EXECUTOR_FACTORY_UNAVAILABLE', 'Verification executor must export createExecutor(ctx, observer).');
  ctx.typert.register(verificationHostContribution);
  return new CanvasVerificationService(ctx, observer, await createExecutor(ctx, observer));
}
export default { name, inject, apply };
