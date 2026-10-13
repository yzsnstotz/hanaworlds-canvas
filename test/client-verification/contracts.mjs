import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateType, validateRequest, validateResponse, validateBoundResponse,
  validateRegionCommit, validateRegionUndo, validateScopedRegionUndo,
  validateCanvasEvent, canonicalJSON } from '../../src/protocol/local/index.mjs';
import { summaryRequest, summarySource } from '../../src/tool-summary.mjs';
import { ENGINE_GUARD_REQUIREMENTS, unmetGuards } from '../../src/region-v1.mjs';
export const examples = JSON.parse(await readFile(new URL('./canvas-examples.json', import.meta.url), 'utf8'));

export function checkSnapshot(value) {
  assert.ok(value && typeof value === 'object', 'Actual before/after evidence is mandatory');
  for (const key of ['selection', 'context', 'registry', 'objects', 'history', 'pending', 'recovery', 'worldRevision', 'scopedState'])
    assert.ok(Object.hasOwn(value, key), `Actual snapshot missing ${key}`);
  assert.ok(value.scopedState?.worldRef);
  validateType('StateProfile', value.scopedState.stateProfile); validateType('ScopedCells', value.scopedState.cells);
  assert.ok(value.scopedState.cells.length > 0, 'Real readback of the case scope is required');
}

