import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { operationContracts, schemaBundle,
  validateType, protocolRequirement, checkProtocolCompatibility } from '../src/protocol/local/index.mjs';
import { CanvasV5, canvasProtocolHandshake, ADAPTER_CELL_REQUIREMENT,
  ADAPTER_REGION_REQUIREMENT } from '../src/index.mjs';

const root = new URL('../', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const manifest = await json(new URL('package.json', root));
const lock = await json(new URL('package-lock.json', root));
const protocol = await json(new URL('scripts/protocol-source.json', root));
assert.equal(protocol.owner, manifest.name);
assert.deepEqual(protocol.documents, ['C-canvas@2', 'C-world-adapter@2', 'C-world-facts@2']);
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
  for (const name of Object.keys(manifest[section] ?? {}))
    assert.ok(name !== 'hanaworlds-contracts' && name !== 'cordis', `external supplier/runtime in ${section}`);
assert.ok(!JSON.stringify(lock).includes('hanaworlds-contracts'), 'external supplier in lock graph');
assert.ok(!Object.hasOwn(lock.packages, 'node_modules/cordis'), 'old framework in lock graph');
for (const [path, digest] of Object.entries(protocol.files))
  assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), digest, `owned protocol drift: ${path}`);
for (const [wire, operations] of Object.entries({
  'canvas/v7': ['SelectWorldConnection', 'ReadWorldSelectionContext', 'ReserveWorldRetirement',
    'HistoryQuery', 'InspectPlacementRegion', 'AnalyzeAffectedObjects', 'ApplyRecoverableCommit', 'Undo', 'Redo'],
  'canvas-region/v3': ['ApplyRegionCommit', 'UndoRegionCommit', 'UndoScopedRegionCommit'],
  'world-adapter/v8': ['ReadLocalConnection', 'InspectRegion', 'PrepareRecoverableTransaction',
    'ApplyCompiledTransaction', 'Readback', 'RestoreTransaction'],
  'world-adapter-region/v3': ['ReadRegion', 'WriteRegion'],
})) {
  const published = operationContracts[wire].map(row => row.operation);
  for (const operation of operations) assert.ok(published.includes(operation), `${wire}:${operation}`);
}
assert.ok(schemaBundle.definitions.PlacementFootprint.properties.geometryProfile);
assert.ok(canvasProtocolHandshake.capabilities.includes('canvas-region/v3:confirmed-scope-undo'));
assert.ok(schemaBundle.definitions.UndoScopedRegionCommitRequest.required.includes('expectedScopeDigest'));
// canvas-05 relays the published optional Error.worldRef (no null form); old errors still decode.
assert.deepEqual(schemaBundle.definitions.Error.properties.worldRef, { $ref: '#/definitions/Ref' });
assert.ok(!schemaBundle.definitions.Error.required.includes('worldRef'));
validateType('PlacementFootprint', { geometryProfile: 'voxel-grid/v1',
  widthCells: 1, depthCells: 1, heightCells: 1 });
assert.equal(checkProtocolCompatibility(new CanvasV5({ store: null }).protocolHandshake,
  [protocolRequirement('canvas/v7', [], 1)]).result, 'PROTOCOL_COMPATIBLE');
assert.equal(checkProtocolCompatibility(canvasProtocolHandshake,
  [protocolRequirement('canvas-region/v3', canvasProtocolHandshake.capabilities, 2)]).result,
  'PROTOCOL_COMPATIBLE');
assert.equal(ADAPTER_CELL_REQUIREMENT.major, 8);
assert.equal(ADAPTER_CELL_REQUIREMENT.minMinor, 0); // no later named-port dependency
assert.equal(ADAPTER_REGION_REQUIREMENT.major, 3);
assert.equal(ADAPTER_REGION_REQUIREMENT.minMinor, 0);
const bundle = await readFile(new URL('lib/client.js', root), 'utf8');
for (const banned of ['display-fixture', 'displayFixture', 'SAMPLE_KEY', '查看示例数据', 'example-house'])
  assert.ok(!bundle.includes(banned), `published client contains ${banned}`);


const generated = await json(new URL('lib/build-source.json', root));
assert.equal(generated.format, 'canvas-build-source/v2');
assert.equal(generated.supplier.name, manifest.name);
assert.equal(generated.supplier.protocolSourceSHA256, createHash('sha256').update(await readFile(new URL('scripts/protocol-source.json', root))).digest('hex'));
for (const [path, digest] of Object.entries({ ...generated.inputs, ...generated.artifacts }))
  assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), digest, `build source drift: ${path}`);
assert.ok(Object.keys(generated.inputs).some(p => p.startsWith('src/protocol/')));
assert.ok(!Object.keys(generated.inputs).some(p => p.includes('node_modules/hanaworlds-contracts/') || p.includes('node_modules/cordis/')));
assert.ok(Object.hasOwn(generated.inputs, 'src/client.jsx'), 'client input provenance required');
assert.ok(Object.hasOwn(generated.artifacts, 'types/index.d.ts'), 'public type provenance required');
console.log(JSON.stringify({ result: 'DOCUMENT_PROTOCOL_AND_SOURCE_CONSISTENT', documents: protocol.documents,
  bundleSHA256: createHash('sha256').update(bundle).digest('hex') }));
