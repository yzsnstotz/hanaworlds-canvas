import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const consumer = await import(process.env.CANVAS_CONSUMER_ENTRY ?? 'hanaworlds-contracts');
const publicPath = name => process.env.CANVAS_PUBLIC_ROOT ?
  new URL(name, process.env.CANVAS_PUBLIC_ROOT).href :
  import.meta.resolve('hanaworlds-canvas/' + name);

test('published NativeFacts consumer reads a complete raw fixture and preserves unknown facts', async () => {
  const example = await import(publicPath('examples/native-facts-consumer.mjs'));
  const bytes = await readFile(new URL(publicPath('fixtures/native-facts-scoped-state.json')));
  const fixture = JSON.parse(bytes);
  const source = JSON.parse(await readFile(new URL(publicPath('fixtures/native-facts-scoped-state.source.json'))));
  const schema = JSON.parse(await readFile(new URL(publicPath('fixtures/native-facts-scoped-state.schema.json'))));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.fixtureSHA256);
  assert.equal(source.canvasPackageVersion, '0.15.1');
  assert.deepEqual(schema.required, ['worldRef', 'stateProfile', 'cells']);
  for (const [name, definition] of Object.entries(schema.definitions))
    assert.deepEqual(definition, JSON.parse(JSON.stringify(consumer.schemaBundle.definitions[name])));
  assert.deepEqual(Object.keys(fixture).sort(), ['cells', 'stateProfile', 'worldRef']);
  assert.deepEqual(example.validateNativeFactsScopedState(fixture, consumer), fixture);
  const port = await example.createFixtureNativeFactsPort(consumer);
  const result = await port.readScopedState('local-connection', [[0, 1, 3]]);
  assert.deepEqual(result, fixture);
  assert.deepEqual(Object.keys(result.stateProfile).sort(), ['clearedFields', 'derivedFields', 'preservedFields', 'profileVersion']);
  const unknown = structuredClone(fixture);
  unknown.cells[0].availability = 'UNKNOWN';
  unknown.cells[0].stateDigest = null;
  assert.equal(example.validateNativeFactsScopedState(unknown, consumer).cells[0].availability, 'UNKNOWN');
  assert.throws(() => example.validateNativeFactsScopedState({ cells: fixture.cells }, consumer),
    error => error.code === 'SCHEMA_INVALID');
  console.log(JSON.stringify({ consumerVersion: consumer.version,
    method: 'readScopedState', arguments: ['local-connection', [[0, 1, 3]]], rawReturn: result }));
});
