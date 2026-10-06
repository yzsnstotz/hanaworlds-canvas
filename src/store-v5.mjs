import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fresh = () => ({ schemaVersion: 5, sessions: {}, connections: {},
  connectionInventories: {}, objects: {},
  footprints: {}, registryRevisions: {}, worldRevisions: {}, placementSettings: {},
  placementInspections: {}, analyses: {}, transactions: {},
  history: {}, replay: {}, pending: {} });

/** One writer per local profile. An fsynced rename is the durable commit point. */
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
    try { snapshot = JSON.parse(await readFile(join(directory, 'canvas-v5.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; snapshot = fresh(); }
    if (snapshot.schemaVersion !== 5) throw new Error('CANVAS_STORAGE_VERSION_UNSUPPORTED');
    return new this(directory, snapshot);
  }
  async commit(change) {
    const operation = this.busy.then(async () => {
      if (this.unavailable) throw new Error('CANVAS_STORAGE_UNAVAILABLE');
      const next = structuredClone(this.snapshot);
      const result = await change(next);
      const temporary = join(this.directory, `.canvas-v5-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(this.directory, 'canvas-v5.json'));
        renamed = true;
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        this.snapshot = next;
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
