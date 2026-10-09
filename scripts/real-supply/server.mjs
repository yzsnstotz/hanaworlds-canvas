/*
 * Canvas real supply trial service (hanaworlds-canvas-SUPPLY-01).
 *
 * One own Cordis root with the official Loader: the Adapter's public package (native Host provider
 * + Loader entry) runs a real isolated Luanti World; Canvas is loaded as its real
 * `hanaworlds-canvas` Loader entry, so every Adapter mutation comes from Canvas's own fiber.
 * The only FIXTURE peer is the Session identity port (Workshop stand-in), labelled on the page.
 * The trial BUILD effects are typed on the page (not a Brush compilation); they are labelled.
 *
 * Inputs (own paths only; no accepted profile/World/Store is read or written):
 *   HW_CR_STATE     own state directory (profile/worlds, games, mods, home, logs, tmp)
 *   HW_CR_ASSEMBLY  directory whose node_modules holds the SDK, contracts, Adapter and Canvas
 *                   (run node_modules/hanaworlds-canvas/scripts/real-supply/server.mjs from there)
 *   HW_CR_LUANTI    absolute Luanti executable
 *   HW_CR_PORT      declared loopback port (47621)
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureSessions } from '../fixture-sessions.mjs';

const DECLARED_PORT = 47621;
const state = process.env.HW_CR_STATE, assembly = process.env.HW_CR_ASSEMBLY,
  luanti = process.env.HW_CR_LUANTI, port = Number(process.env.HW_CR_PORT ?? DECLARED_PORT);
if (!state || !assembly || !luanti) throw new Error('HW_CR_STATE, HW_CR_ASSEMBLY and HW_CR_LUANTI are required');
if (port !== DECLARED_PORT) throw new Error('DECLARED_PORT_REQUIRED');
// Run from the installed package inside the assembly: these bare imports resolve through the
// assembly's single node_modules (one contracts instance shared with the Adapter and Canvas).
const C = await import('hanaworlds-contracts');
const { Context } = await import('@deepseek-ai/cordis');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { createNativeHost } = await import('hanaworlds-adapter-luanti/host');
const { createInspectionContext } = await import('hanaworlds-adapter-luanti/inspection-context');

const profile = join(state, 'profile'), worlds = join(profile, 'worlds'), home = join(state, 'home');
for (const p of [worlds, home, join(profile, 'games'), join(profile, 'mods'), join(state, 'logs'), join(state, 'tmp')])
  await mkdir(p, { recursive: true, mode: 0o700 });
const event = (kind, facts = {}) => appendFileSync(join(state, 'events.jsonl'),
  JSON.stringify({ at: new Date().toISOString(), kind, ...facts }) + '\n', { mode: 0o600 });
const owned = createNativeHost({ C, state, profile, worlds, luanti, event });
const SESSION = 'canvas-real-trial-session';
const sessions = fixtureSessions();

const root = new Context();
// The Adapter registers a loopback status route through webServer; this own trial service
// answers its own routes only, so the registration is recorded and not served.
root.provide('webServer', { register(route) { event('WEBSERVER_ROUTE_NOT_SERVED', { route: String(route?.path ?? route) }); return () => {}; } });
root.provide('dshHomePath', (...parts) => join(home, ...parts));
root.provide('hanaworldsNativeEngineControl', owned.host);
root.provide('hanaworldsWorkshopV3', sessions);
root.provide('hanaworldsLuantiInspectionContext', createInspectionContext({
  resolveCanvas: () => root.get('hanaworldsCanvasV5'),
  resolveOracle: () => root.get('hanaworldsWorldRevisionOracle') }));
await root.plugin(Loader, { baseUrl: pathToFileURL(join(assembly, 'package.json')).href });
const canvasEntry = await root.loader.create({ id: 'hanaworlds-canvas', name: 'hanaworlds-canvas' });
const adapterEntry = await root.loader.create({ id: 'hanaworlds-luanti-adapter', name: 'hanaworlds-adapter-luanti',
  config: { localWorldRoots: [worlds] } });
await root.loader.await();
for (const id of [canvasEntry, adapterEntry])
  if (root.loader.resolve(id).fiber.state !== 2) throw new Error(`LOADER_ENTRY_NOT_ACTIVE:${id}`);
const canvas = root.get('hanaworldsCanvasV5');
await canvas.ready;
const supply = root.get('hanaworldsCanvasConfigSupply');
const compiler = root.get('hanaworldsCompilerConfig');
const local = root.get('hanaworldsLuantiLocalWorlds');
const requesterRef = 'canvas-real-trial';
const native = new Map();
const D = (kind, value) => C.digestValue(kind, value).sha256;
const sha = text => createHash('sha256').update(text).digest('hex');
let chain = Promise.resolve();
const serial = fn => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
const fail = (code, details = null) => { throw Object.assign(new Error(code), { details }); };
const W = 'canvas/v6';
async function call(operation, body) {
  const response = await canvas.call(operation, { contractVersion: W, requestId: randomUUID(), ...body });
  event('CANVAS_CALL', { operation, error: response.error, guardRefusal: response.guardRefusal ?? null,
    status: response.result?.status ?? null });
  if (response.error) fail(response.error.code, { error: response.error, guardRefusal: response.guardRefusal ?? null });
  return response.result;
}
const selection = async worldRef => (await call('ReadWorldSelectionContext',
  { sessionRef: SESSION, worldRef: worldRef ?? 'unbound-probe' })).selection;
async function bound() {
  const current = canvas.current(SESSION);
  if (!current) fail('WORLD_NOT_BOUND');
  return current;
}
/** Load (emerge) the box around `positions` through the public read-only NativeFacts readRegionState
 * (no write; may generate never-visited map), as a present player would. Returns per-chunk KNOWN state. */
