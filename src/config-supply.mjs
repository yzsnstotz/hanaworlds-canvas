import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { randomUUID } from 'node:crypto';
import { ContractError, checkContractHandshake, checkProtocolCompatibility, contractHandshake,
  digestValue, protocolRequirement, schemaBundle, validateBoundResponse, validateCatalogueFacts,
  validateRequest, validateType, validateWriteProfile } from 'hanaworlds-contracts';

/*
 * Stage 1 validation configuration supply: CompilationConfig for one World.
 *
 * Canvas assembles, revisions and invalidates the CompilationConfig of the bound World. It does
 * not invent any value: every field names where it comes from, and a field without a real source
 * is reported by name and the profile is refused (CAPABILITY_UNAVAILABLE). There is no default,
 * no fixture value, no hand-written revision and no editing path here.
 *
 * Canvas declares and supplies no SafetyProfile (v1): its only source is the player's confirmed
 * intent through the Contracts pure function, never a World, Host or Canvas value. Canvas keeps
 * its transaction role (per-cell/region commit, rollback, recovery) and the engine checks bodies.
 *
 * Field sources (the whole table; a new schema field not listed here is refused as UNMAPPED):
 * - CONTRACT_SCHEMA: the installed Contracts schema allows exactly one value (`const`).
 * - WORLD_SOURCE_FACT: read from the bound World's source through C-world-facts (world-facts/v1
 *   ReadCatalogue + ReadWriteProfile). The world source owns the complete CompilationConfig;
 *   Canvas forwards each field unchanged and never reads an engine, mod or package name.
 */
export const SUPPLY_PROFILE = 'canvas-stage1-config-supply/v2';
const AUTHORITY = 'hanaworlds-canvas';
const CONTRACTS_REF = contractHandshake.contracts;
const definitions = schemaBundle.definitions;

const PROFILES = {
  compilationConfig: { type: 'CompilationConfig', digestKind: 'compilation-config',
    revisionPrefix: 'compiler-config' },
};

const FACTS_WIRE = 'world-facts/v1';
const sha = (kind, value) => digestValue(kind, value).sha256;
const same = (a, b) => canonicalize(a) === canonicalize(b);
// Canvas-own domain-separated digest (Contracts has no production kind for this own record).
const observationDigest = value => createHash('sha256')
  .update(`HanaWorlds|canvas|${SUPPLY_PROFILE}\n`).update(canonicalize(value)).digest('hex');

