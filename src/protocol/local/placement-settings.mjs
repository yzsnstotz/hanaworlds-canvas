/** Pure C-canvas consumer checks and static mock; no provider state or world access. */
import { contractMetadata } from './generated/contracts.mjs';
import { validateBoundRequest, validateBoundResponse, validateType, canonicalJSON } from './runtime.mjs';
import { requireFact, ContractError } from '../errors.mjs';
export const placementSettingsRead = contractMetadata.placementSettingsRead;
export function validatePlacementSettingsBinding(wire, operation, request, response) {
  if (wire !== placementSettingsRead.wire || operation !== placementSettingsRead.operation) return;
  requireFact((response.result === null) !== (response.error === null), 'SCHEMA_INVALID', 'INVALID_SHAPE');
  if (response.error) {
    requireFact(placementSettingsRead.errors.includes(response.error.code), 'SCHEMA_INVALID', 'INVALID_SHAPE');
    requireFact(response.error.mutationState === 'NONE' && response.error.transactionRef === null,
      'SCHEMA_INVALID', 'INVALID_SHAPE');
  } else requireFact(request.localContext !== null &&
    canonicalJSON(response.result.localContext) === canonicalJSON(request.localContext),
    'CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
}
export function readPlacementSettings(request, response) {
  const admitted = validateBoundResponse('canvas/v7', 'ReadPlacementSettings', request, response);
  if (admitted.error) throw Object.assign(new Error(admitted.error.code), { publicError: admitted.error });
  return admitted.result;
}
export function createPlacementSettingsMock(input) {
  const state = validateType('PlacementSettingsReadback', input);
  return Object.freeze({ effects: placementSettingsRead.effects, async call(operation, raw) {
    const request = validateBoundRequest('canvas/v7', operation, raw);
    requireFact(operation === 'ReadPlacementSettings', 'UNSUPPORTED_OPERATION', 'INVALID_SHAPE');
    const code = request.localContext === null ? 'WORLD_NOT_BOUND' :
      request.sessionRef !== state.sessionRef || request.worldRef !== state.worldRef ||
      canonicalJSON(request.localContext) !== canonicalJSON(state.localContext) ? 'CURRENT_WORLD_MISMATCH' : null;
    return validateBoundResponse('canvas/v7', operation, request, {
      contractVersion: 'canvas/v7', requestId: request.requestId,
      result: code ? null : state, error: code ? new ContractError(code, 'validate', 'SCOPE_DENIED').publicError : null,
    });
  } });
}
