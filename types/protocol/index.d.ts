export * from './contracts.js';
export declare const placementSettingsRead: Readonly<{introducedIn:string;wire:'canvas/v7';minor:2;operation:'ReadPlacementSettings';provider:'canvas';request:string;response:string;fixture:string;errors:readonly string[];currentValues:string;scope:string;effects:Readonly<{worldWrites:0;inspections:0;historyCreates:0;persistentChanges:0}>;surface:Readonly<Record<string,string>>}>;
export declare function readPlacementSettings(request:import('./contracts.js').ReadPlacementSettingsRequest,response:import('./contracts.js').ReadPlacementSettingsResponse):import('./contracts.js').PlacementSettingsReadback;
export declare function createPlacementSettingsMock(state:import('./contracts.js').PlacementSettingsReadback):Readonly<{effects:typeof placementSettingsRead.effects;call(operation:'ReadPlacementSettings',request:import('./contracts.js').ReadPlacementSettingsRequest):Promise<import('./contracts.js').ReadPlacementSettingsResponse>}>;
import type {TypeMap,TypeName,OperationMap,ProjectionMap,ContractHandshake,LocalRequestFacts,CurrentBuildSubmission,ValidateBuildProposalRequest,ValidateBuildProposalResponse,BuildProposalProviderFacts,ScopedPreparedTransaction,ScopedPreparedTransactionResult,RegionInspection,MaterialMap,Catalogue,BuildProjection,FinalEffects,TargetFacts,SafetyProfile,Coverage} from './contracts.js';
export declare const version: '2.12.0';
export type ToolName='hanaworlds_context'|'hanaworlds_proposal'|'hanaworlds_region_proposal'|'hanaworlds_build'|'hanaworlds_write_methods'|'hanaworlds_download_image'|'hanaworlds_image_material';
export interface ToolMap {
 hanaworlds_context:{request:import('./contracts.js').ToolContextRequest;response:import('./contracts.js').ToolContextResponse};
 hanaworlds_proposal:{request:import('./contracts.js').ToolProposalRequest;response:import('./contracts.js').ToolProposalResponse};
 hanaworlds_region_proposal:{request:import('./contracts.js').ToolRegionProposalRequest;response:import('./contracts.js').ToolRegionProposalResponse};
 hanaworlds_build:{request:import('./contracts.js').ToolBuildRequest;response:import('./contracts.js').ToolBuildResponse};
 hanaworlds_write_methods:{request:import('./contracts.js').ToolWriteMethodsRequest;response:import('./contracts.js').ToolWriteMethodsResponse};
 hanaworlds_download_image:{request:import('./contracts.js').ToolDownloadImageRequest;response:import('./contracts.js').ToolDownloadImageResponse};
 hanaworlds_image_material:{request:import('./contracts.js').ToolImageMaterialRequest;response:import('./contracts.js').ToolImageMaterialResponse};
}
export interface ToolDeclaration {readonly name:ToolName;readonly contract:'C-session'|'C-painter';readonly provider:'workshop'|'painter';readonly wire:'session/v5'|'painter/v6';readonly operation:ToolName;readonly request:TypeName;readonly response:TypeName;readonly inputSchema:{readonly $ref:string};readonly outputSchema:{readonly $ref:string};readonly hostInjectedFields:ReadonlyArray<string>;readonly actions:ReadonlyArray<{readonly action:string;readonly input:TypeName;readonly output:TypeName;readonly errors:ReadonlyArray<import('./contracts.js').ErrorCode>}>;}
export declare const toolManifest:Readonly<{profileVersion:'skill-tools/v1';package:'hanaworlds-contracts';version:string;schemaExport:string;tools:ReadonlyArray<ToolDeclaration>;boundary:string;directBuild:typeof directBuild}>;
export declare const buildingSkill:Readonly<{name:'hanaworlds-building';contract:'C-skill';major:1;wire:'skill/v1';request:'BuildingSkillRequest';response:'BuildingSkillResponse';hostInjected:true;tools:ReadonlyArray<ToolName>;errors:ReadonlyArray<import('./contracts.js').ErrorCode>;description:string;directBuild:typeof directBuild}>;
/** hostFacts must be independently injected/read by the host, never sourced from model arguments. */
export declare function validateToolRequest<N extends ToolName>(name:N,input:unknown,hostFacts:import('./contracts.js').ToolHostContext|import('./contracts.js').ToolBuildHostFacts):ToolMap[N]['request'];
export declare function validateToolResponse<N extends ToolName>(name:N,request:ToolMap[N]['request'],response:unknown):ToolMap[N]['response'];
export declare function createSkillToolsMock(fixture:unknown,refusals?:Readonly<Record<string,import('./contracts.js').ErrorCode|undefined>>):<N extends ToolName>(name:N,input:ToolMap[N]['request'],hostFacts:import('./contracts.js').ToolHostContext|import('./contracts.js').ToolBuildHostFacts)=>ToolMap[N]['response'];
export interface SkillToolsPort {invoke<N extends ToolName>(name:N,request:ToolMap[N]['request']):Promise<ToolMap[N]['response']>;}
export interface BuildingSkillPort {run(request:import('./contracts.js').BuildingSkillRequest):Promise<import('./contracts.js').BuildingSkillResponse>;}
export interface SessionRedoPort {RedoCurrentBuild(request:import('./contracts.js').RedoCurrentBuildRequest):Promise<import('./contracts.js').RedoCurrentBuildResponse>;}
export declare const wireVersions: ReadonlyArray<keyof OperationMap>;
export declare const compiledOperationsVersion: 'operations/v4';
export declare const contractHandshake: ContractHandshake;
export declare const schemaBundle: {readonly $id:string;readonly 'x-contractsCompatibility':{readonly package:'hanaworlds-contracts';readonly major:number;readonly rule:'same-major'};readonly definitions: Readonly<Record<TypeName,unknown>>};
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
/** Package compatibility: same package, equal semver major. Minor/patch/prerelease are provenance only. */
export declare const contractsCompatibility: {readonly package:'hanaworlds-contracts';readonly major:number;readonly rule:'same-major'};
/** The one contracts version predicate. Rejects another package, malformed semver or another major with UNSUPPORTED_VERSION. */
export declare function checkContractsVersion(ref:unknown):{readonly result:'CONTRACTS_MAJOR_MATCH';readonly major:number;readonly advertised:string};
/** Schema entry: a peer schema bundle ($id) or profile (version) by the same major predicate; requiredTypes must be present. */
export declare function checkSchemaCompatibility(input:unknown,requiredTypes?:ReadonlyArray<string>):{readonly result:'SCHEMA_MAJOR_MATCH';readonly major:number;readonly version:string;readonly requiredTypes:ReadonlyArray<string>};
/** Same contracts major (checkContractsVersion) plus every required wire, compiledOperationsVersion and fact profile. */
export declare function checkContractHandshake(input:unknown,required?:{wires:ReadonlyArray<string>;factProfiles:ReadonlyArray<string>}):{result:'HANDSHAKE_VERSION_MATCH';advertised:ContractHandshake};
export declare function checkBuildProposalHandshake(input:unknown):{result:'HANDSHAKE_OPERATION_MATCH';advertised:ContractHandshake};
export declare function validateCurrentBuildSubmission(input:unknown,facts:LocalRequestFacts):CurrentBuildSubmission;
export declare function validateBuildProposalRequest(input:unknown):ValidateBuildProposalRequest;
export declare function validateBuildProposalContext(input:unknown,facts:BuildProposalProviderFacts):ValidateBuildProposalRequest;
export declare function validateBuildProposalResponse(input:unknown,response:unknown):ValidateBuildProposalResponse;
export declare function validateRegionInspection(input:unknown):RegionInspection;
export declare function validateFactsCoverage(input:TargetFacts,coverage:Coverage):TargetFacts;
export declare function validateStaticMaterials(input:MaterialMap,catalogue:Catalogue):MaterialMap;
/** SCHEMA_INVALID/INVALID_SHAPE when an occupied cell reports the Catalogue emptyMaterialRef. */
export declare function requireOccupiedNotEmpty(facts:import('./contracts.js').TargetFacts,catalogue:Catalogue):import('./contracts.js').TargetFacts;
export declare function safetyProfileFromConfirmedIntent(intent:import('./contracts.js').IntentProjection):SafetyProfile;
/** Named site-rule checks that no peer of this major can perform yet (light rule, region entrance). */
export type SafetyCapabilityId='painter/v6:light-rule'|'painter-region/v3:entrance-rule';
export declare const safetyCapabilities:ReadonlyArray<Readonly<{id:SafetyCapabilityId;owner:string;gap:'LIGHT'|'ENTRANCE_ON_REGION';cause:string;meaning:string;whenAbsent:Omit<import('./contracts.js').Error,'transactionRef'>}>>;
export declare function unmetSafetyCapabilities(handshake:unknown,ids:readonly SafetyCapabilityId[]):ReadonlyArray<Readonly<{id:SafetyCapabilityId;cause:string;error:Omit<import('./contracts.js').Error,'transactionRef'>}>>;
export declare function requireSafetyCapabilities(handshake:unknown,ids:readonly SafetyCapabilityId[]):readonly SafetyCapabilityId[];
/** Engine guards G1-G3: per-stage coverage declared in PublicCapabilities.engineGuards, refusals beside errors. */
export interface EngineGuardRequirement{readonly guard:import('./contracts.js').EngineGuard;readonly stage:import('./contracts.js').EngineGuardStage;readonly protectionPrincipal?:import('./contracts.js').ProtectionPrincipal|null}
export declare const engineGuards:Readonly<{id:'engine-guards/v1';stages:ReadonlyArray<Readonly<{stage:import('./contracts.js').EngineGuardStage;wire:string;operation:string;purpose:'APPLY'|'RESTORE'|null;phase:'validate'|'apply'|'restore'}>>;guards:Readonly<Record<import('./contracts.js').EngineGuard,string>>;errors:Readonly<Record<string,unknown>>;rule:string;notDecidedHere:string}>;
export declare function guardRefusalError(refusal:import('./contracts.js').GuardRefusal,options?:{transactionRef?:string|null;preflight?:boolean;cause?:import('./contracts.js').ErrorCode|null}):import('./contracts.js').Error;
export declare function unmetEngineGuards(declaration:import('./contracts.js').EngineGuardDeclaration|null,requirements:readonly EngineGuardRequirement[]):ReadonlyArray<import('./contracts.js').GuardRefusal>;
export declare function requireEngineGuards(declaration:import('./contracts.js').EngineGuardDeclaration|null,requirements:readonly EngineGuardRequirement[]):readonly EngineGuardRequirement[];
export declare function requireSiteRuleChecks(rules:{readonly requireEntranceConnectivity:boolean;readonly optionalLightRule:unknown},options:{entrance:boolean}):void;
export declare function validateWitnessCoherence(input:{build:BuildProjection;finalEffects:FinalEffects;targetFacts:TargetFacts;safetyProfile:SafetyProfile;catalogue:Catalogue}):{coherent:true;authenticityVerified:false;worldWrites:0};
export declare function projectScopedPreparedTransaction(input:ScopedPreparedTransactionResult):ScopedPreparedTransaction;
export declare function validateExactEffects(operations:unknown,materials:unknown,effects:unknown):unknown;
export declare function decodeRawJSON(input:string|Uint8Array):unknown;
export declare class ContractError extends Error {constructor(code?:string,phase?:string,reason?:string,details?:Record<string,unknown>);readonly code:string;readonly phase:string;readonly reason:string;readonly mutationState:string;/** 2.7.0: present only when the constructor was given details.worldRef. */readonly worldRef:string|undefined;readonly publicError:Readonly<Record<string,unknown>>;readonly placementFailure?:PlacementFailure;}
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
/** In-process method of the world source facts service.
 * Provider must verify the paired world/incarnation and source stability across
 * the read. Host supplies a fresh Catalogue and fresh connection to validation. */
