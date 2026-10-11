import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractHandshake, digestValue, publicError, schemaBundle, validateType }
  from 'hanaworlds-contracts';
const { CanvasV5, CanvasStore, CanvasConfigSupply, assembleProfile, STORE_ROOT,
  apply: applyCanvas } =
  await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);
import { g3CellHandshake } from './support/g3-adapter-handshake.mjs';
import { fixtureSessions } from '../scripts/fixture-sessions.mjs';
import { guardSlot } from '../scripts/fixture-engine-guards.mjs';

// FIXTURE peer inputs only (contracts-shaped Adapter, a C-world-facts world-facts/v1 source and a
// Session port). Canvas's assembly, provenance, revision and invalidation are what is under test.
const stateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };
const factsFixture = JSON.parse(await readFile(new URL(import.meta.resolve(
  'hanaworlds-contracts/fixtures/world-source-facts'))));
const exchange = (operation, test) => factsFixture.exchanges.find(e =>
  e.operation === operation && e.response.result !== null && test(e.response.result)).response.result;
const catalogueFacts = exchange('ReadCatalogue', () => true);
const fixtureCatalogue = catalogueFacts.catalogue;
// The source's two declared write profiles: a KNOWN backend with its config, and nothing declared.
const knownProfile = exchange('ReadWriteProfile', r => r.writeBackend.availability === 'KNOWN');
const undeclaredProfile = exchange('ReadWriteProfile', r => r.writeBackend.availability !== 'KNOWN');
const withEngineRevision = revision => ({ ...fixtureCatalogue,
  engineRevisions: { ...fixtureCatalogue.engineRevisions, fixtureEngine: revision } });
const factsHandshake = () => ({ profileVersion: 'protocol-handshake/v1', component: 'fixture-world-source',
  protocols: [{ protocol: 'world-facts', major: 1, minor: 0 }], capabilities: [],
  provenance: { packageName: 'fixture-world-source', packageVersion: '1.0.0', sourceRevision: null,
    artifactDigest: null } });

function fixtureWorld({ catalogue = withEngineRevision('fixture-engine-1'),
  profile = undeclaredProfile } = {}) {
  const env = { incarnation: 'socket-open-1', catalogue, profile, adapterCalls: [], factCalls: [],
    catalogueReads: 0, duringRead: null };
  const current = () => ({ worldRef: 'local-world', connectionRef: 'local-connection',
    connectionIncarnationRef: env.incarnation });
  // A source answer bound to the current connection and Catalogue (the source signs its own reads).
  env.readCatalogue = () => ({ ...structuredClone(catalogueFacts), connection: current(),
    catalogue: structuredClone(env.catalogue),
    catalogueDigest: digestValue('catalogue', env.catalogue).sha256 });
  env.readWriteProfile = () => ({ ...structuredClone(env.profile), connection: current(),
    catalogueDigest: digestValue('catalogue', env.catalogue).sha256 });
  const connection = () => ({ connectionRef: 'local-connection',
    connectionIncarnationRef: env.incarnation, worldRef: 'local-world',
    payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
    capabilities: { providerRef: 'adapter', capabilityRevision: 'cap-1', worldRef: 'local-world',
      engineBounds: { min: [0, 0, 0], max: [9, 9, 9] }, limits: [],
      worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' }, recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile,
      sessionDeleteSupported: true, imageMediaTypes: [], model: null, engineGuards: null } });
  env.adapter = { protocolHandshake: g3CellHandshake(), async call(operation, request) {
    env.adapterCalls.push(operation);
    const answer = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId: request.requestId,
      result, error: null });
    if (operation === 'DiscoverConnections') return answer({ capabilityRevision: 'cap-1',
      connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: 'local-connection',
        worldRef: 'local-world', displayName: 'FIXTURE world', capabilityRevision: 'cap-1',
        payloadVersion: 'local-world/v1', readiness: 'READY',
        connectionIncarnationRef: env.incarnation }] });
    if (operation === 'ReadLocalConnection') return answer(connection());
    throw new Error(`unexpected adapter operation ${operation}`);
  } };
  env.worldFacts = { protocolHandshake: factsHandshake(), async call(operation, request) {
    env.factCalls.push(operation);
    const answer = (result, error = null) => ({ contractVersion: 'world-facts/v1',
      requestId: request.requestId, result, error });
    if (request.worldRef !== 'local-world') return answer(null, { code: 'WORLD_NOT_BOUND',
      phase: 'validate', retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
      transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' });
    if (operation === 'ReadCatalogue') {
      env.catalogueReads += 1;
      await env.duringRead?.();
      return answer(env.readCatalogue());
    }
    if (operation === 'ReadWriteProfile') return answer(await env.readWriteProfile());
    throw new Error(`unexpected world-facts operation ${operation}`);
  } };
  return env;
}

async function boundCanvas(directory, world, sessionRef = 'session-1') {
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter,
    worldFacts: world.worldFacts, sessions: fixtureSessions() });
  await select(canvas, world, sessionRef);
  return canvas;
}
async function select(canvas, world, sessionRef) {
  const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
    sessionRef, requestId: `${sessionRef}-context-${world.incarnation}`, worldRef: 'local-world' });
  const selection = context.result.selection;
  const bound = selection.status === 'BOUND';
  const response = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
    sessionRef, requestId: `${sessionRef}-select-${world.incarnation}`, worldRef: 'local-world',
    connectionRef: 'local-connection', connectionIncarnationRef: world.incarnation,
    expectedRevision: bound ? selection.context.selectionRevision : selection.sessionRevision,
    expectedContext: bound ? selection.context.localContext : null });
  assert.equal(response.error, null, JSON.stringify(response.error));
  return response.result;
}
const temp = () => mkdtemp(join(tmpdir(), 'canvas-config-supply-'));

