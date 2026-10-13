/** Host-local C-session observation protocol. Deliberately absent from wire operations. */
export const sessionReadGuard = Object.freeze({
  protocol: 'session-read-guard/v1', contract: 'C-session', introducedIn: '2.11.0',
  service: 'hanaworldsWorkshop', capture: 'captureSessionReadGuard', check: 'isSessionReadGuardCurrent',
  boundary: 'Capture before asynchronous preparation; after the final await check every provider and local state in one synchronous execution segment before returning.',
  validity: 'Monotonic: any intervening change, disposal, replacement or ABA permanently invalidates the exact guard. Never reset, retry or renew a failed read.',
  transport: 'Same Cordis runtime only; opaque local guard is not JSON, HTTP, a lease or persistent state.',
  unavailable: 'CAPABILITY_UNAVAILABLE', fixture: 'fixtures/session-read-guard',
});
/** Minimal public unsupported-provider fixture, not a stability-success mock. */
export function createUnavailableSessionReadGuardFixture(missing) {
  if (!Array.isArray(missing) || !missing.length || missing.some(x => typeof x !== 'string' || !x))
    throw new TypeError('Concrete missing official guarantees required');
  const gaps = Object.freeze([...missing]);
  return Object.freeze({
    captureSessionReadGuard() { return Object.freeze({ protocol: sessionReadGuard.protocol, guard: null,
      error: Object.freeze({ code: 'CAPABILITY_UNAVAILABLE' }), missing: gaps }); },
    isSessionReadGuardCurrent() { return false; },
  });
}
