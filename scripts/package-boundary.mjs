import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';

export async function inspectPackage(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      assert.ok(name !== 'hanaworlds-contracts', `production contracts dependency in ${section}`);
      assert.ok(!/^(git|file:|link:|https?:|github:)/.test(specifier), `exotic production dependency: ${name}`);
    }
  }
  for (const hook of ['preinstall', 'install', 'postinstall'])
    assert.ok(!manifest.scripts?.[hook], `unexpected production install hook: ${hook}`);
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})]);
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), `packed symlink: ${path}`);
      if (entry.isDirectory()) await walk(path); else files.push(relative(root, path));
    }
  }
  await walk(root);
  async function local(path) {
    assert.ok(!isAbsolute(path), `absolute artifact: ${path}`);
    const absolute = resolve(root, path);
    assert.ok(absolute.startsWith(resolve(root) + '/'), `outside packed package: ${path}`);
    assert.ok((await stat(absolute).catch(() => null))?.isFile(), `missing packed file: ${path}`);
    return relative(root, absolute);
  }
  const entries = [];
  async function targets(value) {
    if (typeof value === 'string') { assert.ok(value.startsWith('./'), `invalid public target: ${value}`); entries.push(await local(value)); }
    else for (const v of Object.values(value ?? {})) await targets(v);
  }
  await targets(manifest.exports);
  for (const field of ['main', 'module', 'types']) if (manifest[field]) await local(manifest[field]);
  if (manifest.dsh?.bundle?.patch) await local(manifest.dsh.bundle.patch);
  for (const [key, value] of Object.entries(manifest.imports ?? {})) {
    assert.ok(key !== '#contracts', '#contracts package import is forbidden');
    await importTargets(value);
  }
  async function importTargets(value) {
    if (typeof value === 'string') await load(value, 'package.json');
    else for (const v of Object.values(value ?? {})) await importTargets(v);
  }
  const edges = {};
  async function load(specifier, from) {
    assert.equal(typeof specifier, 'string', `dynamic module/resource load in ${from}`);
    assert.ok(!specifier.includes('hanaworlds-contracts') && !specifier.startsWith('#contracts'), `contracts runtime load in ${from}`);
    if (isBuiltin(specifier)) return;
    if (specifier.startsWith('#')) {
      assert.ok(manifest.imports?.[specifier], `unresolved package import in ${from}: ${specifier}`);
      await importTargets(manifest.imports[specifier]); return;
    }
    if (specifier.startsWith('.')) {
      const target = await local(join(dirname(from), specifier));
      (edges[from] ??= []).push(target); return;
    }
    assert.ok(!/^(\/|[a-z]+:)/i.test(specifier), `external resource load in ${from}: ${specifier}`);
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    assert.ok(declared.has(name), `undeclared runtime dependency in ${from}: ${name}`);
  }
  function literal(node) {
    if (node?.type === 'Literal') return node.value;
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node?.type === 'BinaryExpression' && node.operator === '+') {
      const a = literal(node.left), b = literal(node.right);
      if (typeof a === 'string' && typeof b === 'string') return a + b;
    }
  }
  function member(node) {
    if (node?.type !== 'MemberExpression' || node.property?.type === 'PrivateIdentifier') return '';
    return node.computed ? literal(node.property) : node.property?.name;
  }
  function metaURL(node) { return member(node) === 'url' && node.object?.type === 'MetaProperty'; }
  function visit(node, handler, parent) {
    if (!node || typeof node !== 'object') return;
    handler(node, parent);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(child)) for (const c of child) visit(c, handler, node);
      else if (child?.type) visit(child, handler, node);
    }
  }
  for (const file of files.filter(p => /\.(mjs|cjs|js)$/.test(p))) {
    const ast = parse(await readFile(join(root, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    const loads = [];
    const bindings = new Map([['require', 'module'], ['__require', 'module'],
      ['createRequire', 'factory'], ['readFile', 'resource'], ['readFileSync', 'resource'],
      ['fetch', 'network'], ['eval', 'unsafe'], ['Function', 'unsafe']]);
    const constants = new Map();
    function role(node) {
      if (node?.type === 'Identifier') return bindings.get(node.name);
      const property = member(node);
      if (property === 'createRequire') return 'factory';
      if (['readFile', 'readFileSync'].includes(property)) return 'resource';
      if (property === 'fetch') return 'network';
      if (property === 'require') return 'module';
      if (property === 'resolve' && (node.object?.type === 'MetaProperty' || role(node.object) === 'module')) return 'module';
      if (['call', 'apply', 'bind'].includes(property)) return role(node.object);
      if (node?.type === 'CallExpression' && role(node.callee) === 'factory') return 'module';
      if (node?.type === 'CallExpression' && member(node.callee) === 'bind') return role(node.callee.object);
    }
    const parents = new WeakMap();
    const nodes = []; visit(ast, (node, parent) => { nodes.push(node); if (parent) parents.set(node, parent); });
    function storageRead(node, arg) {
      let method, owner;
      for (let current = node; current; current = parents.get(current)) {
        if (current.type === 'MethodDefinition' && !method) method = current;
        if (current.type === 'ClassExpression' || current.type === 'ClassDeclaration') {
          owner = current.id?.name ?? parents.get(current)?.id?.name; break;
        }
      }
      const parameter = method?.value.params[0]?.name;
      if (owner === 'CanvasStore' && method?.static && method.key.name === 'open')
        return arg?.type === 'CallExpression' && arg.callee.name === 'join' && arg.arguments.length === 2 &&
          arg.arguments[0]?.name === parameter && argument(arg.arguments[1]) === 'canvas-v7.json';
      if (owner === 'SnapshotFiles' && method?.key.name === 'read')
        return arg?.type === 'CallExpression' && member(arg.callee) === 'path' &&
          arg.callee.object.type === 'ThisExpression' && arg.arguments.length === 1 && arg.arguments[0]?.name === parameter;
      return false;
    }
    for (const node of nodes.filter(n => n.type === 'ImportDeclaration')) {
      for (const spec of node.specifiers) {
        const imported = spec.imported?.name ?? spec.imported?.value;
        const kind = bindings.get(imported);
        if (kind) bindings.set(spec.local.name, kind);
      }
    }
    // Follow local aliases/destructuring before scanning calls, including lazy exports.
    let changed;
    do {
      changed = false;
      for (const node of nodes) {
        if (node.type !== 'VariableDeclarator' && node.type !== 'AssignmentExpression') continue;
        const id = node.id ?? node.left, value = node.init ?? node.right;
        if (id?.type === 'Identifier') {
          const kind = role(value);
          if (kind && !bindings.has(id.name)) { bindings.set(id.name, kind); changed = true; }
          const text = value?.type === 'Identifier' ? constants.get(value.name) : literal(value);
          if (typeof text === 'string' && !constants.has(id.name)) { constants.set(id.name, text); changed = true; }
        }
        if (id?.type === 'ObjectPattern') for (const prop of id.properties) {
          const kind = role({ type: 'MemberExpression', object: value, property: prop.key, computed: prop.computed });
          if (kind && prop.value?.type === 'Identifier' && !bindings.has(prop.value.name)) {
            bindings.set(prop.value.name, kind); changed = true;
          }
        }
      }
    } while (changed);
    function argument(node) { return node?.type === 'Identifier' ? constants.get(node.name) : literal(node); }
    visit(ast, node => {
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
        loads.push(load(literal(node.source), file));
      if (node.type === 'ImportExpression') loads.push(load(literal(node.source), file));
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const kind = role(callee);
        const method = member(callee);
        const arg = ['call', 'bind'].includes(method) ? node.arguments[1] : node.arguments[0];
        if (kind === 'module') {
          assert.ok(method !== 'apply', `uninspectable applied loader in ${file}`);
          loads.push(load(argument(arg), file));
        }
        if (kind === 'factory' || kind === 'unsafe') throw new Error(`uninspectable dynamic loader in ${file}`);
        if (kind === 'network') throw new Error(`external resource fetch in ${file}`);
        if (kind === 'resource') {
          const asset = arg?.type === 'NewExpression' && arg.callee.name === 'URL' && metaURL(arg.arguments[1]);
          // The only dynamic file reads are Canvas-owned durable store/snapshot data.
          // All module/schema/fixture assets must be statically packed relative URLs.
          assert.ok(asset || storageRead(node, arg), `resource read without package-relative URL or controlled Canvas storage in ${file}`);
        }
      }
      if (node.type === 'NewExpression' && node.callee.name === 'URL' && node.arguments.length > 1) {
        assert.ok(metaURL(node.arguments[1]), `external/dynamic resource URL in ${file}`);
        const path = literal(node.arguments[0]);
        assert.ok(typeof path === 'string' && path.startsWith('.'), `external/dynamic resource path in ${file}`);
        loads.push(load(path, file));
      }
    });
    await Promise.all(loads);
  }
  for (const file of files.filter(p => p.endsWith('.json') && p !== 'package.json' && p !== 'lib/build-source.json')) {
    const json = JSON.parse(await readFile(join(root, file), 'utf8'));
    visitJSON(json);
    function visitJSON(value) {
      if (!value || typeof value !== 'object') return;
      // External schema references must be built in; descriptive $id/source URLs are lawful provenance.
      if (typeof value.$ref === 'string') assert.ok(value.$ref.startsWith('#'), `external schema read in ${file}`);
      for (const child of Object.values(value)) visitJSON(child);
    }
  }
  const source = JSON.parse(await readFile(join(root, 'lib/build-source.json')));
  assert.equal(source.supplier.tag, 'git+https://github.com/yzsnstotz/hanaworlds-contracts.git#v2.12.0');
  assert.equal(source.supplier.revision, '33c34372fd5092a83b6f3cc81c086470fa76d794');
  assert.ok(!files.some(p => p.startsWith('node_modules/') || p.startsWith('src/') || p.startsWith('test/')), 'development package shipped');
  return { entries: [...new Set(entries)], files, edges, source };
}
