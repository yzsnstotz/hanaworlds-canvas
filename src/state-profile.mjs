/** Derived fields alone follow engine readback, including disappearance. */
function withDerivedState(expected, actual, profile) {
  const state = { ...expected };
  for (const field of profile.derivedFields) {
    delete state[field];
    if (Object.hasOwn(actual, field)) state[field] = actual[field];
  }
  return state;
}

/** The world source owns the opaque state fields and their write rules. */
export function expectedWrittenRecord(before, effect, actual, profile) {
  const state = Object.fromEntries(profile.preservedFields
    .filter(field => Object.hasOwn(before.state, field)).map(field => [field, before.state[field]]));
  return { position: before.position, geometryProfile: effect.geometryProfile,
    materialRef: effect.materialRef, orientation: effect.orientation,
    state: withDerivedState(state, actual.state, profile) };
}

/** Restore compares every saved field except those the engine derives again. */
export function withDerivedReadback(expected, actual) {
  return { ...expected, records: expected.records.map((record, index) => ({
    ...record, state: withDerivedState(record.state, actual.records[index].state, expected.stateProfile),
  })) };
}
