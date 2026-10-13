import test from 'node:test';
import assert from 'node:assert/strict';
import { publicError, validateType } from '../src/protocol/local/index.mjs';
const failure = {code:'TARGET_FACTS_INCOMPLETE',phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',
  transactionRef:null,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN',worldRef:'opaque-world',
  source:{owner:'world-source',operation:'readCanvasFacts',resource:'opaque-source',kind:'NOT_FOUND',nativeCode:'missing'}};
test('public errors validate a foreign JSON envelope without constructor identity and preserve opaque FailureSource', () => {
  const error = Object.assign(new Error('unshared provider constructor'),{publicError:structuredClone(failure)});
  const decoded = publicError(error);
  assert.deepEqual(decoded,validateType('Error',failure));
  assert.ok(Object.isFrozen(decoded.source));
  error.publicError.source.resource = 'consumer mutation';
  assert.equal(decoded.source.resource,'opaque-source');
});
test('public errors refuse a malformed foreign envelope without invoking its accessor', () => {
  let getters=0;
  const malformed = structuredClone(failure);
  Object.defineProperty(malformed.source,'resource',{enumerable:true,get(){getters++;return 'forged';}});
  assert.equal(publicError({publicError:malformed}).code,'SCHEMA_INVALID');
  assert.equal(getters,0);
  assert.equal(publicError({publicError:{...failure,unexpected:true}}).code,'SCHEMA_INVALID');
});