// A ContractError, so a consumer that maps through Contracts publicError() (Workshop does)
// keeps the exact code/reason instead of a generic decode error. missingSources stays on the
// thrown object and in Canvas's own readback; the public Error shape has no field for it.
export function supplyError(code, reason, extra = {}) {
  return Object.assign(new ContractError(code, 'validate', reason), extra);
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
  if (type === 'CompilationConfig') {
    const profile = facts.writeProfile;
    const ref = `C-world-facts ReadWriteProfile.compilationConfig.${field}`;
    const need = `${ref} declared by the bound world source`;
    if (profile.status !== 'READ') return { status: 'MISSING', value: null,
      provenance: null, sourceKind: 'WORLD_SOURCE_FACT', reason: profile.stale ?
        'REVISION_CHANGED' : 'REQUIRED_FACT_UNKNOWN', cause: profile.cause, need };
    // Contracts admits compilationConfig null exactly when the backend is UNAVAILABLE.
    if (profile.value.compilationConfig === null) return { status: 'MISSING', value: null,
      provenance: null, sourceKind: 'WORLD_SOURCE_FACT', reason: 'REQUIRED_FACT_UNKNOWN',
      cause: profile.value.writeBackend.reason, need };
    return { status: 'SUPPLIED', value: structuredClone(profile.value.compilationConfig[field]),
      provenance: { kind: 'WORLD_SOURCE_FACT', ref, sourceRevision: profile.revision,
        basis: profile.value.writeBackend.basis } };
  }
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

/** Canvas-owned supply over one CanvasV5 instance (its store and C-world-facts port). */
export class CanvasConfigSupply {
  constructor(canvas) { this.canvas = canvas; }
  #domain(worldRef) {
    const rows = boundDomain(this.canvas.store.snapshot, worldRef);
    if (rows.length > 1) throw supplyError('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED',
      { boundConnections: rows });
    return rows[0] ?? null;
  }
  // One world-facts/v1 read over the Host's world source facts port, admitted in both directions.
  // A declared peer error keeps its public code; nothing is defaulted.
  async #call(operation, worldRef) {
    const port = this.canvas.worldFacts;
    if (typeof port?.call !== 'function') throw supplyError('ADAPTER_UNAVAILABLE',
      'REQUIRED_FACT_UNKNOWN', { cause: 'WORLD_FACTS_PORT_ABSENT' });
    if (port.protocolHandshake !== undefined)
      checkProtocolCompatibility(port.protocolHandshake, [protocolRequirement(FACTS_WIRE)]);
    else checkContractHandshake(port.contractHandshake, { wires: [FACTS_WIRE], factProfiles: [] });
    const request = validateRequest(FACTS_WIRE, operation,
      { contractVersion: FACTS_WIRE, requestId: randomUUID(), worldRef });
    const response = validateBoundResponse(FACTS_WIRE, operation, request,
      await port.call(operation, request));
    if (response.error) throw supplyError(response.error.code, response.error.reason,
      { cause: response.error.code });
    return response.result;
  }
  #unavailable(error) {
    // Preserve only the typed code, never a provider exception or rejected raw facts.
    const cause = error.cause ?? (error instanceof ContractError ? error.code : 'WORLD_FACT_UNREADABLE');
    return { status: 'UNAVAILABLE', cause,
      stale: cause === 'CURRENT_WORLD_MISMATCH' || cause === 'CATALOGUE_MISMATCH' };
  }
  async #catalogue(domain) {
    const { worldRef, connectionRef, connectionIncarnationRef } = domain;
    try {
      const facts = validateCatalogueFacts(await this.#call('ReadCatalogue', worldRef),
        { worldRef, connectionRef, connectionIncarnationRef });
      return { status: 'READ', value: facts.catalogue, digest: facts.catalogueDigest };
    } catch (error) { return this.#unavailable(error); }
  }
  async #writeProfile(catalogue, domain) {
    if (catalogue.status !== 'READ')
      return { status: 'UNAVAILABLE', cause: 'CATALOGUE_UNRESOLVED', stale: catalogue.stale };
    const { worldRef, connectionRef, connectionIncarnationRef } = domain;
    try {
      const value = validateWriteProfile(await this.#call('ReadWriteProfile', worldRef),
        catalogue.value, { worldRef, connectionRef, connectionIncarnationRef });
      // WriteProfile has no source revision of its own; Canvas's own digest of the exact value.
      return { status: 'READ', value, revision: `write-profile-${observationDigest(value).slice(0, 32)}` };
    } catch (error) { return this.#unavailable(error); }
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
      observation = { contracts: CONTRACTS_REF, domain: null,
        sessionRefs: [], sources: null,
        profiles: Object.fromEntries(Object.entries(PROFILES).map(([name, { type }]) => [name,
          { type, status: 'NOT_BOUND', value: null, digest: null, revision: null, fields: null,
            missing: [] }])) };
    } else {
      const catalogue = await this.#catalogue(before.domain);
      const writeProfile = await this.#writeProfile(catalogue, before.domain);
      const after = this.#domain(worldRef);
      // The bound connection must not change while its facts are read.
      if (!same(before, after)) throw supplyError('STALE_REVISION', 'REVISION_CHANGED');
      const facts = { catalogue, writeProfile };
      const profiles = {};
      for (const [name, { type }] of Object.entries(PROFILES)) {
        const fields = Object.fromEntries(definitions[type].required
          .map(field => [field, resolveField(type, field, facts)]));
        profiles[name] = assembleProfile(name, fields, before.domain);
      }
      observation = { contracts: CONTRACTS_REF, domain: before.domain,
        sessionRefs: [...before.sessionRefs].sort(), profiles,
        sources: { writeProfile: writeProfile.status === 'READ' ?
          { status: 'READ', sourceRevision: writeProfile.revision } :
          { status: writeProfile.status, cause: writeProfile.cause }, catalogue: catalogue.status === 'READ' ?
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
    if (profile.status !== 'SUPPLIED' && profile.missing.some(row => row.reason === 'REVISION_CHANGED'))
      throw supplyError('STALE_REVISION', 'REVISION_CHANGED',
        { missingSources: profile.missing, observationDigest: report.current.observationDigest });
    if (profile.status !== 'SUPPLIED') throw supplyError('CAPABILITY_UNAVAILABLE',
      'REQUIRED_FACT_UNKNOWN',
      { missingSources: profile.missing, observationDigest: report.current.observationDigest });
    return profile;
  }
  /** Consumer port hanaworldsCompilerConfig.read(worldRef): {compilationConfig, compilerRevision}. */
  async readCompilerConfig(worldRef) {
    const profile = this.#require(await this.read(worldRef), 'compilationConfig');
    return { compilationConfig: structuredClone(profile.value), compilerRevision: profile.revision };
  }
}
