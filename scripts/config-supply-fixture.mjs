import { readFile } from 'node:fs/promises';
import { digestValue } from 'hanaworlds-contracts';
import { fixtureSessions } from './fixture-sessions.mjs';
import { guardSlot } from './fixture-engine-guards.mjs';

/*
 * FIXTURE peers for the /supply preparation page: a contracts-shaped Adapter connection, a
 * C-world-facts world-facts/v1 source (ReadCatalogue/ReadWriteProfile) and a Session identity
 * port. They are inputs only. Canvas's supply, its store, provenance, revisions and refusals are
 * the real Canvas code.
 */
export const supplySessionRef = 'supply-fixture-session';
export const supplyWorldRef = 'supply-fixture-world';
const stateProfile = { profileVersion: 'state-profile/v3', derivedFields: ['light'], preservedFields: ['inventory', 'metadata', 'timer'], clearedFields: [] };
const factsFixture = async () => JSON.parse(await readFile(new URL(
  import.meta.resolve('hanaworlds-contracts/fixtures/world-source-facts'))));

export async function supplyFixturePeers({ incarnation = 'supply-fixture-incarnation-1',
  sourceRevision = 'fixture-source-1', backendDeclared = false } = {}) {
  const fixture = await factsFixture();
  const result = (operation, test) => fixture.exchanges.find(e => e.operation === operation &&
    e.response.result !== null && test(e.response.result)).response.result;
  const catalogueFacts = result('ReadCatalogue', () => true);
  const profiles = { true: result('ReadWriteProfile', r => r.writeBackend.availability === 'KNOWN'),
    false: result('ReadWriteProfile', r => r.writeBackend.availability !== 'KNOWN') };
  const env = { incarnation, sourceRevision, backendDeclared, sessions: fixtureSessions() };
  env.catalogue = () => ({ ...catalogueFacts.catalogue, engineRevisions:
    { ...catalogueFacts.catalogue.engineRevisions, 'fixture-source': env.sourceRevision } });
  const connection = () => ({ connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: env.incarnation, worldRef: supplyWorldRef,
    payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
    capabilities: { providerRef: 'supply-fixture-adapter', capabilityRevision: 'supply-fixture-cap-1',
      worldRef: supplyWorldRef, engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
      worldGeometry: { profileVersion: 'world-geometry/v1', geometryProfiles: ['voxel-grid/v1'], partition: { edge: [16, 16, 16] }, postWriteLighting: 'REQUIRED' }, recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile, sessionDeleteSupported: true,
      imageMediaTypes: [], model: null,
      // FIXTURE: no engine guard declared, so the page names every uncovered guard x stage.
      engineGuards: null } });
  env.adapter = {
    protocolHandshake: { profileVersion: 'protocol-handshake/v1', component: 'supply-fixture-adapter',
      // FIXTURE: Contracts 1.x per-cell wire, no engine safety capability advertised.
      protocols: [{ protocol: 'world-adapter', major: 8, minor: 0 }],
      capabilities: ['world-adapter/v8:callback-free-write', 'world-adapter/v8:write-path-state-facts'],
      provenance: { packageName: 'supply-fixture-adapter', packageVersion: '1.0.0',
        sourceRevision: null, artifactDigest: null } },
    async call(operation, request) {
      const answer = result => guardSlot('world-adapter/v8', operation, { contractVersion: 'world-adapter/v8', requestId: request.requestId,
        result, error: null });
      if (operation === 'DiscoverConnections') return answer({ capabilityRevision: 'supply-fixture-cap-1',
        connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: 'supply-fixture-connection',
          worldRef: supplyWorldRef, displayName: 'FIXTURE 供给示例世界', capabilityRevision: 'supply-fixture-cap-1',
          payloadVersion: 'local-world/v1', readiness: 'READY', connectionIncarnationRef: env.incarnation }] });
      if (operation === 'ReadLocalConnection') return answer(connection());
      // The page never writes a World; any mutating call is a defect.
      throw new Error(`FIXTURE_ADAPTER_READ_ONLY:${operation}`);
    } };
  const current = () => ({ worldRef: supplyWorldRef, connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: env.incarnation });
  env.worldFacts = {
    protocolHandshake: { profileVersion: 'protocol-handshake/v1', component: 'supply-fixture-world-source',
      protocols: [{ protocol: 'world-facts', major: 1, minor: 0 }], capabilities: [],
      provenance: { packageName: 'supply-fixture-world-source', packageVersion: '1.0.0',
        sourceRevision: null, artifactDigest: null } },
    async call(operation, request) {
      const answer = (value, error = null) => ({ contractVersion: 'world-facts/v1',
        requestId: request.requestId, result: value, error });
      if (request.worldRef !== supplyWorldRef) return answer(null, { code: 'WORLD_NOT_BOUND',
        phase: 'validate', retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
        transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' });
      const catalogue = env.catalogue(), catalogueDigest = digestValue('catalogue', catalogue).sha256;
      if (operation === 'ReadCatalogue') return answer({ ...structuredClone(catalogueFacts),
        connection: current(), catalogue, catalogueDigest });
      if (operation === 'ReadWriteProfile') return answer({
        ...structuredClone(profiles[env.backendDeclared]), connection: current(), catalogueDigest });
      throw new Error(`FIXTURE_WORLD_FACTS_UNSUPPORTED:${operation}`);
    } };
  env.describe = () => ({ kind: 'FIXTURE', sessionRef: supplySessionRef, worldRef: supplyWorldRef,
    connectionIncarnationRef: env.incarnation, worldFacts: 'hanaworlds-contracts/fixtures/' +
      `world-source-facts (engineRevisions.fixture-source=${env.sourceRevision}, ` +
      `backend ${env.backendDeclared ? 'KNOWN' : 'NOT_DECLARED_BY_PAYLOAD'})`,
    session: 'scripts/fixture-sessions.mjs', adapter: 'scripts/config-supply-fixture.mjs' });
  return env;
}
