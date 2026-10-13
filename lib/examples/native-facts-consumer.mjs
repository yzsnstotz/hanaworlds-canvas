import {
  canonicalJSON,
  validateType
} from "../chunks/chunk-BTAVI4WZ.mjs";

// examples/native-facts-consumer.mjs
import { readFile } from "node:fs/promises";
var contracts = Object.freeze({ validateType, canonicalJSON });
function validateNativeFactsScopedState(raw, consumer = contracts) {
  consumer.validateType("Ref", raw?.worldRef);
  consumer.validateType("StateProfile", raw?.stateProfile);
  consumer.validateType("ScopedCells", raw?.cells);
  return structuredClone(raw);
}
async function createFixtureNativeFactsPort(consumer = contracts) {
  const raw = JSON.parse(await readFile(new URL("../../fixtures/native-facts-scoped-state.json", import.meta.url)));
  const source = JSON.parse(await readFile(new URL("../../fixtures/native-facts-scoped-state.source.json", import.meta.url)));
  validateNativeFactsScopedState(raw, consumer);
  return { async readScopedState(connectionRef, positions) {
    consumer.validateType("Ref", connectionRef);
    consumer.validateType("Positions", positions);
    if (connectionRef !== source.arguments[0] || consumer.canonicalJSON(positions) !== consumer.canonicalJSON(source.arguments[1]))
      throw new Error("NATIVE_FACTS_FIXTURE_ARGUMENT_MISMATCH");
    return structuredClone(raw);
  } };
}
export {
  createFixtureNativeFactsPort,
  validateNativeFactsScopedState
};
