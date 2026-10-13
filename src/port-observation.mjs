import { channel } from 'node:diagnostics_channel';

// Passive observations retain the original receiver, synchronous throws,
// Promise boundary and returned object. A copying failure invalidates evidence.
const calls = channel('hanaworlds-canvas/contract-call');
function snapshot(owner, service, operation, value) {
  try { return { ok: true, value: structuredClone(value) }; }
  catch (error) {
    calls.publish({ owner, service, operation, phase: 'observation-failure',
      error: { name: error.name, message: error.message } });
    return { ok: false };
  }
}
export function observePortCall(owner, service, operation, request, invoke) {
  if (!calls.hasSubscribers) return invoke();
  const observedRequest = snapshot(owner, service, operation, request);
  const succeeded = response => {
    const observedResponse = snapshot(owner, service, operation, response);
    if (observedRequest.ok && observedResponse.ok)
      calls.publish({ owner, service, operation, request: observedRequest.value,
        response: observedResponse.value, phase: 'result' });
    return response;
  };
  const failed = error => {
    const observedError = snapshot(owner, service, operation, error?.publicError ??
      { code: error?.code ?? error?.name, message: String(error?.message ?? error) });
    if (observedRequest.ok && observedError.ok)
      calls.publish({ owner, service, operation, request: observedRequest.value,
        error: observedError.value, phase: 'failure' });
    throw error;
  };
  let result;
  try { result = invoke(); } catch (error) { return failed(error); }
  return result && typeof result.then === 'function' ? result.then(succeeded, failed) : succeeded(result);
}
export function observeEvent(owner, event) {
  if (calls.hasSubscribers) calls.publish({ owner, event, phase: 'event' });
}
export function observeDisplayFailure(owner, operation, error) {
  if (calls.hasSubscribers) calls.publish({ owner, service: 'hanaworldsCanvasDisplay',
    operation, error, phase: 'display-failure' });
}
