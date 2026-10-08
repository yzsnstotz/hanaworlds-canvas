/*
 * FIXTURE session/v3 port (Workshop stand-in, contracts-shaped): answers
 * ReadSessionIdentity for every Session except those marked unknown/deleted. It is not
 * Workshop, proves no real Session existence, and never deletes anything. Canvas reads it
 * only when the installed Contracts declare the session-world seam (canvas/v5 minor 1).
 */
export function fixtureSessions({ revision = 'session-0', revisions = {}, unknown = [] } = {}) {
  const port = { unknown: new Set(unknown), revisions: { ...revisions }, calls: [],
    async call(operation, request) {
      port.calls.push(operation);
      if (operation !== 'ReadSessionIdentity') throw new Error(`FIXTURE_UNSUPPORTED_SESSION_OPERATION:${operation}`);
      if (port.unknown.has(request.sessionRef)) return { contractVersion: 'session/v3',
        requestId: request.requestId, result: null, error: { code: 'SESSION_NOT_FOUND',
          phase: 'validate', retryability: 'AFTER_NEW_FACTS', mutationState: 'NONE',
          transactionRef: null, causeCode: null, reason: 'IDENTITY_UNVERIFIED' } };
      return { contractVersion: 'session/v3', requestId: request.requestId, error: null,
        result: { sessionRef: request.sessionRef,
          sessionRevision: port.revisions[request.sessionRef] ?? revision } };
    } };
  return port;
}
