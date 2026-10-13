// Explicit document-shaped peer inputs compiled only into the isolated production proof.
// Canvas constructors and public operations always resolve to the installed artifact.
import { mkdir } from 'node:fs/promises';
import { createUndoExample } from '../test/support/undo-example.mjs';
import { openUndoFixtureWorld, undoConnection, undoSessionRef } from '../test/support/undo-fixture-world.mjs';
import { undoWorldFile } from '../test/support/undo-host.mjs';
import { fixtureSessions } from './fixture-sessions.mjs';
export async function prepareSummaryPeers(directory) {
  await mkdir(directory, {recursive:true});
  const world = await openUndoFixtureWorld(undoWorldFile(directory), {create:true});
  await createUndoExample(directory, {world});
  return {world, sessions:fixtureSessions(), sessionRef:undoSessionRef,
    scope:Object.fromEntries(['worldRef','connectionRef','connectionIncarnationRef'].map(key => [key,undoConnection[key]]))};
}
