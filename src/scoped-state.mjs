import { validateType, canonicalJSON } from './protocol/local/index.mjs';

/** C-world-facts@2 local Host return; digests are opaque source facts. */
export function validateScopedState(raw, positions) {
  validateType('Ref', raw?.worldRef);
  validateType('StateProfile', raw?.stateProfile);
  validateType('ScopedCells', raw?.cells);
  if (raw.cells.some(cell => cell.availability !== 'KNOWN') ||
      canonicalJSON(raw.cells.map(cell => cell.position)) !== canonicalJSON(positions)) {
    const error = new Error('TARGET_FACTS_INCOMPLETE');
    error.publicError = { code: 'TARGET_FACTS_INCOMPLETE', phase: 'validate',
      retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE', transactionRef: null,
      causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' };
    throw error;
  }
  return structuredClone(raw);
}
