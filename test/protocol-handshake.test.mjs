import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from './support/cordis-runtime.mjs';

const consumer = await import(process.env.CANVAS_CONSUMER_ENTRY ?? 'hanaworlds-contracts');
const { protocolRequirement, checkProtocolCompatibility, regionCapabilities } = consumer;
const cellRequirement = protocolRequirement('canvas/v6', []);
const regionRequirement = protocolRequirement('canvas-region/v2', regionCapabilities
  .filter(c => c.owner === 'hanaworlds-canvas').map(c => c.id));

test('real Cordis Canvas publicly advertises canvas/v6 and retains its region declaration', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'canvas-protocol-'));
  const runtime = await openRuntime(profile);
  try {
    const service = runtime.ctx.get('hanaworldsCanvasV5');
    assert.equal(service.status().storage, 'READY');
    const advertised = service.protocolHandshake;
    assert.ok(advertised, 'MISSING_PUBLIC_CANVAS_V5_PROTOCOL_HANDSHAKE');
    assert.equal(advertised.profileVersion, 'protocol-handshake/v1');
    // Canvas advertises the canvas/v6 minor the installed Contracts declare (6.0 on 1.x).
    const declared = consumer.contractProtocols.find(row => row.protocol === 'canvas');
    assert.deepEqual(advertised.protocols, [{ protocol: 'canvas', major: 6, minor: declared.minor }]);
    assert.equal(checkProtocolCompatibility(advertised,
      [protocolRequirement('canvas/v6', [], declared.minor)]).result, 'PROTOCOL_COMPATIBLE');
    assert.deepEqual(advertised.capabilities, []); // No published per-cell Canvas token exists.
    assert.equal(checkProtocolCompatibility(advertised, [cellRequirement]).result,
      'PROTOCOL_COMPATIBLE');
    const region = runtime.ctx.get('hanaworldsCanvasRegionV1').protocolHandshake;
    assert.deepEqual(region.protocols, [{ protocol: 'canvas-region', major: 2, minor: 0 }]);
    assert.equal(checkProtocolCompatibility(region, [regionRequirement]).result,
      'PROTOCOL_COMPATIBLE');
    const original = structuredClone(advertised);
    advertised.protocols[0].major = 99;
    advertised.capabilities.push('caller-mutation');
    assert.deepEqual(service.protocolHandshake, original);
    console.log(JSON.stringify({ consumerVersion: consumer.version,
      actualCellHandshake: original, actualRegionHandshake: region,
      storage: service.status().storage }));
  } finally { await runtime.dispose(); await rm(profile, { recursive: true, force: true }); }
});

test('public consumer names wrong major, missing declaration, and missing published capability', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'canvas-protocol-refusal-'));
  const runtime = await openRuntime(profile);
  try {
    const service = runtime.ctx.get('hanaworldsCanvasV5');
    const advertised = service.protocolHandshake;
    assert.ok(advertised, 'MISSING_PUBLIC_CANVAS_V5_PROTOCOL_HANDSHAKE');
    const wrongMajor = structuredClone(advertised);
    wrongMajor.protocols[0].major = 5;
    for (const rejected of [wrongMajor, null, service.contractHandshake,
      runtime.ctx.get('hanaworldsCanvasRegionV1').protocolHandshake]) {
      assert.throws(() => checkProtocolCompatibility(rejected, [cellRequirement]),
        error => error.code === 'UNSUPPORTED_VERSION' && error.phase === 'decode');
    }
    const anotherSource = structuredClone(advertised);
    anotherSource.provenance = { packageName: 'hanaworlds-canvas',
      packageVersion: '99.0.0-fixture', sourceRevision: 'fixture-other-source',
      artifactDigest: 'a'.repeat(64) };
    assert.equal(checkProtocolCompatibility(anotherSource, [cellRequirement]).result,
      'PROTOCOL_COMPATIBLE');
    const region = runtime.ctx.get('hanaworldsCanvasRegionV1').protocolHandshake;
    const missing = structuredClone(region);
    missing.capabilities = missing.capabilities.filter(c =>
      c !== 'canvas-region/v2:whole-region-undo');
    assert.throws(() => checkProtocolCompatibility(missing, [regionRequirement]),
      error => error.code === 'CAPABILITY_UNAVAILABLE' && error.phase === 'decode');
    // Cell capabilities=[] cannot have a missing-cell-token case. Test the real
    // published regional requirement instead; do not invent a per-cell token.
    console.log(JSON.stringify({ consumerVersion: consumer.version,
      wrongMajor: 'UNSUPPORTED_VERSION', noDeclaration: 'UNSUPPORTED_VERSION',
      regionOnlyForCell: 'UNSUPPORTED_VERSION', exactOnlyForCell: 'UNSUPPORTED_VERSION',
      missingPublishedRegionCapability: 'CAPABILITY_UNAVAILABLE',
      missingPerCellCapability: 'NOT_APPLICABLE_NO_PUBLISHED_TOKEN' }));
  } finally { await runtime.dispose(); await rm(profile, { recursive: true, force: true }); }
});
