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
  assert.equal(result.sourceRevision, '3d64364782181c8b5abc3150f8fa9f7ae20bf101');
  assert.equal(result.admittedPackSha256,
    '48f0b56a3b385bd3a17773fd968c0566068fe1a28ecb4aa08d9686d254cdbb0a');
  assert.equal(result.runtimeModuleCount, 24);
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
