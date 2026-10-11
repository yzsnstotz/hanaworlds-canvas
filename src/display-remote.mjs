import { z } from 'zod';

// Authored against the public Typert descriptor API; no private Desktop bridge.
const triple = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const displaySchema = () => z.object({
  state: z.enum(['NO_SESSION', 'NO_WORLD', 'EMPTY', 'READY']), worldRef: z.string().nullable(),
  objects: z.array(z.object({ objectRef: z.string(), name: z.string().nullable(),
    occupiedCells: z.number().int().nonnegative(), bounds: z.object({ min: triple,
      max: triple, size: triple }).nullable() })),
  history: z.array(z.object({ transactionId: z.string(), objectRef: z.string(),
    objectName: z.string().nullable(), sequence: z.number().int(),
    committedAt: z.string().nullable(), mode: z.enum(['CELL', 'REGION']).nullable(),
    affectedCells: z.number().int().nonnegative().nullable(), status: z.enum(['COMMITTED', 'UNDONE']) })),
});
export const displayDescriptor = {
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/read',
  service: 'hanaworldsCanvasDisplay', namespace: 'hanaworldsCanvasDisplay', method: 'read',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'sessionRef', wire: 'sessionRef', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#DisplaySessionRef',
      create: () => z.string().min(1).nullable() } }],
  result: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#ObjectsHistoryDisplay', create: displaySchema },
};
const ref = (name, typeSymbol, nullable = false) => ({ name, wire: name, source: 'json',
  codec: { mode: 'strict', typeSymbol, create: () => nullable ? z.string().min(1).nullable() : z.string().min(1) } });
const undoStep = () => z.object({ available: z.boolean(), reason: z.string().nullable(),
  historyTransactionId: z.string().nullable() });
// Per object: whether its latest committed entry can be undone or redone now, and if not, Canvas's named reason.
const actionsSchema = () => z.object({
  state: z.enum(['NO_SESSION', 'NO_WORLD', 'EMPTY', 'READY']), worldRef: z.string().nullable(),
  objects: z.array(z.object({ objectRef: z.string(), mode: z.enum(['CELL', 'REGION']),
    applied: z.boolean(), undo: undoStep(), redo: undoStep() })),
});
export const actionsDescriptor = {
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/actions',
  service: 'hanaworldsCanvasDisplay', namespace: 'hanaworldsCanvasDisplay', method: 'actions',
  invocation: { kind: 'direct' },
  parameters: [ref('sessionRef', 'hanaworlds-canvas#DisplaySessionRef', true)],
  result: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#HistoryActionsDisplay', create: actionsSchema },
};
// The renderer names only the row the person clicked. World, revisions, context and the
// transaction itself are taken by the Host from Canvas's own durable Session binding.
export const undoDescriptor = {
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/undo',
  service: 'hanaworldsCanvasDisplay', namespace: 'hanaworldsCanvasDisplay', method: 'undo',
  invocation: { kind: 'direct' },
  parameters: [ref('sessionRef', 'hanaworlds-canvas#DisplaySessionRef'),
    ref('objectRef', 'hanaworlds-canvas#DisplayObjectRef'),
    ref('historyTransactionId', 'hanaworlds-canvas#DisplayTransactionRef')],
  result: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#DisplayUndoResult', create: () => z.object({
    status: z.string(), transactionId: z.string(), originTransactionId: z.string(),
    objectRef: z.string(), view: displaySchema() }) },
};
export const redoDescriptor = { ...undoDescriptor,
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/redo', method: 'redo',
  result: { ...undoDescriptor.result, typeSymbol: 'hanaworlds-canvas#DisplayRedoResult' } };
// Logical stream of change notices for one Session's panel; cancelled with the panel.
export const changesDescriptor = {
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/changes',
  service: 'hanaworldsCanvasDisplay', namespace: 'hanaworldsCanvasDisplay', method: 'changes',
  mode: 'stream', invocation: { kind: 'direct' },
  parameters: [ref('sessionRef', 'hanaworlds-canvas#DisplaySessionRef')],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#ObjectsHistoryChange', create: () => z.object({
    worldRef: z.string().nullable(), registryRevision: z.string().nullable() }) },
};
const descriptors = [displayDescriptor, actionsDescriptor, undoDescriptor, redoDescriptor, changesDescriptor];
export const displayHostContribution = { package: 'hanaworlds-canvas-display', face: 'host',
  schemas: [], invocations: descriptors, model: {} };
export const displayClientContribution = { package: 'hanaworlds-canvas-display', descriptors };
