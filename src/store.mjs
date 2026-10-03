import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function nullRecords(value) {
  if (Array.isArray(value)) return value.map(nullRecords);
  if (value === null || typeof value !== 'object') return value;
  const record = Object.create(null);
  for (const [key, child] of Object.entries(value)) record[key] = nullRecords(child);
  return record;
}

function fresh() {
  return { schemaVersion: 3, sessions: {}, bindings: {}, objects: {}, names: {}, footprints: {},
    registryRevisions: {}, analyses: {}, decisions: {}, transactions: {}, history: {},
    authorHistory: {}, connectionInventories: {},
    replay: {}, pending: {} };
}

async function readBackup(path) {
  try { return await readFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('CANVAS_MIGRATION_BACKUP_UNAVAILABLE', { cause: error });
  }
}

async function ensureExactBackup(directory, name, bytes) {
  const path = join(directory, name);
  const existing = await readBackup(path);
  if (existing !== undefined) {
    if (!existing.equals(bytes)) throw new Error('CANVAS_MIGRATION_BACKUP_CONFLICT');
    try {
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      throw new Error('CANVAS_MIGRATION_BACKUP_UNAVAILABLE', { cause: error });
    }
    return;
  }
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if (error.code === 'EEXIST') return ensureExactBackup(directory, name, bytes);
    throw new Error('CANVAS_MIGRATION_BACKUP_UNAVAILABLE', { cause: error });
  }
}

/** Canvas-owned state. A same-profile host must provide one writer instance. */
export class CanvasStore {
  constructor(directory, snapshot) {
    this.directory = directory;
    this.snapshot = snapshot;
    this.busy = Promise.resolve();
    this.unavailable = false;
  }
  static async open(directory) {
    if (typeof directory !== 'string' || !directory) throw new Error('CANVAS_STORAGE_UNAVAILABLE');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let snapshot;
    let oldBytes;
    try {
      oldBytes = await readFile(join(directory, 'canvas-v2.json'));
      snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(oldBytes));
    } catch (error) { if (error.code !== 'ENOENT') throw error; snapshot = fresh(); }
    if (snapshot.schemaVersion === 1) {
      // A conflicting later backup must stop before touching the schema-1 source.
      const intermediate = { ...snapshot, schemaVersion: 2,
        authorHistory: snapshot.authorHistory ?? {},
        connectionInventories: snapshot.connectionInventories ?? {} };
      const existingPreV4 = await readBackup(join(directory, 'canvas-v2.pre-v4.json'));
      if (existingPreV4 !== undefined &&
          !existingPreV4.equals(Buffer.from(JSON.stringify(intermediate))))
        throw new Error('CANVAS_MIGRATION_BACKUP_CONFLICT');
      await ensureExactBackup(directory, 'canvas-v2.pre-v3.json', oldBytes);
      snapshot.schemaVersion = 2;
      snapshot.authorHistory ??= {};
      snapshot.connectionInventories ??= {};
      const migrated = new this(directory, nullRecords(snapshot));
      try { await migrated.commit(() => {}); }
      catch (error) { throw new Error('CANVAS_MIGRATION_WRITE_UNAVAILABLE', { cause: error }); }
      oldBytes = await readFile(join(directory, 'canvas-v2.json'));
      snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(oldBytes));
    }
    if (snapshot.schemaVersion === 2) {
      await ensureExactBackup(directory, 'canvas-v2.pre-v4.json', oldBytes);
      snapshot.schemaVersion = 3;
      snapshot.authorHistory ??= {};
      snapshot.connectionInventories ??= {};
      const migrated = new this(directory, nullRecords(snapshot));
      try { await migrated.commit(() => {}); }
      catch (error) { throw new Error('CANVAS_MIGRATION_WRITE_UNAVAILABLE', { cause: error }); }
      return migrated;
    }
    if (snapshot.schemaVersion !== 3) throw new Error('CANVAS_STORAGE_VERSION_UNSUPPORTED');
    snapshot.authorHistory ??= {};
    snapshot.connectionInventories ??= {};
    return new this(directory, nullRecords(snapshot));
  }
  async commit(change) {
    const operation = this.busy.then(async () => {
      if (this.unavailable) throw new Error('CANVAS_STORAGE_UNAVAILABLE');
      const next = nullRecords(structuredClone(this.snapshot));
      const result = await change(next);
      const path = join(this.directory, 'canvas-v2.json');
      const temporary = join(this.directory, `.canvas-v2-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        renamed = true;
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        this.snapshot = nullRecords(next);
      } catch (error) {
        if (renamed) this.unavailable = true;
        await rm(temporary, { force: true });
        throw error;
      }
      return result;
    });
    this.busy = operation.catch(() => {});
    return operation;
  }
}
