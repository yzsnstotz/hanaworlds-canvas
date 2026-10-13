// src/world-facts-reader.mjs
function worldFactsReader(ctx, canvas, runtime, unavailable) {
  function capture(method) {
    const api = runtime();
    if (!api || !(ctx instanceof api.Context)) throw unavailable();
    const original = (value2) => value2?.[api.symbols.original] ?? value2;
    const registration = (name) => ctx.reflect.store[ctx[api.Context.isolate][name]];
    const own = registration("hanaworldsCanvasV5");
    const source = registration("hanaworldsWorldFacts");
    const value = original(source?.value);
    const port = ctx.get("hanaworldsWorldFacts");
    const live = () => {
      if (!own || !source || registration("hanaworldsCanvasV5") !== own || registration("hanaworldsWorldFacts") !== source || own.value !== canvas || own.fiber !== ctx.fiber || own.fiber.ctx.root !== ctx.root || source.fiber.ctx.root !== ctx.root || original(source.value) !== value || ctx.get("hanaworldsCanvasV5") !== canvas || original(ctx.get("hanaworldsWorldFacts")) !== value || typeof port?.[method] !== "function")
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
  return { capture };
}

export {
  worldFactsReader
};
