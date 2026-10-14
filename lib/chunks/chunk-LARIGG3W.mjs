import {
  ContractError
} from "./chunk-ZMSQQTQX.mjs";

// src/config-handoff.mjs
import { AsyncLocalStorage } from "node:async_hooks";
var hosts = /* @__PURE__ */ new WeakMap();
var sourceCalls = new AsyncLocalStorage();
var unavailable = (cause) => Object.assign(new ContractError(
  "CAPABILITY_UNAVAILABLE",
  "validate",
  "REQUIRED_FACT_UNKNOWN"
), cause === void 0 ? {} : { cause });
function bindConfigHandoff(canvas, ctx, runtime, facts) {
  hosts.set(canvas, { ctx, runtime, facts, current: null });
}
var isHostCanvas = (canvas) => hosts.has(canvas);
function assertConfigHostLive(canvas) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  const api = host.runtime();
  if (!api || !(host.ctx instanceof api.Context)) return;
  host.facts.liveOwn();
}
function hostFactsPresent(canvas) {
  return !!hosts.get(canvas)?.ctx.get?.("hanaworldsWorldFacts");
}
function assertConfigReadNotReentrant(canvas) {
  if (sourceCalls.getStore()?.has(canvas)) throw unavailable("CONFIG_SOURCE_REENTRANT");
}
function bridgeRegistration(host, bridgeContext) {
  const api = host.runtime();
  if (!api || !(bridgeContext instanceof api.Context) || bridgeContext.root !== host.ctx.root || bridgeContext.fiber?.ctx !== bridgeContext)
    throw unavailable();
  const original = (value2) => value2?.[api.symbols.original] ?? value2;
  const registration = () => bridgeContext.reflect.store[bridgeContext[api.Context.isolate].hanaworldsWorldInspectionContext];
  const record = registration();
  const value = original(record?.value);
  const live = () => {
    host.facts.liveOwn();
    if (!record || registration() !== record || record.fiber !== bridgeContext.fiber || record.fiber.ctx.root !== host.ctx.root || original(record.value) !== value || original(bridgeContext.get("hanaworldsWorldInspectionContext")) !== value)
      throw unavailable();
    try {
      record.fiber.assertActive();
    } catch {
      throw unavailable();
    }
  };
  live();
  return { live };
}
function attachConfigSource(canvas, bridgeContext, reader, argumentCount) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  host.facts.liveOwn();
  if (argumentCount !== 2 || typeof reader !== "function")
    throw new ContractError("SCHEMA_INVALID", "decode", "INVALID_SHAPE");
  const bridge = bridgeRegistration(host, bridgeContext);
  const attachment = { bridge, bridgeContext, reader };
  host.current = attachment;
  return () => {
    if (host.current === attachment) host.current = null;
  };
}
function captureConfigSource(canvas) {
  const host = hosts.get(canvas);
  if (!host) throw unavailable();
  host.facts.liveOwn();
  const attachment = host.current;
  if (!attachment) throw unavailable("BRIDGE_CONFIG_SOURCE_ABSENT");
  const facts = host.facts.capturePort("hanaworldsWorldFacts", "call");
  const adapter = host.facts.capturePort("hanaworldsWorldAdapterV6", "call");
  const live = () => {
    host.facts.liveOwn();
    if (host.current !== attachment) throw unavailable("BRIDGE_CONFIG_SOURCE_ABSENT");
    attachment.bridge.live();
    facts.live();
    adapter.live();
  };
  live();
  return {
    live,
    read(scope, request) {
      live();
      const chain = new Set(sourceCalls.getStore());
      chain.add(canvas);
      return sourceCalls.run(chain, () => Reflect.apply(
        attachment.reader,
        attachment.bridgeContext,
        [scope, request]
      ));
    }
  };
}

export {
  bindConfigHandoff,
  isHostCanvas,
  assertConfigHostLive,
  hostFactsPresent,
  assertConfigReadNotReentrant,
  attachConfigSource,
  captureConfigSource
};