export interface MaterialSourceFactsPort {readMaterialSources(worldRef:import('./contracts.js').Ref):Promise<MaterialSources>;}
/** Checks association and content integrity, not provider authenticity, image
 * decoding or static build eligibility. Call validateStaticMaterials as usual. */
export declare function validateMaterialSources(input:unknown,catalogue:Catalogue,currentConnection:import('./contracts.js').MaterialSourceConnection):MaterialSources;
/** region-voxels/v2. Runs are [count, paletteIndex|null] in X_FASTEST_THEN_Y_THEN_Z order.
 * null is UNSPECIFIED (keep); only an explicit palette entry of the Catalogue emptyMaterialRef
 * carves. Pure helpers over supplied facts. */
type C=import('./contracts.js').TypeMap;
export interface ExpandedRegionBlock {readonly box:C['Box'];readonly size:C['RegionSize'];readonly palette:C['RegionPalette'];readonly indices:Int32Array;}
export declare function regionBlockBox(block:C['RegionVoxelBlock']):C['Box'];
export declare function chunkOf(position:C['Position'],partition:C['Partition']):C['ChunkPosition'];
export declare function regionChunksOfBox(box:C['Box'],partition:C['Partition']):ReadonlyArray<{readonly chunkPos:C['ChunkPosition'];readonly box:C['Box']}>;
/** Throws CAPABILITY_GAP (GEOMETRY_PROFILE_UNSUPPORTED) unless worldGeometry declares profile; null declares nothing. */
export declare function requireGeometryProfile(worldGeometry:C['WorldGeometry']|null,profile:C['Ref']):C['WorldGeometry'];
export declare function expandRegionBlock(block:C['RegionVoxelBlock']):ExpandedRegionBlock;
export declare function encodeRegionBlock(input:{origin:C['Position'];size:C['RegionSize'];palette:ReadonlyArray<C['MaterialSpec']>;indices:ArrayLike<number>}):C['RegionVoxelBlock'];
export declare function validateRegionPalette(block:C['RegionVoxelBlock'],catalogue:C['Catalogue']):C['RegionVoxelBlock'];
export declare function expectedRegionState(before:C['RegionState'],ops:C['RegionVoxelBlock']):C['RegionState'];
export declare function summarizeRegionStates(worldRef:C['Ref'],partition:C['Partition'],chunks:ReadonlyArray<{chunkPos:C['ChunkPosition'];state:C['RegionState']}>):C['RegionSummary'];
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
/** region-rollback-cause/v1 metadata: field, rules, read route, what it never covers. */
export declare const regionRollbackCause:Readonly<{id:'region-rollback-cause/v1';field:string;meaning:string;rules:ReadonlyArray<string>;unknown:'UNKNOWN';readRoute:string;notCovered:ReadonlyArray<string>;capability:'canvas-region/v3:rollback-cause'}>;
/** Cause of a successful region rollback, read from the ApplyRegionCommit response of the same request (first answer or exact replay). Absent cause is 'UNKNOWN', never inferred. */
export declare function regionRollbackCauseOf(request:unknown,response:unknown):Readonly<{requestId:C['Ref'];transactionId:C['Ref'];worldRef:C['Ref'];localContext:C['LocalWorldContext'];operationDigest:C['Digest'];cause:'REPORTED'|'UNKNOWN';failure:C['FailureDetail']|null}>;
export declare function validateRegionUndo(request:unknown,response:unknown,originResult:unknown):C['UndoRegionCommitResponse'];
export declare function protocolRequirement(wire:string,capabilities?:ReadonlyArray<string>,minMinor?:number):C['ProtocolRequirement'];
/** Same major, minor >= minMinor, all capabilities. Provenance is recorded, never compared. */
export declare function checkProtocolCompatibility(advertised:unknown,requirements:unknown):{readonly result:'PROTOCOL_COMPATIBLE';readonly component:string;readonly matched:ReadonlyArray<{readonly protocol:string;readonly major:number;readonly minor:number;readonly capabilities:ReadonlyArray<string>}>;readonly provenance:C['ProtocolProvenance']};
export declare const contractProtocols:ReadonlyArray<C['ProtocolDescriptor']>;
export declare const protocolPolicy:Readonly<Record<'rule'|'majors'|'minor'|'rejection'|'legacy'|'digestDomain',string>>;
export declare const regionCapabilities:ReadonlyArray<{readonly id:string;readonly owner:string;readonly meaning:string}>;
export declare const regionInvariants:ReadonlyArray<{readonly id:string;readonly owner:string;readonly switchable:false;readonly text:string;readonly consequence:string}>;
/** write-path-init/v1: Catalogue placeable describes only the declared
 * CALLBACK_FREE_WRITE write/restore path and its initialization; out-of-scope later changes
 * are caught by full-state readback and same-transaction Undo conflict, not claimed absent. */
