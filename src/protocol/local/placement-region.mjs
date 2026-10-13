// Pure neutral Canvas admission over caller-supplied current ReadLocalConnection facts.
// Strict decoding stays backward compatible; this provider check never supplies a default.
import {validateType, validateBoundRequest, validateBoundResponse} from './runtime.mjs';
import {requireGeometryProfile} from './region.mjs';
import {requireFact} from '../errors.mjs';

export function validatePlacementRegionRequest(requestInput, connectionInput) {
  const request = validateBoundRequest('canvas/v7', 'InspectPlacementRegion', requestInput);
  const profile = request.footprint.geometryProfile;
  requireFact(profile !== undefined, 'CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
  const connection = validateType('LocalConnectionReadback', connectionInput), context = request.localContext;
  requireFact(connection.worldRef === request.worldRef && connection.capabilities.worldRef === request.worldRef &&
    connection.connectionRef === context.connectionRef && connection.connectionIncarnationRef === context.connectionIncarnationRef,
    'CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
  // This minor adds a selector, not a new geometry variant for TargetFacts or dimensions.
  requireFact(profile === 'voxel-grid/v1', 'CAPABILITY_GAP', 'GEOMETRY_PROFILE_UNSUPPORTED');
  requireGeometryProfile(connection.capabilities.worldGeometry, profile);
  return request;
}

export function validatePlacementRegionResponse(requestInput, responseInput, connectionInput) {
  const request = validatePlacementRegionRequest(requestInput, connectionInput);
  return validateBoundResponse('canvas/v7', 'InspectPlacementRegion', request, responseInput);
}
