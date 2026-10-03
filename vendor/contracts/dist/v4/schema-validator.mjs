import { schemaBundle } from './generated/contracts.mjs';
import { fail, requireFact } from '../errors.mjs';
export { schemaBundle };
const invalid = () => fail('SCHEMA_INVALID', 'decode', 'INVALID_SHAPE');
/** Interpreter for the generated Draft7 schema subset, not for the source DSL.
 * No coercion, defaults, mutation, unknown-key stripping or extra keyword guesses. */
export function validateShape(typeName, value) {
  if (!Object.hasOwn(schemaBundle.definitions, typeName)) throw new TypeError('Unknown public contract type');
  const work = [{ s: schemaBundle.definitions[typeName], value, field: '', parent: '' }];
  const visits = []; const numericDomains = [];
  while (work.length) {
    const entry = work.pop(); let s = entry.s; const v = entry.value;
    if (s.$ref) {
      const key = s.$ref.slice('#/definitions/'.length);
      s = schemaBundle.definitions[key];
      if (!s) throw new TypeError('Broken generated schema reference');
    }
    if (s.anyOf) {
      // A union of several constants (TargetFacts.profileVersion) selects the matching constant;
      // otherwise the first is checked so a mismatch reports exactly as a single constant would.
      const choices = s.anyOf.filter(x => x.type !== 'null');
      const selected = v === null ? s.anyOf.find(x => x.type === 'null')
        : choices.length > 1 && choices.every(x => Object.hasOwn(x, 'const')) ? (choices.find(x => x.const === v) ?? choices[0]) : choices[0];
      if (!selected) invalid(); work.push({ ...entry, s: selected }); continue;
    }
    const name = s['x-typeName'] ?? entry.parent;
    if (s['x-typeName']) visits.push({ name: s['x-typeName'], value: v, parent: entry.parent, field: entry.field });
    if (s.oneOf) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) invalid();
      const index = s['x-variantKeys'].indexOf(v[s['x-discriminator']]);
      if (index < 0) invalid(); work.push({ ...entry, s: s.oneOf[index], parent: name }); continue;
    }
    if (Object.hasOwn(s, 'const')) {
      if (v !== s.const) {
        if (entry.field === 'contractVersion' || entry.field === 'profileVersion') fail('UNSUPPORTED_VERSION', 'decode', 'VERSION_UNSUPPORTED');
        invalid();
      }
      continue;
    }
    if (s.enum) {
      if (!s.enum.includes(v)) {
        if (name === 'Guarantee') fail('UNSUPPORTED_VERSION', 'decode', 'VERSION_UNSUPPORTED');
        invalid();
      }
      continue;
    }
    if (s.type === 'null') { if (v !== null) invalid(); continue; }
    if (s.type === 'object') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) invalid();
      const keys = Object.keys(v);
      if (s.properties) {
        if (keys.some(k => !Object.hasOwn(s.properties, k))) fail('UNKNOWN_REQUIRED_FIELD', 'decode', 'UNKNOWN_FIELD');
        if (s.required.some(k => !Object.hasOwn(v, k))) invalid();
        const fields = Object.keys(s.properties);
        for (let i = fields.length - 1; i >= 0; i--) { const field = fields[i]; work.push({ s: s.properties[field], value: v[field], field, parent: name }); }
      } else {
        if (s.minProperties !== undefined && keys.length < s.minProperties) invalid();
        for (let i = keys.length - 1; i >= 0; i--) {
          const key = keys[i]; work.push({ s: s.additionalProperties, value: v[key], field: '', parent: name });
          work.push({ s: s.propertyNames, value: key, field: '', parent: name });
        }
      }
      continue;
    }
    if (s.type === 'array') {
      if (!Array.isArray(v)) invalid();
      if ((s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) invalid();
      for (let i = v.length - 1; i >= 0; i--) work.push({ s: Array.isArray(s.items) ? s.items[i] : s.items, value: v[i], field: entry.field, parent: name });
      continue;
    }
    if (s.type === 'integer' || s.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) invalid();
      if ((s.type === 'integer' && !Number.isInteger(v)) || (s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum) || (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)) numericDomains.push({ name, parent: entry.parent });
      continue;
    }
    if (typeof v !== s.type) invalid();
    if (s.type === 'string') {
      if (s.minLength !== undefined && [...v].length < s.minLength) invalid();
      if (s.pattern && !(new RegExp(s.pattern, 'u')).test(v)) invalid();
    }
  }
  if (numericDomains.length) {
    const d = numericDomains[0];
    fail('SCHEMA_INVALID', 'validate', d.parent === 'Position' || d.parent === 'CollisionBox' ? 'INVALID_GEOMETRY' : 'INVALID_SHAPE');
  }
  return visits;
}