export declare const writePathStateScope:Readonly<{id:'write-path-init/v1';writePath:'CALLBACK_FREE_WRITE';writePathMeaning:string;factsMeaning:Readonly<Record<'placeable',string>>;initializationCallbacks:ReadonlyArray<string>;stateIndicatorCallbacks:ReadonlyArray<string>;globalWriteCallbacks:string;outOfScope:ReadonlyArray<string>;guards:string}>;
export interface WritePathMaterialFacts {readonly definitionRevision:string|null;readonly placeable:boolean|null;readonly initialization:ReadonlyArray<string>;readonly stateIndicators:ReadonlyArray<string>;}
export declare function writePathStateFacts(evidence:C['WritePathEvidence']):Readonly<Record<string,WritePathMaterialFacts>>;
export declare function validateCatalogueWritePathFacts(catalogue:C['Catalogue'],evidence:C['WritePathEvidence']):{readonly scope:'write-path-init/v1';readonly writePath:'CALLBACK_FREE_WRITE';readonly verified:ReadonlyArray<string>;readonly stricter:ReadonlyArray<string>};
/** session-world-seam/v1 (additive). Canvas owns selection, inventory, retirement and
 * selectionRevision; Workshop owns Session identity; Adapter consumes readiness/transport. */
export declare const sessionWorldSeam:Readonly<{id:'session-world-seam/v1';evidence:string;authority:Readonly<Record<'sessionToWorldSelection'|'sessionIdentityAndLifecycle'|'nativeReadinessAndTransport'|'worldDeletion',string>>;sequences:Readonly<Record<'selectSession'|'unbind'|'deleteSession'|'deleteWorld',string>>;namedFailures:ReadonlyArray<{readonly case:string;readonly code:string;readonly reason?:string}>;clarifications:Readonly<Record<'C1'|'C2'|'C3',string>>;selectedObjectSnapshot:string;compatibility:string}>;
export declare function requireWorldRetirable(inventory:unknown):C['WorldSelectionInventory'];
export declare function describeSelectionConnection(selection:unknown,inventory:unknown):C['SelectionConnectionState'];
export declare function requireSessionDeleteSupported(capabilities:unknown):C['PublicCapabilities'];
/** config-engine-facts/v2. The world source produces from its loaded payload's declaration; Canvas
 * assembles CompilationConfig.writeBackend from a KNOWN writeBackend only, unchanged. avatarEnvelope is always
 * UNAVAILABLE/NO_PUBLIC_SOURCE: no player geometry is representable (INV-POSE-STAYS-IN-ENGINE).
 * In-process method of the world source facts service; provider verifies the paired
 * world/incarnation across the read. */
