import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contractHandshake, version, operationContracts, schemaBundle,
  validateType, protocolRequirement, checkProtocolCompatibility } from 'hanaworlds-contracts';
import { CanvasV5, canvasProtocolHandshake, ADAPTER_CELL_REQUIREMENT,
  ADAPTER_REGION_REQUIREMENT } from '../src/index.mjs';

// canvas-11 scoped undo: remote annotated tag v2.12.0 (peeled commit), checked at admission.
const release = { tag: 'v2.12.0', version: '2.12.0',
  revision: '33c34372fd5092a83b6f3cc81c086470fa76d794' };
const repository = 'git+https://github.com/yzsnstotz/hanaworlds-contracts.git';
const root = new URL('../', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const manifest = await json(new URL('package.json', root));
const lock = await json(new URL('package-lock.json', root));
const installed = await json(new URL(import.meta.resolve('hanaworlds-contracts/package.json')));
const dependency = `${repository}#${release.tag}`;
assert.match(dependency, /#v2\.\d+\.\d+$/);
assert.equal(manifest.devDependencies['hanaworlds-contracts'], dependency, 'exact public git tag required');
assert.equal(lock.packages[''].devDependencies['hanaworlds-contracts'], dependency, 'root lock drift');
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].version, release.version);
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].resolved
  .replace('git+ssh://git@github.com/', 'git+https://github.com/'),
  `${repository}#${release.revision}`, 'published tag commit required');
assert.equal(installed.version, release.version, 'installed package drift');
assert.equal(version, release.version, 'SDK version drift');
assert.equal(contractHandshake.contracts, `hanaworlds-contracts@${release.version}`);
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


for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'])
  assert.ok(!manifest[section]?.['hanaworlds-contracts'], `production supplier in ${section}`);
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].dev, true);
const generated = await json(new URL('lib/build-source.json', root));
assert.equal(generated.supplier.tag, dependency);
assert.equal(generated.supplier.version, release.version);
assert.equal(generated.supplier.revision, release.revision);
assert.equal(generated.supplier.packageSHA256, createHash('sha256').update(await readFile(new URL(import.meta.resolve('hanaworlds-contracts/package.json')))).digest('hex'));
for (const [path, digest] of Object.entries({ ...generated.inputs, ...generated.artifacts }))
  assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), digest, `build source drift: ${path}`);
assert.ok(Object.keys(generated.inputs).some(p => p.startsWith('node_modules/hanaworlds-contracts/dist/')));
console.log(JSON.stringify({ result: 'BASELINE_CONSISTENT', ...release, dependency,
  installed: fileURLToPath(new URL(import.meta.resolve('hanaworlds-contracts/package.json'))),
  bundleSHA256: createHash('sha256').update(bundle).digest('hex') }));