test('unbound World: the CompilerConfig port refuses WORLD_NOT_BOUND, no fact is read', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = new CanvasV5({ store: await CanvasStore.open(directory), adapter: world.adapter,
      worldFacts: world.worldFacts, sessions: fixtureSessions() });
    const supply = new CanvasConfigSupply(canvas);
    const report = await supply.read('local-world');
    assert.equal(report.authority, 'hanaworlds-canvas');
    assert.equal(report.current.domain, null);
    assert.deepEqual(Object.keys(report.current.profiles), ['compilationConfig']);
    assert.equal(report.current.profiles.compilationConfig.status, 'NOT_BOUND');
    await assert.rejects(supply.readCompilerConfig('local-world'),
      error => publicError(error).code === 'WORLD_NOT_BOUND');
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
    // v1: Canvas supplies only CompilationConfig; it declares no Safety value.
    assert.deepEqual(Object.keys(current.profiles), ['compilationConfig']);
    assert.equal(Object.hasOwn(current, 'declaration'), false);
    const compile = current.profiles.compilationConfig;
    // Schema constants come from the installed Contracts schema, attributed to it.
    for (const [field, row] of Object.entries(compile.fields))
      if (Object.hasOwn(schemaBundle.definitions.CompilationConfig.properties[field], 'const')) {
        assert.equal(row.status, 'SUPPLIED');
        assert.equal(row.provenance.kind, 'CONTRACT_SCHEMA');
        assert.equal(row.provenance.sourceRevision, contractHandshake.contracts);
      }
    // The opaque backend is the world source's declaration; this source declares none.
    assert.deepEqual(compile.missing.map(row => [row.field, row.sourceKind, row.cause]),
      [['writeBackend', 'WORLD_SOURCE_FACT', 'NOT_DECLARED_BY_PAYLOAD']]);
    assert.match(compile.missing[0].need, /C-world-facts ReadWriteProfile/);
    assert.equal(compile.status, 'SOURCE_MISSING');
    assert.equal(compile.value, null);
    assert.equal(compile.revision, null);
    // A consumer mapping through Contracts publicError() (Workshop) keeps the exact refusal.
    await assert.rejects(supply.readCompilerConfig('local-world'), error =>
      publicError(error).code === 'CAPABILITY_UNAVAILABLE' && publicError(error).phase === 'validate' &&
      error.publicError.code === 'CAPABILITY_UNAVAILABLE' &&
      error.publicError.reason === 'REQUIRED_FACT_UNKNOWN' &&
      error.missingSources[0].field === 'writeBackend');
    // Read-only: no Adapter call, no World mutation; only the two C-world-facts reads.
    assert.deepEqual(world.adapterCalls, []);
    assert.deepEqual([...new Set(world.factCalls)], ['ReadCatalogue', 'ReadWriteProfile']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Catalogue alone never invents a write backend', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld({ catalogue: fixtureCatalogue });
    const canvas = await boundCanvas(directory, world);
    const report = await new CanvasConfigSupply(canvas).read('local-world');
    assert.equal(report.current.profiles.compilationConfig.fields.writeBackend.cause,
      'NOT_DECLARED_BY_PAYLOAD');
    canvas.worldFacts = null;
    const absent = await new CanvasConfigSupply(canvas).read('local-world');
    assert.equal(absent.current.sources.catalogue.cause, 'WORLD_FACTS_PORT_ABSENT');
    assert.equal(absent.current.sources.writeProfile.cause, 'CATALOGUE_UNRESOLVED');
    assert.equal(absent.current.profiles.compilationConfig.fields.writeBackend.status, 'MISSING');
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
    world.catalogue = withEngineRevision('fixture-engine-2');
    const changed = await supply.read('local-world');
    assert.notEqual(changed.current.observationDigest, first.current.observationDigest);
    assert.equal(changed.current.sources.catalogue.digest, digestValue('catalogue', world.catalogue).sha256);
    assert.deepEqual(changed.history.at(-1).invalidationReasons, ['SOURCE_REVISION_CHANGED']);
    assert.equal(changed.history.at(-1).supersededBy, changed.current.observationDigest);
    // A new connection incarnation is a new domain.
    world.incarnation = 'socket-open-2';
    await select(canvas, world, 'session-1');
    const rebound = await supply.read('local-world');
    assert.equal(rebound.current.domain.connectionIncarnationRef, 'socket-open-2');
    assert.ok(rebound.history.at(-1).invalidationReasons.includes('CONNECTION_DOMAIN_CHANGED'));
    // Unbinding invalidates the supply for the World.
    const context = await canvas.call('ReadWorldSelectionContext', { contractVersion: 'canvas/v7',
      sessionRef: 'session-1', requestId: 'context-unbind', worldRef: 'local-world' });
    const unbound = await canvas.call('UnselectWorldConnection', { contractVersion: 'canvas/v7',
      sessionRef: 'session-1', requestId: 'unbind-1', worldRef: 'local-world',
      expectedRevision: context.result.selection.context.selectionRevision,
      expectedContext: context.result.selection.context.localContext });
    assert.equal(unbound.error, null, JSON.stringify(unbound.error));
    const after = await supply.read('local-world');
    assert.equal(after.current.domain, null);
    assert.deepEqual(after.history.at(-1).invalidationReasons.slice(0, 1), ['WORLD_UNBOUND']);
    // Durable: a restarted Canvas reads the same record and history.
    const reopened = new CanvasConfigSupply(new CanvasV5({ store: await CanvasStore.open(directory),
      adapter: world.adapter, worldFacts: world.worldFacts, sessions: fixtureSessions() }));
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
      structuredClone(knownProfile.compilationConfig[field]), provenance: { kind: 'FIXTURE', ref: field, sourceRevision: 'f-1' } }];
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
  assert.notEqual(assembleProfile('compilationConfig', { ...fields, writeBackend:
    { ...fields.writeBackend, value: { profileId: 'FIXTURE-other', revision: 'r2' } } }, domain).revision, a.revision);
});

