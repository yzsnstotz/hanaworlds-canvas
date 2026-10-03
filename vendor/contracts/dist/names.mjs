import { fail, requireFact } from './errors.mjs';
import { snapshotJSON } from './strict-json.mjs';
const forbidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/u;
const edges = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const invisible = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u200c\u200d\ufe00-\ufe0f\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]*$/u;
export function runtimeCompatibility() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nfcVectors = [['カ\u3099', 'ガ'], ['\u212a', 'K'], ['A\u030a', 'Å']];
  const nfcReferenceVectorsPass = nfcVectors.every(([a, b]) => a.normalize('NFC') === b);
  const requiredWhiteSpace = [9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288];
  const actualWhiteSpace = [];
  // Unicode17 White_Space is a frozen finite property, tested over every scalar.
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (/\p{White_Space}/u.test(String.fromCodePoint(cp))) actualWhiteSpace.push(cp);
  }
  const whiteSpacePass = JSON.stringify(actualWhiteSpace) === JSON.stringify(requiredWhiteSpace);
  const compatible = nodeMajor >= 22 && process.versions.unicode === '17.0' && nfcReferenceVectorsPass && whiteSpacePass;
  return Object.freeze({ compatible, node: process.versions.node, icu: process.versions.icu,
    unicode: process.versions.unicode, requiredUnicode: '17.0', nfcReferenceVectorsPass, whiteSpacePass,
    whiteSpaceScalarCount: actualWhiteSpace.length, fullNormalizationConformance: 'NOT_RUN',
    providerEvidence: 'NOT_RUN', persistentNameKeysAllowed: compatible });
}
let cachedCompatibility;
export function requireUnicode17() {
  cachedCompatibility ??= runtimeCompatibility();
  requireFact(cachedCompatibility.compatible, 'CAPABILITY_UNAVAILABLE', 'POLICY_UNAVAILABLE');
  return cachedCompatibility;
}
export function validateNameSyntax(name) {
  snapshotJSON(name);
  if (typeof name !== 'string') fail('INVALID_NAME', 'validate', 'INVALID_SHAPE');
  // Deliberately reject before trim. A newline must not become a legal name.
  if (forbidden.test(name)) fail('INVALID_NAME', 'validate', 'NAME_FORBIDDEN_CHARACTER');
  const displayName = name.replace(edges, '');
  if (invisible.test(displayName)) fail('INVALID_NAME', 'validate', 'NAME_INVISIBLE_OR_EMPTY');
  return displayName;
}
export function normalizeName(name) {
  const displayName = validateNameSyntax(name);
  requireUnicode17();
  return Object.freeze({ displayName,
    comparisonKey: displayName.normalize('NFC').replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)) });
}
