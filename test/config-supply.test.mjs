import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractHandshake, digestValue, publicError, schemaBundle, validateType }
  from 'hanaworlds-contracts';
const { CanvasV5, CanvasStore, CanvasConfigSupply, assembleProfile, withoutPlayerGeometry,
  apply: applyCanvas } =
  await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
const { STAGE1_POLICY_DECLARATION, STAGE1_POLICY_REVISION } = await import(
  new URL('../src/stage1-policy.mjs', import.meta.url).href);
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';

// FIXTURE peer inputs only (contracts-shaped Adapter, NativeFacts Catalogue and Session port).
// Canvas's assembly, provenance, revision and invalidation are what is under test.
const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const fixtureCatalogue = (await (async () => JSON.parse(await readFile(new URL(
  import.meta.resolve('hanaworlds-contracts/fixtures/main')))).request.catalogue)());
const withWorldedit = revision => ({ ...fixtureCatalogue,
  modRevisions: { ...fixtureCatalogue.modRevisions, worldedit: revision } });

function fixtureWorld({ catalogue = withWorldedit('fixture-worldedit-1') } = {}) {
  const env = { incarnation: 'socket-open-1', catalogue, adapterCalls: [], catalogueReads: 0,
    duringRead: null };
  const connection = () => ({ connectionRef: 'local-connection',
    connectionIncarnationRef: env.incarnation, worldRef: 'local-world',
    payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
    capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef: 'local-world',
      engineBounds: { min: [0, 0, 0], max: [9, 9, 9] }, limits: [],
      recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
      sessionDeleteSupported: true, imageMediaTypes: [], model: null } });
  env.adapter = { protocolHandshake: g3CellHandshake(), async call(operation, request) {
    env.adapterCalls.push(operation);
    const answer = result => ({ contractVersion: 'world-adapter/v6', requestId: request.requestId,
      result, error: null });
    if (operation === 'DiscoverConnections') return answer({ capabilityRevision: 'cap-1',
      connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: 'local-connection',
        worldRef: 'local-world', displayName: 'FIXTURE world', capabilityRevision: 'cap-1',
        payloadVersion: 'local-world/v1', readiness: 'READY',
        connectionIncarnationRef: env.incarnation }] });
    if (operation === 'ReadLocalConnection') return answer(connection());
    throw new Error(`unexpected adapter operation ${operation}`);
  } };
  env.nativeFacts = { async readCatalogue(worldRef) {
    env.catalogueReads += 1;
    if (worldRef !== 'local-world') throw new Error('FIXTURE_WORLD_MISMATCH');
    await env.duringRead?.();
    return structuredClone(env.catalogue);
  } };
  return env;
}

async function boundCanvas(directory, world, sessionRef = 'session-1') {
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter,
    nativeFacts: world.nativeFacts, sessions: fixtureSessions() });
  await select(canvas, world, sessionRef);
  return canvas;
}
async function select(canvas, world, sessionRef) {
  const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
    sessionRef, requestId: `${sessionRef}-context-${world.incarnation}`, worldRef: 'local-world' });
  const selection = context.result.selection;
  const bound = selection.status === 'BOUND';
  const response = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v5',
    sessionRef, requestId: `${sessionRef}-select-${world.incarnation}`, worldRef: 'local-world',
    connectionRef: 'local-connection', connectionIncarnationRef: world.incarnation,
    expectedRevision: bound ? selection.context.selectionRevision : selection.sessionRevision,
    expectedContext: bound ? selection.context.localContext : null });
  assert.equal(response.error, null, JSON.stringify(response.error));
  return response.result;
}
const temp = () => mkdtemp(join(tmpdir(), 'canvas-config-supply-'));

