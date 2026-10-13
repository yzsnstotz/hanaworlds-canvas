import {
  ContractError,
  checkContractHandshake,
  checkProtocolCompatibility,
  contractHandshake,
  digestValue,
  protocolRequirement,
  schemaBundle,
  validateBoundResponse,
  validateCatalogueFacts,
  validateRequest,
  validateType,
  validateWriteProfile
} from "./chunk-BTAVI4WZ.mjs";

// src/config-supply.mjs
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { randomUUID } from "node:crypto";
var SUPPLY_PROFILE = "canvas-stage1-config-supply/v2";
var AUTHORITY = "hanaworlds-canvas";
var CONTRACTS_REF = contractHandshake.contracts;
var definitions = schemaBundle.definitions;
var PROFILES = {
  compilationConfig: {
    type: "CompilationConfig",
    digestKind: "compilation-config",
    revisionPrefix: "compiler-config"
  }
};
var FACTS_WIRE = "world-facts/v1";
var sha = (kind, value) => digestValue(kind, value).sha256;
var same = (a, b) => canonicalize(a) === canonicalize(b);
var observationDigest = (value) => createHash("sha256").update(`HanaWorlds|canvas|${SUPPLY_PROFILE}
`).update(canonicalize(value)).digest("hex");
function supplyError(code, reason, extra = {}) {
  return Object.assign(new ContractError(code, "validate", reason), extra);
}
function boundDomain(snapshot, worldRef) {
  const rows = /* @__PURE__ */ new Map();
  for (const [sessionRef, session] of Object.entries(snapshot.sessions ?? {})) {
    if (session?.activeWorldRef !== worldRef || !session.localContext) continue;
    const connection = snapshot.connections?.[sessionRef];
    if (!connection || connection.worldRef !== worldRef) continue;
    const domain = {
      worldRef,
      connectionRef: connection.connectionRef,
      connectionIncarnationRef: connection.connectionIncarnationRef,
      payloadVersion: connection.payloadVersion,
      capabilityRevision: connection.capabilities?.capabilityRevision ?? null
    };
    const key = canonicalize(domain);
    const row = rows.get(key) ?? { domain, sessionRefs: [] };
    row.sessionRefs.push(sessionRef);
    rows.set(key, row);
  }
  return [...rows.values()];
}
function resolveField(type, field, facts) {
  const schema = definitions[type].properties[field];
  if (Object.hasOwn(schema, "const")) return {
    status: "SUPPLIED",
    value: schema.const,
    provenance: {
      kind: "CONTRACT_SCHEMA",
      ref: `${CONTRACTS_REF}#${type}.${field}`,
      sourceRevision: CONTRACTS_REF
    }
  };
  if (type === "CompilationConfig") {
    const profile = facts.writeProfile;
    const ref = `C-world-facts ReadWriteProfile.compilationConfig.${field}`;
    const need = `${ref} declared by the bound world source`;
    if (profile.status !== "READ") return {
      status: "MISSING",
      value: null,
      provenance: null,
      sourceKind: "WORLD_SOURCE_FACT",
      reason: profile.stale ? "REVISION_CHANGED" : "REQUIRED_FACT_UNKNOWN",
      cause: profile.cause,
      need
    };
    if (profile.value.compilationConfig === null) return {
      status: "MISSING",
      value: null,
      provenance: null,
      sourceKind: "WORLD_SOURCE_FACT",
      reason: "REQUIRED_FACT_UNKNOWN",
      cause: profile.value.writeBackend.reason,
      need
    };
    return {
      status: "SUPPLIED",
      value: structuredClone(profile.value.compilationConfig[field]),
      provenance: {
        kind: "WORLD_SOURCE_FACT",
        ref,
        sourceRevision: profile.revision,
        basis: profile.value.writeBackend.basis
      }
    };
  }
  return {
    status: "MISSING",
    value: null,
    provenance: null,
    sourceKind: "UNMAPPED",
    reason: "REQUIRED_FACT_UNKNOWN",
    need: `no Canvas source is mapped for ${type}.${field}`
  };
}
function assembleProfile(name, fields, domain) {
  const { type, digestKind, revisionPrefix } = PROFILES[name];
  const missing = Object.entries(fields).filter(([, row]) => row.status !== "SUPPLIED").map(([field, row]) => ({
    profile: type,
    field,
    sourceKind: row.sourceKind,
    reason: row.reason,
    need: row.need,
    cause: row.cause ?? null
  }));
  if (missing.length) return {
    type,
    status: "SOURCE_MISSING",
    value: null,
    digest: null,
    revision: null,
    fields,
    missing
  };
  const value = validateType(type, Object.fromEntries(Object.entries(fields).map(([field, row]) => [field, row.value])));
  const digest = sha(digestKind, value);
  const provenance = Object.fromEntries(Object.entries(fields).map(([field, row]) => [field, row.provenance]));
  const revision = `${revisionPrefix}-${observationDigest({ type, digest, provenance, domain }).slice(0, 32)}`;
  return { type, status: "SUPPLIED", value, digest, revision, fields, missing: [] };
}
function changeReasons(previous, current) {
  if (!previous) return ["FIRST_OBSERVATION"];
  const reasons = [];
  if (!same(previous.domain, current.domain)) reasons.push(current.domain ? previous.domain ? "CONNECTION_DOMAIN_CHANGED" : "WORLD_BOUND" : "WORLD_UNBOUND");
  if (!same(previous.sources, current.sources)) reasons.push("SOURCE_REVISION_CHANGED");
  if (previous.contracts !== current.contracts) reasons.push("CONTRACTS_CHANGED");
  for (const name of Object.keys(PROFILES)) {
    const a = previous.profiles[name], b = current.profiles[name];
    if (a.status !== b.status) reasons.push(`${PROFILES[name].type.toUpperCase()}_STATUS_CHANGED`);
    else if (a.revision !== b.revision || !same(a.fields, b.fields))
      reasons.push(`${PROFILES[name].type.toUpperCase()}_CHANGED`);
  }
  return reasons.length ? reasons : ["OBSERVATION_CHANGED"];
}
var CanvasConfigSupply = class {
  constructor(canvas) {
    this.canvas = canvas;
  }
  #domain(worldRef) {
    const rows = boundDomain(this.canvas.store.snapshot, worldRef);
    if (rows.length > 1) throw supplyError(
      "CURRENT_WORLD_MISMATCH",
      "SCOPE_DENIED",
      { boundConnections: rows }
    );
    return rows[0] ?? null;
  }
  // One world-facts/v1 read over the Host's world source facts port, admitted in both directions.
  // A declared peer error keeps its public code; nothing is defaulted.
  async #call(operation, worldRef) {
    const port = this.canvas.worldFacts;
    if (typeof port?.call !== "function") throw supplyError(
      "ADAPTER_UNAVAILABLE",
      "REQUIRED_FACT_UNKNOWN",
      { cause: "WORLD_FACTS_PORT_ABSENT" }
    );
    if (port.protocolHandshake !== void 0)
      checkProtocolCompatibility(port.protocolHandshake, [protocolRequirement(FACTS_WIRE)]);
    else checkContractHandshake(port.contractHandshake, { wires: [FACTS_WIRE], factProfiles: [] });
    const request = validateRequest(
      FACTS_WIRE,
      operation,
      { contractVersion: FACTS_WIRE, requestId: randomUUID(), worldRef }
    );
    const response = validateBoundResponse(
      FACTS_WIRE,
      operation,
      request,
      await port.call(operation, request)
    );
    if (response.error) throw supplyError(
      response.error.code,
      response.error.reason,
      { cause: response.error.code }
    );
    return response.result;
  }
  #unavailable(error) {
    let typedCode;
    try {
      typedCode = validateType("Error", error?.publicError).code;
    } catch {
    }
    const cause = error.cause ?? typedCode ?? "WORLD_FACT_UNREADABLE";
    return {
      status: "UNAVAILABLE",
      cause,
      stale: cause === "CURRENT_WORLD_MISMATCH" || cause === "CATALOGUE_MISMATCH"
    };
  }
  async #catalogue(domain) {
    const { worldRef, connectionRef, connectionIncarnationRef } = domain;
    try {
      const facts = validateCatalogueFacts(
        await this.#call("ReadCatalogue", worldRef),
        { worldRef, connectionRef, connectionIncarnationRef }
      );
      return { status: "READ", value: facts.catalogue, digest: facts.catalogueDigest };
    } catch (error) {
      return this.#unavailable(error);
    }
  }
  async #writeProfile(catalogue, domain) {
    if (catalogue.status !== "READ")
      return { status: "UNAVAILABLE", cause: "CATALOGUE_UNRESOLVED", stale: catalogue.stale };
    const { worldRef, connectionRef, connectionIncarnationRef } = domain;
    try {
      const value = validateWriteProfile(
        await this.#call("ReadWriteProfile", worldRef),
        catalogue.value,
        { worldRef, connectionRef, connectionIncarnationRef }
      );
      return { status: "READ", value, revision: `write-profile-${observationDigest(value).slice(0, 32)}` };
    } catch (error) {
      return this.#unavailable(error);
    }
  }
  /** Observe the current supply for one World; records any change durably in Canvas's store. */
  async read(worldRef) {
    validateType("Ref", worldRef);
    await this.canvas.ready;
    const store = this.canvas.store;
    if (!store || store.unavailable) throw supplyError("CAPABILITY_UNAVAILABLE", "REQUIRED_FACT_UNKNOWN");
    const before = this.#domain(worldRef);
    let observation;
    if (!before) {
      observation = {
        contracts: CONTRACTS_REF,
        domain: null,
        sessionRefs: [],
        sources: null,
        profiles: Object.fromEntries(Object.entries(PROFILES).map(([name, { type }]) => [
          name,
          {
            type,
            status: "NOT_BOUND",
            value: null,
            digest: null,
            revision: null,
            fields: null,
            missing: []
          }
        ]))
      };
    } else {
      const catalogue = await this.#catalogue(before.domain);
      const writeProfile = await this.#writeProfile(catalogue, before.domain);
      const after = this.#domain(worldRef);
      if (!same(before, after)) throw supplyError("STALE_REVISION", "REVISION_CHANGED");
      const facts = { catalogue, writeProfile };
      const profiles = {};
      for (const [name, { type }] of Object.entries(PROFILES)) {
        const fields = Object.fromEntries(definitions[type].required.map((field) => [field, resolveField(type, field, facts)]));
        profiles[name] = assembleProfile(name, fields, before.domain);
      }
      observation = {
        contracts: CONTRACTS_REF,
        domain: before.domain,
        sessionRefs: [...before.sessionRefs].sort(),
        profiles,
        sources: { writeProfile: writeProfile.status === "READ" ? { status: "READ", sourceRevision: writeProfile.revision } : { status: writeProfile.status, cause: writeProfile.cause }, catalogue: catalogue.status === "READ" ? { status: "READ", digest: catalogue.digest } : { status: catalogue.status, cause: catalogue.cause } }
      };
    }
    const digest = observationDigest(observation);
    const record = await store.commit((state) => {
      state.configSupply ??= {};
      const row = state.configSupply[worldRef] ??= { sequence: 0, current: null, history: [] };
      if (row.current?.observationDigest === digest) return structuredClone(row);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (row.current) row.history.push({
        ...row.current,
        supersededAt: now,
        supersededBy: digest,
        invalidationReasons: changeReasons(row.current, observation)
      });
      row.sequence += 1;
      row.current = {
        ...observation,
        observationDigest: digest,
        observedSequence: row.sequence,
        observedAt: now
      };
      return structuredClone(row);
    });
    return {
      profileVersion: SUPPLY_PROFILE,
      authority: AUTHORITY,
      worldRef,
      current: record.current,
      history: record.history
    };
  }
  #require(report, name) {
    const profile = report.current.profiles[name];
    if (profile.status === "NOT_BOUND") throw supplyError("WORLD_NOT_BOUND", "SCOPE_DENIED");
    if (profile.status !== "SUPPLIED" && profile.missing.some((row) => row.reason === "REVISION_CHANGED"))
      throw supplyError(
        "STALE_REVISION",
        "REVISION_CHANGED",
        { missingSources: profile.missing, observationDigest: report.current.observationDigest }
      );
    if (profile.status !== "SUPPLIED") throw supplyError(
      "CAPABILITY_UNAVAILABLE",
      "REQUIRED_FACT_UNKNOWN",
      { missingSources: profile.missing, observationDigest: report.current.observationDigest }
    );
    return profile;
  }
  /** Consumer port hanaworldsCompilerConfig.read(worldRef): {compilationConfig, compilerRevision}. */
  async readCompilerConfig(worldRef) {
    const profile = this.#require(await this.read(worldRef), "compilationConfig");
    return { compilationConfig: structuredClone(profile.value), compilerRevision: profile.revision };
  }
};

export {
  SUPPLY_PROFILE,
  supplyError,
  boundDomain,
  assembleProfile,
  CanvasConfigSupply
};
