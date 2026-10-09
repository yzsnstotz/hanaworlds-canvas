import { safetyCapabilities } from 'hanaworlds-contracts';

/*
 * FIXTURE: the ProtocolHandshake an Adapter publishes on its per-cell world-adapter/v7 port:
 * major 7 at the Contracts-declared minor, callback-free-write, write-path-state-facts and, by
 * default, the three Contracts engine safety capabilities of that wire (G1 restore-body-recheck,
 * G2 cell-protection, G3 no-body-enclosure). In-memory peer fixtures attach it; it is not the
 * real Adapter, and it says nothing about whether a real engine implements those checks.
 */
const safety = wire => safetyCapabilities.filter(c => c.id.startsWith(`${wire}:`) &&
  ['G1', 'G2', 'G3'].includes(c.gap)).map(c => c.id).sort();
export const CELL_SAFETY_CAPABILITIES = Object.freeze(safety('world-adapter/v7'));
export const REGION_SAFETY_CAPABILITIES = Object.freeze(safety('world-adapter-region/v1'));
export const G3_CELL_CAPABILITIES = Object.freeze(['world-adapter/v7:callback-free-write',
  'world-adapter/v7:write-path-state-facts']);
export const g3CellHandshake = ({ major = 7, minor = 0,
  capabilities = [...G3_CELL_CAPABILITIES, ...CELL_SAFETY_CAPABILITIES],
  component = 'fixture-adapter' } = {}) => ({
  profileVersion: 'protocol-handshake/v1', component,
  protocols: [{ protocol: "world-adapter", major, minor }], capabilities: [...capabilities].sort(),
  provenance: { packageName: component, packageVersion: '0.0.0-fixture',
    sourceRevision: null, artifactDigest: null } });
