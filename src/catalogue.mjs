import { canonicalJSON, ContractError, snapshotJSON, validateCatalogueFacts, validateType }
  from './protocol/local/index.mjs';

const scopeKeys = ['worldRef', 'connectionRef', 'connectionIncarnationRef'];
const providerKeys = ['providerRef', 'providerRevision'];
const same = (left, right) => canonicalJSON(left) === canonicalJSON(right);
const refusal = (code, reason = 'REQUIRED_FACT_UNKNOWN', phase = 'validate') =>
  new ContractError(code, phase, reason);
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw refusal('SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
  if (Object.keys(value).some(key => !allowed.includes(key)))
    throw refusal('UNKNOWN_REQUIRED_FIELD', 'UNKNOWN_FIELD', 'decode');
  if (required.some(key => !Object.hasOwn(value, key)))
    throw refusal('SCHEMA_INVALID', 'INVALID_SHAPE', 'decode');
}
function provider(value) {
  fields(value, providerKeys);
  for (const key of providerKeys) validateType('Ref', value[key]);
}
function request(raw) {
  const value = snapshotJSON(raw);
  fields(value, ['sessionRef', 'expectedConnection', 'expectedProvider', 'expectedCatalogueDigest'], ['sessionRef']);
  validateType('Ref', value.sessionRef);
  if (Object.hasOwn(value, 'expectedConnection')) validateType('MaterialSourceConnection', value.expectedConnection);
  if (Object.hasOwn(value, 'expectedProvider')) provider(value.expectedProvider);
  if (Object.hasOwn(value, 'expectedCatalogueDigest')) validateType('Digest', value.expectedCatalogueDigest);
  return value;
}
function catalogue(raw, scope) {
  const value = snapshotJSON(raw);
  fields(value, ['provider', 'facts']);
  provider(value.provider);
  // This admits the complete own CatalogueFacts closure, including presentation,
  // orientation correlation and opaque material extensions, before checking its digest.
  validateCatalogueFacts(value.facts, scope);
  return value;
}

/** Canvas's current, read-only C-world-facts@2 Host transfer. Captures remain private
 * to the registered Canvas receiver; no wire fallback or persisted observation. */
export async function catalogueRead(canvas, raw, host, readConnection) {
  const input = request(raw);
  host.liveOwn();
  await canvas.ready;
  host.liveOwn();
  if (!canvas.store || canvas.store.unavailable) throw refusal('CAPABILITY_UNAVAILABLE');
  await canvas.store.busy;
  host.liveOwn();
  const selected = canvas.current(input.sessionRef);
  if (!selected?.localContext || !selected.activeWorldRef)
    throw refusal('WORLD_NOT_BOUND', 'SCOPE_DENIED');
  // Detach the baseline so even an in-place selection change cannot move it.
  const selection = snapshotJSON(selected);
  const scope = validateType('MaterialSourceConnection',
    Object.fromEntries(scopeKeys.map(key => [key, selection.localContext[key]])));
  if (selection.activeWorldRef !== scope.worldRef ||
      input.expectedConnection && !same(input.expectedConnection, scope))
    throw refusal('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
  const source = host.capture('readCatalogue');
  const adapter = host.capturePort('hanaworldsWorldAdapterV6', 'call');
  const live = () => {
    host.liveOwn(); source.live(); adapter.live();
    const current = canvas.current(input.sessionRef);
    if (!current || !same(current, selection))
      throw refusal('CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
  };
  const connectionMatches = value => {
    if (scopeKeys.some(key => value[key] !== scope[key]))
      throw refusal('CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
  };
  const expectations = value => {
    if (input.expectedProvider && !same(input.expectedProvider, value.provider))
      throw refusal('CURRENT_WORLD_MISMATCH', 'SCOPE_DENIED');
    if (Object.hasOwn(input, 'expectedCatalogueDigest') && input.expectedCatalogueDigest !== value.facts.catalogueDigest)
      throw refusal('CATALOGUE_MISMATCH', 'REVISION_CHANGED');
  };
  live();
  const firstConnection = await readConnection(input.sessionRef, scope);
  live(); connectionMatches(firstConnection);
  const firstRaw = await source.read(scope);
  live();
  const first = catalogue(firstRaw, scope);
  expectations(first);
  const lastRaw = await source.read(scope);
  live();
  const last = catalogue(lastRaw, scope);
  expectations(last);
  if (!same(first, last)) throw refusal('CURRENT_WORLD_MISMATCH', 'REVISION_CHANGED');
  const lastConnection = await readConnection(input.sessionRef, scope);
  live(); connectionMatches(lastConnection);
  const result = structuredClone(last);
  live();
  return result;
}
