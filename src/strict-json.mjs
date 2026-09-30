function fault(code = 'SCHEMA_INVALID', reason = 'INVALID_SHAPE') {
  const error = new Error(code);
  error.code = code;
  error.reason = reason;
  error.strictJSON = true;
  throw error;
}
function scalarString(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fault('SCHEMA_INVALID', 'LONE_SURROGATE');
    } else if (code >= 0xdc00 && code <= 0xdfff) fault('SCHEMA_INVALID', 'LONE_SURROGATE');
  }
  return value;
}
function snapshot(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scalarString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fault('SCHEMA_INVALID', 'INVALID_NUMBER');
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) fault();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) fault();
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') ||
      Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) fault();
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length || Object.hasOwn(descriptors, 'toJSON')) fault();
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fault();
    result = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = descriptors[i];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fault();
      result.push(snapshot(descriptor.value, seen));
    }
  } else {
    result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      scalarString(key);
      if (!Object.hasOwn(descriptor, 'value')) fault();
      Object.defineProperty(result, key, { value: snapshot(descriptor.value, seen),
        enumerable: true, configurable: true, writable: true });
    }
  }
  seen.delete(value);
  return result;
}

/** Reject escaped duplicate keys before JSON.parse discards their identity. */
function duplicateKeys(raw) {
  let i = 0;
  const space = () => { while (/\s/.test(raw[i] ?? '')) i++; };
  const string = () => {
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i++] === '"') return JSON.parse(raw.slice(start, i));
    }
    fault();
  };
  const value = () => {
    space();
    if (raw[i] === '{') {
      i++; space(); const keys = new Set();
      if (raw[i] === '}') { i++; return; }
      for (;;) {
        if (raw[i] !== '"') fault();
        const key = string();
        if (keys.has(key)) fault('NON_CANONICAL_AMBIGUITY', 'DUPLICATE_DECODED_KEY');
        keys.add(key); space();
        if (raw[i++] !== ':') fault();
        value(); space();
        if (raw[i] === '}') { i++; return; }
        if (raw[i++] !== ',') fault();
        space();
      }
    }
    if (raw[i] === '[') {
      i++; space();
      if (raw[i] === ']') { i++; return; }
      for (;;) {
        value(); space();
        if (raw[i] === ']') { i++; return; }
        if (raw[i++] !== ',') fault();
      }
    }
    if (raw[i] === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));
    if (!token) fault();
    i += token[0].length;
  };
  value(); space();
  if (i !== raw.length) fault();
}

export function readJSON(input) {
  try {
    if (typeof input === 'string' || input instanceof Uint8Array) {
      const raw = typeof input === 'string' ? input :
        new TextDecoder('utf-8', { fatal: true }).decode(input);
      const parsed = JSON.parse(raw);
      duplicateKeys(raw);
      return snapshot(parsed);
    }
    return snapshot(input);
  } catch (error) {
    if (error.strictJSON) throw error;
    fault('SCHEMA_INVALID', input instanceof Uint8Array && error instanceof TypeError ?
      'INVALID_UTF8' : 'INVALID_SHAPE');
  }
}
