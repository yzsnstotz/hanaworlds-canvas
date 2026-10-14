import test from 'node:test';
import assert from 'node:assert/strict';
import { configHandoffFixture, attachConfigFixture } from './support/config-handoff-fixture.mjs';

// Q-288 actual registered Canvas port; source Error comes through the trusted Bridge reader.
// Full original Error/cause/UNKNOWN assertions from Q-284 are retained.
for (const unknown of [false, true]) test(`Q284 compiler availability retains original source cause and complete diagnostics: UNKNOWN=${unknown}`, async t => {
  const env = await configHandoffFixture(t); attachConfigFixture(env);
  const worldRef = env.worldRef;
  const supply = { readCompilerConfig: ref => env.compiler.read(ref), read: ref => env.supply.read(ref) };
  const original = Object.assign(new Error('source failed', { cause: new Error('original safe I/O cause') }), {
    publicError: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate',
      retryability: unknown ? 'AFTER_MANUAL_RECOVERY' : 'AFTER_NEW_FACTS',
      mutationState: unknown ? 'UNKNOWN' : 'NONE', transactionRef: unknown ? 'uncertain-source' : null,
      causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN', worldRef,
      source: { owner: 'world-source', operation: 'ReadWriteProfile', resource: worldRef,
        kind: 'IO', nativeCode: 'EIO' } } });
  env.thrown = original;
  await assert.rejects(() => supply.readCompilerConfig(worldRef), error => {
    assert.equal(error.publicError.code, 'CAPABILITY_UNAVAILABLE', 'Own availability code stays compatible');
    assert.equal(error.publicError.reason, 'REQUIRED_FACT_UNKNOWN');
    assert.ok(error.missingSources.some(row => row.field === 'writeBackend'));
    assert.equal(error.cause, original, 'Availability cannot discard or reconstruct the original source Error');
    assert.deepEqual(error.cause.publicError, original.publicError);
    assert.equal(error.cause.cause, original.cause);
    return true;
  });
  env.thrown = null;
  const recovered = await supply.readCompilerConfig(worldRef);
  assert.equal(recovered.compilationConfig.profileVersion, 'compilation-config/v3');
  const report = await supply.read(worldRef);
  assert.equal(report.current.profiles.compilationConfig.status, 'SUPPLIED');
  assert.deepEqual(report.current.profiles.compilationConfig.missing, []);
  assert.ok(report.history.some(row => row.profiles.compilationConfig.status === 'SOURCE_MISSING'));
});
