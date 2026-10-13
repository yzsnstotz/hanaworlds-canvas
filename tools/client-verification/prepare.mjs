// Configure a local observation entry in an already prepared, isolated product.
// This does not build a testing package, create a product receipt, or bypass supply.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, readdir, mkdir, cp, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { buildClientVerification, buildHostVerification } from './build.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const runRoot = await realpath(resolve(sourceRoot, '..'));
const inside = (root, path) => path.startsWith(root + sep);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(value, code) { assert.ok(value, code); return value; }
async function installationAnchor(root) {
  const candidates = new Set();
  const visited = new Set();
  async function visit(dir) {
    const canonical = await realpath(dir);
    if (!inside(root, canonical) || visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(canonical, { withFileTypes: true });
    if (entries.some(e => e.name === 'package.json')) {
      const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') candidates.add(join(canonical, 'package.json'));
    }
    for (const entry of entries) {
      // Directory traversal only; no personal links or credential/config contents are read.
      if (entry.isDirectory()) await visit(join(canonical, entry.name));
    }
  }
  await visit(root);
  assert.equal(candidates.size, 1, 'CANVAS_APP_INSTALLATION_ANCHOR_MISSING_OR_AMBIGUOUS');
  return [...candidates][0];
}
export async function prepareObservation({ root, tgz }) {
  root = await realpath(requireValue(root, 'CANVAS_PREPARED_ENVIRONMENT_REQUIRED'));
  assert.ok(inside(runRoot, root), 'CANVAS_ENVIRONMENT_OUTSIDE_CARD_RUN');
  tgz = await realpath(requireValue(tgz, 'CANVAS_ACTUAL_TGZ_REQUIRED'));
  assert.ok(inside(runRoot, tgz), 'CANVAS_TGZ_OUTSIDE_CARD_RUN');
  const product = JSON.parse(await readFile(join(root, 'product-environment.json'), 'utf8'));
  assert.equal(product.electronUserData, join(root, 'electron-user-data'));
  await mkdir(product.electronUserData, { recursive: true });
  for (const key of ['app', 'dshHome', 'profile', 'electronUserData'])
    assert.ok(inside(root, await realpath(product[key])), `CANVAS_PRODUCT_PATH_OUTSIDE_RUN:${key}`);
  assert.equal(product.dshHome, join(root, 'dsh-home'));
  assert.equal(product.profile, join(product.dshHome, 'profiles/desktop'));
  await access(join(product.app, 'Contents/Info.plist'));
  const runtime = join(product.app, 'Contents/Resources/runtime/primary-runtime');
  const bundledNode = join(runtime, 'dependencies/node/bin/node');
  const runtimeRecord = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'));
  const pnpm = requireValue(runtimeRecord.pnpm, 'CANVAS_APP_PNPM_RECORD_REQUIRED');
  await access(bundledNode);
  const anchor = await installationAnchor(await realpath(runtime));
  const tools = join(product.profile, '.canvas-verification');
  await mkdir(tools); // Exclusive: do not overwrite previous observation/install evidence.
  await mkdir(join(tools, 'tools'));
  await cp(new URL('.', import.meta.url), join(tools, 'tools/client-verification'), { recursive: true });
  // Local Loader metadata only. No npm pack/add or new installed bundle for this tool.
  await writeFile(join(tools, 'package.json'), JSON.stringify({ name: 'hanaworlds-canvas-client-verification',
    version: '0.0.0', private: true, type: 'module', exports: { '.': './host.mjs', './client': './client.js' },
    dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-session'], external: ['react'] } } }, null, 2));
  const installer = join(tools, 'install.mjs');
  await writeFile(installer, `import {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nimport {writeFile} from 'node:fs/promises';\nconst [anchor,profile,home,tgz,pnpm,resultPath]=process.argv.slice(2);\nconst require=createRequire(anchor);\nconst {runPluginCommand}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')));\nconst result=await runPluginCommand({profile:'desktop',dir:profile,home,cwd:profile,installAnchor:anchor},['add','--save-exact',tgz],{command:process.execPath,args:[pnpm],execution:'service',outputBytes:4*1024*1024,activateNewBundles:true,onOutput:(value,stream)=>process[stream].write(value)});\nawait writeFile(resultPath,JSON.stringify(result,null,2));\nprocess.exitCode=result.exitCode;\n`);
  const resultPath = join(tools, 'manager-result.json');
  const child = spawn(bundledNode, [installer, anchor, product.profile, product.dshHome, tgz, pnpm, resultPath], {
    cwd: product.profile, env: { ...process.env, DSH_HOME: product.dshHome, npm_config_cache: join(root, 'npm-cache') }, stdio: 'inherit',
  });
  const exitCode = await new Promise((complete, reject) => { child.once('error', reject); child.once('close', complete); });
  assert.equal(exitCode, 0, `CANVAS_NORMAL_MANAGER_INSTALL_FAILED:${resultPath}`);
  const packageRoot = await realpath(join(product.profile, 'node_modules/hanaworlds-canvas'));
  assert.ok(inside(root, packageRoot), 'CANVAS_INSTALLED_PACKAGE_OUTSIDE_RUN');
  const receiptPath = join(tools, 'manager-receipt.json');
  await writeFile(receiptPath, JSON.stringify({ format: 'canvas-observer-install/v1', packageName: 'hanaworlds-canvas',
    tgzPath: tgz, tgzSha256: hash(await readFile(tgz)), packageRoot, profileDir: product.profile,
    installAnchor: anchor, managerResult: JSON.parse(await readFile(resultPath, 'utf8')) }, null, 2));
  const installedBuild = JSON.parse(await readFile(join(packageRoot, 'lib/build-source.json'), 'utf8'));
  const hostBuild = await buildHostVerification({ output: join(tools, 'host.mjs') });
  for (const input of Object.keys(hostBuild.metafile.inputs).filter(input => input.startsWith('src/'))) {
    assert.equal(hash(await readFile(join(sourceRoot, input))), installedBuild.inputs[input],
      `CANVAS_OBSERVER_VALIDATION_SOURCE_DIFFERS_FROM_INSTALLED_ARTIFACT:${input}`);
  }
  await writeFile(join(tools, 'host-build.json'), JSON.stringify(hostBuild.metafile, null, 2));
  await buildClientVerification({ output: join(tools, 'client.js') });
  const patchPath = join(product.profile, 'cordis.patch.yml');
  const patch = await readFile(patchPath, 'utf8');
  assert.ok(!patch.includes('canvas-client-verification'), 'CANVAS_OBSERVER_ALREADY_CONFIGURED');
  // Standard profile overlay interpreted by the existing official Loader on normal App start.
  const row = { id: 'canvas-client-verification', name: pathToFileURL(join(tools, 'host.mjs')).href,
    config: { packageRoot, tgzPath: tgz, managerReceiptPath: receiptPath } };
  await writeFile(patchPath, `${patch.trimEnd()}\n- insert:\n    - ${JSON.stringify(row)}\n`);
  return { root, tools, packageRoot, installAnchor: anchor, managerReceiptPath: receiptPath, patchPath };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--tgz', 'Usage: SEGFLOW_ENV_DIR=<prepared run> node tools/client-verification/prepare.mjs --tgz <actual Canvas tgz>');
  console.log(JSON.stringify(await prepareObservation({ root: process.env.SEGFLOW_ENV_DIR, tgz: args[1] }), null, 2));
}
