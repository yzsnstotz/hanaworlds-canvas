// write-path-init/v1: the fact scope of the Catalogue placeable tag.
// Pure derivation from a supplied callback-name inventory; no registry access.
import { contractMetadata } from './generated/contracts.mjs';
import { validateType, validateDigestBinding, deepFreeze } from './runtime.mjs';
import { requireFact } from '../errors.mjs';
export const writePathStateScope = contractMetadata.writePathStateScope;
const INIT = new Set(writePathStateScope.initializationCallbacks);
const STATE = new Set(writePathStateScope.stateIndicatorCallbacks);

function derive(material, pathKnownClean) {
  if (!pathKnownClean || material.definedCallbacks === null || material.definitionRevision === null)
    return { placeable: null, initialization: [], stateIndicators: [] };
  const initialization = material.definedCallbacks.filter(c => INIT.has(c));
  const stateIndicators = material.definedCallbacks.filter(c => STATE.has(c));
  // Never true while any initialization or state-bearing callback exists, never inferred from opaque code.
  return { placeable: initialization.length > 0 ? false : stateIndicators.length === 0 ? true : null,
    initialization, stateIndicators };
}
/** Facts each material gets under write-path-init/v1 from the supplied inventory.
 * Unknown inventories or any global callback on the write path give null. */
export function writePathStateFacts(evidenceInput) {
  const evidence = validateType('WritePathEvidence', evidenceInput);
  const clean = evidence.globalWriteCallbacks !== null && evidence.globalWriteCallbacks.length === 0;
  return deepFreeze(Object.fromEntries(evidence.materials.map(n => [n.materialRef, { definitionRevision: n.definitionRevision, ...derive(n, clean) }])));
}
/** A Catalogue may publish facts no looser than the derivation: placeable true only where
 * derived true; false/null are always allowed (stricter). Every material with a true
 * fact must be covered by the inventory with the same definitionRevision. */
export function validateCatalogueWritePathFacts(catalogueInput, evidenceInput) {
  const catalogue = validateType('Catalogue', catalogueInput);
  const evidence = validateType('WritePathEvidence', evidenceInput);
  validateDigestBinding('catalogue', catalogue, evidence.catalogueDigest);
  const derived = writePathStateFacts(evidence);
  const looser = ok => requireFact(ok, 'CATALOGUE_MISMATCH', 'CATALOGUE_UNRESOLVED');
  const verified = [], stricter = [];
  for (const [name, tags] of Object.entries(catalogue.materials)) {
    const d = Object.hasOwn(derived, name) ? derived[name] : null;
    if (d) looser(d.definitionRevision === tags.definitionRevision);
    if (tags.placeable === true) { looser(d !== null && d.placeable === true); verified.push(name); }
    else if (d && d.placeable === true) stricter.push(name);
  }
  return deepFreeze({ scope: evidence.scope, writePath: evidence.writePath, verified, stricter });
}
