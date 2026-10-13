import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';

export class RunnerFailure extends Error {
  constructor(code, message, details = {}) { super(`${code}: ${message}`); this.name = 'SupplyFailure'; this.code = code; this.details = details; }
}
export function positive(value, name, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new RunnerFailure('CANVAS_VERIFY_BUDGET_INVALID', `${name} must be a positive integer.`, { name });
  return number;
}
export async function confined(root, path, label) {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(path);
  if (!candidate.startsWith(canonicalRoot + sep))
    throw new RunnerFailure('CANVAS_VERIFY_RESOURCE_OUTSIDE_RUN', `${label} is outside the actual current run.`, { label, path: candidate });
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(canonicalRoot + sep))
    throw new RunnerFailure('CANVAS_VERIFY_RESOURCE_SYMLINK_OUTSIDE_RUN', `${label} resolves outside the actual current run.`, { label, path: canonical });
  return canonical;
}
export async function ensureConfinedDirectory(root, path, label) {
  const canonicalRoot = await realpath(root), candidate = resolve(path);
  if (!candidate.startsWith(canonicalRoot + sep))
    throw new RunnerFailure('CANVAS_VERIFY_RESOURCE_OUTSIDE_RUN', `${label} is outside the actual current run.`, { label });
  let ancestor = candidate;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + sep))
        throw new RunnerFailure('CANVAS_VERIFY_RESOURCE_SYMLINK_OUTSIDE_RUN', `${label} has an ancestor outside this run.`, { label });
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(candidate, { recursive: true });
  return confined(canonicalRoot, candidate, label);
}
export function redactor() {
  const secrets = new Set();
  return {
    add: value => { if (value) secrets.add(value); },
    text(value) {
      let text = String(value).replace(/\u001b\[[0-9;]*m/g, '');
      for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
      return text.replace(/([?&](?:token|access_token|auth)=)[^&\s"'<>]*/gi, '$1[REDACTED]')
        .replace(/((?:set-cookie|cookie)\s*:)[^\r\n]*/gi, '$1 [REDACTED]');
    },
  };
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function deadline(promise, ms, code, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RunnerFailure(code, message, { timeoutMs: ms })), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function launchOwned({ file, args, cwd, env, root, label, redact = redactor(), readyMatch }) {
  await mkdir(join(root, 'process-evidence'), { recursive: true });
  const stdoutPath = join(root, 'process-evidence', `${label}.stdout.log`);
  const stderrPath = join(root, 'process-evidence', `${label}.stderr.log`);
  const output = { stdout: createWriteStream(stdoutPath, { flags: 'wx' }), stderr: createWriteStream(stderrPath, { flags: 'wx' }) };
  const child = spawn(file, args, { cwd, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit = null, startupError = null, processEnded = false;
  const logErrors = [];
  let readyResolve, readyReject, readySettled = false;
  const readyPromise = readyMatch ? new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady; readyReject = rejectReady;
  }) : null;
  readyPromise?.catch(() => {});
  const logsClosed = Object.values(output).map(stream => new Promise(done => {
    stream.on('error', error => logErrors.push(error.code)); stream.once('close', done);
  }));
  function received(stream, line) {
    // The one startup matcher is supplied before launch, so early output cannot
    // be lost. Retain only its selected actual value, never a raw output history.
    if (readyMatch && !readySettled) {
      try {
        const result = readyMatch(line, stream);
        if (result) { readySettled = true; readyResolve(result); }
      } catch (error) { readySettled = true; readyReject(error); }
    }
    const safe = redact.text(line); output[stream].write(safe + '\n');
  }
  for (const stream of ['stdout', 'stderr']) {
    let pending = '';
    child[stream].setEncoding('utf8');
    child[stream].on('data', chunk => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) { received(stream, pending.slice(0, index)); pending = pending.slice(index + 1); }
    });
    child[stream].on('end', () => { if (pending) received(stream, pending); output[stream].end(); });
  }
  const closed = new Promise(resolveExit => {
    child.once('exit', () => { processEnded = true; });
    child.once('error', error => {
      startupError = error;
      readyReject?.(new RunnerFailure('CANVAS_VERIFY_PROCESS_START_FAILED', `${label} could not start.`, { cause: error.code }));
    });
    child.once('close', async (code, signal) => {
      for (const stream of Object.values(output)) if (!stream.writableEnded) stream.end();
      await Promise.all(logsClosed);
      exit = { code, signal, startupError: startupError?.code ?? null, logErrors };
      readyReject?.(new RunnerFailure('CANVAS_VERIFY_PROCESS_EXITED', `${label} exited before readiness.`, { ...exit, stderrPath }));
      resolveExit(exit);
    });
  });
  return {
    child, pid: child.pid, label, closed, stdoutPath, stderrPath,
    get exit() { return exit; },
    async ready(timeoutMs) {
      if (!readyPromise) throw new RunnerFailure('CANVAS_VERIFY_OUTPUT_MATCHER_REQUIRED', `${label} must register its actual startup matcher before launch.`);
      if (processEnded || exit) throw new RunnerFailure('CANVAS_VERIFY_PROCESS_EXITED', `${label} already exited.`,
        exit ?? { code: child.exitCode, signal: child.signalCode });
      return deadline(readyPromise, timeoutMs, 'CANVAS_VERIFY_PROCESS_READY_TIMEOUT', `${label} has not supplied its actual startup address.`);
    },
    async complete(timeoutMs) {
      const result = timeoutMs ? await deadline(closed, timeoutMs, 'CANVAS_VERIFY_PROCESS_TIMEOUT', `${label} exceeded its command budget.`) : await closed;
      if (result.code !== 0 || result.logErrors.length) throw new RunnerFailure('CANVAS_VERIFY_COMMAND_FAILED', `${label} exited unsuccessfully or could not preserve evidence.`, { ...result, stdoutPath, stderrPath });
      return result;
    },
    receipt() { return { pid: child.pid ?? null, label, file, args: args.map(redact.text), cwd, stdoutPath, stderrPath, exit }; },
  };
}
export async function stopOwned(owned, stopTimeoutMs) {
  if (!owned?.pid) return { label: owned?.label ?? null, started: false };
  const sent = [];
  const signal = name => {
    try { process.kill(-owned.pid, name); sent.push(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (groupAlive(owned.pid)) signal('SIGTERM');
  let timedOut = false;
  try { await deadline(owned.closed, stopTimeoutMs, 'CANVAS_VERIFY_STOP_TIMEOUT', `${owned.label} did not stop after SIGTERM.`); }
  catch (error) {
    if (error.code !== 'CANVAS_VERIFY_STOP_TIMEOUT') throw error;
    timedOut = true; signal('SIGKILL');
    await deadline(owned.closed, stopTimeoutMs, 'CANVAS_VERIFY_KILL_TIMEOUT', `${owned.label} remains alive after the named stop budget.`);
  }
  if (groupAlive(owned.pid)) {
    signal('SIGKILL');
    throw new RunnerFailure('CANVAS_VERIFY_OWNED_DESCENDANT_REMAINS', `${owned.label} left its own process group running.`, { pid: owned.pid, sent });
  }
  if (timedOut) throw new RunnerFailure('CANVAS_VERIFY_STOP_TIMEOUT', `${owned.label} required SIGKILL after its configured SIGTERM budget.`, { pid: owned.pid, sent, exit: owned.exit });
  return { ...owned.receipt(), signals: sent, processGroupReleased: true };
}
export async function verifyPortReleased(url) {
  const value = new URL(url);
  const server = createServer();
  const released = new Promise((resolvePort, reject) => {
    server.once('error', error => reject(new RunnerFailure('CANVAS_VERIFY_PORT_NOT_RELEASED', 'An actual this-run listener port remains unavailable after cleanup.', { port: Number(value.port), cause: error.code })));
    server.listen(Number(value.port), value.hostname, () => server.close(error => error ? reject(error) : resolvePort({ port: Number(value.port), released: true })));
  });
  return released;
}
export { deadline };
