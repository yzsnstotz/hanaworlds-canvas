import { AsyncLocalStorage } from 'node:async_hooks';
import { ContractError } from './protocol/local/index.mjs';

// Host runtime capabilities never enter request JSON, the store, or a public report.
const hosts = new WeakMap();
const sourceCalls = new AsyncLocalStorage();
const unavailable = cause => Object.assign(new ContractError('CAPABILITY_UNAVAILABLE',
  'validate', 'REQUIRED_FACT_UNKNOWN'), cause === undefined ? {} : { cause });

export function bindConfigHandoff(canvas, ctx, runtime, facts) {
  hosts.set(canvas, { ctx, runtime, facts, current: null });
}
export const isHostCanvas = canvas => hosts.has(canvas);
export function assertConfigHostLive(canvas) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  // Offline apply harnesses have no official registration. They can report missing
  // sources, but captureConfigSource/readCatalogue still refuse all source authority.
  const api = host.runtime();
  if (!api || !(host.ctx instanceof api.Context)) return;
  host.facts.liveOwn();
}
export function hostFactsPresent(canvas) {
  return !!hosts.get(canvas)?.ctx.get?.('hanaworldsWorldFacts');
}
export function assertConfigReadNotReentrant(canvas) {
  if (sourceCalls.getStore()?.has(canvas)) throw unavailable('CONFIG_SOURCE_REENTRANT');
}
function bridgeRegistration(host, bridgeContext) {
  const api = host.runtime();
  if (!api || !(bridgeContext instanceof api.Context) ||
      bridgeContext.root !== host.ctx.root || bridgeContext.fiber?.ctx !== bridgeContext)
    throw unavailable();
  const original = value => value?.[api.symbols.original] ?? value;
  const registration = () => bridgeContext.reflect.store[
    bridgeContext[api.Context.isolate].hanaworldsWorldInspectionContext];
  const record = registration();
  const value = original(record?.value);
  const live = () => {
    host.facts.liveOwn();
    if (!record || registration() !== record || record.fiber !== bridgeContext.fiber ||
        record.fiber.ctx.root !== host.ctx.root || original(record.value) !== value ||
        original(bridgeContext.get('hanaworldsWorldInspectionContext')) !== value)
      throw unavailable();
    try { record.fiber.assertActive(); } catch { throw unavailable(); }
  };
  live();
  return { live };
}
export function attachConfigSource(canvas, bridgeContext, reader, argumentCount) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  host.facts.liveOwn();
  if (argumentCount !== 2 || typeof reader !== 'function')
    throw new ContractError('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
  const bridge = bridgeRegistration(host, bridgeContext);
  const attachment = { bridge, bridgeContext, reader };
  host.current = attachment;
  return () => { if (host.current === attachment) host.current = null; };
}
export function captureConfigSource(canvas) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  host.facts.liveOwn();
  const attachment = host.current;
  if (!attachment) throw unavailable('BRIDGE_CONFIG_SOURCE_ABSENT');
  const facts = host.facts.capturePort('hanaworldsWorldFacts', 'call');
  const adapter = host.facts.capturePort('hanaworldsWorldAdapterV6', 'call');
  const live = () => {
    host.facts.liveOwn();
    if (host.current !== attachment) throw unavailable('BRIDGE_CONFIG_SOURCE_ABSENT');
    attachment.bridge.live(); facts.live(); adapter.live();
  };
  live();
  return {
    live,
    read(scope, request) {
      live();
      const chain = new Set(sourceCalls.getStore()); chain.add(canvas);
      return sourceCalls.run(chain, () => Reflect.apply(attachment.reader,
        attachment.bridgeContext, [scope, request]));
    },
  };
}
