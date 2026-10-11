import { requestWorldSelectors, targetWorldRef } from 'hanaworlds-contracts';

// Contracts 2.7.0 Error.worldRef: the public codes by which Canvas fails closed because the
// world an admitted operation needs — or the store, Adapter, port or capability that reaches
// it — is unavailable. Other refusals (stale revisions, conflicts, decode) name no world.
export const WORLD_UNAVAILABLE_CODES = Object.freeze(['CAPABILITY_UNAVAILABLE',
  'ADAPTER_UNAVAILABLE', 'CAPABILITY_GAP', 'CONNECTION_NOT_FOUND', 'WORLD_NOT_FOUND',
  'WORLD_NOT_BOUND', 'TARGET_FACTS_INCOMPLETE']);
const unavailable = new Set(WORLD_UNAVAILABLE_CODES);

/** The Session → World binding Canvas itself holds durably for this request's Session only. */
export function trustedSessionWorld(store, request) {
  if (!store || store.unavailable || typeof request?.sessionRef !== 'string') return {};
  const sessions = store.snapshot.sessions;
  const bound = Object.hasOwn(sessions, request.sessionRef) ?
    sessions[request.sessionRef].activeWorldRef : null;
  return typeof bound === 'string' ? { [request.sessionRef]: bound } : {};
}

/**
 * The public Error of an admitted request, naming the world it needed when Canvas failed
 * closed for world unavailability. The target is the request's own selector, else Canvas's
 * trusted binding of that request's Session (targetWorldRef); never raw input, an exception
 * message or another Session's world. Every existing field — mutationState, transactionRef,
 * causeCode, reason — is kept exactly. Unchanged (no worldRef) when the code is not a world
 * unavailability, the error already names a world, the request selects two different worlds,
 * or no target can be determined.
 */
export function withTargetWorld(error, request, trustedSessionWorlds = {}) {
  if (!error || !unavailable.has(error.code) || Object.hasOwn(error, 'worldRef')) return error;
  if (new Set(requestWorldSelectors(request)).size > 1) return error;
  const worldRef = targetWorldRef(request, trustedSessionWorlds);
  return worldRef === undefined ? error : { ...error, worldRef };
}

/** Same, for a thrown Canvas/provider error: replaces only its publicError, never the cause. */
export function nameTargetWorld(thrown, request, trustedSessionWorlds) {
  if (thrown?.publicError)
    thrown.publicError = withTargetWorld(thrown.publicError, request, trustedSessionWorlds);
  return thrown;
}

/** A host-port argument that has the published Ref shape (non-empty string, never trimmed or
 * normalised), else undefined: a malformed argument names no world. */
export const refOrUndefined = value => typeof value === 'string' && value.length > 0 ? value : undefined;
