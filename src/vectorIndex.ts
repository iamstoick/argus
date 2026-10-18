/** Per-project ANN wrapper: HNSW over stored symbol vectors, persisted in SQLite. */
import type { ArgusDb } from './db.js';
import { HnswIndex } from './hnsw.js';

export type VectorSyncMode = 'none' | 'rebuild' | 'incremental';

/** Yield to the event loop this often while rebuilding large indexes. */
const REBUILD_YIELD_EVERY = 256;

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class VectorIndex {
  private readonly hnsw = new HnswIndex();
  private dim = 0;
  private ready = false;
  private attached = false;
  private lastMode: VectorSyncMode = 'none';
  private syncing = false;
  private resync = false;

  static empty(): VectorIndex {
    return new VectorIndex();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get dimension(): number {
    return this.dim;
  }

  /** True when the graph was restored from SQLite rather than rebuilt. */
  get attachedFromDisk(): boolean {
    return this.attached;
  }

  get lastSyncMode(): VectorSyncMode {
    return this.lastMode;
  }

  get liveNodes(): number {
    return this.hnsw.size;
  }

  /** Full rebuild from stored vectors; persists the graph. */
  async rebuild(db: ArgusDb): Promise<void> {
    const rows = db.symbolVectors();
    this.hnsw.clear();
    this.dim = 0;
    this.attached = false;
    const first = rows[0];
    if (first === undefined) {
      this.ready = true;
      this.lastMode = 'rebuild';
      db.clearVectorIndex();
      return;
    }
    const dim = first.dim;
    let n = 0;
    for (const row of rows) {
      if (row.dim !== dim) continue;
      this.hnsw.insert(row.symbolId, row.vec);
      n += 1;
      if (n % REBUILD_YIELD_EVERY === 0) await yieldToLoop();
    }
    this.dim = dim;
    this.ready = true;
    this.lastMode = 'rebuild';
    db.setVectorIndex(dim, this.hnsw.serialize());
  }

  /**
   * Incremental catch-up: attach the persisted graph on first use, insert new
   * vectors, tombstone removed ones, rebuild on dimension change or tombstone
   * pressure. Coalesces overlapping calls; never runs two syncs at once.
   */
  async sync(db: ArgusDb): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.resync = false;
        await this.syncOnce(db);
      } while (this.resync);
    } finally {
      this.syncing = false;
    }
  }

  private async syncOnce(db: ArgusDb): Promise<void> {
    if (!this.ready) {
      let attached = false;
      try {
        const stored = db.getVectorIndex();
        if (stored !== undefined && stored.dim > 0) {
          const rows = db.symbolVectors().filter((r) => r.dim === stored.dim);
          if (rows.length > 0) {
            this.hnsw.deserialize(stored.payload);
            this.hnsw.attach(new Map(rows.map((r) => [r.symbolId, r.vec] as [number, number[]])));
            this.dim = stored.dim;
            attached = true;
          }
        }
      } catch {
        attached = false;
      }
      this.attached = attached;
      if (!attached) {
        await this.rebuild(db);
        return;
      }
      this.ready = true;
      this.lastMode = 'incremental';
    }
    const ids = new Set(db.vectorIds());
    if (ids.size === 0) {
      this.hnsw.clear();
      this.dim = 0;
      db.clearVectorIndex();
      this.lastMode = 'incremental';
      return;
    }
    const sample = db.vectorById(firstOf(ids));
    if (sample === undefined || sample.dim !== this.dim) {
      await this.rebuild(db);
      return;
    }
    let changed = false;
    for (const id of ids) {
      if (this.hnsw.has(id)) continue;
      const vec = db.vectorById(id);
      if (vec === undefined || vec.dim !== this.dim) continue;
      this.hnsw.insert(id, vec.vec);
      changed = true;
    }
    for (const id of this.hnsw.ids()) {
      if (ids.has(id)) continue;
      this.hnsw.remove(id);
      changed = true;
    }
    if (this.hnsw.needsRebuild) {
      await this.rebuild(db);
      return;
    }
    this.lastMode = 'incremental';
    if (changed) db.setVectorIndex(this.dim, this.hnsw.serialize());
  }

  /**
   * Approximate top-k symbol ids by cosine similarity, excluding ids.
   * Mirrors the brute-force gate (similarity > 0). Undefined when the index
   * is not ready or dims mismatch: callers fall back to brute force.
   */
  search(qvec: readonly number[], k: number, exclude: ReadonlySet<number>): number[] | undefined {
    if (!this.ready || this.dim === 0 || qvec.length !== this.dim || k <= 0) return undefined;
    const out: number[] = [];
    for (const hit of this.hnsw.query(qvec, k + exclude.size)) {
      if (hit.dist >= 1 || exclude.has(hit.id)) continue;
      out.push(hit.id);
      if (out.length >= k) break;
    }
    return out;
  }
}

function firstOf(ids: ReadonlySet<number>): number {
  for (const id of ids) return id;
  return -1;
}