export interface ConfigEngineFactsPort {readConfigEngineFacts(worldRef:C['Ref']):Promise<C['ConfigEngineFacts']>;}
export declare const configEngineFacts:Readonly<{id:'config-engine-facts/v2';evidence:string;port:string;producer:string;consumer:string;writeBackend:string;domainAndLifecycle:string;avatarDimensions:Readonly<{publicSource:'NONE';record:Readonly<{availability:'UNAVAILABLE';reason:'NO_PUBLIC_SOURCE'}>;cause:'INV-POSE-STAYS-IN-ENGINE';rule:string;refusal:Readonly<{code:'CAPABILITY_UNAVAILABLE';phase:'validate';reason:'REQUIRED_FACT_UNKNOWN'}>}>;notDecidedHere:string}>;
/** Checks shape, current connection, fresh Catalogue digest and sourceRevision; not provider authenticity. */
export declare function validateConfigEngineFacts(input:unknown,catalogue:C['Catalogue'],currentConnection:C['MaterialSourceConnection']):C['ConfigEngineFacts'];
/** CAPABILITY_UNAVAILABLE/REQUIRED_FACT_UNKNOWN when UNAVAILABLE; never a default. */
export declare function requireKnownWriteBackend(facts:unknown):C['WriteBackendRef'];
/** Always throws CAPABILITY_UNAVAILABLE/validate/REQUIRED_FACT_UNKNOWN: avatarDimensions has no public source. */
export declare function requireKnownAvatarEnvelope(facts:unknown):never;
/** confirmed-placement/v1: a placement shown before confirmation is a PlacementProposal (data, not prose),
 * bound in Controls/ConfirmedIntent and matched against the final world effect set by Painter and Canvas. */