test('host keys: Workshop consumer shapes plus Canvas own provenance readback', async () => {
  const profile = await temp();
  try {
    const ports = new Map();
    const homePath = (...parts) => join(profile, ...parts);
    const world = fixtureWorld();
    const ctx = { get: name => name === 'dshHomePath' ? homePath :
      name === 'hanaworldsWorldAdapterV6' ? world.adapter :
      name === 'hanaworldsWorldFacts' ? world.worldFacts :
      name === 'hanaworldsWorkshopV3' ? fixtureSessions() : ports.get(name) ?? null,
    provide: (name, port) => ports.set(name, port) };
    const canvas = applyCanvas(ctx);
    await canvas.ready;
    for (const key of ['hanaworldsCompilerConfig', 'hanaworldsCanvasConfigSupply'])
      assert.equal(typeof ports.get(key)?.read, 'function', key);
    // v1: Canvas provides no second SafetyProfile service.
    assert.equal(ports.has('hanaworldsSafetyProfile'), false);
    await select(canvas, world, 'session-1');
    const report = await ports.get('hanaworldsCanvasConfigSupply').read('local-world');
    assert.equal(report.current.profiles.compilationConfig.fields.writeBackend.status, 'MISSING');
    await assert.rejects(ports.get('hanaworldsCompilerConfig').read('local-world'),
      error => error.publicError.code === 'CAPABILITY_UNAVAILABLE');
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('v1: no Safety declaration or player geometry in the supply or its durable record', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = await boundCanvas(directory, world);
    const supply = new CanvasConfigSupply(canvas);
    assert.equal(supply.readSafetyProfile, undefined);
    await supply.read('local-world');
    world.catalogue = withEngineRevision('fixture-engine-2');
    await supply.read('local-world');
    const stored = await readFile(join(directory, 'canvas-v7.json'), 'utf8');
    for (const word of ['SafetyProfile', 'safetyProfile', 'avatarDimensions',
      'requireBodyClearance', 'requireEntranceConnectivity', 'hazardPolicy', 'optionalLightRule',
      'stage1-policy', '"declaration"', 'bodyOccupiedPositions'])
      assert.equal(stored.includes(word), false, word);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('v1 store: a new root; a 0.x store is never read, migrated or accepted', async () => {
  const directory = await temp();
  try {
    assert.equal(STORE_ROOT, 'hanaworlds-canvas-v2');
    const { writeFile } = await import('node:fs/promises');
    // A 0.x file left in the directory is ignored; a 0.x schema in the 1.x file is refused.
    await writeFile(join(directory, 'canvas-v5.json'), JSON.stringify({ schemaVersion: 5,
      placementInspections: { old: { inspection: { bodyOccupiedPositions: [[0, 0, 0]] } } } }));
    const fresh = await CanvasStore.open(directory);
    assert.equal(fresh.snapshot.schemaVersion, 7);
    assert.deepEqual(fresh.snapshot.placementInspections, {});
    await writeFile(join(directory, 'canvas-v7.json'), JSON.stringify({ schemaVersion: 5 }));
    await assert.rejects(CanvasStore.open(directory), /CANVAS_STORAGE_VERSION_UNSUPPORTED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Public C-world-facts fixture inputs only; no Adapter implementation or live engine is used.
test('backend and configuration come only from the world source ReadWriteProfile, with provenance', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld({ profile: knownProfile });
    const supply = new CanvasConfigSupply(await boundCanvas(directory, world));
    world.adapterCalls.length = 0;
    const report = await supply.read('local-world');
    const row = report.current.profiles.compilationConfig.fields.writeBackend;
    assert.equal(row.status, 'SUPPLIED');
    assert.deepEqual(row.value, knownProfile.writeBackend.writeBackend);
    assert.equal(row.provenance.kind, 'WORLD_SOURCE_FACT');
    assert.equal(row.provenance.ref, 'C-world-facts ReadWriteProfile.compilationConfig.writeBackend');
    assert.match(row.provenance.sourceRevision, /^write-profile-[0-9a-f]{32}$/);
    assert.equal(row.provenance.basis, 'LOADED_PAYLOAD_DECLARATION');
    assert.equal(report.current.sources.writeProfile.sourceRevision, row.provenance.sourceRevision);
    const result = await supply.readCompilerConfig('local-world');
    // Forwarded unchanged: the exact configuration the source declared.
    assert.deepEqual(result.compilationConfig, knownProfile.compilationConfig);
    assert.deepEqual(world.adapterCalls, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('undeclared backend, peer errors and an absent port never default and expose legal errors', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const canvas = await boundCanvas(directory, world);
    const supply = new CanvasConfigSupply(canvas);
    const refused = async cause => {
      const row = (await supply.read('local-world')).current.profiles.compilationConfig.fields.writeBackend;
      assert.equal(row.value, null);
      assert.equal(row.cause, cause);
      await assert.rejects(supply.readCompilerConfig('local-world'), e => {
        const error = publicError(e); validateType('Error', error);
        return error.code === 'CAPABILITY_UNAVAILABLE' && error.reason === 'REQUIRED_FACT_UNKNOWN';
      });
    };
    await refused('NOT_DECLARED_BY_PAYLOAD');
    // A declared peer error keeps its public code.
    world.readWriteProfile = () => { throw Object.assign(new Error('peer'), { never: 'shown' }); };
    world.worldFacts.call = async (operation, request) => operation === 'ReadCatalogue' ?
      { contractVersion: 'world-facts/v1', requestId: request.requestId, result: world.readCatalogue(),
        error: null } :
      { contractVersion: 'world-facts/v1', requestId: request.requestId, result: null,
        error: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
          mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' } };
    await refused('ADAPTER_UNAVAILABLE');
    // A source without world-facts/v1 in its handshake is not read.
    world.worldFacts.protocolHandshake = { ...factsHandshake(), protocols: [{ protocol: 'world-adapter', major: 8, minor: 0 }] };
    await refused('CATALOGUE_UNRESOLVED');
    assert.equal((await supply.read('local-world')).current.sources.catalogue.cause,
      'UNSUPPORTED_VERSION');
    canvas.worldFacts = { protocolHandshake: factsHandshake() };
    await refused('CATALOGUE_UNRESOLVED');
    assert.equal((await supply.read('local-world')).current.sources.catalogue.cause,
      'WORLD_FACTS_PORT_ABSENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('write profile changes invalidate compiler supply and survive reopening', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld({ profile: knownProfile });
    const canvas = await boundCanvas(directory, world);
    const supply = new CanvasConfigSupply(canvas);
    const first = await supply.readCompilerConfig('local-world');
    const next = structuredClone(knownProfile);
    next.writeBackend.writeBackend.revision = next.compilationConfig.writeBackend.revision =
      'fixture-world-source-rev-8';
    world.profile = next;
    const second = await supply.readCompilerConfig('local-world');
    assert.notEqual(second.compilerRevision, first.compilerRevision);
    assert.equal(second.compilationConfig.writeBackend.revision, 'fixture-world-source-rev-8');
    const report = await supply.read('local-world');
    assert.ok(report.history.at(-1).invalidationReasons.includes('SOURCE_REVISION_CHANGED'));
    const reopened = new CanvasConfigSupply(new CanvasV5({ store: await CanvasStore.open(directory),
      worldFacts: world.worldFacts, adapter: world.adapter, sessions: fixtureSessions() }));
    assert.equal((await reopened.readCompilerConfig('local-world')).compilerRevision, second.compilerRevision);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection and Catalogue mismatches are stale, never usable backend values', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld({ profile: knownProfile });
    const supply = new CanvasConfigSupply(await boundCanvas(directory, world));
    const bound = world.readWriteProfile, boundCatalogue = world.readCatalogue;
    for (const mismatch of ['connection', 'catalogueDigest', 'catalogueConnection']) {
      world.readWriteProfile = bound; world.readCatalogue = boundCatalogue;
      if (mismatch === 'catalogueConnection') world.readCatalogue = () => ({ ...boundCatalogue(),
        connection: { ...boundCatalogue().connection, connectionIncarnationRef: 'retired' } });
      else world.readWriteProfile = () => {
        const altered = bound();
        if (mismatch === 'connection') altered.connection.connectionIncarnationRef = 'retired';
        else altered.catalogueDigest = '0'.repeat(64);
        return altered;
      };
      assert.equal((await supply.read('local-world')).current.profiles.compilationConfig
        .fields.writeBackend.value, null, mismatch);
      await assert.rejects(supply.readCompilerConfig('local-world'), e => {
        const error = publicError(e); validateType('Error', error);
        return error.code === 'STALE_REVISION' && error.reason === 'REVISION_CHANGED';
      }, mismatch);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('single and multiple missing-source refusals validate as public Error, without schema fallback', async () => {
  // Only the refusal projection is isolated here; policy values are never installed or changed.
  for (const missing of [
    [{ field: 'writeBackend', reason: 'REQUIRED_FACT_UNKNOWN' }],
    [{ field: 'unmappedFixtureField', reason: 'REQUIRED_FACT_UNKNOWN' }],
    [{ field: 'writeBackend', reason: 'REQUIRED_FACT_UNKNOWN' },
      { field: 'unmappedFixtureField', reason: 'REQUIRED_FACT_UNKNOWN' }],
  ]) {
    const supply = new CanvasConfigSupply(null);
    supply.read = async () => ({ current: { observationDigest: 'FIXTURE-refusal', profiles:
      { compilationConfig: { status: 'SOURCE_MISSING', missing } } } });
    await assert.rejects(supply.readCompilerConfig('w'), e => {
      const error = publicError(e); validateType('Error', error);
      return error.code === 'CAPABILITY_UNAVAILABLE' && error.phase === 'validate' &&
        error.mutationState === 'NONE' && e.missingSources === missing;
    });
  }
});

test('public fixture shape failures are refused through the consumer without schema fallback', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    const supply = new CanvasConfigSupply(await boundCanvas(directory, world));
    const invalid = factsFixture.provider.invalid.filter(item =>
      item.type === 'WriteProfile' || item.type === 'CatalogueFacts');
    assert.ok(invalid.length >= 2);
    const [boundCatalogue, boundProfile] = [world.readCatalogue, world.readWriteProfile];
    for (const item of invalid) {
      // Rebind the public fixture to this fixture World; intentionally do not repair its bad shape.
      const value = { ...structuredClone(item.value), connection: { worldRef: 'local-world',
        connectionRef: 'local-connection', connectionIncarnationRef: world.incarnation } };
      world.readCatalogue = item.type === 'CatalogueFacts' ? () => value : boundCatalogue;
      world.readWriteProfile = item.type === 'WriteProfile' ? () => value : boundProfile;
      await assert.rejects(supply.readCompilerConfig('local-world'), error => {
        const projected = publicError(error); validateType('Error', projected);
        return ['CAPABILITY_UNAVAILABLE', 'STALE_REVISION'].includes(projected.code) &&
          error.missingSources.some(row => row.field === 'writeBackend');
      }, item.title);
    }
    const stored = await readFile(join(directory, 'canvas-v7.json'), 'utf8');
    assert.equal(stored.includes('collisionBox'), false);
    assert.equal(stored.includes('playerNames'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config fact read changing the selected connection is rejected before recording supply', async () => {
  const directory = await temp();
  try {
    const world = fixtureWorld();
    world.profile = knownProfile;
    const canvas = await boundCanvas(directory, world);
    const bound = world.readWriteProfile;
    world.readWriteProfile = async () => {
      const facts = bound();
      world.incarnation = 'socket-open-2';
      await select(canvas, world, 'session-1');
      return facts;
    };
    await assert.rejects(new CanvasConfigSupply(canvas).read('local-world'), e => {
      const error = publicError(e); validateType('Error', error);
      return error.code === 'STALE_REVISION' && error.reason === 'REVISION_CHANGED';
    });
    assert.equal(canvas.store.snapshot.configSupply?.['local-world'], undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host apply() reads the world source C-world-facts port, never an engine-named service', async () => {
  // Regression: apply() read Catalogue and backend from hanaworldsLuantiNativeFacts. The
  // configuration now comes only from the source's world-facts/v1 ReadCatalogue/ReadWriteProfile.
  const profile = await temp();
  try {
    const ports = new Map();
    const world = fixtureWorld({ profile: knownProfile });
    let factsPort = world.worldFacts;
    const asked = new Set();
    const legacy = { readCatalogue: () => assert.fail('engine-named Catalogue read'),
      readConfigEngineFacts: () => assert.fail('engine-named config read') };
    const ctx = { get: name => { asked.add(name);
      return name === 'dshHomePath' ? (...parts) => join(profile, ...parts) :
      name === 'hanaworldsWorldAdapterV6' ? world.adapter :
      name === 'hanaworldsLuantiNativeFacts' ? legacy :
      name === 'hanaworldsWorldFacts' ? factsPort :
      name === 'hanaworldsWorkshopV3' ? fixtureSessions() : ports.get(name) ?? null; },
    provide: (name, port) => ports.set(name, port) };
    const canvas = applyCanvas(ctx);
    await canvas.ready;
    await select(canvas, world, 'session-1');
    asked.clear();
    const row = (await ports.get('hanaworldsCanvasConfigSupply').read('local-world'))
      .current.profiles.compilationConfig.fields.writeBackend;
    assert.equal(row.status, 'SUPPLIED');
    assert.deepEqual(row.value, knownProfile.writeBackend.writeBackend);
    assert.equal(asked.has('hanaworldsLuantiNativeFacts'), false);
    // Without the source port on the Host the source is named absent, never defaulted.
    factsPort = undefined;
    const report = await ports.get('hanaworldsCanvasConfigSupply').read('local-world');
    assert.equal(report.current.sources.catalogue.cause, 'WORLD_FACTS_PORT_ABSENT');
    assert.equal(report.current.profiles.compilationConfig.fields.writeBackend.status, 'MISSING');
  } finally { await rm(profile, { recursive: true, force: true }); }
});
