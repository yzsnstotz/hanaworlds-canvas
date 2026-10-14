// src/world-facts-reader.mjs
function worldFactsReader(ctx, canvas, runtime, unavailable) {
  function context() {
    const api = runtime();
    if (!api || !(ctx instanceof api.Context)) throw unavailable();
    return api;
  }
  function ownRegistration(api) {
    const registration = ctx.reflect.store[ctx[api.Context.isolate].hanaworldsCanvasV5];
    if (!registration || registration.value !== canvas || registration.fiber !== ctx.fiber || registration.fiber.ctx.root !== ctx.root || ctx.get("hanaworldsCanvasV5") !== canvas)
      throw unavailable();
    try {
      registration.fiber.assertActive();
    } catch {
      throw unavailable();
    }
    return registration;
  }
  let capturedOwn;
  function liveOwn() {
    const own = ownRegistration(context());
    if (capturedOwn && own !== capturedOwn) throw unavailable();
    capturedOwn = own;
  }
  function capturePort(key, method) {
    const api = context();
    const original = (value2) => value2?.[api.symbols.original] ?? value2;
    const registration = (name) => ctx.reflect.store[ctx[api.Context.isolate][name]];
    const own = ownRegistration(api);
    const source = registration(key);
    const value = original(source?.value);
    const port = ctx.get(key);
    const live = () => {
      if (!own || !source || registration("hanaworldsCanvasV5") !== own || registration(key) !== source || own.value !== canvas || own.fiber !== ctx.fiber || own.fiber.ctx.root !== ctx.root || source.fiber.ctx.root !== ctx.root || original(source.value) !== value || ctx.get("hanaworldsCanvasV5") !== canvas || original(ctx.get(key)) !== value || typeof port?.[method] !== "function")
        throw unavailable();
      try {
        own.fiber.assertActive();
        source.fiber.assertActive();
      } catch {
        throw unavailable();
      }
    };
    live();
    return { live, read: (...args) => port[method](...args) };
  }
  return { capture: (method) => capturePort("hanaworldsWorldFacts", method), capturePort, liveOwn };
}

export {
  worldFactsReader
};
