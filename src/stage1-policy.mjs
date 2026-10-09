import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/*
 * Canvas's explicit Stage 1 declaration of the four SafetyProfile policy fields. Canvas is the
 * only declarer (Host/Brush/Adapter never decide them). There is no editing path: the record
 * changes only with a new Canvas package, and its revision is part of every supply observation.
 *
 * A field is DECLARED only when a current authoritative project rule fixes its value; the
 * rule is cited with the exact document revision it was read from. Otherwise it is
 * UNDETERMINED: no value, the rules that were checked, and what the value would change.
 * Nothing here is a default.
 */
const DOCS = 'hanaworlds-docs@cb6f5c43a71ad430a38aee8dfe3d4ae4852694b6';
const SETTINGS = { ref: 'bluemap/SETTINGS_AND_INVARIANTS.json', sourceRevision: DOCS,
  sha256: '7642867f74b93de2d0efd71602a2d5faaf6989333faf32cc79d58e40f56694f6' };
const PRD = { ref: 'docs/superpowers/specs/2026-09-26-hanaworlds-stage1-v0.1-design.md §4',
  sourceRevision: DOCS, sha256: '5b8cb4372732cd5b4a7a7941af3de4c97779f710d16b56fa25613605f2415fa7' };
const CHECKED = [PRD.ref, SETTINGS.ref];

const record = {
  profileVersion: 'canvas-stage1-policy-declaration/v1',
  declarer: 'hanaworlds-canvas',
  scope: 'every World bound through this Canvas package (Stage 1, local single-user)',
  fields: {
    requireBodyClearance: { status: 'DECLARED', value: true, basis: {
      kind: 'PROJECT_RULE', ...SETTINGS, id: 'INV-BODY-RECHECK-AT-PREPARE', switchable: false,
      text: "Prepare rechecks every connected player's actual collision box against every effect cell before the durable barrier.",
      derivation: 'A non-switchable project invariant requires that no effect cell overlaps a ' +
        "player's body; a validation profile with requireBodyClearance=false would contradict it." } },
    requireEntranceConnectivity: { status: 'UNDETERMINED', checked: CHECKED,
      impact: 'true: Painter requires a walkable entrance path sized by avatarDimensions and ' +
        'rejects proposals without one; false: no entrance check. No current rule says whether ' +
        'a Stage 1 building must be enterable.' },
    hazardPolicy: { status: 'UNDETERMINED', checked: CHECKED,
      impact: 'forbidLiquid and maximumDamagePerSecond decide which liquid/damaging nodes count ' +
        'as passable or hazardous in Painter path/hazard checks. No current rule gives either value.' },
    optionalLightRule: { status: 'UNDETERMINED', checked: CHECKED,
      impact: 'null declares that Stage 1 has no light requirement; an object sets minimumLight. ' +
        'No current rule states either. Painter 0.4.1 does not read this field, so it has no ' +
        'current validation effect.' },
  },
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze);
  Object.freeze(value); } return value; };
export const STAGE1_POLICY_DECLARATION = freeze(record);
export const STAGE1_POLICY_REVISION = `stage1-policy-${createHash('sha256')
  .update('HanaWorlds|canvas|canvas-stage1-policy-declaration/v1\n')
  .update(canonicalize(record)).digest('hex').slice(0, 32)}`;