test('unbound World: both consumer ports refuse WORLD_NOT_BOUND, no fact is read', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter,
      nativeFacts: world.nativeFacts, sessions: fixtureSessions() });
    const supply = new CanvasConfigSupply(canvas);
    const report = await supply.read('local-world');
    assert.equal(report.authority, 'hanaworlds-canvas');
    assert.equal(report.current.domain, null);
    assert.equal(report.current.profiles.safetyProfile.status, 'NOT_BOUND');
    for (const read of [() => supply.readSafetyProfile('local-world'),
      () => supply.readCompilerConfig('local-world')])
      await assert.rejects(read, error => publicError(error).code === 'WORLD_NOT_BOUND');
    assert.equal(world.catalogueReads, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bound World: every field names its source; sourceless fields are refused by name', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = await boundCanvas(directory, world);
    const supply = new CanvasConfigSupply(canvas);
    world.adapterCalls.length = 0;
    const report = await supply.read('local-world');
    const { current } = report;
    assert.deepEqual(current.domain, { worldRef: 'local-world', connectionRef: 'local-connection',
      connectionIncarnationRef: 'socket-open-1', payloadVersion: 'local-world/v1',
      capabilityRevision: 'cap-1' });
    assert.deepEqual(current.sessionRefs, ['session-1']);
    const safety = current.profiles.safetyProfile;
    const compile = current.profiles.compilationConfig;
    // Schema constants come from the installed Contracts schema, attributed to it.
    for (const [profile, type] of [[safety, 'SafetyProfile'], [compile, 'CompilationConfig']])
      for (const [field, row] of Object.entries(profile.fields))
        if (Object.hasOwn(schemaBundle.definitions[type].properties[field], 'const')) {
          assert.equal(row.status, 'SUPPLIED');
          assert.equal(row.provenance.kind, 'CONTRACT_SCHEMA');
          assert.equal(row.provenance.sourceRevision, contractHandshake.contracts);
        }
    assert.equal(safety.fields.connectivity.value, 6);
    // worldeditRevision is the bound World's loaded Catalogue fact, bound to that Catalogue.
    assert.deepEqual(compile.fields.worldeditRevision, { status: 'SUPPLIED',
      value: 'fixture-worldedit-1', provenance: { kind: 'ENGINE_FACT',
        ref: 'hanaworldsLuantiNativeFacts.readCatalogue(worldRef).modRevisions.worldedit',
        sourceRevision: digestValue('catalogue', world.catalogue).sha256 } });
    assert.deepEqual(safety.missing.map(row => [row.field, row.sourceKind, row.reason]), [
      ['avatarDimensions', 'ENGINE_FACT', 'REQUIRED_FACT_UNKNOWN'],
      ['requireEntranceConnectivity', 'DECLARED_POLICY', 'POLICY_UNAVAILABLE'],
      ['hazardPolicy', 'DECLARED_POLICY', 'POLICY_UNAVAILABLE'],
      ['optionalLightRule', 'DECLARED_POLICY', 'POLICY_UNAVAILABLE']]);
    // INV-POSE: the envelope stays in the engine; Canvas names that, it does not fill it.
    assert.equal(safety.missing[0].cause, 'INV-POSE-STAYS-IN-ENGINE');
    for (const row of safety.missing.slice(1)) {
      assert.equal(row.cause, 'VALUE_UNDETERMINED');
      assert.ok(row.impact.length > 0);
    }
    // The one value a current non-switchable project rule fixes, attributed to Canvas's record.
    const body = safety.fields.requireBodyClearance;
    assert.equal(body.status, 'SUPPLIED');
    assert.equal(body.value, true);
    assert.equal(body.provenance.kind, 'CANVAS_DECLARATION');
    assert.equal(body.provenance.sourceRevision, STAGE1_POLICY_REVISION);
    assert.equal(body.provenance.basis.id, 'INV-BODY-RECHECK-AT-PREPARE');
    assert.equal(current.declaration, STAGE1_POLICY_REVISION);
    assert.deepEqual(compile.missing.map(row => [row.field, row.sourceKind]),
      [['backendProfileId', 'UNDEFINED_IN_CONTRACT']]);
    for (const profile of [safety, compile]) {
      assert.equal(profile.status, 'SOURCE_MISSING');
      assert.equal(profile.value, null);
      assert.equal(profile.revision, null);
    }
    // A consumer mapping through Contracts publicError() (Workshop) keeps the exact refusal.
    await assert.rejects(supply.readSafetyProfile('local-world'), error =>
      publicError(error).code === 'CAPABILITY_UNAVAILABLE' &&
      publicError(error).reason === 'POLICY_UNAVAILABLE' && publicError(error).phase === 'validate' &&
      error.publicError.code === 'CAPABILITY_UNAVAILABLE' &&
      error.publicError.reason === 'POLICY_UNAVAILABLE' && error.missingSources.length === 4);
    await assert.rejects(supply.readCompilerConfig('local-world'), error =>
      error.publicError.code === 'CAPABILITY_UNAVAILABLE' &&
      error.publicError.reason === 'REQUIRED_FACT_UNKNOWN' &&
      error.missingSources[0].field === 'backendProfileId');
    // Read-only: no Adapter call, no World mutation.
    assert.deepEqual(world.adapterCalls, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('World Catalogue without worldedit: worldeditRevision is refused, not filled', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld({ catalogue: fixtureCatalogue });
    const supply = new CanvasConfigSupply(await boundCanvas(directory, world));
    const row = (await supply.read('local-world')).current.profiles.compilationConfig
      .fields.worldeditRevision;
    assert.equal(row.status, 'MISSING');
    assert.equal(row.cause, 'MOD_NOT_LOADED');
    world.nativeFacts = null;
    const absent = new CanvasConfigSupply(new CanvasV5({ store: await CanvasStore.open(directory),
      adapter: world.adapter, sessions: fixtureSessions() }));
    const report = await absent.read('local-world');
    assert.equal(report.current.sources.catalogue.cause, 'NATIVE_FACTS_CATALOGUE_PORT_ABSENT');
    assert.equal(report.current.profiles.compilationConfig.fields.worldeditRevision.status, 'MISSING');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changes and invalidation are recorded durably and read back after restart', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = await boundCanvas(directory, world);
    const supply = new CanvasConfigSupply(canvas);
    const first = await supply.read('local-world');
    const again = await supply.read('local-world');
    // Same sources: same observation, nothing new recorded.
    assert.equal(again.current.observationDigest, first.current.observationDigest);
    assert.equal(again.history.length, 0);
    world.catalogue = withWorldedit('fixture-worldedit-2');
    const changed = await supply.read('local-world');
    assert.notEqual(changed.current.observationDigest, first.current.observationDigest);
    assert.equal(changed.current.profiles.compilationConfig.fields.worldeditRevision.value,
      'fixture-worldedit-2');
    assert.deepEqual(changed.history.at(-1).invalidationReasons, ['SOURCE_REVISION_CHANGED',
      'COMPILATIONCONFIG_CHANGED']);
    assert.equal(changed.history.at(-1).supersededBy, changed.current.observationDigest);
    // A new connection incarnation is a new domain.
    world.incarnation = 'socket-open-2';
    await select(canvas, world, 'session-1');
    const rebound = await supply.read('local-world');
    assert.equal(rebound.current.domain.connectionIncarnationRef, 'socket-open-2');
    assert.ok(rebound.history.at(-1).invalidationReasons.includes('CONNECTION_DOMAIN_CHANGED'));
    // Unbinding invalidates the supply for the World.
    const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v5',
      sessionRef: 'session-1', requestId: 'context-unbind', worldRef: 'local-world' });
    const unbound = await canvas.call('UnselectWorldConnection', { contractVersion: 'canvas/v5',
      sessionRef: 'session-1', requestId: 'unbind-1', worldRef: 'local-world',
      expectedRevision: context.result.selection.context.selectionRevision,
      expectedContext: context.result.selection.context.localContext });
    assert.equal(unbound.error, null, JSON.stringify(unbound.error));
    const after = await supply.read('local-world');
    assert.equal(after.current.domain, null);
    assert.deepEqual(after.history.at(-1).invalidationReasons.slice(0, 1), ['WORLD_UNBOUND']);
    // Durable: a restarted Canvas reads the same record and history.
    const reopened = new CanvasConfigSupply(new CanvasV5({ store: await CanvasStore.open(directory),
      adapter: world.adapter, nativeFacts: world.nativeFacts, sessions: fixtureSessions() }));
    const readback = await reopened.read('local-world');
    assert.equal(readback.current.observationDigest, after.current.observationDigest);
    assert.equal(readback.history.length, after.history.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a connection change during the fact read is refused as stale', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = await boundCanvas(directory, world);
    world.duringRead = async () => {
      world.duringRead = null;
      world.incarnation = 'socket-open-2';
      await select(canvas, world, 'session-1');
    };
    await assert.rejects(new CanvasConfigSupply(canvas).read('local-world'),
      error => error.publicError.code === 'STALE_REVISION');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('assembly: a complete profile validates and its revision follows value and domain', () => {
  // FIXTURE resolved rows exercise the pure assembly only; production has no such source.
  const fields = Object.fromEntries(schemaBundle.definitions.CompilationConfig.required.map(field => {
    const schema = schemaBundle.definitions.CompilationConfig.properties[field];
    return [field, { status: 'SUPPLIED', value: Object.hasOwn(schema, 'const') ? schema.const :
      `FIXTURE-${field}`, provenance: { kind: 'FIXTURE', ref: field, sourceRevision: 'f-1' } }];
  }));
  const domain = { worldRef: 'w', connectionRef: 'c', connectionIncarnationRef: 'i',
    payloadVersion: 'p', capabilityRevision: 'r' };
  const a = assembleProfile('compilationConfig', fields, domain);
  assert.equal(a.status, 'SUPPLIED');
  assert.doesNotThrow(() => validateType('CompilationConfig', a.value));
  assert.equal(a.digest, digestValue('compilation-config', a.value).sha256);
  assert.match(a.revision, /^compiler-config-[0-9a-f]{32}$/);
  assert.equal(assembleProfile('compilationConfig', fields, domain).revision, a.revision);
  assert.notEqual(assembleProfile('compilationConfig', fields,
    { ...domain, connectionIncarnationRef: 'i2' }).revision, a.revision);
  assert.notEqual(assembleProfile('compilationConfig', { ...fields, worldeditRevision:
    { ...fields.worldeditRevision, value: 'FIXTURE-other' } }, domain).revision, a.revision);
});

test('host keys: Workshop consumer shapes plus Canvas own provenance readback', async () => {
  const profile = await temp();
  try {
    const ports = new Map();
    const homePath = (...parts) => join(profile, ...parts);
    const world = fixtureWorld();
    const ctx = { get: name => name === 'dshHomePath' ? homePath :
      name === 'hanaworldsWorldAdapterV6' ? world.adapter :
      name === 'hanaworldsLuantiNativeFacts' ? world.nativeFacts :
      name === 'hanaworldsWorkshopV3' ? fixtureSessions() : ports.get(name) ?? null,
    provide: (name, port) => ports.set(name, port) };
    const canvas = applyCanvas(ctx);
    await canvas.ready;
    for (const key of ['hanaworldsSafetyProfile', 'hanaworldsCompilerConfig',
      'hanaworldsCanvasConfigSupply'])
      assert.equal(typeof ports.get(key)?.read, 'function', key);
    await select(canvas, world, 'session-1');
    const report = await ports.get('hanaworldsCanvasConfigSupply').read('local-world');
    assert.equal(report.current.profiles.compilationConfig.fields.worldeditRevision.value,
      'fixture-worldedit-1');
    await assert.rejects(ports.get('hanaworldsSafetyProfile').read('local-world'),
      error => error.publicError.code === 'CAPABILITY_UNAVAILABLE');
    await assert.rejects(ports.get('hanaworldsCompilerConfig').read('local-world'),
      error => error.publicError.code === 'CAPABILITY_UNAVAILABLE');
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('Stage 1 policy declaration: Canvas-only, cited or UNDETERMINED, never a default', () => {
  const record = STAGE1_POLICY_DECLARATION;
  assert.equal(record.declarer, 'hanaworlds-canvas');
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.fields.requireBodyClearance));
  assert.deepEqual(Object.keys(record.fields).sort(), ['hazardPolicy', 'optionalLightRule',
    'requireBodyClearance', 'requireEntranceConnectivity']);
  for (const [field, row] of Object.entries(record.fields)) {
    if (row.status === 'DECLARED') {
      assert.equal(row.basis.kind, 'PROJECT_RULE', field);
      assert.match(row.basis.sha256, /^[0-9a-f]{64}$/);
      assert.match(row.basis.sourceRevision, /^hanaworlds-docs@[0-9a-f]{40}$/);
      assert.equal(row.basis.switchable, false);
    } else {
      assert.equal(row.status, 'UNDETERMINED', field);
      assert.equal(Object.hasOwn(row, 'value'), false, field);
      assert.ok(row.checked.length && row.impact, field);
    }
  }
  assert.match(STAGE1_POLICY_REVISION, /^stage1-policy-[0-9a-f]{32}$/);
});

test('INV-POSE: Canvas never persists player geometry, even when a source supplies it', async () => {
  // FIXTURE observation: a supplied envelope exercises the durable-form guard only.
  const domain = { worldRef: 'w', connectionRef: 'c', connectionIncarnationRef: 'i',
    payloadVersion: 'p', capabilityRevision: 'r' };
  const envelope = { width: 0.6, height: 1.77, depth: 0.6, unit: 'node' };
  const fields = Object.fromEntries(schemaBundle.definitions.SafetyProfile.required.map(field => {
    const schema = schemaBundle.definitions.SafetyProfile.properties[field];
    const value = Object.hasOwn(schema, 'const') ? schema.const : field === 'avatarDimensions' ?
      envelope : field === 'hazardPolicy' ? { forbidLiquid: true, maximumDamagePerSecond: 0 } :
      field === 'optionalLightRule' ? null : true;
    return [field, { status: 'SUPPLIED', value, provenance: { kind: 'FIXTURE', ref: field,
      sourceRevision: 'f-1' } }];
  }));
  const safetyProfile = assembleProfile('safetyProfile', fields, domain);
  assert.equal(safetyProfile.status, 'SUPPLIED');
  const observation = { contracts: 'c', declaration: 'd', domain, sessionRefs: [], sources: null,
    profiles: { safetyProfile, compilationConfig: { type: 'CompilationConfig', status: 'SOURCE_MISSING',
      value: null, digest: null, revision: null, fields: {}, missing: [] } } };
  const stored = withoutPlayerGeometry(observation);
  const text = JSON.stringify(stored);
  for (const number of ['0.6', '1.77']) assert.equal(text.includes(number), false, number);
  assert.equal(text.includes(safetyProfile.digest), false);
  assert.equal(text.includes(safetyProfile.revision), false);
  assert.equal(stored.profiles.safetyProfile.fields.avatarDimensions.redacted, 'INV-POSE-STAYS-IN-ENGINE');
  assert.equal(stored.profiles.safetyProfile.fields.avatarDimensions.provenance.sourceRevision, 'f-1');
  // The caller's own observation is untouched (the live read still returns the profile).
  assert.deepEqual({ ...observation.profiles.safetyProfile.value.avatarDimensions }, envelope);
});
