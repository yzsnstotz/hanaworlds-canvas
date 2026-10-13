import {
  schemaBundle,
  snapshotJSON,
  validateType
} from "./chunk-BTAVI4WZ.mjs";

// src/tool-summary.mjs
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
var object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
var ref = { type: "string", minLength: 1 };
var source = object({ kind: { enum: ["LOADED_WORLD_DECLARATION", "NATIVE_OBSERVATION"] }, factRef: ref, revision: ref });
var sourced = (value) => object({ value, source });
var connection = object({ worldRef: ref, connectionRef: ref, connectionIncarnationRef: ref });
var provider = object({ providerRef: ref, providerRevision: ref });
var toolSummarySchemas = {
  request: object({ sessionRef: ref, expectedConnection: connection, expectedProvider: provider }, ["sessionRef"]),
  source: object({
    profileVersion: { const: "canvas-source-facts/v1" },
    connection,
    provider,
    tools: { type: "array", minItems: 1, items: object({
      toolRef: ref,
      purpose: sourced(ref),
      typicalScale: sourced(object({ size: schemaBundle.definitions.RegionSize, unit: ref }))
    }) },
    unit: sourced(schemaBundle.definitions.GridUnit),
    frame: sourced(schemaBundle.definitions.Frame),
    partition: sourced(schemaBundle.definitions.Partition),
    sourceRevision: schemaBundle.definitions.Digest
  })
};
toolSummarySchemas.source.definitions = schemaBundle.definitions;
function summaryError(code, reason = "REQUIRED_FACT_UNKNOWN") {
  return Object.assign(new Error(code), { publicError: {
    code,
    phase: "validate",
    retryability: "AFTER_NEW_FACTS",
    mutationState: "NONE",
    transactionRef: null,
    causeCode: null,
    reason
  } });
}
var invalid = () => {
  throw summaryError("SCHEMA_INVALID", "INVALID_SHAPE");
};
function fields(value, allowed, required = allowed, missing = "SCHEMA_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw summaryError("UNKNOWN_REQUIRED_FIELD", "UNKNOWN_FIELD");
  if (required.some((key) => !Object.hasOwn(value, key))) throw summaryError(missing);
}
function refs(value, keys) {
  fields(value, keys);
  for (const key of keys) validateType("Ref", value[key]);
}
var scopeKeys = ["worldRef", "connectionRef", "connectionIncarnationRef"];
var providerKeys = ["providerRef", "providerRevision"];
function clean(value) {
  return snapshotJSON(value);
}
function summaryRequest(raw) {
  const input = clean(raw);
  fields(input, ["sessionRef", "expectedConnection", "expectedProvider"], ["sessionRef"]);
  validateType("Ref", input.sessionRef);
  if (Object.hasOwn(input, "expectedConnection")) refs(input.expectedConnection, scopeKeys);
  if (Object.hasOwn(input, "expectedProvider")) refs(input.expectedProvider, providerKeys);
  return input;
}
function sourcedValue(row, validate) {
  fields(row, ["value", "source"], ["value", "source"], "TARGET_FACTS_INCOMPLETE");
  fields(row.source, ["kind", "factRef", "revision"], ["kind", "factRef", "revision"], "TARGET_FACTS_INCOMPLETE");
  if (!["LOADED_WORLD_DECLARATION", "NATIVE_OBSERVATION"].includes(row.source.kind)) invalid();
  validateType("Ref", row.source.factRef);
  validateType("Ref", row.source.revision);
  validate(row.value);
}
function summarySource(raw) {
  const value = clean(raw);
  const keys = ["profileVersion", "connection", "provider", "tools", "unit", "frame", "partition", "sourceRevision"];
  fields(value, keys, keys, "TARGET_FACTS_INCOMPLETE");
  if (value.profileVersion !== "canvas-source-facts/v1") invalid();
  refs(value.connection, scopeKeys);
  refs(value.provider, providerKeys);
  if (!Array.isArray(value.tools) || !value.tools.length) invalid();
  for (let i = 0; i < value.tools.length; i++) {
    const tool = value.tools[i];
    fields(tool, ["toolRef", "purpose", "typicalScale"], ["toolRef", "purpose", "typicalScale"], "TARGET_FACTS_INCOMPLETE");
    validateType("Ref", tool.toolRef);
    if (i && value.tools[i - 1].toolRef >= tool.toolRef) invalid();
    sourcedValue(tool.purpose, (v) => validateType("Ref", v));
    sourcedValue(tool.typicalScale, (v) => {
      fields(v, ["size", "unit"]);
      validateType("RegionSize", v.size);
      validateType("Ref", v.unit);
    });
  }
  sourcedValue(value.unit, (v) => validateType("GridUnit", v));
  sourcedValue(value.frame, (v) => {
    try {
      validateType("Frame", v);
    } catch (error) {
      if (error.publicError?.code === "UNSUPPORTED_VERSION") invalid();
      throw error;
    }
  });
  sourcedValue(value.partition, (v) => validateType("Partition", v));
  if (value.partition.source.kind !== "NATIVE_OBSERVATION" || value.tools.some((tool) => tool.typicalScale.value.unit !== value.unit.value.name) || canonicalize(value.frame.value.gridUnit) !== canonicalize(value.unit.value)) invalid();
  validateType("Digest", value.sourceRevision);
  const { sourceRevision, ...body } = value;
  if (createHash("sha256").update(canonicalize(body)).digest("hex") !== sourceRevision)
    throw summaryError("READBACK_MISMATCH");
  return value;
}

export {
  toolSummarySchemas,
  summaryError,
  scopeKeys,
  summaryRequest,
  summarySource
};
