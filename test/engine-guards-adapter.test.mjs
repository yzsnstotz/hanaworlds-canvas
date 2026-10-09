import test from 'node:test';
import assert from 'node:assert/strict';
import { validateType } from 'hanaworlds-contracts';
import { unmetGuards } from '../src/index.mjs';

/*
 * FIXTURE transcription of the guard x stage coverage the Adapter publicly declares for
 * Contracts 1.0.0 (hanaworlds-adapter-luanti 0.12.1 README, "Contracts 1.0" table; main
 * 65383fac). The real gate reads the same declaration from ReadLocalConnection instead.
 */
const bodyAndProtection = ['PREPARE_RECOVERABLE', 'APPLY_COMPILED', 'APPLY_HISTORY', 'RESTORE',
  'REGION_APPLY', 'REGION_RESTORE'];
const adapter = validateType('EngineGuardDeclaration', { profileVersion: 'engine-guards/v1',
  coverage: [
    { guard: 'BODY_CLEARANCE', stages: bodyAndProtection, protectionPrincipal: null },
    { guard: 'CELL_PROTECTION', stages: bodyAndProtection, protectionPrincipal: 'ANONYMOUS' },
    { guard: 'PLAYER_ENCLOSURE', stages: ['PREPARE_RECOVERABLE', 'APPLY_COMPILED', 'APPLY_HISTORY'],
      protectionPrincipal: null }] });
const gaps = operation => unmetGuards(adapter, operation).map(u => `${u.guard}@${u.stage}`);

test('Adapter 0.12.1 declaration: cell BUILD/Undo/Redo and region recovery pass; region writes refused by name', () => {
  for (const operation of ['ApplyRecoverableCommit', 'Undo', 'Redo', 'RecoverRegion'])
    assert.deepEqual(gaps(operation), [], operation);
  assert.deepEqual(gaps('ApplyRegionCommit'), ['PLAYER_ENCLOSURE@REGION_APPLY']);
  assert.deepEqual(gaps('UndoRegionCommit'), ['PLAYER_ENCLOSURE@REGION_RESTORE']);
  assert.ok(unmetGuards(adapter, 'ApplyRegionCommit').every(u => u.finding === 'GUARD_UNAVAILABLE'));
});

test('a declaration without a write stage refuses that operation; Prepare stages alone do not count', () => {
  const prepareOnly = validateType('EngineGuardDeclaration', { profileVersion: 'engine-guards/v1',
    coverage: ['BODY_CLEARANCE', 'CELL_PROTECTION', 'PLAYER_ENCLOSURE'].map(guard => ({ guard,
      stages: ['PREPARE_RECOVERABLE', 'PREPARE_HISTORY'],
      protectionPrincipal: guard === 'CELL_PROTECTION' ? 'ANONYMOUS' : null })) });
  assert.deepEqual(unmetGuards(prepareOnly, 'Undo').map(u => u.stage).sort(),
    ['APPLY_HISTORY', 'APPLY_HISTORY', 'APPLY_HISTORY', 'RESTORE', 'RESTORE']);
});
