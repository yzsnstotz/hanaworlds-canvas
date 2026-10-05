import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyVendoredContracts } from '../scripts/verify-vendored-contracts.mjs';

const vendor = fileURLToPath(new URL('../vendor/contracts/', import.meta.url));
const packageJson = fileURLToPath(new URL('../package.json', import.meta.url));
const packageLock = fileURLToPath(new URL('../package-lock.json', import.meta.url));

test('Canvas package contains the exact admitted Contracts runtime closure', async () => {
  const result = await verifyVendoredContracts();
  assert.equal(result.sourceRevision, 'c00a489a6118fda68b80c7c1eee9a2aa90b6ddc0');
  assert.equal(result.admittedPackSha256,
    '9157fac5942b3604c8b145922c526f7ae6bdafc681ac8ac75feb2489bdddb8a2');
  assert.equal(result.runtimeModuleCount, 25);
  const pkg = JSON.parse(await readFile(packageJson, 'utf8'));
  assert.equal(pkg.dependencies['hanaworlds-contracts'], undefined);
  assert.equal(pkg.files.includes('vendor/contracts/'), true);
  const lock = JSON.parse(await readFile(packageLock, 'utf8'));
  assert.equal(lock.packages['node_modules/hanaworlds-contracts'], undefined);
  assert.equal(JSON.stringify(lock).includes('codeload.github.com'), false);
});

test('vendored Contracts source or provenance tampering fails closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-contracts-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(vendor, root, { recursive: true });
  const source = join(root, 'dist', 'v4', 'runtime.mjs');
  const exact = await readFile(source);
  await appendFile(source, '\n');
  await assert.rejects(() => verifyVendoredContracts(root),
    /VENDOR_FILE_DIGEST_MISMATCH:dist\/v4\/runtime\.mjs/);
  await writeFile(source, exact);
  await appendFile(join(root, 'PROVENANCE.json'), '\n');
  await assert.rejects(() => verifyVendoredContracts(root),
    /VENDOR_MANIFEST_DIGEST_MISMATCH/);
});
