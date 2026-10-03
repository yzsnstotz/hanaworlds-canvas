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
  assert.equal(result.sourceRevision, 'e82735780bdfd4ea8e662781455040a6e5306121');
  assert.equal(result.admittedPackSha256,
    '47a2e5cc77590fb471ffedde715682564e169a0d88dbc5005b71d8d542b38f5c');
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