export type PlacementFailure='PLACEMENT_TARGET_MISMATCH'|'PLACEMENT_BINDING_CHANGED'|'PLACEMENT_INSPECTION_CHANGED'|'PLACEMENT_REVISION_STALE'|'PLACEMENT_FRAME_CHANGED'|'PLACEMENT_WORLD_CHANGED'|'PLACEMENT_OUTSIDE_INSPECTION';
export declare const confirmedPlacement:Readonly<{id:'confirmed-placement/v1';meaning:string;kinds:Readonly<Record<'EXACT_CELLS'|'ANCHORED_EXTENT',string>>;chain:ReadonlyArray<string>;namedFailures:ReadonlyArray<Readonly<{failure:PlacementFailure;code:import('./contracts.js').ErrorCode;phase:'validate';reason:import('./contracts.js').ErrorReason;cases:string}>>;remedy:string;notDecidedHere:string}>;
/** The only PlacementProposal source: a real RegionInspection plus the selected target inside its sampled bounds. */
export declare function createPlacementProposal(inspection:RegionInspection,target:import('./contracts.js').PlacementTarget):import('./contracts.js').PlacementProposal;
/** The inspection used must be the placement's source inspection (same World, frame, revision, id and facts digest). */
export declare function requirePlacementSource(placement:import('./contracts.js').PlacementProposal,inspection:RegionInspection,worldRef:string):import('./contracts.js').PlacementProposal;
/** Final world positions (sorted, unique) against the target: EXACT_CELLS equal, ANCHORED_EXTENT inside. */
export declare function requirePlacementTarget(placement:import('./contracts.js').PlacementProposal,positions:import('./contracts.js').Positions):import('./contracts.js').PlacementProposal;
/** Brief controls and confirmed intent placement must be equal (both absent, or equal); returns it, or null when none was confirmed. */
export declare function confirmedPlacementOf(intent:import('./contracts.js').IntentProjection,brief:import('./contracts.js').BriefProjection):import('./contracts.js').PlacementProposal|null;
/** canvas/v7 regionInspectionBinding.confirmedPlacement for a confirmed intent; null when none was confirmed (send no confirmedPlacement field). */
export declare function confirmedPlacementBinding(intent:import('./contracts.js').IntentProjection):import('./contracts.js').ConfirmedPlacementBinding|null;
/** Canvas pre-commit: the apply's confirmed placement against Canvas's recorded inspection and current world revision. */
export declare function checkConfirmedPlacementApply(apply:import('./contracts.js').ApplyRecoverableCommitRequest,recordedInspection:RegionInspection,currentWorldRevision:string):Readonly<{placementDigest:string;intentDigest:string;kind:'EXACT_CELLS'|'ANCHORED_EXTENT';cellCount:number}>|null;
/** painter/v6 CreateBuildPlan (model path): confirmed placement needs its source inspection; planned operations match the target. */
export declare function validateCreateBuildPlanRequest(input:unknown):import('./contracts.js').CreateBuildPlanRequest;
export declare function validateCreateBuildPlanResponse(request:unknown,response:unknown):import('./contracts.js').CreateBuildPlanResponse|import('./contracts.js').ClarificationNeed;
/** canvas-region/v3 Canvas pre-write: the commit's confirmed placement against Canvas's recorded inspection and current world revision, before any snapshot or Adapter WriteRegion. */
export declare function checkConfirmedRegionPlacementCommit(commit:import('./contracts.js').ApplyRegionCommitRequest,recordedInspection:RegionInspection,currentWorldRevision:string):Readonly<{placementDigest:string;intentDigest:string;kind:'EXACT_CELLS'|'ANCHORED_EXTENT';cellCount:number}>|null;
/** Workshop region submission: the commit carries exactly confirmedPlacementBinding(intent) (no confirmedPlacement field when none was confirmed). */
export declare function validateRegionCommitSubmission(intent:import('./contracts.js').IntentProjection,brief:import('./contracts.js').BriefProjection,commit:import('./contracts.js').ApplyRegionCommitRequest):import('./contracts.js').ApplyRegionCommitRequest;
/** canvas-region/v3 ApplyRegionCommit admission: shape, operations digest and the confirmed-placement coherence with its own operations. */
export declare function validateRegionCommitRequest(commit:unknown):import('./contracts.js').ApplyRegionCommitRequest;
/** world-source-facts/v1 (2.1.0): named world source fact operations (world-facts/v1, world-adapter/v8
 * ReadWorldSourceCapabilities) and the host inspection context (world-inspection/v1). Pure checks; no engine read. */
