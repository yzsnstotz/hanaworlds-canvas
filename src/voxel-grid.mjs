import { comparePosition, expandRegionBlock, requireGeometryProfile } from 'hanaworlds-contracts';

export const VOXEL_GRID = 'voxel-grid/v1';
/** Only this module interprets a footprint as integer cells. Never infer a profile. */
export function requireVoxelGrid(profile, worldGeometry) {
  if (profile !== VOXEL_GRID) {
    const error = new Error('CAPABILITY_GAP');
    error.publicError = { code: 'CAPABILITY_GAP', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
      mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'GEOMETRY_PROFILE_UNSUPPORTED' };
    throw error;
  }
  return worldGeometry === undefined ? profile : requireGeometryProfile(worldGeometry, profile);
}
export const positionKey = position => position.join(',');

export function cellPositions(operations, worldGeometry) {
  for (const effect of operations.effects) requireVoxelGrid(effect.geometryProfile, worldGeometry);
  const positions = operations.effects.map(effect => effect.position);
  if (!positions.length || new Set(positions.map(positionKey)).size !== positions.length) {
    const error = new Error('INVALID_OPERATIONS');
    error.publicError = { code: 'INVALID_OPERATIONS', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
      mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'PAYLOAD_CHANGED' };
    throw error;
  }
  return positions;
}

export function affectedObjectRefs(footprints, positions, profile, exceptObjectRef = null) {
  requireVoxelGrid(profile);
  const checked = new Set(positions.map(positionKey));
  return Object.entries(footprints ?? {})
    .filter(([objectRef, row]) => objectRef !== exceptObjectRef &&
      row.positions.some(position => checked.has(positionKey(position))))
    .map(([objectRef]) => objectRef).sort();
}

export function boxCells(box, profile) {
  requireVoxelGrid(profile);
  const cells = [];
  for (let z = box.min[2]; z <= box.max[2]; z++) for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let x = box.min[0]; x <= box.max[0]; x++) cells.push([x, y, z]);
  return cells;
}

export function footprintBounds(positions, profile) {
  requireVoxelGrid(profile);
  if (!positions.length) return null;
  const min = [0, 1, 2].map(axis => positions.reduce((v, p) => Math.min(v, p[axis]), Infinity));
  const max = [0, 1, 2].map(axis => positions.reduce((v, p) => Math.max(v, p[axis]), -Infinity));
  return { min, max, size: min.map((v, axis) => max[axis] - v + 1) };
}

/** Expand only specified cells; unspecified cells never cause an object overlap. */
export function regionPositions(operations, worldGeometry) {
  const positions = [];
  for (const chunk of operations.chunks) {
    requireVoxelGrid(chunk.block.geometryProfile, worldGeometry);
    const { box, indices } = expandRegionBlock(chunk.block);
    const sx = box.max[0] - box.min[0] + 1, sy = box.max[1] - box.min[1] + 1;
    indices.forEach((v, i) => { if (v !== -1) positions.push([box.min[0] + i % sx,
      box.min[1] + Math.floor(i / sx) % sy, box.min[2] + Math.floor(i / (sx * sy))]); });
  }
  return positions.sort(comparePosition);
}
