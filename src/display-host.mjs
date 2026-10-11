import { createHash, randomUUID } from 'node:crypto';
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { displayHostContribution } from './display-remote.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rejected = (reason, message) => new RemoteError('canvas/undo-rejected', message, { reason });
function canvasFor(ctx, method) {
  const canvas = ctx.get('hanaworldsCanvasV5');
  if (typeof canvas?.[method] !== 'function')
    throw new RemoteError('canvas/display-unavailable', `Canvas display service requires CanvasV5.${method}.`);
  return canvas;
}

export class CanvasDisplayService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'hanaworldsCanvasDisplay');
    // Apply the public standard decorator in native JS, using its initializer API.
    for (const name of ['read', 'actions', 'undo'])
      Remote(this[name], { kind: 'method', name, private: false, static: false,
        addInitializer: initializer => initializer.call(this) });
    // Methods are invoked through Cordis's traced service proxy, so state is a plain property.
    this.undoQueue = Promise.resolve();
  }
  async read(sessionRef) {
    return canvasFor(this.ctx, 'readObjectsHistory').readObjectsHistory(sessionRef);
  }
  /** What the panel may offer: Canvas's own readHistoryActions, reduced to Undo. Never executes. */
  async actions(sessionRef) {
    if (sessionRef === null) return { state: 'NO_SESSION', worldRef: null, objects: [] };
    const published = await canvasFor(this.ctx, 'readHistoryActions').readHistoryActions(sessionRef);
    return { state: published.state, worldRef: published.worldRef,
      objects: (published.objects ?? []).map(object => ({ objectRef: object.objectRef,
        mode: object.mode, applied: object.applied,
        undo: object.undo.available ?
          { available: true, reason: null, historyTransactionId: object.undo.historyTransactionId } :
          { available: false, reason: object.undo.reason, historyTransactionId: null } })) };
  }
  /**
   * One click = one canvas/v7 Undo of the entry the person clicked. The request is built only
   * from what Canvas itself published for this Session; Canvas re-validates history head,
   * revisions and the actual world cells, and commits or rolls back the whole transaction.
   */
  async undo(sessionRef, objectRef, historyTransactionId) {
    const canvas = canvasFor(this.ctx, 'readHistoryActions');
    const run = this.undoQueue.then(async () => {
      const published = await canvas.readHistoryActions(sessionRef);
      if (published.state === 'NO_WORLD') throw rejected('NO_WORLD', 'This Session has no Canvas world binding.');
      const object = published.objects.find(row => row.objectRef === objectRef);
      if (!object) throw rejected('OBJECT_NOT_FOUND', 'Canvas has no such object in this Session world.');
      const step = object.undo;
      if (!step.available) throw rejected(step.reason, `Canvas does not offer Undo: ${step.reason}.`);
      // The clicked row must still be the entry Canvas would undo; never undo a different one.
      if (step.historyTransactionId !== historyTransactionId)
        throw rejected('HISTORY_MOVED', 'The clicked entry is no longer the latest change of this object.');
      const transactionId = `canvas-panel-undo-${randomUUID()}`;
      const intent = { surface: 'app/canvas-objects-history', action: 'undo', sessionRef, objectRef,
        historyTransactionId };
      const request = { contractVersion: 'canvas/v7', sessionRef, requestId: transactionId,
        worldRef: published.worldRef, objectRef, transactionId, historyTransactionId,
        expectedHistoryRevision: step.expectedHistoryRevision,
        expectedWorldRevision: step.expectedWorldRevision,
        expectedObjectRevisions: step.expectedObjectRevisions,
        intentDigest: digest(intent), surfaceActionDigest: digest({ ...intent, transactionId }),
        localContext: published.localContext };
      const response = await canvas.call('Undo', request);
      if (response.error || response.result?.status !== 'VERIFIED')
        throw new RemoteError('canvas/undo-failed', `Canvas Undo did not verify: ${response.error?.code ?? response.result?.status}.`,
          { reason: response.error?.code ?? response.result?.status ?? 'UNKNOWN', transactionId,
            mutationState: response.error?.mutationState ?? null,
            // Contracts 2.7.0: the world Canvas needed, as Canvas's own public error named it.
            worldRef: response.error?.worldRef ?? null });
      // Written state is shown only from Canvas's own public read after the commit.
      return { status: response.result.status, transactionId, originTransactionId: historyTransactionId,
        objectRef, view: await canvas.readObjectsHistory(sessionRef) };
    });
    this.undoQueue = run.catch(() => {});
    return run;
  }
}
export const name = 'hanaworlds-canvas-display';
export const inject = ['typert', 'hanaworldsCanvasV5'];
export function apply(ctx) {
  ctx.typert.register(displayHostContribution);
  return new CanvasDisplayService(ctx);
}
export default { name, inject, apply };