export type WorldSourceFactsOperation={contract:'C-world-facts'|'C-world-adapter'|'C-world-inspection';wire:'world-facts/v1'|'world-adapter/v8'|'world-inspection/v1';operation:string;provider:'world-source'|'desktop-bridge';consumers:ReadonlyArray<string>;result:keyof C;errors:ReadonlyArray<C['ErrorCode']>};
export declare const worldSourceFacts:Readonly<{id:'world-source-facts/v1';evidence:string;meaning:string;providerRole:'world-source';operations:ReadonlyArray<Readonly<WorldSourceFactsOperation>>;domainAndLifecycle:string;unavailable:string;forwarding:string;avatarEnvelope:string;writePath:string;errors:string}>;
/** Wires added in a minor (with the version that added them); advertised, not required by the default handshake. */
export declare const minorWires:Readonly<Record<string,string>>;
/** Current connection; catalogueDigest is the digest of the carried Catalogue. */
export declare function validateCatalogueFacts(input:unknown,currentConnection:C['MaterialSourceConnection']):C['CatalogueFacts'];
/** Current connection and Catalogue; recomputed sourceRevision; only Catalogue materials. */
export declare function validateMaterialSourceFacts(input:unknown,catalogue:C['Catalogue'],currentConnection:C['MaterialSourceConnection']):C['MaterialSourceFacts'];
export declare function validateEngineFacts(input:unknown,currentConnection:C['MaterialSourceConnection']):C['EngineFacts'];
export declare function validateWriteProfile(input:unknown,catalogue:C['Catalogue'],currentConnection:C['MaterialSourceConnection']):C['WriteProfile'];
/** Also: write path conclusions name only Catalogue materials; a placeable material has clean path and material conclusions. */
export declare function validateWorldSourceCapabilities(input:unknown,catalogue:C['Catalogue'],currentConnection:C['MaterialSourceConnection']):C['WorldSourceCapabilities'];
/** The declared CompilationConfig unchanged; CAPABILITY_UNAVAILABLE/validate/REQUIRED_FACT_UNKNOWN when the backend is unknown. */
export declare function requireWriteProfileConfig(profile:unknown):C['CompilationConfig'];
/** The declared body size; CAPABILITY_UNAVAILABLE/validate/REQUIRED_FACT_UNKNOWN when none is declared. */
export declare function requireDeclaredAvatarEnvelope(fact:C['WriteProfile']|C['WorldSourceCapabilities']):C['AvatarSize'];
export declare function validateInspectionContextResponse(request:unknown,response:unknown):C['ReadInspectionContextResponse'];

/** Neutral Canvas admission: explicit profile, supported shape and current ReadLocalConnection identity/geometry. */
export declare function validatePlacementRegionRequest(request:unknown,connection:unknown):C['InspectPlacementRegionRequest'];
/** Binds successful inspection to request profile and current world declaration; missing profile fails closed. */
export declare function validatePlacementRegionResponse(request:unknown,response:unknown,connection:unknown):C['PlacementRegionInspection'];

/** Major-2 source-owned lifecycle operations, errors and provider declarations. */
export declare const worldLifecycle: Readonly<{
 contracts: ReadonlyArray<Readonly<{id:'C-world-lifecycle'|'C-engine-runtime'|'C-local-worlds';wire:'world-lifecycle/v2'|'engine-runtime/v2'|'local-worlds/v2';major:2;provider:string;providerRole?:'world-source';consumers:ReadonlyArray<string>}>>;
 operations: ReadonlyArray<Readonly<{wire:keyof OperationMap;operation:string;request:TypeName;response:TypeName;errors:ReadonlyArray<import('./contracts.js').ErrorCode>}>>;
 opaqueFields:ReadonlyArray<string>;rules:ReadonlyArray<string>;
}>;
/** Stateless SOURCE/FIXTURE only. Does not create/delete worlds or control processes. */
export declare function createWorldLifecycleMock(fixture:unknown,refusals?:Readonly<Record<string,import('./contracts.js').ErrorCode>>):<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,name:N,input:unknown)=>OperationMap[W][N] extends {response:infer R}?R:never;
export interface WorldLifecyclePort {
 describe(request:import('./contracts.js').WorldLifecycleDescribeRequest):Promise<import('./contracts.js').WorldLifecycleDescribeResponse>;
 list(request:import('./contracts.js').WorldLifecycleListRequest):Promise<import('./contracts.js').WorldLifecycleListResponse>;
 create(request:import('./contracts.js').WorldLifecycleCreateRequest):Promise<import('./contracts.js').WorldLifecycleCreateResponse>;
 describeDelete(request:import('./contracts.js').WorldLifecycleDescribeDeleteRequest):Promise<import('./contracts.js').WorldLifecycleDescribeDeleteResponse>;
 delete(request:import('./contracts.js').WorldLifecycleDeleteRequest):Promise<import('./contracts.js').WorldLifecycleDeleteResponse>;
 launch(request:import('./contracts.js').WorldLifecycleLaunchRequest):Promise<import('./contracts.js').WorldLifecycleLaunchResponse>;
 stop(request:import('./contracts.js').WorldLifecycleStopRequest):Promise<import('./contracts.js').WorldLifecycleStopResponse>;
 play(request:import('./contracts.js').WorldLifecyclePlayRequest):Promise<import('./contracts.js').WorldLifecyclePlayResponse>;
}
export interface EngineRuntimePort {
 StartWorldRuntime(request:import('./contracts.js').EngineRuntimeStartRequest):Promise<import('./contracts.js').EngineRuntimeStartResponse>;
 StopWorldRuntime(request:import('./contracts.js').EngineRuntimeStopRequest):Promise<import('./contracts.js').EngineRuntimeStopResponse>;
 ReadRuntimeStatus(request:import('./contracts.js').EngineRuntimeReadStatusRequest):Promise<import('./contracts.js').EngineRuntimeReadStatusResponse>;
}
export interface LocalWorldsPort {
 /** Optional read-only capability. Consumers report CAPABILITY_UNAVAILABLE when absent. */
 describeSourceWorld?(request:import('./contracts.js').LocalWorldsDescribeSourceRequest):Promise<import('./contracts.js').LocalWorldsDescribeSourceResponse>;
 discover(request:import('./contracts.js').LocalWorldsDiscoverRequest):Promise<import('./contracts.js').LocalWorldsDiscoverResponse>;
 createWorld(request:import('./contracts.js').LocalWorldsCreateRequest):Promise<import('./contracts.js').LocalWorldsCreateResponse>;
 pair(request:import('./contracts.js').LocalWorldsPairRequest):Promise<import('./contracts.js').LocalWorldsPairResponse>;
 deleteWorld(request:import('./contracts.js').LocalWorldsDeleteRequest):Promise<import('./contracts.js').LocalWorldsDeleteResponse>;
}
/** Checks the optional capability and binds requestId/worldRef in the returned receipt. */
export declare function describeSourceWorld(port:Pick<LocalWorldsPort,'describeSourceWorld'>,input:unknown):Promise<import('./contracts.js').LocalWorldsDescribeSourceResponse>;
/** SOURCE/FIXTURE only; exact worldRef selection with declared refusals and no side effects. */
export declare function createLocalWorldSourceMock(fixture:unknown,refusalCode?:'WORLD_NOT_FOUND'|'ADAPTER_UNAVAILABLE'|'CURRENT_WORLD_MISMATCH'|null):(input:unknown)=>import('./contracts.js').LocalWorldsDescribeSourceResponse;

