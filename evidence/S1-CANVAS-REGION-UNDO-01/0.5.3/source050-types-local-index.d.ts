export * from './contracts.js';
import type {TypeMap,TypeName,OperationMap,ProjectionMap,ContractHandshake,LocalRequestFacts,CurrentBuildSubmission,ValidateBuildProposalRequest,ValidateBuildProposalResponse,BuildProposalProviderFacts,ScopedPreparedTransaction,ScopedPreparedTransactionResult,RegionInspection,MaterialMap,Catalogue,BuildProjection,FinalEffects,TargetFacts,SafetyProfile,Coverage} from './contracts.js';
export declare const version: '0.5.0';
export declare const wireVersions: ReadonlyArray<keyof OperationMap>;
export declare const compiledOperationsVersion: 'operations/v3';
export declare const contractHandshake: ContractHandshake;
export declare const schemaBundle: {readonly definitions: Readonly<Record<TypeName,unknown>>};
export declare const operationContracts: Readonly<Record<keyof OperationMap, ReadonlyArray<{operation:string;request:TypeName;response:TypeName}>>>;
export declare const ownership: Readonly<Record<string,{domainOwner:string;mutationCaller:string}>>;
export declare function validateType<K extends TypeName>(name:K,input:unknown):TypeMap[K];
export declare function admitType<K extends TypeName>(name:K,input:string|Uint8Array):TypeMap[K];
export declare function validateRequest<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,input:unknown):OperationMap[W][N] extends {request:infer R}?R:never;
export declare const validateBoundRequest: typeof validateRequest;
export declare const admitRequest: typeof validateRequest;
export declare function validateResponse<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,input:unknown):OperationMap[W][N] extends {response:infer R}?R:never;
export declare function validateBoundResponse<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,request:unknown,response:unknown):OperationMap[W][N] extends {response:infer R}?R:never;
export declare function validateCurrentRequest<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,input:unknown,facts:LocalRequestFacts):{request:OperationMap[W][N] extends {request:infer R}?R:never;requestDigest:string;disposition:'EXECUTE'|'RETURN_STORED'};
export declare function requestDigest<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,input:unknown):string;
export declare function canonicalJSON(input:unknown):string;
export declare function digestValue<K extends keyof ProjectionMap>(kind:K,input:ProjectionMap[K]):{sha256:string;projection:ProjectionMap[K];canonicalUtf8:string;preimageUtf8:string;preimageHex:string;kind:K};
export declare function validateDigestBinding<K extends keyof ProjectionMap>(kind:K,input:ProjectionMap[K],hash:string):ReturnType<typeof digestValue<K>>;
export declare function checkContractHandshake(input:unknown,required?:{wires:ReadonlyArray<string>;factProfiles:ReadonlyArray<string>}):{result:'HANDSHAKE_VERSION_MATCH';advertised:ContractHandshake};
export declare function checkBuildProposalHandshake(input:unknown):{result:'HANDSHAKE_OPERATION_MATCH';advertised:ContractHandshake};
export declare function validateCurrentBuildSubmission(input:unknown,facts:LocalRequestFacts):CurrentBuildSubmission;
export declare function validateBuildProposalRequest(input:unknown):ValidateBuildProposalRequest;
export declare function validateBuildProposalContext(input:unknown,facts:BuildProposalProviderFacts):ValidateBuildProposalRequest;
export declare function validateBuildProposalResponse(input:unknown,response:unknown):ValidateBuildProposalResponse;
export declare function validateRegionInspection(input:unknown):RegionInspection;
export declare function validateFactsCoverage(input:TargetFacts,coverage:Coverage):TargetFacts;
export declare function validateStaticMaterials(input:MaterialMap,catalogue:Catalogue):MaterialMap;
export declare function validateWitnessCoherence(input:{build:BuildProjection;finalEffects:FinalEffects;targetFacts:TargetFacts;safetyProfile:SafetyProfile;catalogue:Catalogue}):{coherent:true;authenticityVerified:false;worldWrites:0};
export declare function projectScopedPreparedTransaction(input:ScopedPreparedTransactionResult):ScopedPreparedTransaction;
export declare function validateExactEffects(operations:unknown,materials:unknown,effects:unknown):unknown;
export declare function decodeRawJSON(input:string|Uint8Array):unknown;
export declare class ContractError extends Error {constructor(code?:string,phase?:string,reason?:string,details?:Record<string,unknown>);readonly code:string;readonly phase:string;readonly reason:string;readonly mutationState:string;readonly publicError:Readonly<Record<string,unknown>>;}
export declare function validateWorldSelection(input:unknown,facts:LocalRequestFacts,connection:unknown):import('./contracts.js').SelectWorldConnectionRequest;
export declare function validateCommitReadback(receipt:unknown,expected:unknown,actual:unknown,durableHistory:unknown):import('./contracts.js').ReceiptProjection;
export declare const placementSettingDescriptors: ReadonlyArray<{readonly name:string;readonly owner:string;readonly type:string;readonly default:number;readonly scope:string;readonly editable:boolean;readonly meaning:string;readonly consequence:string;readonly whenUnsetOrInvalid:string}>;
export declare const placementInvariants: ReadonlyArray<{readonly id:string;readonly owner:string;readonly switchable:false;readonly text:string;readonly consequence:string}>;
export declare const settingsSurface: {readonly where:string;readonly rule:string;readonly currentEvidence:'NOT_RUN'};
export declare const canvasEventRules: Readonly<Record<string,unknown>>;
export declare const digestProfile: Readonly<{domainPrefix:string;domainSuffix:string;domainPrefixByKind?:Readonly<Partial<Record<keyof ProjectionMap,string>>>;projectionTypes:Readonly<Record<keyof ProjectionMap,TypeName>>}>;
export declare const schemaInventory: ReadonlyArray<TypeName>;
export declare function assertType<K extends TypeName>(name:K,input:unknown):void;
export declare function validateCanvasEvent<K extends TypeName>(name:K,input:unknown):TypeMap[K];
export declare function snapshotJSON(input:unknown):unknown;
export declare function assertPureJSON(input:unknown):void;
export declare function deepFreeze<T>(input:T):Readonly<T>;
export declare function publicError(input:unknown):import('./contracts.js').Error;
export declare function normalizeName(input:string):{displayName:string;comparisonKey:string};
export declare function validateNameSyntax(input:string):string;
export declare function runtimeCompatibility():Readonly<Record<string,unknown>>;
export declare function requireUnicode17():Readonly<Record<string,unknown>>;
export declare function comparePosition(a:ReadonlyArray<number>,b:ReadonlyArray<number>):number;
export declare function compareUTF16(a:string,b:string):number;
export declare function boxCellCount(box:import('./contracts.js').Box):bigint;
export declare function unionCellCount(boxes:ReadonlyArray<import('./contracts.js').Box>):bigint;
export declare function project<K extends keyof ProjectionMap>(kind:K,input:ProjectionMap[K]):ProjectionMap[K];
export declare function digestRaw<K extends keyof ProjectionMap>(kind:K,input:string|Uint8Array):ReturnType<typeof digestValue<K>>;
export declare function projectField<K extends keyof ProjectionMap>(kind:K,sourceType:TypeName,source:unknown,field:string):ProjectionMap[K];
/** Existing internal Host lifecycle service. Handles only correlate the actual
 * owned process and finite operation; STOPPED is supplied during the callback. */
