import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ObjectsHistoryDisplay } from './index.js';

/** Canvas's public availability projection; revisions stay on the Host. */
export type HistoryActionDisplay = {
  available: true;
  reason: null;
  historyTransactionId: string;
} | {
  available: false;
  reason: string;
  historyTransactionId: null;
};

export interface HistoryActionsDisplay {
  state: ObjectsHistoryDisplay['state'];
  worldRef: string | null;
  objects: {
    objectRef: string;
    mode: 'CELL' | 'REGION';
    applied: boolean;
    undo: HistoryActionDisplay;
    redo: HistoryActionDisplay;
  }[];
}

/** Returned only after Canvas verifies the history operation and re-reads its view. */
export interface DisplayHistoryResult {
  status: 'VERIFIED';
  transactionId: string;
  originTransactionId: string;
  objectRef: string;
  view: ObjectsHistoryDisplay;
}

/** A durable change notice; the panel re-reads read/actions for the current data. */
export interface ObjectsHistoryChange {
  worldRef: string | null;
  registryRevision: string | null;
}

export class CanvasDisplayService extends TypertRemoteService {
  constructor(ctx: Context);
  /** Serializes this service's history operations. */
  historyQueue: Promise<void | DisplayHistoryResult>;
  read(sessionRef: string | null): Promise<ObjectsHistoryDisplay>;
  actions(sessionRef: string | null): Promise<HistoryActionsDisplay>;
  undo(sessionRef: string, objectRef: string, historyTransactionId: string): Promise<DisplayHistoryResult>;
  redo(sessionRef: string, objectRef: string, historyTransactionId: string): Promise<DisplayHistoryResult>;
  changes(sessionRef: string, signal?: AbortSignal): AsyncGenerator<ObjectsHistoryChange, void, undefined>;
  /** Shared Host implementation used by undo and redo. */
  performHistory(action: 'undo' | 'redo', sessionRef: string, objectRef: string,
    historyTransactionId: string): Promise<DisplayHistoryResult>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hanaworldsCanvasDisplay: CanvasDisplayService;
  }
}

export const name: 'hanaworlds-canvas-display';
export const inject: ['typert', 'hanaworldsCanvasV5'];
export function apply(ctx: Context): CanvasDisplayService;
declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply };
export default plugin;
