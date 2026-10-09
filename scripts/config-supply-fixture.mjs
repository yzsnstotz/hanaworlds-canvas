import { readFile } from 'node:fs/promises';
import { fixtureSessions } from './fixture-sessions.mjs';

/*
 * FIXTURE peers for the /supply preparation page: a contracts-shaped Adapter connection, a
 * NativeFacts Catalogue and a Session identity port. They are inputs only. Canvas's supply,
 * its store, provenance, revisions and refusals are the real Canvas code.
 */
export const supplySessionRef = 'supply-fixture-session';
export const supplyWorldRef = 'supply-fixture-world';
const stateProfile = { profileVersion: 'state-profile/v2',
  nodeFields: ['nodeName', 'param1', 'param2'], metadataMode: 'exact',
  inventoryMode: 'exact', timerMode: 'exact', derivedLightMode: 'recompute-with-readback' };
const contractsCatalogue = async () => JSON.parse(await readFile(new URL(
  import.meta.resolve('hanaworlds-contracts/fixtures/main')))).request.catalogue;

export async function supplyFixturePeers({ incarnation = 'supply-fixture-incarnation-1',
  worldeditRevision = 'fixture-worldedit-1' } = {}) {
  const base = await contractsCatalogue();
  const env = { incarnation, worldeditRevision, sessions: fixtureSessions() };
  env.catalogue = () => {
    const modRevisions = { ...base.modRevisions };
    if (env.worldeditRevision !== null) modRevisions.worldedit = env.worldeditRevision;
    return { ...base, modRevisions };
  };
  const connection = () => ({ connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: env.incarnation, worldRef: supplyWorldRef,
    payloadVersion: 'local-world/v1', payloadDigest: '1'.repeat(64),
    capabilities: { providerRef: 'supply-fixture-adapter', capabilityRevision: 'supply-fixture-cap-1',
      worldRef: supplyWorldRef, engineBounds: { min: [-64, -64, -64], max: [64, 64, 64] }, limits: [],
      recoveryGuarantee: 'RECOVERABLE_VERIFIED', stateProfile, sessionDeleteSupported: true,
      imageMediaTypes: [], model: null } });
  env.adapter = {
    protocolHandshake: { profileVersion: 'protocol-handshake/v1', component: 'supply-fixture-adapter',
      protocols: [{ protocol: 'world-adapter', major: 6, minor: 1 }],
      capabilities: ['world-adapter/v6:callback-free-write', 'world-adapter/v6:write-path-state-facts'],
      provenance: { packageName: 'supply-fixture-adapter', packageVersion: '1.0.0',
        sourceRevision: null, artifactDigest: null } },
    async call(operation, request) {
      const answer = result => ({ contractVersion: 'world-adapter/v6', requestId: request.requestId,
        result, error: null });
      if (operation === 'DiscoverConnections') return answer({ capabilityRevision: 'supply-fixture-cap-1',
        connections: [{ adapterId: 'hanaworlds-world-adapter', connectionRef: 'supply-fixture-connection',
          worldRef: supplyWorldRef, displayName: 'FIXTURE 供给示例世界', capabilityRevision: 'supply-fixture-cap-1',
          payloadVersion: 'local-world/v1', readiness: 'READY', connectionIncarnationRef: env.incarnation }] });
      if (operation === 'ReadLocalConnection') return answer(connection());
      // The page never writes a World; any mutating call is a defect.
      throw new Error(`FIXTURE_ADAPTER_READ_ONLY:${operation}`);
    } };
  env.nativeFacts = { async readCatalogue(worldRef) {
    if (worldRef !== supplyWorldRef) throw Object.assign(new Error('WORLD_NOT_FOUND'),
      { publicError: { code: 'WORLD_NOT_FOUND' } });
    return env.catalogue();
  } };
  env.describe = () => ({ kind: 'FIXTURE', sessionRef: supplySessionRef, worldRef: supplyWorldRef,
    connectionIncarnationRef: env.incarnation, catalogue: 'hanaworlds-contracts/fixtures/main ' +
      'request.catalogue' + (env.worldeditRevision === null ? '' :
      ` + modRevisions.worldedit=${env.worldeditRevision}`),
    session: 'scripts/fixture-sessions.mjs', adapter: 'scripts/config-supply-fixture.mjs' });
  return env;
}