export interface LocalEngineControlPort {
 acquire(input:import('./contracts.js').NativeControlInput):Promise<import('./contracts.js').NativeControlLease>;
 inspect(query:import('./contracts.js').NativeControlQuery):Promise<import('./contracts.js').NativeControlEvidence>;
 withStoppedWorld<T>(query:import('./contracts.js').NativeControlQuery,consume:(facts:import('./contracts.js').NativeControlEvidence)=>Promise<T>):Promise<T>;
}
/** Actual asset bytes travel only on the in-process typed channel, never JSON.
 * validateMaterialSources returns owned copies; typed array elements remain mutable. */
export interface MaterialTextureBytes {readonly bytesDigest:import('./contracts.js').Digest;readonly bytes:Uint8Array;}
export interface MaterialSources {readonly snapshot:import('./contracts.js').MaterialSourcesSnapshot;readonly textures:ReadonlyArray<MaterialTextureBytes>;}
/** Additive subset of the existing hanaworldsLuantiNativeFacts service.
 * Provider must verify the paired world/incarnation and source stability across
 * the read. Host supplies a fresh Catalogue and fresh connection to validation. */
export interface MaterialSourceFactsPort {readMaterialSources(worldRef:import('./contracts.js').Ref):Promise<MaterialSources>;}
/** Checks association and content integrity, not provider authenticity, image
 * decoding or static build eligibility. Call validateStaticMaterials as usual. */