async function loadArea(worldRef, positions) {
  const min = [0, 1, 2].map(a => Math.min(...positions.map(p => p[a])));
  const max = [0, 1, 2].map(a => Math.max(...positions.map(p => p[a])));
  const state = await root.get('hanaworldsLuantiNativeFacts').readRegionState(worldRef, { min, max });
  const chunks = state.chunks.map(c => ({ chunkPos: c.chunkPos, availability: c.availability, loadMethod: c.loadMethod }));
  event('AREA_LOADED', { worldRef, box: { min, max }, chunks });
  return { box: { min, max }, chunks };
}
async function worldRows() {
  const rows = await local.discover();
  return rows.map(row => ({ ...row, running: native.has(row.connectionRef) }));
}

const actions = {
  async create({ worldName }) {
    const row = await local.createFlatWorld({ requesterRef, userPath: profile, ...(worldName ? { worldName } : {}) });
    event('WORLD_CREATED', { worldRef: row.worldRef, connectionRef: row.connectionRef, worldPath: row.worldPath });
    return row;
  },
  async start({ connectionRef }) {
    if (native.has(connectionRef)) fail('ALREADY_RUNNING');
    const lease = await local.acquire({ requesterRef, userPath: profile, connectionRef, action: 'BIND_RUNNING_WORLD' });
    const q = { requesterRef, connectionRef, leaseRef: lease.leaseRef };
    const paired = await local.pair(q);
    native.set(connectionRef, { lease: q, nativeProcessId: lease.nativeProcessId });
    event('WORLD_PAIRED', { connectionRef, nativeProcessId: lease.nativeProcessId });
    return { paired, nativeProcessId: lease.nativeProcessId };
  },
  async stop({ connectionRef }) {
    const row = (await worldRows()).find(r => r.connectionRef === connectionRef) ?? fail('CONNECTION_NOT_FOUND');
    const result = await local.stopWorld({ requesterRef, connectionRef, worldRef: row.worldRef });
    native.delete(connectionRef);
    return result;
  },
  async select({ connectionRef }) {
    const rows = await worldRows();
    const row = rows.find(r => r.connectionRef === connectionRef) ?? fail('CONNECTION_NOT_FOUND');
    const connection = await canvas.call('ListWorldConnections', { contractVersion: W, requestId: randomUUID(),
      sessionRef: SESSION, worldRef: row.worldRef, expectedCapabilityRevision: null }).catch(() => null);
    void connection;
    const current = await selection(row.worldRef);
    const live = await root.get('hanaworldsWorldAdapterV6').call('ReadLocalConnection', {
      contractVersion: 'world-adapter/v7', requestId: randomUUID(), sessionRef: SESSION, connectionRef });
    if (live.error) fail(live.error.code, { error: live.error });
    const previous = canvas.current(SESSION);
    if (previous && previous.activeWorldRef !== row.worldRef) {
      return call('SwitchWorldConnection', { sessionRef: SESSION, worldRef: previous.activeWorldRef,
        fromWorldRef: previous.activeWorldRef, toWorldRef: row.worldRef, toConnectionRef: connectionRef,
        toConnectionIncarnationRef: live.result.connectionIncarnationRef,
        expectedRevision: previous.selectionRevision, expectedContext: previous.localContext });
    }
    return call('SelectWorldConnection', { sessionRef: SESSION, worldRef: row.worldRef, connectionRef,
      connectionIncarnationRef: live.result.connectionIncarnationRef,
      expectedRevision: current.status === 'BOUND' ? current.context.selectionRevision : current.sessionRevision,
      expectedContext: current.status === 'BOUND' ? current.context.localContext : null });
  },
  async build({ positions, nodeName }) {
    const session = await bound();
    const worldRef = session.activeWorldRef;
    const config = await compiler.read(worldRef);
    const report = await supply.read(worldRef);
    const catalogue = report.current.sources?.catalogue;
    if (catalogue?.status !== 'READ') fail('CATALOGUE_UNAVAILABLE', { catalogue });
    if (!Array.isArray(positions) || !positions.length) fail('SCHEMA_INVALID', { need: 'positions' });
    // FIXTURE-labelled trial write: effects typed on this page, not compiled by Brush. The
    // compiler revision and CompilationConfig digest are the real supply's.
    const loaded = await loadArea(worldRef, positions);
    const intent = { trial: 'canvas-real-supply', positions, nodeName };
    const operations = { contractVersion: 'operations/v3', buildDigest: sha(`canvas-trial|${JSON.stringify(intent)}`),
      compilerRevision: config.compilerRevision, compilationConfigDigest: D('compilation-config', config.compilationConfig),
      worldRef, frameDigest: sha('canvas-trial|frame|luanti-world-grid'), catalogueDigest: catalogue.digest,
      targetFactsDigest: sha(`canvas-trial|target|${JSON.stringify(positions)}`),
      effects: positions.map(position => ({ position, nodeName, param2: 0 })) };
    const operationDigest = D('operations', operations);
    const transactionId = `trial-${randomUUID()}`;
    const worldRevision = await canvas.readWorldRevision(worldRef);
    const listed = await call('ListObjects', { sessionRef: SESSION, worldRef, expectedRevision: null,
      localContext: session.localContext });
    const analysis = await call('AnalyzeAffectedObjects', { sessionRef: SESSION, worldRef, transactionId,
      operations, operationDigest, expectedRevision: worldRevision, expectedRegistryRevision: listed.registryRevision,
      expectedSelectionRevision: session.selectionRevision, localContext: session.localContext });
    const receipt = await call('ApplyRecoverableCommit', { sessionRef: SESSION, worldRef, transactionId, operations,
      operationDigest, analysisDigest: D('affected-analysis', analysis), decisionRevision: null,
      expectedWorldRevision: worldRevision, expectedObjectRevisions: {}, guarantee: 'RECOVERABLE_VERIFIED',
      regionInspectionBinding: null, localContext: session.localContext });
    lastBuild = { transactionId, operations, receipt };
    return { transactionId, operationDigest, receipt, compilerRevision: config.compilerRevision, loaded };
  },
  async readback({ transactionId }) {
    const session = await bound();
    const build = transactionId === lastBuild?.transactionId ? lastBuild : fail('TRANSACTION_NOT_FOUND');
    await loadArea(session.activeWorldRef, build.operations.effects.map(e => e.position));
    return call('Readback', { sessionRef: SESSION, worldRef: session.activeWorldRef, transactionId,
      commitRevision: build.receipt.observedWorldRevision, expectedOperations: build.operations,
      transactionPayloadDigest: build.receipt.transactionPayloadDigest, localContext: session.localContext });
  },
  async history({ objectRef, operation }) {
    const actionsView = await canvas.readHistoryActions(SESSION);
    const row = actionsView.objects.find(o => o.objectRef === objectRef) ?? fail('OBJECT_NOT_FOUND');
    const offer = operation === 'Redo' ? row.redo : row.undo;
    if (!offer.available) fail(offer.reason);
    const session = await bound();
    // No player keeps this area loaded in the trial World: load the object's cells first.
    await loadArea(session.activeWorldRef, row.cells);
    return call(operation, { sessionRef: SESSION, worldRef: session.activeWorldRef, objectRef,
      transactionId: `trial-${operation.toLowerCase()}-${randomUUID()}`, historyTransactionId: offer.historyTransactionId,
      expectedHistoryRevision: offer.expectedHistoryRevision, expectedWorldRevision: offer.expectedWorldRevision,
      expectedObjectRevisions: offer.expectedObjectRevisions,
      intentDigest: sha(`canvas-trial|${operation}|intent`), surfaceActionDigest: sha(`canvas-trial|${operation}|surface`),
      localContext: session.localContext });
  },
  async cells({ positions }) {
    const session = await bound();
    await loadArea(session.activeWorldRef, positions);
    const facts = await root.get('hanaworldsLuantiNativeFacts').readScopedState(session.localContext.connectionRef, positions);
    return facts;
  },
};
let lastBuild = null;