// Bind only opaque references/revisions/digests and observed time. It cannot
// replace a subtree, status, error code, geometry, material, policy or quantity.
export function bind(value, bindings = [], permitted = []) {
  const result = structuredClone(value);
  const allowed = new Map(permitted.map(x => [x.path, x]));
  // Resolve dictionary values before renaming opaque object-reference keys.
  for (const row of [...bindings].sort((a, b) => Number(a.kind === 'RefKey') - Number(b.kind === 'RefKey'))) {
    const specification = allowed.get(row.path);
    assert.ok(specification, `No enum/policy/quantity/subtree binding: ${row.path}`);
    assert.equal(row.kind, specification.kind); assert.equal(row.example, specification.example);
    assert.ok(typeof row.value === 'string' || row.kind === 'NativeCode' && row.value === null);
    if (row.observedBeforeCall !== true) {
      assert.equal(row.observationPhase, 'AFTER_CALL_READBACK');
      assert.match(row.path, /^\/(response|events|failure)\//, 'Request/CAS bindings must be established before the call');
      assert.ok(row.evidence?.surface && row.evidence.provider?.registrationRef);
      assert.equal(row.evidence.provider.origin, 'OFFICIAL_LOADER');
      assert.deepEqual(row.evidence.observedValue, row.value, 'Provider-assigned opaque outputs need an independent actual readback');
      assert.ok(Object.hasOwn(row.evidence, 'request') && Object.hasOwn(row.evidence, 'response'));
    }
    if (row.kind === 'Digest') assert.match(row.value, /^[a-f0-9]{64}$/);
    const path = row.path.slice(1).split('/'); let target = result;
    for (const key of path.slice(0, -1)) { if (!target || !Object.hasOwn(target, key)) { target = null; break; } target = target[key]; }
    if (target && row.kind === 'RefKey') {
      const old = path.at(-1).slice(5); assert.ok(Object.hasOwn(target, old));
      const child = target[old]; delete target[old]; Object.defineProperty(target, row.value, { value: child, enumerable: true, configurable: true, writable: true }); continue;
    }
    if (!target || !Object.hasOwn(target, path.at(-1))) continue;
    assert.deepEqual(target[path.at(-1)], specification.example);
    target[path.at(-1)] = row.value;
  }
  return result;
}
export function checkEnvelope(item, request, response) {
  validateRequest(item.wire, item.id, request); validateResponse(item.wire, item.id, response);
  assert.equal(response.requestId, request.requestId); assert.equal(response.contractVersion, item.wire);
  if (!response.error) {
    if (item.id === 'ApplyRegionCommit') validateRegionCommit(request, response);
    else if (item.wire === 'canvas/v7' || item.id === 'UndoScopedRegionCommit') validateBoundResponse(item.wire, item.id, request, response);
  }
}
export function checkActual(item, mode, actual) {
  assert.equal(actual.caseId, item.id); assert.equal(actual.mode, mode);
  assert.equal(actual.execution, 'INSTALLED_CLIENT_TO_REGISTERED_PROVIDER');
  assert.ok(actual.provider.instanceRef && actual.provider.registrationRef);
  checkSnapshot(actual.before); checkSnapshot(actual.after);
  const pair = bind({ request: mode === 'ok' ? item.request : item.invalidRequest,
    [mode === 'ok' ? 'response' : 'failure']: mode === 'ok' ? item.response : item.failure }, actual.bindings, item.bindings);
  assert.deepEqual(actual.request, pair.request);
  assert.deepEqual(actual.response, pair[mode === 'ok' ? 'response' : 'failure'], 'Every success/refusal field must match the complete document example');
  if (mode === 'ok') {
    checkEnvelope(item, actual.request, actual.response);
    if (item.id === 'UndoRegionCommit' || item.id === 'UndoScopedRegionCommit') {
      assert.equal(actual.originReadBeforeCall, true);
      assert.ok(actual.origin, 'Origin must be read from the actual durable verified transaction');
      if (item.id === 'UndoRegionCommit') validateRegionUndo(actual.request, actual.response, actual.origin.result);
      else validateScopedRegionUndo(actual.request, actual.response, actual.origin);
    }
  }
  else {
    validateResponse(item.wire, item.id, actual.response);
    assert.deepEqual(actual.before, actual.after, 'Decode refusal cannot write world/selection/history/pending state');
    assert.deepEqual(actual.adapterCalls, []); assert.deepEqual(actual.events, []);
  }
  for (const event of actual.events) validateCanvasEvent(event.event, event);
}
export function checkLocal(item, mode, actual) {
  assert.equal(actual.caseId, item.id); assert.equal(actual.mode, mode);
  assert.equal(actual.execution, 'INSTALLED_CLIENT_TO_REGISTERED_PROVIDER');
  checkSnapshot(actual.before); checkSnapshot(actual.after);
  const pair = bind({ request: mode === 'ok' ? item.request : item.invalidRequest,
    [mode === 'ok' ? 'response' : 'failure']: mode === 'ok' ? item.response : item.failure }, actual.bindings, item.bindings);
  assert.deepEqual(actual.request, pair.request);
  if (item.id === 'readToolSummary' && mode === 'ok') {
    summaryRequest(actual.request); summarySource(actual.response.source); summarySource(actual.sourceBefore);
    assert.deepEqual(actual.response.source, actual.sourceBefore, 'Complete sourced facts must equal the independent live pre-read, not fixed example numbers');
    assert.equal(actual.response.objectsHistory.state, 'READY');
    assert.ok(actual.response.objectsHistory.objects.length > 0 && actual.response.objectsHistory.history.length > 0);
    assert.deepEqual(actual.response.objectsHistory, actual.historyBefore);
  } else if (item.id === 'readScopedState' && mode === 'ok') {
    validateType('StateProfile', actual.response.stateProfile); validateType('ScopedCells', actual.response.cells);
    assert.deepEqual(actual.response, actual.sourceBefore, 'Keep complete actual StateProfile, position coverage and opaque digests');
    assert.deepEqual(actual.response.cells.map(x => x.position), actual.request.positions);
  } else if (item.id === 'Error.source' && mode === 'ok') {
    validateType('Error', actual.response.publicError); validateType('Error', actual.observedSourceError);
    assert.deepEqual(actual.response.publicError, actual.observedSourceError, 'Preserve the real provider JSON error, including every FailureSource field');
  } else if (['historyActions', 'engineSafety', 'compilerConfig', 'configSupply'].includes(item.id) && mode === 'ok') {
    assert.equal(actual.sourceReadBeforeCall, true);
    assert.deepEqual(actual.response, actual.sourceBefore);
    if (item.id === 'historyActions') {
      assert.equal(actual.response.state, 'READY'); assert.ok(actual.response.objects.length > 0);
      assert.ok(actual.response.objects.some(x => x.undo.available || x.redo.available));
    } else if (item.id === 'engineSafety') {
      assert.equal(actual.response.bound, true); validateType('EngineGuardDeclaration', actual.response.declaration);
      assert.deepEqual(actual.response.operations, Object.entries(ENGINE_GUARD_REQUIREMENTS).map(([operation, required]) => {
        const unmet = unmetGuards(actual.response.declaration, operation);
        return { operation, required: required.map(x => ({ ...x })), unmet, status: unmet.length ? 'CAPABILITY_UNAVAILABLE' : 'COVERED' };
      }));
    } else if (item.id === 'compilerConfig') {
      validateType('CompilationConfig', actual.response.compilationConfig);
      assert.deepEqual(actual.response.compilationConfig, actual.worldSourceCompilationConfig);
    } else {
      assert.equal(actual.response.profileVersion, 'canvas-stage1-config-supply/v2');
      assert.equal(actual.response.current.profiles.compilationConfig.status, 'SUPPLIED');
      validateType('CompilationConfig', actual.response.current.profiles.compilationConfig.value);
      assert.deepEqual(actual.response.current.profiles.compilationConfig.value, actual.worldSourceCompilationConfig);
      assert.equal(actual.response.current.profiles.compilationConfig.missing.length, 0);
    }
    assert.deepEqual(actual.worldWrites, []);
  } else {
    assert.deepEqual(actual.response, pair[mode === 'ok' ? 'response' : 'failure']);
  }
  if (mode === 'reject' || ['readToolSummary', 'readScopedState', 'Error.source'].includes(item.id)) {
    assert.deepEqual(actual.before, actual.after); assert.deepEqual(actual.worldWrites, []);
  }
}
export const equalJSON = (a, b) => canonicalJSON(a) === canonicalJSON(b);
