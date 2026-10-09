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
  /** G3 write-before guard on the per-cell port; throws a public decode error when incompatible. */
  adapterCompatible(): ReturnType<typeof import('hanaworlds-contracts').checkProtocolCompatibility>;
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
export const ADAPTER_CELL_REQUIREMENT: import('hanaworlds-contracts').ProtocolRequirement;
export const SNAPSHOT_COMPRESSION: 'gzip';
export const regionToolDescription: Readonly<Record<string, unknown>>;
export function encodeSnapshot(content: RegionSnapshotContent, before: RegionSummary):
  Promise<{ ref: RegionSnapshotRef; compressed: Uint8Array; rawByteLength: number }>;
export function decodeSnapshot(compressed: Uint8Array, ref: RegionSnapshotRef,
  before: RegionSummary): Promise<RegionSnapshotContent>;
/** Stage 1 validation configuration supply (Canvas-own observation; not a Contracts wire). */
export type ConfigFieldSource = 'CONTRACT_SCHEMA' | 'ENGINE_FACT' | 'DECLARED_POLICY' |
  'UNDEFINED_IN_CONTRACT' | 'UNMAPPED';
export interface ConfigFieldRow {
  status: 'SUPPLIED' | 'MISSING';
  value: unknown;
  provenance: { kind: ConfigFieldSource; ref: string; sourceRevision: string } | null;
  sourceKind?: ConfigFieldSource; reason?: 'REQUIRED_FACT_UNKNOWN' | 'POLICY_UNAVAILABLE';
  need?: string; cause?: string;
}
export interface ConfigDomain {
  worldRef: string; connectionRef: string; connectionIncarnationRef: string;
  payloadVersion: string; capabilityRevision: string | null;
}
export interface ConfigProfileObservation<T> {
  type: 'SafetyProfile' | 'CompilationConfig';
  status: 'SUPPLIED' | 'SOURCE_MISSING' | 'NOT_BOUND';
  value: T | null; digest: string | null; revision: string | null;
  fields: Record<string, ConfigFieldRow> | null;
  missing: { profile: string; field: string; sourceKind: ConfigFieldSource; reason: string;
    need: string; cause: string | null }[];
}
export interface ConfigObservation {
  contracts: string; domain: ConfigDomain | null; sessionRefs: string[];
  sources: { catalogue: { status: string; digest?: string; cause?: string } } | null;
  profiles: { safetyProfile: ConfigProfileObservation<import('hanaworlds-contracts').SafetyProfile>;
    compilationConfig: ConfigProfileObservation<import('hanaworlds-contracts').CompilationConfig> };
  observationDigest: string; observedSequence: number; observedAt: string;
}
export interface ConfigSupplyReport {
  profileVersion: 'canvas-stage1-config-supply/v1'; authority: 'hanaworlds-canvas';
  worldRef: string; current: ConfigObservation;
  history: (ConfigObservation & { supersededAt: string; supersededBy: string;
    invalidationReasons: string[] })[];
}
/** Host keys: hanaworldsSafetyProfile.read, hanaworldsCompilerConfig.read,
 * hanaworldsCanvasConfigSupply.read. Missing sources reject with publicError
 * CAPABILITY_UNAVAILABLE plus missingSources; an unbound World rejects WORLD_NOT_BOUND. */
export class CanvasConfigSupply {
  constructor(canvas: CanvasV5);
  read(worldRef: string): Promise<ConfigSupplyReport>;
  readSafetyProfile(worldRef: string): Promise<import('hanaworlds-contracts').SafetyProfile>;
  readCompilerConfig(worldRef: string): Promise<{
    compilationConfig: import('hanaworlds-contracts').CompilationConfig; compilerRevision: string }>;
}
export const SUPPLY_PROFILE: 'canvas-stage1-config-supply/v1';
export function assembleProfile(name: 'safetyProfile' | 'compilationConfig',
  fields: Record<string, ConfigFieldRow>, domain: ConfigDomain): ConfigProfileObservation<unknown>;
export function boundDomain(snapshot: any, worldRef: string):
  { domain: ConfigDomain; sessionRefs: string[] }[];
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