/** Direct-build handoff metadata; SOURCE/FIXTURE only, the host owns trust and current state. */
export declare const directBuild:Readonly<{introducedIn:'2.6.0';contract:'C-session';operation:'hanaworlds_build';action:'build';hostFacts:'ToolBuildHostFacts';authorization:'HostBuildIntentAuthorization';currentUserRequest:'CurrentBuildUserRequest';scope:string;digest:string;consumption:string;pipeline:ReadonlyArray<string>;otherObjects:string}>;
/** 2.7.0 optional target world on the public Error (C-canvas / C-session). */
export declare const worldErrorContext:Readonly<{introducedIn:'2.7.0';contracts:ReadonlyArray<'C-canvas'|'C-session'>;type:'Error';field:'worldRef';meaning:string;absence:string;binding:string;unchanged:string;carrier:string;compatibility:string;fixture:string;mock:'createWorldErrorMock'}>;
/** World selectors the request itself carries: worldRef, localContext.worldRef, hostContext.localContext.worldRef. */
export declare function requestWorldSelectors(request:unknown):ReadonlyArray<string>;
export declare function targetWorldRef(request:unknown,trustedSessionWorlds?:Readonly<Record<string,string>>|ReadonlyMap<string,string>):string|undefined;
export declare function worldUnavailableError(request:unknown,error:Omit<import('./contracts.js').Error,'worldRef'>,trustedSessionWorlds?:Readonly<Record<string,string>>|ReadonlyMap<string,string>):import('./contracts.js').Error;
export declare function createWorldErrorMock(fixture:unknown):<W extends keyof OperationMap,N extends keyof OperationMap[W]>(wire:W,operation:N,request:unknown)=>OperationMap[W][N] extends {response:infer R}?R:never;
/** 2.8.0 world-adapter/v8 QueryTransaction historical receipt (C-world-adapter / C-canvas). */
export declare const historicalReceipt:Readonly<{introducedIn:'2.8.0';contracts:ReadonlyArray<'C-world-adapter'|'C-canvas'>;wire:'world-adapter/v8';operation:'QueryTransaction';type:'QueryTransactionResponse';fields:readonly ['currentLocalContext','receiptDigest'];meaning:string;absence:string;binding:string;unchanged:string;compatibility:string;fixture:string;mock:'createHistoricalReceiptMock'}>;
export interface HistoricalReceiptReading {readonly receipt:import('./contracts.js').ReceiptProjection;readonly receiptDigest:string;readonly historical:boolean;readonly writtenContext:import('./contracts.js').LocalWorldContext;readonly currentContext:import('./contracts.js').LocalWorldContext;readonly sameConnection:boolean;readonly sameIncarnation:boolean;readonly sameSelectionRevision:boolean;}
export declare function historicalReceiptResponse(request:import('./contracts.js').QueryTransactionRequest,storedReceipt:import('./contracts.js').ReceiptProjection,storedReceiptDigest:string):import('./contracts.js').QueryTransactionResponse;
export declare function readHistoricalReceipt(request:import('./contracts.js').QueryTransactionRequest,response:import('./contracts.js').QueryTransactionResponse):HistoricalReceiptReading;
export declare function createHistoricalReceiptMock(fixture:unknown):(wire:'world-adapter/v8',operation:'QueryTransaction',request:unknown)=>import('./contracts.js').QueryTransactionResponse;
/** 2.9.0 world-inspection/v1 ReadPluginRoles (C-world-inspection): role -> providing plugins, derived from the running host. */
export type PluginRoleEvidence=Readonly<{kind:'service'|'skill';name:string}>;
export declare const pluginRoles:Readonly<{introducedIn:'2.9.0';contract:'C-world-inspection';wire:'world-inspection/v1';operation:'ReadPluginRoles';provider:'desktop-bridge';consumers:ReadonlyArray<'shell-ui'>;type:'ReadPluginRolesResponse';roles:ReadonlyArray<import('./contracts.js').PluginRole>;requiredRoles:ReadonlyArray<import('./contracts.js').PluginRole>;evidence:Readonly<Record<import('./contracts.js').PluginRole,ReadonlyArray<PluginRoleEvidence>>>;meaning:string;identity:Readonly<{service:string;skill:string}>;status:string;failure:string;forbidden:string;errors:ReadonlyArray<'CAPABILITY_UNAVAILABLE'>;compatibility:string;fixture:string;mock:'createPluginRolesMock'}>;
/** One active registered Cordis service and the loader module specifier of the plugin that registered it. */
export interface RegisteredPluginService {readonly name:string;readonly moduleName:string;}
/** One live skill-registry catalog entry and its registered provider name. */
export interface RegisteredPluginSkill {readonly name:string;readonly provider:string;}
export interface PluginRolesHost {readonly services?:Iterable<RegisteredPluginService>;readonly skills?:Iterable<RegisteredPluginSkill>;}
export declare function derivePluginRoles(host?:PluginRolesHost):import('./contracts.js').PluginRoles;
export declare function pluginRolesResponse(request:unknown,result:import('./contracts.js').PluginRoles):import('./contracts.js').ReadPluginRolesResponse;
export declare function pluginRolesUnavailable(request:unknown):import('./contracts.js').ReadPluginRolesResponse;
export declare function createPluginRolesMock(host:{readonly services?:ReadonlyArray<RegisteredPluginService>;readonly skills?:ReadonlyArray<RegisteredPluginSkill>}|{readonly unreadable:true}):(wire:'world-inspection/v1',operation:'ReadPluginRoles',request:unknown)=>import('./contracts.js').ReadPluginRolesResponse;
/** Same-runtime observations only. Never serialize guards or register these methods as wire operations. */
declare const sessionReadGuardBrand: unique symbol;
export interface SessionReadGuard {readonly [sessionReadGuardBrand]: true;}
export interface SessionReadGuardScope {readonly sessionRef:string;readonly worldRef?:string|null;readonly sessionRevision?:string;}
export interface SessionReadGuardSnapshot {readonly sessionRef:string;readonly sessionRevision:string;readonly worldRef:string|null;}
export type SessionReadGuardCapture = Readonly<{protocol:'session-read-guard/v1';guard:SessionReadGuard;snapshot:SessionReadGuardSnapshot;error:null}> | Readonly<{protocol:'session-read-guard/v1';guard:null;error:Readonly<{code:'CAPABILITY_UNAVAILABLE'}>;missing:readonly string[]}>;
export interface SessionReadGuardProvider {
  /** Capture and establish complete invalidation before the first await; never creates a Session. */
  captureSessionReadGuard(scope:SessionReadGuardScope):SessionReadGuardCapture;
  /** Synchronous, permanently false after invalidation; rejects foreign, fabricated and wrong-scope guards. */
  isSessionReadGuardCurrent(guard:SessionReadGuard,scope:SessionReadGuardScope):boolean;
}
export declare const sessionReadGuard:Readonly<{protocol:'session-read-guard/v1';contract:'C-session';introducedIn:'2.11.0';service:'hanaworldsWorkshop';capture:'captureSessionReadGuard';check:'isSessionReadGuardCurrent';boundary:string;validity:string;transport:string;unavailable:'CAPABILITY_UNAVAILABLE';fixture:string}>;
export declare function createUnavailableSessionReadGuardFixture(missing:readonly string[]):SessionReadGuardProvider;

