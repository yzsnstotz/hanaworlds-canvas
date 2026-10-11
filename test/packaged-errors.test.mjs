import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, validateType } from 'hanaworlds-contracts';
import { CanvasConfigSupply } from 'hanaworlds-canvas';
import { validateNativeFactsScopedState } from 'hanaworlds-canvas/examples/native-facts-consumer.mjs';

test('independent packaged consumer publishes errors validated by a separate development SDK', () => {
  assert.throws(() => validateNativeFactsScopedState({ cells: [] }), error => {
    assert.equal(error instanceof ContractError, false, 'private SDK constructors must be independent');
    const failure = validateType('Error', error.publicError);
    assert.equal(failure.code, 'SCHEMA_INVALID');
    assert.equal(failure.mutationState, 'NONE');
    return true;
  });
});

test('independent packaged config supply preserves public capability-error consumption', async () => {
  const supply = new CanvasConfigSupply({ store: null });
  await assert.rejects(() => supply.readCompilerConfig('unavailable-world'), error => {
    assert.equal(error instanceof ContractError, false);
    const failure = validateType('Error', error.publicError);
    assert.equal(failure.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(failure.mutationState, 'NONE');
    assert.equal(failure.reason, 'REQUIRED_FACT_UNKNOWN');
    return true;
  });
});
