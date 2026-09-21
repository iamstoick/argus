/** Multi-project core: one isolated index (DB + watcher) per project, one shared engine. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { DB_FILENAME, type ProjectSpec } from './config.js';
import { ArgusDb } from './db.js';
import { syncRoot, watchRoot, type IndexStats } from './indexer.js';
import type { ParserEngine } from './parser.js';

export interface ProjectEntry {
  name: string;
  root: string;
  db: ArgusDb;
  watching: boolean;
  lastSync: IndexStats | undefined;
}

export interface ProjectStats {
  name: string;
  root: string;
  files: number;
  symbols: number;
  relationships: number;
  watching: boolean;
  lastSync: IndexStats | undefined;
}

export type ProjectResolution =
  | { entry: ProjectEntry }
  | { error: string };

/**
 * Owns N isolated project indexes. Each project keeps its own SQLite file and
 * watcher; the tree-sitter engine is shared (grammars load once).
 */
export class IndexManager {
  private readonly projects = new Map<string, ProjectEntry>();
  private readonly watchers: FSWatcher[] = [];

  private constructor(entries: ProjectEntry[]) {
    for (const e of entries) this.projects.set(e.name, e);
  }

  static async open(
    specs: ProjectSpec[],
    engine: ParserEngine,
    opts: { watch: boolean; onError: (msg: string) => void },
  ): Promise<IndexManager> {
    const manager = new IndexManager([]);
    try {
      for (const spec of specs) {
        manager.openOne(spec, engine, opts);
      }
    } catch (err) {
      await manager.close();
      throw err;
    }
    return manager;
  }

  private openOne(
    spec: ProjectSpec,
    engine: ParserEngine,
    opts: { watch: boolean; onError: (msg: string) => void },
  ): void {
    let stat;
    try {
      stat = statSync(spec.path);
    } catch {
      throw new Error(`project '${spec.name}': path does not exist: ${spec.path}`);
    }
    if (!stat.isDirectory()) throw new Error(`project '${spec.name}': not a directory: ${spec.path}`);
    if (this.projects.has(spec.name)) throw new Error(`project '${spec.name}': duplicate name`);
    for (const existing of this.projects.values()) {
      if (existing.root === spec.path) throw new Error(`project '${spec.name}': duplicate path ${spec.path}`);
    }
    const db = new ArgusDb(join(spec.path, DB_FILENAME));
    const entry: ProjectEntry = { name: spec.name, root: spec.path, db, watching: false, lastSync: undefined };
    try {
      entry.lastSync = syncRoot(db, engine, spec.path);
    } catch (err) {
      db.close();
      throw new Error(
        `project '${spec.name}': initial sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (opts.watch) {
      const handle = watchRoot(db, engine, spec.path, (err) => {
        opts.onError(`project '${spec.name}': ${err instanceof Error ? err.message : String(err)}`);
      });
      this.watchers.push(handle.watcher);
      entry.watching = true;
    }
    this.projects.set(spec.name, entry);
  }

  names(): string[] {
    return [...this.projects.keys()];
  }

  get(name: string): ProjectEntry | undefined {
    return this.projects.get(name);
  }

  /**
   * Resolve a tool/API project selector. With a single project the selector is
   * optional; with several it is required (no silent cross-project reads).
   */
  resolve(rawName: string | undefined): ProjectResolution {
    const name = rawName?.trim() === '' ? undefined : rawName?.trim();
    if (name === undefined) {
      if (this.projects.size === 1) {
        const only = [...this.projects.values()][0];
        if (only !== undefined) return { entry: only };
      }
      return { error: `Pass "project" (one of: ${this.names().join(', ')}).` };
    }
    const entry = this.projects.get(name);
    if (entry === undefined) return { error: `Unknown project '${name}' (one of: ${this.names().join(', ')}).` };
    return { entry };
  }

  stats(name: string): ProjectStats | undefined {
    const entry = this.projects.get(name);
    if (entry === undefined) return undefined;
    return {
      name: entry.name,
      root: entry.root,
      files: entry.db.countFiles(),
      symbols: entry.db.countSymbols(),
      relationships: entry.db.countRelationships(),
      watching: entry.watching,
      lastSync: entry.lastSync,
    };
  }

  allStats(): ProjectStats[] {
    return this.names().map((n) => this.stats(n)).filter((s): s is ProjectStats => s !== undefined);
  }

  async close(): Promise<void> {
    for (const w of this.watchers) {
      try {
        await w.close();
      } catch {
        // Best effort on shutdown.
      }
    }
    this.watchers.length = 0;
    for (const entry of this.projects.values()) entry.db.close();
    this.projects.clear();
  }
}