export declare const scopedRegionUndo: Readonly<{wire:'canvas-region/v3';operation:'UndoScopedRegionCommit';minMinor:2;capability:string;scopeProfile:'confirmed-region-undo-scope/v1';redo:false;errors:Readonly<Record<string,string>>}>;
export declare function deriveConfirmedRegionUndoScope(origin:C['RegionUndoOriginEvidence']):C['ConfirmedRegionUndoScope'];
export declare function validateScopedRegionUndoRequest(request:unknown,origin:unknown):C['UndoScopedRegionCommitRequest'];
export declare function composeScopedRegionUndoTarget(origin:unknown,current:unknown):C['RegionSnapshotContent'];
export declare function validateScopedRegionUndo(request:unknown,response:unknown,origin:unknown):C['UndoScopedRegionCommitResponse'];
export declare function createScopedRegionUndoMock(fixture:{origin:C['RegionUndoOriginEvidence'];response:C['UndoScopedRegionCommitResponse']}):Readonly<{evidence:'FIXTURE_ONLY';call(operation:string,request:unknown):Promise<C['UndoScopedRegionCommitResponse']>}>;
export declare function composeScopedRegionUndoRecoveryTarget(origin:unknown,preUndo:unknown,current:unknown):C['RegionSnapshotContent'];
export declare function validateScopedRegionUndoBinding(wire:string,operation:string,request:C['UndoScopedRegionCommitRequest'],response:C['UndoScopedRegionCommitResponse']):void;
