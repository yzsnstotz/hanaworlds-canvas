import type { ContractHandshake, OperationMap, ProtocolHandshake, RegionSnapshotContent,
  RegionSnapshotRef, RegionSummary } from 'hanaworlds-contracts';
import type { NativeFactsPort } from './native-facts.js';
export type { NativeFactsPort, NativeFactsScopedState } from './native-facts.js';

/** Public declaration only: canvas major 5/minor 0, no published per-cell tokens.
 * Read this property on the real hanaworldsCanvasV5 service supplied by apply(ctx).
 * It declares the protocol; it does not establish storage/world readiness.
 */
export interface CanvasV5ProtocolSource {
  readonly protocolHandshake: ProtocolHandshake;
}
export interface CanvasHostContext {
  get?(name: string): any;
  provide?(name: string, service: any): unknown;
}
export class CanvasStore {
  directory: string;
  snapshot: any;
  unavailable: boolean;
  busy: Promise<unknown>;
  constructor(directory: string, snapshot: any);
  static open(directory: string): Promise<CanvasStore>;
  commit<T>(change: (state: any) => T | Promise<T>): Promise<T>;
}
export class CanvasV5 implements CanvasV5ProtocolSource {
  constructor(options: { store: CanvasStore | null; adapter?: any;
    nativeFacts?: NativeFactsPort; adapterId?: string });
  store: CanvasStore | null;
  ready: Promise<void>;
  storageState: string;
  readonly contractHandshake: ContractHandshake;
  readonly protocolHandshake: ProtocolHandshake;
  status(): { component: string; version: string; canvasContract: string;
    adapterContract: string; storage: string; productReadiness: 'UNPROVEN' };
  current(sessionRef: string): any;
  call<N extends keyof OperationMap['canvas/v5']>(operation: N,
    request: unknown): Promise<OperationMap['canvas/v5'][N]['response']>;
  readObjectsHistory(sessionRef: string | null): Promise<ObjectsHistoryDisplay>;
  readFootprints(worldRef: string, objectRefs: string[], request: unknown): Promise<any>;
  readHistoryFacts(request: unknown): Promise<any>;
  readWorldRevision(worldRef: string): Promise<string>;
}
export class CanvasRegionV1 {
  constructor(canvas: CanvasV5, regionAdapter: any);
  readonly protocolHandshake: ProtocolHandshake;
  describe(): Record<string, unknown>;
  call<N extends keyof OperationMap['canvas-region/v1']>(operation: N,
    request: unknown): Promise<OperationMap['canvas-region/v1'][N]['response']>;
  recoverPending(): Promise<any>;
}
/** Region-only canvas-region major 1/minor 0; not the per-cell declaration. */
export const canvasProtocolHandshake: ProtocolHandshake;
export const REGION_WIRE: 'canvas-region/v1';
export const REGION_ADAPTER: 'world-adapter-region/v1';
export const CANVAS_REGION_CAPABILITIES: readonly string[];
export const ADAPTER_REGION_REQUIREMENT: import('hanaworlds-contracts').ProtocolRequirement;
export const SNAPSHOT_COMPRESSION: 'gzip';
export const regionToolDescription: Readonly<Record<string, unknown>>;
export function encodeSnapshot(content: RegionSnapshotContent, before: RegionSummary):
  Promise<{ ref: RegionSnapshotRef; compressed: Uint8Array; rawByteLength: number }>;
export function decodeSnapshot(compressed: Uint8Array, ref: RegionSnapshotRef,
  before: RegionSummary): Promise<RegionSnapshotContent>;
export const name: 'hanaworlds-canvas';
export const inject: string[];
export function apply(ctx: CanvasHostContext): CanvasV5;
declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply };
export default plugin;

/** Canvas-owned read-only display projection, not a BUILD wire protocol. */
export interface ObjectsHistoryDisplay {
  state: 'NO_SESSION' | 'NO_WORLD' | 'EMPTY' | 'READY';
  worldRef: string | null;
  objects: { objectRef: string; name: string | null; occupiedCells: number;
    bounds: { min: [number, number, number]; max: [number, number, number];
      size: [number, number, number] } | null }[];
  history: { transactionId: string; objectRef: string; objectName: string | null;
    sequence: number; committedAt: string | null; mode: 'CELL' | 'REGION' | null;
    affectedCells: number | null; status: 'COMMITTED' | 'UNDONE' }[];
}
