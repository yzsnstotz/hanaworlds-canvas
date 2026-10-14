import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, realpath, readlink, rm } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// Q271: test-owned resources only. No Host, manager, peer or product substitute.
const identity = stat => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
const errorValue = error => ({ name: error.name, message: error.message, code: error.code ?? null,
  path: error.path ?? null, stack: error.stack ?? null });
async function snapshot(paths, contents) {
  const rows = {};
  async function visit(path) {
    const stat = await lstat(path);
    const row = { ...identity(stat), kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file' };
    if (stat.isSymbolicLink()) row.target = await readlink(path); // Never recurse through a link.
    else if (contents && stat.isFile()) row.sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
    rows[path] = row;
    if (contents && stat.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  for (const path of paths) await visit(resolve(path));
  return rows;
}

export async function createOfficialHostLifecycle({ runRoot, archiveRoot, protectedPaths = [], sharedPaths = [] }) {
  runRoot = await realpath(runRoot);
  archiveRoot = resolve(archiveRoot);
  assert.ok(archiveRoot.startsWith(runRoot + '/'), 'Independent diagnostics stay in this card run');
  const before = { contents: await snapshot(protectedPaths, true), shared: await snapshot(sharedPaths, false) };
  const directory = await mkdtemp(join(runRoot, 'official-host-supply-'));
  const ownedIdentity = identity(await lstat(directory));
  const failures = [], commands = [], settlements = [];
  let primaryError;
  const recordError = (stage, error) => {
    primaryError ??= error;
    failures.push({ stage, ...errorValue(error) });
  };
  const currentProtection = async () => ({ contents: await snapshot(protectedPaths, true), shared: await snapshot(sharedPaths, false) });
  async function assertArchiveParents() {
    let cursor = runRoot;
    for (const name of archiveRoot.slice(runRoot.length + 1).split('/')) {
      cursor = join(cursor, name);
      try {
        assert.ok(!(await lstat(cursor)).isSymbolicLink(), 'Never write diagnostics through a shared archive link');
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
  }
  async function assertOwned() {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Owned root must remain a real directory');
    assert.deepEqual(identity(stat), ownedIdentity, 'Do not delete a replaced root');
    assert.equal(dirname(directory), runRoot);
    assert.equal(await realpath(directory), directory, 'Do not follow a replacement/shared root link');
  }
  function command(binary, args, cwd, log, env) {
    const row = { binary, args, cwd, log, pid: null, settled: false, code: null, signal: null, error: null };
    commands.push(row);
    const task = (async () => {
      let output = '', launchError;
      const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      row.pid = child.pid ?? null;
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { output += bytes; });
      // Even a spawn error has a close event. Wait for the actual child/stdio
      // settlement before any root deletion, rather than rejecting on error.
      child.on('error', error => { launchError = error; row.error = errorValue(error); });
      await new Promise(resolveClose => child.on('close', (code, signal) => {
        row.code = code; row.signal = signal; row.settled = true; resolveClose();
      }));
      await writeFile(join(directory, log), output);
      if (launchError) throw launchError;
      return { code: row.code, output };
    })().catch(error => { recordError(`command:${log}`, error); throw error; });
    settlements.push(task);
    // Mark rejection handled even if suite teardown is the first awaiter.
    task.catch(() => {});
    return task;
  }
  async function finalize({ diagnostics = [] } = {}) {
    const archive = join(archiveRoot, basename(directory));
    const audit = { directory, archive, ownedIdentity, before, failures, commands, removed: false };
    try {
      await Promise.allSettled(settlements);
      assert.ok(commands.every(row => row.settled), 'Every owned command must really settle before deletion');
      await assertOwned();
      audit.beforeCleanup = await currentProtection();
      await assertArchiveParents();
      await mkdir(archive, { recursive: true });
      assert.equal(await realpath(archive), archive, 'Diagnostic archive must not escape through a symlink');
      for (const relative of diagnostics) {
        const file = resolve(directory, relative);
        assert.ok(file.startsWith(directory + '/'), 'Only necessary diagnostics inside this root');
        let stat;
        try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        assert.ok((await realpath(file)).startsWith(directory + '/'), 'Never archive a shared link target');
        const destination = join(archive, relative);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(file));
      }
      // Independent diagnostic evidence must exist before rm, including the
      // original assertion/setup/command error and all command exit receipts.
      await writeFile(join(archive, 'lifecycle-audit.json'), JSON.stringify(audit, null, 2));
      await assertOwned();
      await rm(directory, { recursive: true, force: false });
      await assert.rejects(lstat(directory), { code: 'ENOENT' });
      audit.removed = true;
      audit.afterCleanup = await currentProtection();
      audit.protectedUnchanged = JSON.stringify(before) === JSON.stringify(audit.afterCleanup)
        && JSON.stringify(before) === JSON.stringify(audit.beforeCleanup);
      await writeFile(join(archive, 'lifecycle-audit.json'), JSON.stringify(audit, null, 2));
      assert.deepEqual(audit.beforeCleanup, before, 'Installation must preserve source/input/shared identities');
      assert.deepEqual(audit.afterCleanup, before, 'Cleanup must preserve source/input/shared/link targets');
      return audit;
    } catch (error) {
      audit.cleanupFailure = errorValue(error);
      // A failed archive/delete cannot replace the original business error or
      // claim success. Root identity drift is also a named retained resource.
      try {
        await assertArchiveParents();
        await writeFile(join(archive, 'lifecycle-audit.json'), JSON.stringify(audit, null, 2));
      } catch {} // Root and full failure remain named in the thrown AggregateError.
      const failure = new AggregateError(primaryError ? [primaryError, error] : [error],
        `Official test resource cleanup failed; removed=${audit.removed}; ownedRoot=${directory}; ${error.message}`);
      failure.audit = audit;
      throw failure;
    }
  }
  return { directory, recordError, command, finalize };
}
