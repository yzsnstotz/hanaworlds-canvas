// src/state-profile.mjs
function withDerivedState(expected, actual, profile) {
  const state = { ...expected };
  for (const field of profile.derivedFields) {
    delete state[field];
    if (Object.hasOwn(actual, field)) state[field] = actual[field];
  }
  return state;
}
function expectedWrittenRecord(before, effect, actual, profile) {
  const state = Object.fromEntries(profile.preservedFields.filter((field) => Object.hasOwn(before.state, field)).map((field) => [field, before.state[field]]));
  return {
    position: before.position,
    geometryProfile: effect.geometryProfile,
    materialRef: effect.materialRef,
    orientation: effect.orientation,
    state: withDerivedState(state, actual.state, profile)
  };
}
function withDerivedReadback(expected, actual) {
  return { ...expected, records: expected.records.map((record, index) => ({
    ...record,
    state: withDerivedState(record.state, actual.records[index].state, expected.stateProfile)
  })) };
}

export {
  expectedWrittenRecord,
  withDerivedReadback
};
