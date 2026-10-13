// Normal official Web-profile installation and ordinary local Loader metadata.
// The public supplier owns CLI supply. This tool never manufactures its receipt.
import { readFile, writeFile, realpath, mkdir, cp, access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildClientVerification, buildHostVerification } from './build.mjs';
import { RunnerFailure, confined, ensureConfinedDirectory, launchOwned } from './processes.mjs';

export const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
export const cardRoot = resolve(sourceRoot, '..');
export const approvedSource = Object.freeze({ tag: 'dsh-v0.2.1-alpha.2',
  tagObject: '6851e496285b2c9670066fdd142e7e46da586649',
  commit: 'd743267388641bc76f17c45ce8b4c231aed1d32c',
  archiveSHA256: 'f277ff1f70eda785522aec3fcdcf9d658fafb3c0d30036f810dec76d400c0e51',
  lockSHA256: 'b45f8695fb0dca90d3ed07afc766e923356539962706ee36ac8cdb396e6d734d' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const peerVersions = { '@deepseek-ai/cordis': '4.0.5-alpha.1',
  '@deepseek-ai/dsh-typert-protocol': '0.2.1-alpha.2', react: '18.3.1', zod: '4.4.3' };

export async function readSupply(root) {
  root = await confined(cardRoot, root, 'public supply runRoot');
  let supply;
  try { supply = JSON.parse(await readFile(join(root, 'official-host-supply.json'), 'utf8')); }
  catch (error) { throw new RunnerFailure('CANVAS_VERIFY_PUBLIC_SUPPLIER_RECEIPT_MISSING', 'The actual public supplier has not produced its receipt.', { cause: error.code }); }
  for (const [key, expected] of Object.entries({ tag: approvedSource.tag, tagObject: approvedSource.tagObject,
    commit: approvedSource.commit, archiveSha256: approvedSource.archiveSHA256, lockSha256: approvedSource.lockSHA256 }))
    if (supply.source?.[key] !== expected)
      throw new RunnerFailure('CANVAS_VERIFY_OFFICIAL_SOURCE_MISMATCH', `The public receipt has a different ${key}.`, { key });
  if (!Array.isArray(supply.packages) || !supply.commands?.start || !supply.commands?.dumpConfig)
    throw new RunnerFailure('CANVAS_VERIFY_PUBLIC_SUPPLIER_PROTOCOL_MISSING', 'The public receipt is missing normal commands or actual official package roots.');
  await confined(root, supply.usagePath, 'generated HOST-USAGE');
  const dshHome = await confined(root, supply.dshHome, 'normal dshHome');
  const profile = await confined(root, supply.profileDir, 'normal installed Web profile');
  if (profile !== join(dshHome, 'profiles', 'web'))
    throw new RunnerFailure('CANVAS_VERIFY_WEB_PROFILE_REQUIRED', 'Supply must use the normal web profile.');
  const cli = supply.packages.filter(pkg => pkg.name === '@deepseek-ai/dsh');
  if (cli.length !== 1 || cli[0].version !== '0.2.1-alpha.2')
    throw new RunnerFailure('CANVAS_VERIFY_OFFICIAL_CLI_SUPPLY_MISSING', 'The public supplier must identify exactly one approved CLI installation.');
  const installationRoot = await confined(root, cli[0].packageRoot, 'same-source CLI installation');
  const installationAnchor = await confined(root, join(installationRoot, 'package.json'), 'CLI installationAnchor');
  const manifest = JSON.parse(await readFile(installationAnchor, 'utf8'));
  if (manifest.name !== cli[0].name || manifest.version !== cli[0].version)
    throw new RunnerFailure('CANVAS_VERIFY_OFFICIAL_CLI_IDENTITY_INVALID', 'Actual CLI package bytes do not match the supplier record.');
  for (const command of Object.values(supply.commands)) {
    if (!command || typeof command.file !== 'string' || !Array.isArray(command.args) || !command.env)
      throw new RunnerFailure('CANVAS_VERIFY_PUBLIC_COMMAND_INVALID', 'The supplier did not provide an executable command with its complete env-i environment.');
    await confined(root, command.cwd, 'public command cwd');
    for (const key of ['HOME', 'TMPDIR', 'DSH_HOME', 'DSH_AGENTS_HOME', 'npm_config_cache', 'XDG_CACHE_HOME'])
      await ensureConfinedDirectory(root, command.env[key], `public command ${key}`);
    if (command.env.DSH_HOME !== supply.dshHome)
      throw new RunnerFailure('CANVAS_VERIFY_COMMAND_HOME_MISMATCH', 'The actual command names a different dshHome.');
  }
  const cliBin = await confined(root, join(installationRoot, manifest.bin.dsh), 'normal CLI executable');
  if (await realpath(supply.commands.start.args[0]) !== cliBin)
    throw new RunnerFailure('CANVAS_VERIFY_COMMAND_CLI_MISMATCH', 'The generated command does not launch the recorded CLI installation.');
  return { root, supply, dshHome, profile, installationAnchor, installationRoot };
}

export async function retainOfficialSource(prepared, { timeoutMs, owned, redact }) {
  const directory = join(prepared.root, 'approved-source');
  await mkdir(directory);
  const archive = join(directory, 'deepseek-harness.tar.gz');
  const response = await fetch(`https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/tags/${approvedSource.tag}`,
    { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new RunnerFailure('CANVAS_VERIFY_SOURCE_ARCHIVE_DOWNLOAD_FAILED', 'The approved source archive could not be retained.', { status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== approvedSource.archiveSHA256)
    throw new RunnerFailure('CANVAS_VERIFY_SOURCE_ARCHIVE_MISMATCH', 'Actual approved tag archive bytes have drifted.');
  await writeFile(archive, bytes, { flag: 'wx' });
  const extract = await launchOwned({ file: 'tar', args: ['-xzf', archive, '-C', directory],
    cwd: prepared.root, env: prepared.supply.commands.start.env, root: prepared.root, label: 'extract-approved-source', redact });
  owned.push(extract); await extract.complete(timeoutMs);
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  if (entries.length !== 1) throw new RunnerFailure('CANVAS_VERIFY_SOURCE_ARCHIVE_LAYOUT_INVALID', 'The actual approved source archive has no unambiguous root.');
  const lockfile = await confined(prepared.root, join(directory, entries[0].name, 'pnpm-lock.yaml'), 'original approved lock');
  if (hash(await readFile(lockfile)) !== approvedSource.lockSHA256)
    throw new RunnerFailure('CANVAS_VERIFY_SOURCE_LOCK_MISMATCH', 'Actual original source lock bytes have drifted.');
  return { tag: prepared.supply.source.tag, commit: prepared.supply.source.commit, archive, lockfile };
}

export async function prepareObservation({ root, tgz, prepared, timeoutMs, outputBytes, owned, redact }) {
  prepared ??= await readSupply(root);
  root = prepared.root;
  tgz = await confined(root, tgz, 'actual production Canvas tgz');
  const actualManifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!isDeepStrictEqual(actualManifest.peerDependencies, peerVersions))
    throw new RunnerFailure('CANVAS_VERIFY_PEER_DRIFT', 'Canvas fixed official peers have changed.');
  const tools = join(prepared.profile, '.canvas-verification');
  await mkdir(tools); // Exclusive: never replace an earlier tool or installation receipt.
  await cp(new URL('.', import.meta.url), join(tools, 'tools', 'client-verification'), { recursive: true });
  await writeFile(join(tools, 'package.json'), JSON.stringify({ name: 'hanaworlds-canvas-client-verification',
    version: '0.0.0', private: true, type: 'module', exports: { '.': './host.mjs', './client': './client.js' },
    dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-session'], external: ['react'] } } }, null, 2));
  const links = [];
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-plugin-manager',
    '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway']) {
    const rows = prepared.supply.packages.filter(pkg => pkg.name === name);
    if (rows.length !== 1)
      throw new RunnerFailure('CANVAS_VERIFY_OFFICIAL_DEPENDENCY_MISSING', `The actual supply has no unambiguous ${name}.`, { packageName: name });
    const packageRoot = await confined(root, rows[0].packageRoot, `same-source ${name}`);
    await access(join(packageRoot, 'package.json')); links.push(`link:${packageRoot}`);
  }
  const installer = join(tools, 'install.mjs');
  // The public package operation creates no Context, Gateway, or Host.
  await writeFile(installer, `import {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nimport {readFile,writeFile} from 'node:fs/promises';\nconst spec=JSON.parse(await readFile(process.argv[2],'utf8'));\nconst require=createRequire(spec.installAnchor);\nconst {runPluginCommand}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')));\nconst result=await runPluginCommand({profile:'web',dir:spec.profile,home:spec.home,cwd:spec.profile,installAnchor:spec.installAnchor},['add','--save-exact',...spec.links,spec.tgz],{command:'pnpm',execution:'service',outputBytes:spec.outputBytes,activateNewBundles:true,onOutput:(text,stream)=>process[stream].write(text)});\nawait writeFile(spec.resultPath,JSON.stringify(result,null,2));\nprocess.exitCode=result.exitCode;\n`);
  const resultPath = join(tools, 'manager-result.json'), installInput = join(tools, 'install-input.json');
  await writeFile(installInput, JSON.stringify({ installAnchor: prepared.installationAnchor,
    profile: prepared.profile, home: prepared.dshHome, tgz, links, outputBytes, resultPath }, null, 2));
  const manager = await launchOwned({ file: prepared.supply.commands.start.file, args: [installer, installInput],
    cwd: prepared.profile, env: prepared.supply.commands.start.env, root, label: 'normal-manager-canvas-install', redact });
  owned.push(manager); await manager.complete(timeoutMs);
  const managerResult = JSON.parse(await readFile(resultPath, 'utf8'));
  if (managerResult.exitCode !== 0) throw new RunnerFailure('CANVAS_VERIFY_NORMAL_MANAGER_INSTALL_FAILED', 'The actual manager rejected the production Canvas tgz.', { resultPath });
  const packageRoot = await confined(root, join(prepared.profile, 'node_modules', 'hanaworlds-canvas'), 'manager-installed Canvas');
  const receiptPath = join(tools, 'manager-receipt.json');
  await writeFile(receiptPath, JSON.stringify({ format: 'canvas-observer-install/v1', packageName: 'hanaworlds-canvas',
    tgzPath: tgz, tgzSha256: hash(await readFile(tgz)), packageRoot, profileDir: prepared.profile,
    installAnchor: prepared.installationAnchor, managerResult }, null, 2));
  const installedBuild = JSON.parse(await readFile(join(packageRoot, 'lib', 'build-source.json'), 'utf8'));
  const hostBuild = await buildHostVerification({ output: join(tools, 'host.mjs') });
  for (const input of Object.keys(hostBuild.metafile.inputs).filter(input => input.startsWith('src/')))
    if (hash(await readFile(join(sourceRoot, input))) !== installedBuild.inputs[input])
      throw new RunnerFailure('CANVAS_VERIFY_OBSERVER_SOURCE_DRIFT', `Own observer validation input differs from the actually installed artifact: ${input}.`, { input });
  await writeFile(join(tools, 'host-build.json'), JSON.stringify(hostBuild.metafile, null, 2));
  await buildClientVerification({ output: join(tools, 'client.js') });
  const patchPath = await confined(root, join(prepared.profile, 'cordis.patch.yml'), 'normal Web profile overlay');
  const patch = await readFile(patchPath, 'utf8');
  if (patch.includes('canvas-client-verification'))
    throw new RunnerFailure('CANVAS_VERIFY_OBSERVER_ALREADY_CONFIGURED', 'This profile already contains an observation entry.');
  const row = { id: 'canvas-client-verification', name: pathToFileURL(join(tools, 'host.mjs')).href,
    config: { packageRoot, tgzPath: tgz, managerReceiptPath: receiptPath } };
  await writeFile(patchPath, `${patch.trimEnd()}\n- insert:\n    - ${JSON.stringify(row)}\n`);
  return { tools, packageRoot, installAnchor: prepared.installationAnchor, managerReceiptPath: receiptPath, patchPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  throw new RunnerFailure('CANVAS_VERIFY_USE_RUNNER', 'Use node tools/client-verification/run.mjs; it supplies all engineering resources itself.');
