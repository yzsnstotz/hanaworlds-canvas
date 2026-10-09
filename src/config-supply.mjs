import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { contractHandshake, digestValue, schemaBundle, validateType } from 'hanaworlds-contracts';

/*
 * Stage 1 validation configuration supply: SafetyProfile and CompilationConfig for one World.
 *
 * Canvas is the authority that assembles, revisions and invalidates these two profiles because
 * the transaction decision and its safety invariants are Canvas's. Canvas does not invent any
 * value: every field names where it comes from, and a field without a real source is reported
 * by name and the profile is refused (CAPABILITY_UNAVAILABLE). There is no default, no fixture
 * value, no hand-written revision and no editing path here.
 *
 * Field sources (the whole table; a new schema field not listed here is refused as UNMAPPED):
 * - CONTRACT_SCHEMA: the installed Contracts schema allows exactly one value (`const`).
 * - ENGINE_FACT: read from the bound World through the public NativeFacts port.
 * - DECLARED_POLICY: a policy value somebody must declare. No declaration source exists in
 *   Stage 1 (SafetyProfile management authority is outside MVP), so these are always missing.
 */
export const SUPPLY_PROFILE = 'canvas-stage1-config-supply/v1';
const AUTHORITY = 'hanaworlds-canvas';
const CONTRACTS_REF = contractHandshake.contracts;
const definitions = schemaBundle.definitions;

const MISSING_SOURCE = {
  // No public Contracts/Adapter port reports the actual player movement/collision envelope.
  avatarDimensions: { sourceKind: 'ENGINE_FACT', reason: 'REQUIRED_FACT_UNKNOWN',
    need: 'actual player collision envelope of this World from a public Adapter fact port' },
  requireBodyClearance: { sourceKind: 'DECLARED_POLICY', reason: 'POLICY_UNAVAILABLE',
    need: 'declared Stage 1 safety policy value and its declaring authority' },
  requireEntranceConnectivity: { sourceKind: 'DECLARED_POLICY', reason: 'POLICY_UNAVAILABLE',
    need: 'declared Stage 1 safety policy value and its declaring authority' },
  hazardPolicy: { sourceKind: 'DECLARED_POLICY', reason: 'POLICY_UNAVAILABLE',
    need: 'declared forbidLiquid / maximumDamagePerSecond and their declaring authority' },
  optionalLightRule: { sourceKind: 'DECLARED_POLICY', reason: 'POLICY_UNAVAILABLE',
    need: 'declared light rule (or a declared "no light rule") and its declaring authority' },
  // Contracts 0.5.4 names the field but defines no source or derivation for it.
  backendProfileId: { sourceKind: 'UNDEFINED_IN_CONTRACT', reason: 'REQUIRED_FACT_UNKNOWN',
    need: 'Contracts definition of what backendProfileId identifies and which port supplies it' },
};
const WORLDEDIT_MOD = 'worldedit';
const PROFILES = {
  safetyProfile: { type: 'SafetyProfile', digestKind: 'safety-profile', revisionPrefix: 'safety-config' },
  compilationConfig: { type: 'CompilationConfig', digestKind: 'compilation-config',
    revisionPrefix: 'compiler-config' },
};

const sha = (kind, value) => digestValue(kind, value).sha256;
const same = (a, b) => canonicalize(a) === canonicalize(b);
// Canvas-own domain-separated digest (Contracts has no production kind for this own record).
const observationDigest = value => createHash('sha256')
  .update(`HanaWorlds|canvas|${SUPPLY_PROFILE}\n`).update(canonicalize(value)).digest('hex');

export function supplyError(code, reason, extra = {}) {
  const error = new Error(code);
  error.publicError = { code, phase: 'validate', retryability: 'AFTER_NEW_FACTS',
    mutationState: 'NONE', transactionRef: null, causeCode: null, reason };
  return Object.assign(error, extra);
}

