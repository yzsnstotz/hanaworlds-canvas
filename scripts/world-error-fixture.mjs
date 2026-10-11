import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJSON } from 'hanaworlds-contracts';
import { CanvasV5, CanvasStore, apply } from '../src/index.mjs';
import { fixtureSessions } from './fixture-sessions.mjs';

/*
 * Public Canvas world-error fixture (Contracts 2.7.0 Error.worldRef), for Workshop/bridge to
 * relay. Every exchange is produced by the real CanvasV5 public call() in an isolated temp
 * store; the peers are FIXTURES: no Adapter service at all, or an in-memory contracts-shaped
 * Adapter that reports itself unavailable. SOURCE/FIXTURE evidence only — no real world.
 */
const world = 'fixture-world-A', session = 'fixture-session-S1';
const select = (requestId, expectedRevision) => ({ contractVersion: 'canvas/v7',
  sessionRef: session, requestId, worldRef: world, connectionRef: 'fixture-connection-A',
  connectionIncarnationRef: 'fixture-incarnation-A-1', expectedRevision, expectedContext: null });
const unreachableAdapter = () => ({ calls: [], async call(operation, request) {
  this.calls.push(operation);
  return { contractVersion: 'world-adapter/v8', requestId: request.requestId, result: null,
    error: { code: 'ADAPTER_UNAVAILABLE', phase: 'validate', retryability: 'AFTER_NEW_FACTS',
      mutationState: 'NONE', transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' } };
} });

// ReadWorldSelectionContext discovers the Adapter's live connections before it answers.
async function contextOn(canvas, requestId) {
  const request = { contractVersion: 'canvas/v7', sessionRef: session, requestId, worldRef: world };
  return { request, response: await canvas.call('ReadWorldSelectionContext', request) };
}

export async function buildWorldErrorFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-world-error-fixture-'));
  try {
    const exchanges = [];
    const add = (title, request, response, operation = 'SelectWorldConnection') => exchanges.push({
      title, wire: 'canvas/v7', operation, request, response: JSON.parse(canonicalJSON(response)) });
    const missingStore = select('world-error-store', 'fixture-selection-0');
    add('Canvas store unavailable: the request worldRef names the target world', missingStore,
      await new CanvasV5({ store: null }).call('SelectWorldConnection', missingStore));
    // The Cordis entry with no world-adapter service on the Host (world not started).
    const ctx = { get: name => name === 'dshHomePath' ? (...p) => join(directory, 'host', ...p) : undefined,
      provide: () => {} };
    const hosted = apply(ctx);
    await hosted.ready;
    hosted.store = await CanvasStore.open(join(directory, 'absent'));
    hosted.sessions = fixtureSessions();
    const absent = await contextOn(hosted, 'world-error-adapter-absent');
    add('no Adapter service (world not started): the target world is named', absent.request,
      absent.response, 'ReadWorldSelectionContext');
    const unreachable = new CanvasV5({ store: await CanvasStore.open(join(directory, 'unreachable')),
      adapter: unreachableAdapter(), sessions: fixtureSessions() });
    const down = await contextOn(unreachable, 'world-error-adapter-unavailable');
    add('Adapter reports ADAPTER_UNAVAILABLE: its error is kept and names the target world',
      down.request, down.response, 'ReadWorldSelectionContext');
    const raw = '{"contractVersion":"canvas/v7","sessionRef":"fixture-session-S1","requestId":"world-error-raw","worldRef":"fixture-world-A"';
    const undecoded = await new CanvasV5({ store: null }).call('SelectWorldConnection',
      new TextEncoder().encode(raw));
    return { evidence: 'SOURCE/FIXTURE only: produced by CanvasV5.call in an isolated temp store; no real world, Adapter or Session was read.',
      contracts: 'hanaworlds-contracts 2.7.0 Error.worldRef (optional; absent = no world context)',
      exchanges,
      undecoded: { title: 'undecodable raw bytes (UTF-8 of raw) are refused without echoing their selector',
        wire: 'canvas/v7', operation: 'SelectWorldConnection', raw,
        response: JSON.parse(canonicalJSON(undecoded)) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../fixtures/world-error.json', import.meta.url);
  await writeFile(target, `${JSON.stringify(await buildWorldErrorFixture(), null, 2)}\n`);
  console.log(fileURLToPath(target));
}
