import {
  requestWorldSelectors,
  targetWorldRef
} from "./chunk-ZMSQQTQX.mjs";

// src/world-error.mjs
var WORLD_UNAVAILABLE_CODES = Object.freeze([
  "CAPABILITY_UNAVAILABLE",
  "ADAPTER_UNAVAILABLE",
  "CAPABILITY_GAP",
  "CONNECTION_NOT_FOUND",
  "WORLD_NOT_FOUND",
  "WORLD_NOT_BOUND",
  "TARGET_FACTS_INCOMPLETE"
]);
var unavailable = new Set(WORLD_UNAVAILABLE_CODES);
function trustedSessionWorld(store, request) {
  if (!store || store.unavailable || typeof request?.sessionRef !== "string") return {};
  const sessions = store.snapshot.sessions;
  const bound = Object.hasOwn(sessions, request.sessionRef) ? sessions[request.sessionRef].activeWorldRef : null;
  return typeof bound === "string" ? { [request.sessionRef]: bound } : {};
}
function withTargetWorld(error, request, trustedSessionWorlds = {}) {
  if (!error || !unavailable.has(error.code) || Object.hasOwn(error, "worldRef")) return error;
  if (new Set(requestWorldSelectors(request)).size > 1) return error;
  const worldRef = targetWorldRef(request, trustedSessionWorlds);
  return worldRef === void 0 ? error : { ...error, worldRef };
}
function nameTargetWorld(thrown, request, trustedSessionWorlds) {
  if (thrown?.publicError)
    thrown.publicError = withTargetWorld(thrown.publicError, request, trustedSessionWorlds);
  return thrown;
}
var refOrUndefined = (value) => typeof value === "string" && value.length > 0 ? value : void 0;

export {
  WORLD_UNAVAILABLE_CODES,
  trustedSessionWorld,
  withTargetWorld,
  nameTargetWorld,
  refOrUndefined
};
