import type { ContractHandshake, OperationMap, ProtocolHandshake, RegionSnapshotContent,
  RegionSnapshotRef, RegionSummary } from 'hanaworlds-contracts';
import type { NativeFactsPort } from './native-facts.js';
import type Schema from '@deepseek-ai/schemastery';
export type { NativeFactsPort, NativeFactsScopedState } from './native-facts.js';

/** Public declaration only: canvas major 7/minor 1, no published per-cell tokens.
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
/** Canvas-owned placement policy; managed by the host plugin Config form. */
export interface CanvasConfig {
  placement?: Partial<{
    frontGapCells: number; forwardSearchCells: number;
    lateralSearchCells: number; verticalSearchCells: number;
  }>;
}
export const Config: Schema<CanvasConfig>;
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
    nativeFacts?: NativeFactsPort; sessions?: any; adapterId?: string; config?: CanvasConfig });
  store: CanvasStore | null;
  ready: Promise<void>;
  storageState: string;
  readonly contractHandshake: ContractHandshake;
  readonly protocolHandshake: ProtocolHandshake;
  status(): { component: string; version: string; canvasContract: string;
    adapterContract: string; storage: string; productReadiness: 'UNPROVEN' };
  current(sessionRef: string): any;
  /** Apply saved placement policy to bound worlds before host startup completes. */
  syncPlacementSettings(): Promise<void>;
  /** Exact pending History outcome; it never reapplies or forces Restore. */
  resolvePendingHistory(request: { sessionRef: string; transactionId: string }): Promise<{
    transactionId: string; status: string; recoveryPending?: boolean;
    receipt: import("hanaworlds-contracts").ReceiptProjection; response: unknown;
  }>;
  /** G3 write-before guard on the per-cell port; throws a public decode error when incompatible. */
  adapterCompatible(): ReturnType<typeof import('hanaworlds-contracts').checkProtocolCompatibility>;
  call<N extends keyof OperationMap['canvas/v7']>(operation: N,
    request: unknown): Promise<OperationMap['canvas/v7'][N]['response']>;
  readObjectsHistory(sessionRef: string | null): Promise<ObjectsHistoryDisplay>;
  readFootprints(worldRef: string, objectRefs: string[], request: unknown): Promise<any>;
  readHistoryFacts(request: unknown): Promise<any>;
  readWorldRevision(worldRef: string): Promise<string>;
  /** Plugin-owned read: per-object Undo/Redo availability plus every unfinished transaction of
   * the World; a rollback the engine refused stays `recoveryPending` (phase RESTORE_PENDING). */
  /** Canvas-own read: per write operation, the engine guards it needs and which are uncovered. */
  readEngineSafety(sessionRef: string): EngineSafetyReadback;
  readHistoryActions(sessionRef: string): Promise<{ state: string; worldRef: string | null;
    objects: any[]; recovery?: RecoveryRow[] } & Record<string, unknown>>;
}
export interface RecoveryRow {
  transactionId: string; mode: 'CELL' | 'REGION'; phase: string; recoveryPending: boolean;
  /** CELL: RESTORE_FAILED (canvas/v7 receipt, manual recovery) or RECOVERY_PENDING (unknown). */
  receiptStatus: 'RESTORE_FAILED' | 'RECOVERY_PENDING' | null;
  guardRefusal: import('hanaworlds-contracts').GuardRefusal | null;
  restoreCode: string | null; causeCode: string | null;
  /** NONE is proved by this transaction's public Abort receipt; an uncertain reply stays UNKNOWN. */
  mutationState: import('hanaworlds-contracts').MutationState;
  abortConfirmation: { transactionId: string; status: 'ABORTED_PREPARED'; mutationState: 'NONE' } | null;
  originalFailure: { error: import('hanaworlds-contracts').Error;
    guardRefusal: import('hanaworlds-contracts').GuardRefusal | null } | null;
  /** Failure of the later exact query, Abort or readback, distinct from originalFailure. */
  queryFailure: string | null;
}
export type EngineGuardOperation = 'ApplyRecoverableCommit' | 'Undo' | 'Redo' |
  'ApplyRegionCommit' | 'UndoRegionCommit' | 'RecoverRegion';
type GuardRequirement = { guard: import('hanaworlds-contracts').EngineGuard;
  stage: import('hanaworlds-contracts').EngineGuardStage };
/** Contracts engine-guards/v1 guard x stage requirements of each Canvas write operation. */
export const ENGINE_GUARD_REQUIREMENTS: Readonly<Record<EngineGuardOperation,
  readonly Readonly<GuardRequirement>[]>>;
/** Uncovered requirements of `operation` against a declaration, as GUARD_UNAVAILABLE refusals. */
export function unmetGuards(declaration: import('hanaworlds-contracts').EngineGuardDeclaration | null,
  operation: EngineGuardOperation): import('hanaworlds-contracts').GuardRefusal[];
