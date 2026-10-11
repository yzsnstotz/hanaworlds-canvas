// src/display-remote.mjs
import { z } from "zod";
var triple = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
var displaySchema = () => z.object({
  state: z.enum(["NO_SESSION", "NO_WORLD", "EMPTY", "READY"]),
  worldRef: z.string().nullable(),
  objects: z.array(z.object({
    objectRef: z.string(),
    name: z.string().nullable(),
    occupiedCells: z.number().int().nonnegative(),
    bounds: z.object({
      min: triple,
      max: triple,
      size: triple
    }).nullable()
  })),
  history: z.array(z.object({
    transactionId: z.string(),
    objectRef: z.string(),
    objectName: z.string().nullable(),
    sequence: z.number().int(),
    committedAt: z.string().nullable(),
    mode: z.enum(["CELL", "REGION"]).nullable(),
    affectedCells: z.number().int().nonnegative().nullable(),
    status: z.enum(["COMMITTED", "UNDONE"])
  }))
});
var displayDescriptor = {
  id: "hanaworlds-canvas#hanaworldsCanvasDisplay/read",
  service: "hanaworldsCanvasDisplay",
  namespace: "hanaworldsCanvasDisplay",
  method: "read",
  invocation: { kind: "direct" },
  parameters: [{
    name: "sessionRef",
    wire: "sessionRef",
    source: "json",
    codec: {
      mode: "strict",
      typeSymbol: "hanaworlds-canvas#DisplaySessionRef",
      create: () => z.string().min(1).nullable()
    }
  }],
  result: { mode: "strict", typeSymbol: "hanaworlds-canvas#ObjectsHistoryDisplay", create: displaySchema }
};
var ref = (name, typeSymbol, nullable = false) => ({
  name,
  wire: name,
  source: "json",
  codec: { mode: "strict", typeSymbol, create: () => nullable ? z.string().min(1).nullable() : z.string().min(1) }
});
var undoStep = () => z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  historyTransactionId: z.string().nullable()
});
var actionsSchema = () => z.object({
  state: z.enum(["NO_SESSION", "NO_WORLD", "EMPTY", "READY"]),
  worldRef: z.string().nullable(),
  objects: z.array(z.object({
    objectRef: z.string(),
    mode: z.enum(["CELL", "REGION"]),
    applied: z.boolean(),
    undo: undoStep(),
    redo: undoStep()
  }))
});
var actionsDescriptor = {
  id: "hanaworlds-canvas#hanaworldsCanvasDisplay/actions",
  service: "hanaworldsCanvasDisplay",
  namespace: "hanaworldsCanvasDisplay",
  method: "actions",
  invocation: { kind: "direct" },
  parameters: [ref("sessionRef", "hanaworlds-canvas#DisplaySessionRef", true)],
  result: { mode: "strict", typeSymbol: "hanaworlds-canvas#HistoryActionsDisplay", create: actionsSchema }
};
var undoDescriptor = {
  id: "hanaworlds-canvas#hanaworldsCanvasDisplay/undo",
  service: "hanaworldsCanvasDisplay",
  namespace: "hanaworldsCanvasDisplay",
  method: "undo",
  invocation: { kind: "direct" },
  parameters: [
    ref("sessionRef", "hanaworlds-canvas#DisplaySessionRef"),
    ref("objectRef", "hanaworlds-canvas#DisplayObjectRef"),
    ref("historyTransactionId", "hanaworlds-canvas#DisplayTransactionRef")
  ],
  result: { mode: "strict", typeSymbol: "hanaworlds-canvas#DisplayUndoResult", create: () => z.object({
    status: z.string(),
    transactionId: z.string(),
    originTransactionId: z.string(),
    objectRef: z.string(),
    view: displaySchema()
  }) }
};
var redoDescriptor = {
  ...undoDescriptor,
  id: "hanaworlds-canvas#hanaworldsCanvasDisplay/redo",
  method: "redo",
  result: { ...undoDescriptor.result, typeSymbol: "hanaworlds-canvas#DisplayRedoResult" }
};
var changesDescriptor = {
  id: "hanaworlds-canvas#hanaworldsCanvasDisplay/changes",
  service: "hanaworldsCanvasDisplay",
  namespace: "hanaworldsCanvasDisplay",
  method: "changes",
  mode: "stream",
  invocation: { kind: "direct" },
  parameters: [ref("sessionRef", "hanaworlds-canvas#DisplaySessionRef")],
  cancellation: { parameter: "signal" },
  result: { mode: "strict", typeSymbol: "hanaworlds-canvas#ObjectsHistoryChange", create: () => z.object({
    worldRef: z.string().nullable(),
    registryRevision: z.string().nullable()
  }) }
};
var descriptors = [displayDescriptor, actionsDescriptor, undoDescriptor, redoDescriptor, changesDescriptor];
var displayHostContribution = {
  package: "hanaworlds-canvas-display",
  face: "host",
  schemas: [],
  invocations: descriptors,
  model: {}
};
var displayClientContribution = { package: "hanaworlds-canvas-display", descriptors };

export {
  displayDescriptor,
  actionsDescriptor,
  undoDescriptor,
  redoDescriptor,
  changesDescriptor,
  displayHostContribution,
  displayClientContribution
};
