import { readFile } from 'node:fs/promises';
import * as contracts from 'hanaworlds-contracts';

/** Validate the existing Canvas-owned injection return, not a new wire/type in
 * Contracts. Extra wrapper fields are not consumed; the three fields are required.
 * Subtype/order/uniqueness/KNOWN-digest rules come from public validateType.
 * Canvas subsequently matches world/profile/positions and requires every cell KNOWN.
 */
export function validateNativeFactsScopedState(raw, consumer = contracts) {
  consumer.validateType('Ref', raw?.worldRef);
  consumer.validateType('StateProfile', raw?.stateProfile);
  consumer.validateType('ScopedCells', raw?.cells);
  return structuredClone(raw);
}

/** Complete fixed SOURCE/FIXTURE input, never a real-world fact provider.
 * A real Host must supply current native facts from the selected Adapter connection.
 */
export async function createFixtureNativeFactsPort(consumer = contracts) {
  const raw = JSON.parse(await readFile(new URL('../fixtures/native-facts-scoped-state.json', import.meta.url)));
  const source = JSON.parse(await readFile(new URL('../fixtures/native-facts-scoped-state.source.json', import.meta.url)));
  validateNativeFactsScopedState(raw, consumer);
  return { async readScopedState(connectionRef, positions) {
    consumer.validateType('Ref', connectionRef);
    consumer.validateType('Positions', positions);
    if (connectionRef !== source.arguments[0] ||
        consumer.canonicalJSON(positions) !== consumer.canonicalJSON(source.arguments[1]))
      throw new Error('NATIVE_FACTS_FIXTURE_ARGUMENT_MISMATCH');
    return structuredClone(raw);
  } };
}
