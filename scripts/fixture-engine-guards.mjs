import { engineGuards, validateType } from 'hanaworlds-contracts';

/*
 * FIXTURE engine-guards/v1 declarations for in-memory peer Adapters (tests and dev pages). They
 * are claims of a fixture, never of a real engine: `covering` names every stage for every guard
 * (CELL_PROTECTION asked ANONYMOUSly), `without` drops chosen guard x stage pairs.
 */
const STAGES = engineGuards.stages.map(row => row.stage);
const GUARDS = Object.keys(engineGuards.guards).sort();
export function fixtureEngineGuards({ without = [] } = {}) {
  const dropped = new Set(without.map(({ guard, stage }) => `${guard}@${stage}`));
  return validateType('EngineGuardDeclaration', { profileVersion: 'engine-guards/v1',
    coverage: GUARDS.map(guard => ({ guard,
      stages: STAGES.filter(stage => !dropped.has(`${guard}@${stage}`)),
      protectionPrincipal: guard === 'CELL_PROTECTION' ? 'ANONYMOUS' : null }))
      .filter(row => row.stages.length) });
}
const GUARDED = new Set(engineGuards.stages.map(row => `${row.wire}#${row.operation}`));
/** A fixture Adapter response with the Contracts guardRefusal slot where the wire has one. */
export function guardSlot(wire, operation, response, guardRefusal = null) {
  return GUARDED.has(`${wire}#${operation}`) ? { ...response, guardRefusal } : response;
}
