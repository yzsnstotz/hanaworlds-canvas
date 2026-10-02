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
  return { schemaVersion: 2, sessions: {}, bindings: {}, objects: {}, names: {}, footprints: {},
    registryRevisions: {}, analyses: {}, decisions: {}, transactions: {}, history: {},
    authorHistory: {}, connectionInventories: {},
    replay: {}, pending: {} };
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
      oldBytes = await readFile(join(directory, 'canvas-v2.json'), 'utf8');
      snapshot = JSON.parse(oldBytes);
    } catch (error) { if (error.code !== 'ENOENT') throw error; snapshot = fresh(); }
    if (snapshot.schemaVersion === 1) {
      const backup = join(directory, 'canvas-v2.pre-v3.json');
      let existing;
      try { existing = await readFile(backup, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing !== undefined && existing !== oldBytes)
        throw new Error('CANVAS_MIGRATION_BACKUP_CONFLICT');
      if (existing === undefined) {
        const file = await open(backup, 'wx', 0o600);
        try { await file.writeFile(oldBytes); await file.sync(); }
        finally { await file.close(); }
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      snapshot.schemaVersion = 2;
      snapshot.authorHistory ??= {};
      snapshot.connectionInventories ??= {};
      const migrated = new CanvasStore(directory, nullRecords(snapshot));
      await migrated.commit(() => {});
      return migrated;
    }
    if (snapshot.schemaVersion !== 2) throw new Error('CANVAS_STORAGE_VERSION_UNSUPPORTED');
    snapshot.authorHistory ??= {};
    snapshot.connectionInventories ??= {};
    return new CanvasStore(directory, nullRecords(snapshot));
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