export declare function validateMaterialSources(input:unknown,catalogue:Catalogue,currentConnection:import('./contracts.js').MaterialSourceConnection):MaterialSources;
/** region-voxels/v1. Runs are [count, paletteIndex|null] in Luanti VoxelArea order
 * (x fastest, then y, then z). null is UNSPECIFIED (keep); only an explicit
 * {nodeName:'air',param2:0} palette entry carves. Pure helpers over supplied facts. */
type C=import('./contracts.js').TypeMap;
export interface ExpandedRegionBlock {readonly box:C['Box'];readonly size:C['RegionSize'];readonly palette:C['RegionPalette'];readonly indices:Int32Array;}
export declare function regionBlockBox(block:C['RegionVoxelBlock']):C['Box'];
export declare function mapblockOf(position:C['Position']):C['ChunkPosition'];
export declare function regionChunksOfBox(box:C['Box']):ReadonlyArray<{readonly chunkPos:C['ChunkPosition'];readonly box:C['Box']}>;
export declare function expandRegionBlock(block:C['RegionVoxelBlock']):ExpandedRegionBlock;
export declare function encodeRegionBlock(input:{origin:C['Position'];size:C['RegionSize'];palette:ReadonlyArray<C['NodeSpec']>;indices:ArrayLike<number>}):C['RegionVoxelBlock'];
export declare function validateRegionPalette(block:C['RegionVoxelBlock'],catalogue:C['Catalogue']):C['RegionVoxelBlock'];
export declare function expectedRegionState(before:C['RegionState'],ops:C['RegionVoxelBlock']):C['RegionState'];
export declare function summarizeRegionStates(worldRef:C['Ref'],chunks:ReadonlyArray<{chunkPos:C['ChunkPosition'];state:C['RegionState']}>):C['RegionSummary'];
export declare function expectedRegionSummary(content:C['RegionSnapshotContent'],operations:C['RegionOperationsProjection']):C['RegionSummary'];
export declare function validateRegionProposalRequest(input:unknown):C['ValidateRegionProposalRequest'];
export declare function validateRegionProposalResponse(request:unknown,response:unknown):C['ValidateRegionProposalResponse'];
export declare function validateCompileRegionBuildRequest(input:unknown):C['CompileRegionBuildRequest'];
export declare function validateCompiledRegionSet(request:unknown,response:unknown):C['CompileRegionBuildResponse'];
export declare function validateRegionRead(request:unknown,response:unknown):C['ReadRegionResponse'];
export declare function requireKnownRegion(result:unknown):C['RegionReadResult'];
/** Transport facts only: allWritten is never a commit; committed is always false. */
export declare function validateRegionWrite(request:unknown,response:unknown):{readonly response:C['WriteRegionResponse'];readonly allWritten:boolean;readonly committed:false};
export declare function validateRegionSnapshotContent(content:unknown,ref:unknown,beforeSummary:unknown):C['RegionSnapshotContent'];
export declare function validateRegionCommit(request:unknown,response:unknown):C['ApplyRegionCommitResponse'];
export declare function validateRegionUndo(request:unknown,response:unknown,originResult:unknown):C['UndoRegionCommitResponse'];
export declare function protocolRequirement(wire:string,capabilities?:ReadonlyArray<string>,minMinor?:number):C['ProtocolRequirement'];
/** Same major, minor >= minMinor, all capabilities. Provenance is recorded, never compared. */
export declare function checkProtocolCompatibility(advertised:unknown,requirements:unknown):{readonly result:'PROTOCOL_COMPATIBLE';readonly component:string;readonly matched:ReadonlyArray<{readonly protocol:string;readonly major:number;readonly minor:number;readonly capabilities:ReadonlyArray<string>}>;readonly provenance:C['ProtocolProvenance']};
export declare const contractProtocols:ReadonlyArray<C['ProtocolDescriptor']>;
export declare const protocolPolicy:Readonly<Record<'rule'|'majors'|'minor'|'rejection'|'legacy'|'digestDomain',string>>;
export declare const regionCapabilities:ReadonlyArray<{readonly id:string;readonly owner:string;readonly meaning:string}>;
export declare const regionInvariants:ReadonlyArray<{readonly id:string;readonly owner:string;readonly switchable:false;readonly text:string;readonly consequence:string}>;