export interface EngineSafetyReadback {
  sessionRef: string; bound: boolean;
  declaration: import('hanaworlds-contracts').EngineGuardDeclaration | null;
  operations: { operation: EngineGuardOperation; required: GuardRequirement[];
    unmet: import('hanaworlds-contracts').GuardRefusal[]; status: 'COVERED' | 'CAPABILITY_UNAVAILABLE' }[];
}
/** Data directory name under `<dsh home>/data` for the v2 store; older data is never read. */
export const STORE_ROOT: 'hanaworlds-canvas-v2';
export class CanvasRegionV1 {
  constructor(canvas: CanvasV5, regionAdapter: any);
  readonly protocolHandshake: ProtocolHandshake;
  /** Re-read the selected world's capabilities. No Session returns an unbound description. */
  describe(sessionRef?: string | null): Promise<Record<string, unknown>>;
  call<N extends keyof OperationMap['canvas-region/v3']>(operation: N,
    request: unknown): Promise<OperationMap['canvas-region/v3'][N]['response']>;
  recoverPending(): Promise<any>;
}
/** Region-only canvas-region major 3/minor 1; not the per-cell declaration. */
export const canvasProtocolHandshake: ProtocolHandshake;
export const REGION_WIRE: 'canvas-region/v3';
export const REGION_ADAPTER: 'world-adapter-region/v3';
export const CANVAS_REGION_CAPABILITIES: readonly string[];
export const ADAPTER_REGION_REQUIREMENT: import('hanaworlds-contracts').ProtocolRequirement;
export const ADAPTER_CELL_REQUIREMENT: import('hanaworlds-contracts').ProtocolRequirement;
export const SNAPSHOT_COMPRESSION: 'gzip';
export function regionToolDescription(capabilities?: any): Record<string, unknown>;
export function encodeSnapshot(content: RegionSnapshotContent, before: RegionSummary):
  Promise<{ ref: RegionSnapshotRef; compressed: Uint8Array; rawByteLength: number }>;
export function decodeSnapshot(compressed: Uint8Array, ref: RegionSnapshotRef,
  before: RegionSummary): Promise<RegionSnapshotContent>;
/** Stage 1 validation configuration supply (Canvas-own observation; not a Contracts wire). */
export type ConfigFieldSource = 'CONTRACT_SCHEMA' | 'ENGINE_FACT' | 'UNMAPPED';
export interface ConfigFieldRow {
  status: 'SUPPLIED' | 'MISSING';
  value: unknown;
  provenance: { kind: ConfigFieldSource; ref: string; sourceRevision: string; basis?: string } | null;
  sourceKind?: ConfigFieldSource; reason?: 'REQUIRED_FACT_UNKNOWN' | 'REVISION_CHANGED';
  need?: string; cause?: string;
}
export interface ConfigDomain {
  worldRef: string; connectionRef: string; connectionIncarnationRef: string;
  payloadVersion: string; capabilityRevision: string | null;
}
export interface ConfigProfileObservation<T> {
  type: 'CompilationConfig';
  status: 'SUPPLIED' | 'SOURCE_MISSING' | 'NOT_BOUND';
  value: T | null; digest: string | null; revision: string | null;
  fields: Record<string, ConfigFieldRow> | null;
  missing: { profile: string; field: string; sourceKind: ConfigFieldSource; reason: string;
    need: string; cause: string | null }[];
}
export interface ConfigObservation {
  contracts: string; domain: ConfigDomain | null; sessionRefs: string[];
  sources: { catalogue: { status: string; digest?: string; cause?: string } } | null;
  profiles: { compilationConfig: ConfigProfileObservation<import('hanaworlds-contracts').CompilationConfig> };
  observationDigest: string; observedSequence: number; observedAt: string;
}
export interface ConfigSupplyReport {
  profileVersion: 'canvas-stage1-config-supply/v2'; authority: 'hanaworlds-canvas';
  worldRef: string; current: ConfigObservation;
  history: (ConfigObservation & { supersededAt: string; supersededBy: string;
    invalidationReasons: string[] })[];
}
/** Host keys: hanaworldsCompilerConfig.read, hanaworldsCanvasConfigSupply.read. Canvas provides
 * no SafetyProfile (its only source is the player's confirmed intent). Missing sources reject with
 * publicError CAPABILITY_UNAVAILABLE plus missingSources; an unbound World rejects WORLD_NOT_BOUND. */
export class CanvasConfigSupply {
  constructor(canvas: CanvasV5);
  read(worldRef: string): Promise<ConfigSupplyReport>;
  readCompilerConfig(worldRef: string): Promise<{
    compilationConfig: import('hanaworlds-contracts').CompilationConfig; compilerRevision: string }>;
}
export const SUPPLY_PROFILE: 'canvas-stage1-config-supply/v2';
export function assembleProfile(name: 'compilationConfig',
  fields: Record<string, ConfigFieldRow>, domain: ConfigDomain): ConfigProfileObservation<unknown>;
export function boundDomain(snapshot: any, worldRef: string):
  { domain: ConfigDomain; sessionRefs: string[] }[];
export const name: 'hanaworlds-canvas';
export const inject: string[];
export function apply(ctx: CanvasHostContext, config?: CanvasConfig): CanvasV5;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
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
