/*
 * FIXTURE: the ProtocolHandshake a G3 Adapter (Contracts 0.5.1+) publishes on its
 * per-cell world-adapter/v6 port: major 6, minor 1, callback-free-write and
 * write-path-state-facts. In-memory peer fixtures attach it; it is not the real Adapter.
 */
export const G3_CELL_CAPABILITIES = Object.freeze(['world-adapter/v6:callback-free-write',
  'world-adapter/v6:write-path-state-facts']);
export const g3CellHandshake = ({ major = 6, minor = 1, capabilities = G3_CELL_CAPABILITIES,
  component = 'fixture-adapter' } = {}) => ({
  profileVersion: 'protocol-handshake/v1', component,
  protocols: [{ protocol: 'world-adapter', major, minor }], capabilities: [...capabilities],
  provenance: { packageName: component, packageVersion: '0.0.0-fixture',
    sourceRevision: null, artifactDigest: null } });
