import { requireFact } from './errors.mjs';
import { snapshotJSON } from './strict-json.mjs';
export const compareUTF16 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const comparePosition = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
export function assertPosition(p) {
  requireFact(Array.isArray(p) && p.length === 3 && p.every(Number.isSafeInteger), 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
}
export function assertBox(box) {
  assertPosition(box.min); assertPosition(box.max);
  requireFact(box.min.every((v, i) => v <= box.max[i]), 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
}
export function boxCellCount(box) {
  snapshotJSON(box); assertBox(box);
  return box.max.reduce((n, v, i) => n * (BigInt(v) - BigInt(box.min[i]) + 1n), 1n);
}
export function unionCellCount(boxes) {
  snapshotJSON(boxes); for (const b of boxes) assertBox(b);
  const ranges = boxes.map(b => ({ min: b.min.map(BigInt), max: b.max.map(v => BigInt(v) + 1n) }));
  function measure(items, axis) {
    if (!items.length) return 0n;
    if (axis === 3) return 1n;
    const cuts = [...new Set(items.flatMap(b => [b.min[axis], b.max[axis]]))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    let count = 0n;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      count += (b - a) * measure(items.filter(r => r.min[axis] <= a && r.max[axis] >= b), axis + 1);
    }
    return count;
  }
  return measure(ranges, 0);
}
export const inside = (p, box) => p.every((v, i) => v >= box.min[i] && v <= box.max[i]);
export function unionBounds(boxes) {
  requireFact(boxes.length > 0, 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
  for (const b of boxes) assertBox(b);
  const result = { min: [...boxes[0].min], max: [...boxes[0].max] };
  for (const b of boxes) for (let a = 0; a < 3; a++) { result.min[a] = Math.min(result.min[a], b.min[a]); result.max[a] = Math.max(result.max[a], b.max[a]); }
  return result;
}
export function validateExactEffects(operations, materials, effects) {
  for (const op of operations) assertBox(op);
  requireFact(unionCellCount(operations) === BigInt(effects.length), 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
  for (const effect of effects) {
    const op = operations.findLast(item => inside(effect.position, item));
    requireFact(op && Object.hasOwn(materials, op.materialRef), 'CATALOGUE_MISMATCH', 'CATALOGUE_UNRESOLVED');
    const material = materials[op.materialRef];
    requireFact(effect.nodeName === material.nodeName && effect.param2 === material.param2, 'SCHEMA_INVALID', 'INVALID_GEOMETRY');
  }
  return true;
}
