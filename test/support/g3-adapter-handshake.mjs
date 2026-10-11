/*
 * FIXTURE: the ProtocolHandshake an Adapter publishes on its per-cell world-adapter/v8 port:
 * major 7 at the Contracts-declared minor with callback-free-write and write-path-state-facts.
 * Engine guards are not handshake capabilities (Contracts 1.0.0-rc.2): they are declared per
 * stage in the connection's PublicCapabilities.engineGuards. Not the real Adapter.
 */
export const G3_CELL_CAPABILITIES = Object.freeze(['world-adapter/v8:callback-free-write',
  'world-adapter/v8:write-path-state-facts']);
export const g3CellHandshake = ({ major = 8, minor = 0, capabilities = G3_CELL_CAPABILITIES,
  component = 'fixture-adapter' } = {}) => ({
  profileVersion: 'protocol-handshake/v1', component,
  protocols: [{ protocol: 'world-adapter', major, minor }], capabilities: [...capabilities].sort(),
  provenance: { packageName: component, packageVersion: '0.0.0-fixture',
    sourceRevision: null, artifactDigest: null } });
