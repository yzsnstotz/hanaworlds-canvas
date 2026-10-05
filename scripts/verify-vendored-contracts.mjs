import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRevision = 'c00a489a6118fda68b80c7c1eee9a2aa90b6ddc0';
const admittedPackSha256 = '9157fac5942b3604c8b145922c526f7ae6bdafc681ac8ac75feb2489bdddb8a2';
const manifestSha256 = 'a5b9e4a26b6caa929e67ad4f73dc8688e0ff951b05a4ddfc722a87a05c52f354';
const defaultRoot = fileURLToPath(new URL('../vendor/contracts/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesUnder(root, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(root, path));
    else if (entry.isFile()) found.push(path.split(sep).join('/'));
    else throw new Error('VENDOR_UNEXPECTED_FILE_TYPE');
  }
  return found;
}

export async function verifyVendoredContracts(root = defaultRoot) {
  const rawManifest = await readFile(join(root, 'PROVENANCE.json'));
  if (digest(rawManifest) !== manifestSha256)
    throw new Error('VENDOR_MANIFEST_DIGEST_MISMATCH');
  const manifest = JSON.parse(rawManifest);
  if (manifest.sourceRevision !== sourceRevision ||
      manifest.admittedPackSha256 !== admittedPackSha256 ||
      manifest.sourcePackageVersion !== '0.3.4')
    throw new Error('VENDOR_SOURCE_PIN_MISMATCH');
  const listed = new Set();
  for (const file of manifest.files) {
    if (listed.has(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..'))
      throw new Error('VENDOR_FILE_LIST_INVALID');
    listed.add(file.path);
    const bytes = await readFile(join(root, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error(`VENDOR_FILE_DIGEST_MISMATCH:${file.path}`);
  }
  const onDisk = (await filesUnder(root)).filter(path => path !== 'PROVENANCE.json');
  if (onDisk.length !== listed.size || onDisk.some(path => !listed.has(path)))
    throw new Error('VENDOR_FILE_SET_MISMATCH');

  const visited = new Set();
  const external = new Set();
  const pending = [...manifest.runtimeRoots];
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    if (!listed.has(path)) throw new Error(`VENDOR_IMPORT_MISSING:${path}`);
    visited.add(path);
    if (path.includes('/generated/')) continue;
    const source = await readFile(join(root, path), 'utf8');
    const specs = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)]
      .map(match => match[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) { external.add(spec); continue; }
      const child = resolve(root, dirname(path), spec);
      const rel = relative(root, child).split(sep).join('/');
      if (rel.startsWith('../') || rel === '..') throw new Error('VENDOR_IMPORT_ESCAPE');
      pending.push(rel);
    }
  }
  const modules = manifest.files.filter(file => file.path.endsWith('.mjs'))
    .map(file => file.path).sort();
  if (modules.length !== visited.size || modules.some(file => !visited.has(file)))
    throw new Error('VENDOR_IMPORT_CLOSURE_MISMATCH');
  if (JSON.stringify([...external].sort()) !==
      JSON.stringify(manifest.allowedExternalImports))
    throw new Error('VENDOR_EXTERNAL_IMPORT_MISMATCH');
  return { sourceRevision, admittedPackSha256, fileCount: listed.size,
    runtimeModuleCount: visited.size, externalImports: [...external].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyVendoredContracts())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
