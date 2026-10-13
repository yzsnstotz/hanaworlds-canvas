import { snapshotJSON, deepFreeze } from './strict-json.mjs';
import { validateShape } from './local/schema-validator.mjs';
/** Errors never contain an input value, user key, path, stack or provider exception. */
const retryFor = (phase, code) => phase === 'decode' || phase === 'replay' ? 'NEVER'
  : phase === 'restore' ? 'AFTER_MANUAL_RECOVERY'
  : code === 'RECOVERY_PENDING' ? 'SAME_TRANSACTION_QUERY' : 'AFTER_NEW_FACTS';
// 2.7.0: optional target world; present only when the constructor was given one.
const worldContext = details => {
  if (!Object.hasOwn(details, 'worldRef') || details.worldRef === undefined) return {};
  if (typeof details.worldRef !== 'string' || details.worldRef.length === 0) throw new TypeError('worldRef must be a non-empty Ref');
  return { worldRef: details.worldRef };
};
export class ContractError extends Error {
  constructor(code = 'SCHEMA_INVALID', phase = 'decode', reason = 'INVALID_SHAPE', details = {}) {
    super(`${code}/${phase}/${reason}`);
    this.name = 'ContractError';
    this.publicError = Object.freeze({ code, phase, retryability: details.retryability ?? retryFor(phase, code),
      mutationState: details.mutationState ?? 'NONE', transactionRef: details.transactionRef ?? null,
      causeCode: details.causeCode ?? null, reason, ...worldContext(details) });
  }
  get code() { return this.publicError.code; }
  get phase() { return this.publicError.phase; }
  get reason() { return this.publicError.reason; }
  get mutationState() { return this.publicError.mutationState; }
  get retryability() { return this.publicError.retryability; }
  get worldRef() { return this.publicError.worldRef; }
}
export function fail(code, phase, reason, details) { throw new ContractError(code, phase, reason, details); }
export function publicError(error) {
  try {
    const value = snapshotJSON(error?.publicError);
    validateShape('Error', value);
    return deepFreeze(value);
  } catch {
    return new ContractError('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE').publicError;
  }
}
export function requireFact(condition, code = 'SCHEMA_INVALID', reason = 'INVALID_SHAPE', phase = 'validate', details) {
  if (!condition) fail(code, phase, reason, details);
}
