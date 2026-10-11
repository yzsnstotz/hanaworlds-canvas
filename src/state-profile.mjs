/** The world source owns the opaque state fields and their write rules. */
export function expectedWrittenRecord(before, effect, actual, profile) {
  const state = Object.fromEntries(profile.preservedFields
    .filter(field => Object.hasOwn(before.state, field)).map(field => [field, before.state[field]]));
  for (const field of profile.derivedFields)
    if (Object.hasOwn(actual.state, field)) state[field] = actual.state[field];
  return { position: before.position, geometryProfile: effect.geometryProfile,
    materialRef: effect.materialRef, orientation: effect.orientation, state };
}

/** Restore compares every saved field except those the engine derives again. */
export function withDerivedReadback(expected, actual) {
  const derived = expected.stateProfile.derivedFields;
  return { ...expected, records: expected.records.map((record, index) => {
    const state = { ...record.state };
    for (const field of derived) {
      delete state[field];
      if (Object.hasOwn(actual.records[index].state, field))
        state[field] = actual.records[index].state[field];
    }
    return { ...record, state };
  }) };
}