async function snapshot() {
  const rows = await worldRows();
  const current = canvas.current(SESSION);
  const worldRef = current?.activeWorldRef ?? null;
  return {
    service: { pid: process.pid, port, canvas: canvas.status(), adapter: root.get('hanaworldsWorldAdapterV6').protocolHandshake,
      contracts: C.contractHandshake.contracts, loaderEntries: [canvasEntry, adapterEntry] },
    labels: { fixture: 'Session 身份端口为公开合约 FIXTURE（Workshop 替身）；试用写入的 effects 由本页给出，不是 Brush 编译。',
      real: 'Luanti 世界、native 进程、Adapter、Canvas 供给/事务/历史均为本卡真实隔离运行。' },
    prerequisites: await local.describeFlatWorldCreation({ requesterRef, userPath: profile }),
    worlds: rows, session: SESSION, selection: current,
    supply: worldRef ? await supply.read(worldRef).catch(e => ({ error: e.publicError ?? { code: e.message }, missingSources: e.missingSources ?? null })) : null,
    compiler: worldRef ? await compiler.read(worldRef).then(v => ({ ok: true, ...v }), e => ({ ok: false, error: e.publicError ?? { code: e.message }, missingSources: e.missingSources ?? null })) : null,
    engineSafety: canvas.readEngineSafety(SESSION),
    history: current ? await canvas.readHistoryActions(SESSION) : null,
    lastBuild,
  };
}

