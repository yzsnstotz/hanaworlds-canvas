import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contractHandshake, version, operationContracts, schemaBundle,
  validateType, protocolRequirement, checkProtocolCompatibility } from 'hanaworlds-contracts';
import { CanvasV5, canvasProtocolHandshake, ADAPTER_CELL_REQUIREMENT,
  ADAPTER_REGION_REQUIREMENT } from '../src/index.mjs';

// contracts-brush-digests-01 REPORT + remote annotated tag, checked at admission.
const release = { tag: 'v2.2.1', version: '2.2.1',
  revision: 'ee53aed37117bc859d9cbb2aedee9ea7d8dfc8b1' };
const repository = 'git+https://github.com/yzsnstotz/hanaworlds-contracts.git';
const root = new URL('../', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const manifest = await json(new URL('package.json', root));
const lock = await json(new URL('package-lock.json', root));
const installed = await json(new URL(import.meta.resolve('hanaworlds-contracts/package.json')));
const dependency = `${repository}#${release.tag}`;
assert.match(dependency, /#v2\.\d+\.\d+$/);
assert.equal(manifest.dependencies['hanaworlds-contracts'], dependency, 'exact public git tag required');
assert.equal(lock.packages[''].dependencies['hanaworlds-contracts'], dependency, 'root lock drift');
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].version, release.version);
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].resolved,
  `${repository}#${release.revision}`, 'published tag commit required');
assert.equal(installed.version, release.version, 'installed package drift');
assert.equal(version, release.version, 'SDK version drift');
assert.equal(contractHandshake.contracts, `hanaworlds-contracts@${release.version}`);
for (const [wire, operations] of Object.entries({
  'canvas/v7': ['SelectWorldConnection', 'ReadWorldSelectionContext', 'ReserveWorldRetirement',
    'HistoryQuery', 'InspectPlacementRegion', 'AnalyzeAffectedObjects', 'ApplyRecoverableCommit', 'Undo', 'Redo'],
  'canvas-region/v3': ['ApplyRegionCommit', 'UndoRegionCommit'],
  'world-adapter/v8': ['ReadLocalConnection', 'InspectRegion', 'PrepareRecoverableTransaction',
    'ApplyCompiledTransaction', 'Readback', 'RestoreTransaction'],
  'world-adapter-region/v3': ['ReadRegion', 'WriteRegion'],
})) {
  const published = operationContracts[wire].map(row => row.operation);
  for (const operation of operations) assert.ok(published.includes(operation), `${wire}:${operation}`);
}
assert.ok(schemaBundle.definitions.PlacementFootprint.properties.geometryProfile);
validateType('PlacementFootprint', { geometryProfile: 'voxel-grid/v1',
  widthCells: 1, depthCells: 1, heightCells: 1 });
assert.equal(checkProtocolCompatibility(new CanvasV5({ store: null }).protocolHandshake,
  [protocolRequirement('canvas/v7', [], 1)]).result, 'PROTOCOL_COMPATIBLE');
assert.equal(checkProtocolCompatibility(canvasProtocolHandshake,
  [protocolRequirement('canvas-region/v3', canvasProtocolHandshake.capabilities, 1)]).result,
  'PROTOCOL_COMPATIBLE');
assert.equal(ADAPTER_CELL_REQUIREMENT.major, 8);
assert.equal(ADAPTER_CELL_REQUIREMENT.minMinor, 0); // no later named-port dependency
assert.equal(ADAPTER_REGION_REQUIREMENT.major, 3);
assert.equal(ADAPTER_REGION_REQUIREMENT.minMinor, 0);
const bundle = await readFile(new URL('lib/client.js', root), 'utf8');
for (const banned of ['display-fixture', 'displayFixture', 'SAMPLE_KEY', '查看示例数据', 'example-house'])
  assert.ok(!bundle.includes(banned), `published client contains ${banned}`);
console.log(JSON.stringify({ result: 'BASELINE_CONSISTENT', ...release, dependency,
  installed: fileURLToPath(new URL(import.meta.resolve('hanaworlds-contracts/package.json'))),
  bundleSHA256: createHash('sha256').update(bundle).digest('hex') }));
