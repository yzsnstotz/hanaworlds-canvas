import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasV5, CanvasStore, CanvasConfigSupply } from '../src/index.mjs';
import { supplyFixturePeers, supplySessionRef as sessionRef, supplyWorldRef as worldRef }
  from '../scripts/config-supply-fixture.mjs';

// Existing Canvas compatibility API, exercised offline with peer example data.
// This does not authorize Canvas to consume Bridge-only ReadWriteProfile in a Host.
async function fixture(t) {
  const root = fileURLToPath(new URL('../../tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'q284-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const peers = await supplyFixturePeers({ backendDeclared: true });
  const canvas = new CanvasV5({ store: await CanvasStore.open(directory),
    adapter: peers.adapter, sessions: peers.sessions, worldFacts: peers.worldFacts });
  const selected = await canvas.call('SelectWorldConnection', { contractVersion: 'canvas/v7',
    requestId: 'q284-select', sessionRef, worldRef, connectionRef: 'supply-fixture-connection',
    connectionIncarnationRef: peers.incarnation, expectedRevision: 'session-0', expectedContext: null });
  assert.equal(selected.error, null);
  return { peers, canvas, supply: new CanvasConfigSupply(canvas) };
}
for (const unknown of [false, true]) test(`Q284 compiler availability retains original source cause and complete diagnostics: UNKNOWN=${unknown}`, async t => {
  const { peers, supply } = await fixture(t);
  const originalCall = peers.worldFacts.call.bind(peers.worldFacts);
  const original = Object.assign(new Error('source failed', { cause: new Error('original safe I/O cause') }), {
    publicError: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate',
      retryability: unknown ? 'AFTER_MANUAL_RECOVERY' : 'AFTER_NEW_FACTS',
      mutationState: unknown ? 'UNKNOWN' : 'NONE', transactionRef: unknown ? 'uncertain-source' : null,
      causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN', worldRef,
      source: { owner: 'world-source', operation: 'ReadWriteProfile', resource: worldRef,
        kind: 'IO', nativeCode: 'EIO' } } });
  peers.worldFacts.call = (operation, request) => {
    if (operation === 'ReadWriteProfile') throw original;
    return originalCall(operation, request);
  };
  await assert.rejects(() => supply.readCompilerConfig(worldRef), error => {
    assert.equal(error.publicError.code, 'CAPABILITY_UNAVAILABLE', 'Own availability code stays compatible');
    assert.equal(error.publicError.reason, 'REQUIRED_FACT_UNKNOWN');
    assert.ok(error.missingSources.some(row => row.field === 'writeBackend'));
    assert.equal(error.cause, original, 'Availability cannot discard or reconstruct the original source Error');
    assert.deepEqual(error.cause.publicError, original.publicError);
    assert.equal(error.cause.cause, original.cause);
    return true;
  });
  peers.worldFacts.call = originalCall;
  const recovered = await supply.readCompilerConfig(worldRef);
  assert.equal(recovered.compilationConfig.profileVersion, 'compilation-config/v3');
  const report = await supply.read(worldRef);
  assert.equal(report.current.profiles.compilationConfig.status, 'SUPPLIED');
  assert.deepEqual(report.current.profiles.compilationConfig.missing, []);
  assert.ok(report.history.some(row => row.profiles.compilationConfig.status === 'SOURCE_MISSING'));
});