const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { if (!req.headers['content-type']?.startsWith('application/json')) fail('SCHEMA_INVALID');
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 65536) fail('SCHEMA_INVALID'); } return text ? JSON.parse(text) : {}; }
const page = await readFile(new URL('./page.html', import.meta.url));
const routes = { '/api/create': q => actions.create(q), '/api/start': q => actions.start(q), '/api/stop': q => actions.stop(q),
  '/api/select': q => actions.select(q), '/api/build': q => actions.build(q), '/api/readback': q => actions.readback(q),
  '/api/undo': q => actions.history({ ...q, operation: 'Undo' }), '/api/redo': q => actions.history({ ...q, operation: 'Redo' }),
  '/api/cells': q => actions.cells(q) };
async function handle(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, await serial(snapshot));
    if (req.method === 'POST' && routes[path]) {
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))
        return json(res, 403, { error: 'ORIGIN_REJECTED' });
      const q = await body(req);
      const result = await serial(() => routes[path](q));
      event('PUBLIC_ACTION', { path, ok: true });
      return json(res, 200, { ok: true, result });
    }
    if (['GET', 'HEAD'].includes(req.method) && ['/', '/real'].includes(path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      return res.end(req.method === 'HEAD' ? undefined : page);
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const failure = { code: error.message, details: error.details ?? null, publicError: error.publicError ?? null,
      missingSources: error.missingSources ?? null };
    event('PUBLIC_ACTION_FAILED', { path, failure });
    return json(res, 409, { ok: false, error: failure });
  }
}
const server = createServer(handle);
await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
event('SERVICE_STARTED', { pid: process.pid, port, state, canvas: canvas.status(), contracts: C.contractHandshake.contracts });
console.log(`Canvas real supply trial http://127.0.0.1:${port}/real PID ${process.pid}`);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  server.close();
  for (const [connectionRef] of native) await actions.stop({ connectionRef }).catch(e => event('STOP_FAILED', { connectionRef, code: e.message }));
  await root.fiber.dispose(); await owned.shutdown();
  event('SERVICE_STOPPED', { pid: process.pid });
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
