import { types as nodeTypes } from 'node:util';
import { fail } from './errors.mjs';
const invalid = (reason = 'INVALID_SHAPE') => fail('SCHEMA_INVALID', 'decode', reason);
const scalar = s => { if (!s.isWellFormed()) invalid('LONE_SURROGATE'); return s; };

/** Strict UTF-8 + JSON grammar. Object keys are checked AFTER escape decoding,
 * BEFORE insertion. No full-document JSON.parse, reviver, accessor, or toJSON call.
 * Explicit stacks avoid an invented maximum JSON nesting depth. */
export function decodeRawJSON(bytes) {
  if (nodeTypes.isProxy(bytes) || !(bytes instanceof Uint8Array)) invalid();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('INVALID_UTF8'); }
  let p = 0;
  const whitespace = () => { while (p < text.length && /[\x20\x09\x0a\x0d]/.test(text[p])) p++; };
  function token() {
    whitespace();
    if (p === text.length) return { kind: 'EOF' };
    const c = text[p];
    if ('{}[]:,'.includes(c)) { p++; return { kind: c }; }
    if (c === '"') {
      const start = p++;
      let ended = false;
      while (p < text.length) {
        const ch = text[p++];
        if (ch === '"') { ended = true; break; }
        if (ch === '\\') {
          if (p >= text.length) invalid();
          const esc = text[p++];
          if (esc === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(p, p + 4))) invalid();
            p += 4;
          } else if (!'"\\/bfnrt'.includes(esc)) invalid();
        } else if (ch.charCodeAt(0) < 0x20) invalid();
      }
      if (!ended) invalid();
      let value;
      try { value = JSON.parse(text.slice(start, p)); } catch { invalid(); }
      return { kind: 'scalar', value: scalar(value), string: true };
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, p)) { p += word.length; return { kind: 'scalar', value }; }
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(p));
      if (!match) invalid('INVALID_NUMBER');
      p += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) invalid('INVALID_NUMBER');
      return { kind: 'scalar', value };
    }
    if (text.startsWith('NaN', p) || text.startsWith('Infinity', p)) invalid('INVALID_NUMBER');
    invalid();
  }
  const stack = [];
  let root; let hasRoot = false;
  const attach = value => {
    if (!stack.length) { if (hasRoot) invalid(); root = value; hasRoot = true; return; }
    const parent = stack[stack.length - 1];
    if (parent.kind === 'object') {
      if (parent.state !== 'value') invalid();
      Object.defineProperty(parent.value, parent.key, { value, enumerable: true, writable: true, configurable: true });
    } else parent.value.push(value);
    parent.state = 'commaOrEnd';
  };
  function valueToken(t) {
    if (t.kind === 'scalar') attach(t.value);
    else if (t.kind === '{' || t.kind === '[') {
      const value = t.kind === '{' ? Object.create(null) : [];
      attach(value);
      stack.push({ kind: t.kind === '{' ? 'object' : 'array', value,
        state: t.kind === '{' ? 'keyOrEnd' : 'valueOrEnd', keys: new Set(), key: null });
    } else invalid();
  }
  valueToken(token());
  while (stack.length) {
    const f = stack[stack.length - 1];
    const t = token();
    if (f.kind === 'object') {
      if (f.state === 'keyOrEnd' || f.state === 'key') {
        if (t.kind === '}' && f.state === 'keyOrEnd') { stack.pop(); continue; }
        if (t.kind !== 'scalar' || !t.string) invalid();
        if (f.keys.has(t.value)) fail('NON_CANONICAL_AMBIGUITY', 'decode', 'DUPLICATE_DECODED_KEY');
        f.keys.add(t.value); f.key = t.value; f.state = 'colon';
      } else if (f.state === 'colon') {
        if (t.kind !== ':') invalid(); f.state = 'value';
      } else if (f.state === 'value') valueToken(t);
      else if (t.kind === '}') stack.pop();
      else if (t.kind === ',') f.state = 'key';
      else invalid();
    } else {
      if (f.state === 'valueOrEnd' && t.kind === ']') { stack.pop(); continue; }
      if (f.state === 'valueOrEnd' || f.state === 'value') valueToken(t);
      else if (t.kind === ']') stack.pop();
      else if (t.kind === ',') f.state = 'value';
      else invalid();
    }
  }
  if (token().kind !== 'EOF') invalid();
  return root;
}

/** Make a detached plain-JSON snapshot. Descriptors are read, never getters.
 * JSON keys such as __proto__ remain ordinary map data in null-prototype copies.
 * Proxies are rejected before any reflection; cycles, symbols, sparse arrays,
 * extra array properties, boxed values and custom prototypes are not JSON. */
export function snapshotJSON(input) {
  const holder = { value: undefined };
  const ancestors = new Set();
  const work = [{ input, target: holder, key: 'value', exit: false }];
  while (work.length) {
    const item = work.pop();
    if (item.exit) { ancestors.delete(item.input); continue; }
    const value = item.input;
    if (value === null || typeof value === 'boolean') { item.target[item.key] = value; continue; }
    if (typeof value === 'string') { item.target[item.key] = scalar(value); continue; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('INVALID_NUMBER');
      item.target[item.key] = value; continue;
    }
    if (typeof value !== 'object' || nodeTypes.isProxy(value)) invalid();
    if (ancestors.has(value)) invalid();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) invalid();
    const target = array ? [] : Object.create(null);
    item.target[item.key] = target;
    const keys = Object.keys(descriptors);
    if (array && (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length'))) invalid();
    ancestors.add(value); work.push({ input: value, exit: true });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]; const d = descriptors[key];
      if (array && key === 'length') continue;
      if (!Object.hasOwn(d, 'value') || !d.enumerable) invalid();
      if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
      scalar(key);
      work.push({ input: d.value, target, key, exit: false });
    }
  }
  return holder.value;
}
export function assertPureJSON(value) { snapshotJSON(value); }
export function deepFreeze(value) {
  const stack = [value]; const seen = new Set();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v); for (const x of Object.values(v)) stack.push(x); Object.freeze(v);
  }
  return value;
}
