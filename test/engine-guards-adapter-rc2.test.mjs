import test from 'node:test';
import assert from 'node:assert/strict';
import { validateType } from 'hanaworlds-contracts';
import { unmetGuards } from '../src/index.mjs';

/*
 * FIXTURE transcription of the guard x stage coverage the Adapter publicly reports for
 * Contracts 1.0.0-rc.2 (hanaworlds-adapter-luanti-SUPPLY-01 REPORT, current section, table
 * 「guard×stage 声明」). Not read from Adapter source or a live engine. It shows which Canvas
 * operations that declaration lets through and which Canvas refuses, by guard x stage.
 */
const writeStages = ['PREPARE_RECOVERABLE', 'APPLY_COMPILED', 'APPLY_HISTORY', 'RESTORE', 'REGION_APPLY'];
const adapterRc2 = validateType('EngineGuardDeclaration', { profileVersion: 'engine-guards/v1',
  coverage: [
    { guard: 'BODY_CLEARANCE', stages: writeStages, protectionPrincipal: null },
    { guard: 'CELL_PROTECTION', stages: writeStages, protectionPrincipal: 'ANONYMOUS' },
    { guard: 'PLAYER_ENCLOSURE', stages: ['PREPARE_RECOVERABLE', 'APPLY_COMPILED', 'APPLY_HISTORY'],
      protectionPrincipal: null }] });
const gaps = operation => unmetGuards(adapterRc2, operation).map(u => `${u.guard}@${u.stage}`);

test('Adapter rc.2 declaration: BUILD passes; Undo/Redo and every region write are refused by name', () => {
  assert.deepEqual(gaps('ApplyRecoverableCommit'), []);
  for (const operation of ['Undo', 'Redo'])
    assert.deepEqual(gaps(operation), ['BODY_CLEARANCE@PREPARE_HISTORY',
      'CELL_PROTECTION@PREPARE_HISTORY', 'PLAYER_ENCLOSURE@PREPARE_HISTORY'], operation);
  assert.deepEqual(gaps('ApplyRegionCommit'), ['PLAYER_ENCLOSURE@REGION_APPLY',
    'BODY_CLEARANCE@REGION_RESTORE', 'CELL_PROTECTION@REGION_RESTORE']);
  assert.deepEqual(gaps('UndoRegionCommit'), ['BODY_CLEARANCE@REGION_RESTORE',
    'CELL_PROTECTION@REGION_RESTORE', 'PLAYER_ENCLOSURE@REGION_RESTORE']);
  assert.deepEqual(gaps('RecoverRegion'), ['BODY_CLEARANCE@REGION_RESTORE',
    'CELL_PROTECTION@REGION_RESTORE']);
  // One covered guard never stands in for another, nor one stage for another.
  assert.ok(unmetGuards(adapterRc2, 'Undo').every(u => u.finding === 'GUARD_UNAVAILABLE'));
});