/** The bound connection domain of one World, from Canvas's own selections. */
export function boundDomain(snapshot, worldRef) {
  const rows = new Map();
  for (const [sessionRef, session] of Object.entries(snapshot.sessions ?? {})) {
    if (session?.activeWorldRef !== worldRef || !session.localContext) continue;
    const connection = snapshot.connections?.[sessionRef];
    if (!connection || connection.worldRef !== worldRef) continue;
    const domain = { worldRef, connectionRef: connection.connectionRef,
      connectionIncarnationRef: connection.connectionIncarnationRef,
      payloadVersion: connection.payloadVersion,
      capabilityRevision: connection.capabilities?.capabilityRevision ?? null };
    const key = canonicalize(domain);
    const row = rows.get(key) ?? { domain, sessionRefs: [] };
    row.sessionRefs.push(sessionRef);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Resolve one field of one profile; never returns a value without a named source. */
function resolveField(type, field, facts) {
  const schema = definitions[type].properties[field];
  if (Object.hasOwn(schema, 'const')) return { status: 'SUPPLIED', value: schema.const,
    provenance: { kind: 'CONTRACT_SCHEMA', ref: `${CONTRACTS_REF}#${type}.${field}`,
      sourceRevision: CONTRACTS_REF } };
  if (type === 'CompilationConfig' && field === 'worldeditRevision') {
    if (facts.catalogue.status !== 'READ') return { status: 'MISSING', value: null,
      provenance: null, sourceKind: 'ENGINE_FACT', reason: 'REQUIRED_FACT_UNKNOWN',
      need: `Catalogue.modRevisions.${WORLDEDIT_MOD} via hanaworldsLuantiNativeFacts.readCatalogue`,
      cause: facts.catalogue.cause };
    const value = facts.catalogue.value.modRevisions[WORLDEDIT_MOD];
    if (typeof value !== 'string' || !value) return { status: 'MISSING', value: null,
      provenance: null, sourceKind: 'ENGINE_FACT', reason: 'REQUIRED_FACT_UNKNOWN',
      need: `the bound World's loaded Catalogue has no modRevisions.${WORLDEDIT_MOD}`,
      cause: 'MOD_NOT_LOADED' };
    return { status: 'SUPPLIED', value, provenance: { kind: 'ENGINE_FACT',
      ref: `hanaworldsLuantiNativeFacts.readCatalogue(worldRef).modRevisions.${WORLDEDIT_MOD}`,
      sourceRevision: facts.catalogue.digest } };
  }
  const missing = MISSING_SOURCE[field];
  if (missing) return { status: 'MISSING', value: null, provenance: null, ...missing };
  return { status: 'MISSING', value: null, provenance: null, sourceKind: 'UNMAPPED',
    reason: 'REQUIRED_FACT_UNKNOWN', need: `no Canvas source is mapped for ${type}.${field}` };
}

/**
 * Pure assembly of one profile from resolved fields. A profile exists only when every field
 * is SUPPLIED; its revision is derived from the exact value, provenance and domain.
 */
export function assembleProfile(name, fields, domain) {
  const { type, digestKind, revisionPrefix } = PROFILES[name];
  const missing = Object.entries(fields).filter(([, row]) => row.status !== 'SUPPLIED')
    .map(([field, row]) => ({ profile: type, field, sourceKind: row.sourceKind,
      reason: row.reason, need: row.need, cause: row.cause ?? null }));
  if (missing.length) return { type, status: 'SOURCE_MISSING', value: null, digest: null,
    revision: null, fields, missing };
  const value = validateType(type, Object.fromEntries(Object.entries(fields)
    .map(([field, row]) => [field, row.value])));
  const digest = sha(digestKind, value);
  const provenance = Object.fromEntries(Object.entries(fields)
    .map(([field, row]) => [field, row.provenance]));
  const revision = `${revisionPrefix}-${observationDigest({ type, digest, provenance, domain })
    .slice(0, 32)}`;
  return { type, status: 'SUPPLIED', value, digest, revision, fields, missing: [] };
}

function changeReasons(previous, current) {
  if (!previous) return ['FIRST_OBSERVATION'];
  const reasons = [];
  if (!same(previous.domain, current.domain)) reasons.push(current.domain ?
    (previous.domain ? 'CONNECTION_DOMAIN_CHANGED' : 'WORLD_BOUND') : 'WORLD_UNBOUND');
  if (!same(previous.sources, current.sources)) reasons.push('SOURCE_REVISION_CHANGED');
  if (previous.contracts !== current.contracts) reasons.push('CONTRACTS_CHANGED');
  for (const name of Object.keys(PROFILES)) {
    const a = previous.profiles[name], b = current.profiles[name];
    if (a.status !== b.status) reasons.push(`${PROFILES[name].type.toUpperCase()}_STATUS_CHANGED`);
    else if (a.revision !== b.revision || !same(a.fields, b.fields))
      reasons.push(`${PROFILES[name].type.toUpperCase()}_CHANGED`);
  }
  return reasons.length ? reasons : ['OBSERVATION_CHANGED'];
}

/** Canvas-owned supply over one CanvasV5 instance (its store and NativeFacts port). */
export class CanvasConfigSupply {
  constructor(canvas) { this.canvas = canvas; }
  #domain(worldRef) {
    const rows = boundDomain(this.canvas.store.snapshot, worldRef);
    if (rows.length > 1) throw supplyError('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED',
      { boundConnections: rows });
    return rows[0] ?? null;
  }
  async #catalogue(worldRef) {
    const port = this.canvas.nativeFacts;
    if (typeof port?.readCatalogue !== 'function')
      return { status: 'UNAVAILABLE', cause: 'NATIVE_FACTS_CATALOGUE_PORT_ABSENT' };
    try {
      const value = validateType('Catalogue', await port.readCatalogue(worldRef));
      return { status: 'READ', value, digest: sha('catalogue', value) };
    } catch (error) {
      return { status: 'UNAVAILABLE', cause: error.publicError?.code ?? error.message ?? 'READ_FAILED' };
    }
  }
  /** Observe the current supply for one World; records any change durably in Canvas's store. */
  async read(worldRef) {
    validateType('Ref', worldRef);
    await this.canvas.ready;
    const store = this.canvas.store;
    if (!store || store.unavailable) throw supplyError('CAPABILITY_UNAVAILABLE', 'REQUIRED_FACT_UNKNOWN');
    const before = this.#domain(worldRef);
    let observation;
    if (!before) {
      observation = { contracts: CONTRACTS_REF, domain: null, sessionRefs: [], sources: null,
        profiles: Object.fromEntries(Object.entries(PROFILES).map(([name, { type }]) => [name,
          { type, status: 'NOT_BOUND', value: null, digest: null, revision: null, fields: null,
            missing: [] }])) };
    } else {
      const catalogue = await this.#catalogue(worldRef);
      const after = this.#domain(worldRef);
      // The bound connection must not change while its facts are read.
      if (!same(before, after)) throw supplyError('STALE_REVISION', 'REVISION_CHANGED');
      const facts = { catalogue };
      const profiles = {};
      for (const [name, { type }] of Object.entries(PROFILES)) {
        const fields = Object.fromEntries(definitions[type].required
          .map(field => [field, resolveField(type, field, facts)]));
        profiles[name] = assembleProfile(name, fields, before.domain);
      }
      observation = { contracts: CONTRACTS_REF, domain: before.domain,
        sessionRefs: [...before.sessionRefs].sort(), profiles,
        sources: { catalogue: catalogue.status === 'READ' ?
          { status: 'READ', digest: catalogue.digest } :
          { status: catalogue.status, cause: catalogue.cause } } };
    }
    const digest = observationDigest(observation);
    const record = await store.commit(state => {
      state.configSupply ??= {};
      const row = state.configSupply[worldRef] ??= { sequence: 0, current: null, history: [] };
      if (row.current?.observationDigest === digest) return structuredClone(row);
      const now = new Date().toISOString();
      if (row.current) row.history.push({ ...row.current, supersededAt: now,
        supersededBy: digest, invalidationReasons: changeReasons(row.current, observation) });
      row.sequence += 1;
      row.current = { ...observation, observationDigest: digest, observedSequence: row.sequence,
        observedAt: now };
      return structuredClone(row);
    });
    return { profileVersion: SUPPLY_PROFILE, authority: AUTHORITY, worldRef,
      current: record.current, history: record.history };
  }
  #require(report, name) {
    const profile = report.current.profiles[name];
    if (profile.status === 'NOT_BOUND') throw supplyError('WORLD_NOT_BOUND', 'SCOPE_DENIED');
    if (profile.status !== 'SUPPLIED') throw supplyError('CAPABILITY_UNAVAILABLE',
      profile.missing.some(row => row.reason === 'POLICY_UNAVAILABLE') ?
        'POLICY_UNAVAILABLE' : 'REQUIRED_FACT_UNKNOWN',
      { missingSources: profile.missing, observationDigest: report.current.observationDigest });
    return profile;
  }
  /** Consumer port hanaworldsSafetyProfile.read(worldRef): a SafetyProfile or a named refusal. */
  async readSafetyProfile(worldRef) {
    return structuredClone(this.#require(await this.read(worldRef), 'safetyProfile').value);
  }
  /** Consumer port hanaworldsCompilerConfig.read(worldRef): {compilationConfig, compilerRevision}. */
  async readCompilerConfig(worldRef) {
    const profile = this.#require(await this.read(worldRef), 'compilationConfig');
    return { compilationConfig: structuredClone(profile.value), compilerRevision: profile.revision };
  }
}
