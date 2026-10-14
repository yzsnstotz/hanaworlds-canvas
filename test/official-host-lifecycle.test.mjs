import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, symlink, rename, rm, cp } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficialHostLifecycle } from './support/official-host-lifecycle.mjs';

const runRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidence = join(runRoot, 'evidence/q271/lifecycle-fixtures');
// RESOURCE_FIXTURE evidence only. The original official suite must separately
// run its real npm/pack/manager/types/runtime and final file-suite cleanup.
async function fixture(t) {
  const directory = await mkdtemp(join(runRoot, 'q271-lifecycle-fixture-'));
  const initial = await lstat(directory);
  const proof = { classification: 'RESOURCE_FIXTURE', directory, scenario: t.name };
  t.after(async () => {
    await mkdir(evidence, { recursive: true });
    try { await cp(join(directory, 'audits'), join(evidence, basename(directory)), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(evidence, basename(directory) + '.json'), JSON.stringify(proof, null, 2));
    const stat = await lstat(directory);
    assert.equal(stat.ino, initial.ino); assert.ok(!stat.isSymbolicLink());
    // Dispose only this test's finished fixtures, including intentional
    // retained-root negative cases. Never an old official/profile directory.
    await rm(directory, { recursive: true, force: false });
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  });
  for (const name of ['source', 'inputs', 'shared', 'link-target']) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'sentinel'), `${name}: original bytes\n`);
  }
  await symlink(join(directory, 'link-target'), join(directory, 'input-link'));
  const protectedPaths = ['source', 'inputs', 'shared', 'link-target', 'input-link'].map(name => join(directory, name));
  const archiveRoot = join(directory, 'audits');
  const create = options => createOfficialHostLifecycle({ runRoot: directory, archiveRoot,
    protectedPaths, sharedPaths: [join(directory, 'shared')], ...options });
  const preserved = async () => {
    for (const name of ['source', 'inputs', 'shared', 'link-target'])
      assert.equal(await readFile(join(directory, name, 'sentinel'), 'utf8'), `${name}: original bytes\n`);
    assert.equal(await readlink(join(directory, 'input-link')), join(directory, 'link-target'));
  };
  return { directory, proof, archiveRoot, create, preserved };
}

test('official lifecycle: success archives before removal and awaits the actual owned child', async t => {
  const env = await fixture(t), life = await env.create();
  for (const name of ['installation', 'profile']) await mkdir(join(life.directory, name));
  await symlink(join(env.directory, 'link-target'), join(life.directory, 'external-target'));
  await writeFile(join(life.directory, 'versions.json'), '{"fixture":true}');
  const running = life.command(process.execPath, ['-e',
    "setTimeout(()=>{require('fs').writeFileSync('profile/settled','child really closed');console.log('settled');},100)"],
  life.directory, 'child.log', { PATH: process.env.PATH });
  const audit = await life.finalize({ diagnostics: ['child.log', 'versions.json'] });
  assert.equal((await running).code, 0);
  assert.equal(audit.commands[0].settled, true); assert.ok(audit.commands[0].pid > 0);
  assert.equal(await readFile(join(audit.archive, 'child.log'), 'utf8'), 'settled\n');
  assert.deepEqual(JSON.parse(await readFile(join(audit.archive, 'versions.json'))), { fixture: true });
  assert.equal(audit.removed, true); assert.equal(audit.protectedUnchanged, true);
  await assert.rejects(lstat(life.directory), { code: 'ENOENT' }); await env.preserved();
  env.proof.audit = audit;
});

test('official lifecycle: original assertion failure is archived and installation/profile are removed', async t => {
  const env = await fixture(t), life = await env.create();
  for (const name of ['installation', 'profile']) await mkdir(join(life.directory, name));
  let original;
  try { assert.equal('actual', 'expected', 'original body assertion'); } catch (error) { original = error; life.recordError('body', error); }
  assert.equal(original.code, 'ERR_ASSERTION');
  await writeFile(join(life.directory, 'failure.log'), original.stack);
  const audit = await life.finalize({ diagnostics: ['failure.log'] });
  assert.equal(audit.failures[0].message, original.message); assert.equal(audit.failures[0].code, original.code);
  assert.equal(await readFile(join(audit.archive, 'failure.log'), 'utf8'), original.stack);
  await assert.rejects(lstat(life.directory), { code: 'ENOENT' }); await env.preserved();
  env.proof.audit = audit;
});

test('official lifecycle: real setup ENOTDIR after root registration retains its error then removes the root', async t => {
  const env = await fixture(t), life = await env.create();
  await writeFile(join(life.directory, 'installation'), 'a real ordinary file blocks setup');
  let original;
  try { await mkdir(join(life.directory, 'installation', 'node_modules')); }
  catch (error) { original = error; life.recordError('setup', error); }
  assert.equal(original.code, 'ENOTDIR');
  const audit = await life.finalize();
  assert.equal(audit.failures[0].message, original.message); assert.equal(audit.failures[0].path, original.path);
  assert.equal(audit.failures[0].code, 'ENOTDIR');
  await assert.rejects(lstat(life.directory), { code: 'ENOENT' }); await env.preserved();
  env.proof.audit = audit;
});

test('official lifecycle: real spawn ENOENT closes before teardown and preserves its command error', async t => {
  const env = await fixture(t), life = await env.create();
  await assert.rejects(life.command(join(env.directory, 'does-not-exist'), [], life.directory, 'spawn.log', {}), { code: 'ENOENT' });
  const audit = await life.finalize({ diagnostics: ['spawn.log'] });
  assert.equal(audit.commands[0].settled, true); assert.equal(audit.commands[0].error.code, 'ENOENT');
  assert.equal(audit.failures[0].code, 'ENOENT');
  await assert.rejects(lstat(life.directory), { code: 'ENOENT' }); await env.preserved();
  env.proof.audit = audit;
});

test('official lifecycle: archive ENOTDIR names the retained root and preserves the original failure', async t => {
  const env = await fixture(t), occupied = join(env.directory, 'archive-file');
  await writeFile(occupied, 'not a directory');
  const life = await env.create({ archiveRoot: join(occupied, 'audit') });
  const original = new Error('original setup failure'); life.recordError('setup', original);
  let caught;
  try { await life.finalize(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0], original);
  assert.equal(caught.audit.cleanupFailure.code, 'ENOTDIR'); assert.equal(caught.audit.removed, false);
  assert.ok(caught.message.includes(life.directory)); assert.ok((await lstat(life.directory)).isDirectory());
  await env.preserved(); env.proof.audit = caught.audit;
});

test('official lifecycle: a replaced root link is refused without deleting the link target', async t => {
  const env = await fixture(t), life = await env.create();
  const original = new Error('original runtime failure'); life.recordError('runtime', original);
  await rename(life.directory, life.directory + '-retained');
  await symlink(join(env.directory, 'link-target'), life.directory);
  let caught;
  try { await life.finalize(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0], original);
  assert.equal(caught.audit.removed, false); assert.ok((await lstat(life.directory)).isSymbolicLink());
  assert.equal(await readlink(life.directory), join(env.directory, 'link-target'));
  await env.preserved(); env.proof.audit = caught.audit;
});
