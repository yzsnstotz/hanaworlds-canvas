import {
  displayHostContribution
} from "../chunks/chunk-JEWBEX2Y.mjs";
import {
  observeDisplayFailure
} from "../chunks/chunk-BI5G6EY4.mjs";
import {
  checkProtocolCompatibility,
  protocolRequirement
} from "../chunks/chunk-ZMSQQTQX.mjs";

// src/display-host.mjs
import { createHash, randomUUID } from "node:crypto";
import { TypertRemoteService, Remote, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
var digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
var rejected = (action, reason, message) => new RemoteError(`canvas/${action}-rejected`, message, { reason });
function canvasFor(ctx, method) {
  const canvas = ctx.get("hanaworldsCanvasV5");
  if (typeof canvas?.[method] !== "function")
    throw new RemoteError("canvas/display-unavailable", `Canvas display service requires CanvasV5.${method}.`);
  return canvas;
}
async function readyCanvasFor(ctx, method) {
  const canvas = canvasFor(ctx, method);
  await canvas.ready;
  if (canvas.storageState === "UNAVAILABLE")
    throw new RemoteError(
      "canvas/storage-unavailable",
      "Canvas storage initialization failed.",
      { storageFailure: canvas.storageFailure ?? null }
    );
  return canvas;
}
var CanvasDisplayService = class extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "hanaworldsCanvasDisplay");
    for (const name2 of ["read", "actions", "undo", "redo"])
      Remote(this[name2], {
        kind: "method",
        name: name2,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(this)
      });
    Remote({ mode: "stream" })(this.changes, {
      kind: "method",
      name: "changes",
      private: false,
      static: false,
      addInitializer: (initializer) => initializer.call(this)
    });
    this.historyQueue = Promise.resolve();
  }
  async read(sessionRef) {
    try {
      return await (await readyCanvasFor(this.ctx, "readObjectsHistory")).readObjectsHistory(sessionRef);
    } catch (error) {
      observeDisplayFailure(this, "read", error);
      throw error;
    }
  }
  /**
   * Logical stream: one item after each durable Canvas commit that changes what this Session's
   * panel shows, so a build, Undo or Redo made anywhere (Workshop, skills, this panel) appears
   * without the person refreshing. Items carry no data; the panel re-reads read/actions.
   */
  changes(sessionRef, signal) {
    return canvasFor(this.ctx, "watchObjectsHistory").watchObjectsHistory(sessionRef, signal);
  }
  /** Canvas's own Undo/Redo availability. Never executes. */
  async actions(sessionRef) {
    if (sessionRef === null) return { state: "NO_SESSION", worldRef: null, objects: [] };
    const published = await (await readyCanvasFor(this.ctx, "readHistoryActions")).readHistoryActions(sessionRef);
    return {
      state: published.state,
      worldRef: published.worldRef,
      objects: (published.objects ?? []).map((object) => ({
        objectRef: object.objectRef,
        mode: object.mode,
        applied: object.applied,
        ...Object.fromEntries(["undo", "redo"].map((action) => [action, object[action].available ? { available: true, reason: null, historyTransactionId: object[action].historyTransactionId } : { available: false, reason: object[action].reason, historyTransactionId: null }]))
      }))
    };
  }
  /**
   * One click = one canvas/v7 Undo or Redo of the entry the person clicked. The request is built only
   * from what Canvas itself published for this Session; Canvas re-validates history head,
   * revisions and the actual world cells, and commits or rolls back the whole transaction.
   */
  undo(sessionRef, objectRef, historyTransactionId) {
    return this.performHistory("undo", sessionRef, objectRef, historyTransactionId);
  }
  redo(sessionRef, objectRef, historyTransactionId) {
    return this.performHistory("redo", sessionRef, objectRef, historyTransactionId);
  }
  async performHistory(action, sessionRef, objectRef, historyTransactionId) {
    try {
      const canvas = await readyCanvasFor(this.ctx, "readHistoryActions");
      const operation = action === "redo" ? "Redo" : "Undo";
      const run = this.historyQueue.then(async () => {
        const published = await canvas.readHistoryActions(sessionRef);
        if (published.state === "NO_WORLD") throw rejected(action, "NO_WORLD", "This Session has no Canvas world binding.");
        const object = published.objects.find((row) => row.objectRef === objectRef);
        if (!object) throw rejected(action, "OBJECT_NOT_FOUND", "Canvas has no such object in this Session world.");
        const step = object[action];
        if (!step.available) throw rejected(action, step.reason, `Canvas does not offer ${operation}: ${step.reason}.`);
        if (step.historyTransactionId !== historyTransactionId)
          throw rejected(action, "HISTORY_MOVED", "The clicked entry is no longer the latest change of this object.");
        const transactionId = `canvas-panel-${action}-${randomUUID()}`;
        const intent = {
          surface: "app/canvas-objects-history",
          action,
          sessionRef,
          objectRef,
          historyTransactionId
        };
        const request = {
          contractVersion: "canvas/v7",
          sessionRef,
          requestId: transactionId,
          worldRef: published.worldRef,
          objectRef,
          transactionId,
          historyTransactionId,
          expectedHistoryRevision: step.expectedHistoryRevision,
          expectedWorldRevision: step.expectedWorldRevision,
          expectedObjectRevisions: step.expectedObjectRevisions,
          intentDigest: digest(intent),
          surfaceActionDigest: digest({ ...intent, transactionId }),
          localContext: published.localContext
        };
        let response;
        if (step.operation === "UndoScopedRegionCommit") {
          const region = this.ctx.get("hanaworldsCanvasRegionV1");
          if (typeof region?.call !== "function") throw rejected(action, "REGION_SCOPE_EVIDENCE_UNAVAILABLE", "Canvas scoped region undo is unavailable.");
          checkProtocolCompatibility(region.protocolHandshake, [protocolRequirement("canvas-region/v3", ["canvas-region/v3:confirmed-scope-undo"], 2)]);
          response = await region.call("UndoScopedRegionCommit", {
            contractVersion: "canvas-region/v3",
            sessionRef,
            requestId: transactionId,
            worldRef: published.worldRef,
            originTransactionId: historyTransactionId,
            undoTransactionId: transactionId,
            expectedHistoryRevision: step.expectedHistoryRevision,
            expectedScopeDigest: step.expectedScopeDigest,
            localContext: published.localContext
          });
        } else response = await canvas.call(operation, request);
        const outcome = response.result?.outcome ?? response.result;
        if (response.error || outcome?.status !== "VERIFIED")
          throw new RemoteError(
            `canvas/${action}-failed`,
            `Canvas ${operation} did not verify: ${response.error?.code ?? outcome?.status}.`,
            {
              reason: response.error?.code ?? outcome?.status ?? "UNKNOWN",
              transactionId,
              mutationState: response.error?.mutationState ?? null,
              // Contracts 2.7.0: the world Canvas needed, as Canvas's own public error named it.
              worldRef: response.error?.worldRef ?? null
            }
          );
        return {
          status: outcome.status,
          transactionId,
          originTransactionId: historyTransactionId,
          objectRef,
          view: await canvas.readObjectsHistory(sessionRef)
        };
      });
      this.historyQueue = run.catch(() => {
      });
      return await run;
    } catch (error) {
      observeDisplayFailure(this, action, error);
      throw error;
    }
  }
};
var name = "hanaworlds-canvas-display";
var inject = ["typert", "hanaworldsCanvasV5"];
function apply(ctx) {
  ctx.typert.register(displayHostContribution);
  return new CanvasDisplayService(ctx);
}
var display_host_default = { name, inject, apply };
export {
  CanvasDisplayService,
  apply,
  display_host_default as default,
  inject,
  name
};
