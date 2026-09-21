/** Differential indexer: SHA-256 delta detection, full sync, live watcher. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { DB_FILENAME, EXTENSION_LANGUAGE, IGNORE_DIRS } from './config.js';
import { ArgusDb, type NewRelationship, type NewSymbol } from './db.js';
import type { ParserEngine } from './parser.js';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function toRelPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

export function isIndexable(fileName: string): boolean {
  return EXTENSION_LANGUAGE.has(extname(fileName).toLowerCase());
}

/** Recursively collect indexable files, skipping ignored dirs and the DB itself. */
export function collectFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable dir: skip, don't fail the sync.
    }
    for (const entry of entries) {
      if (entry.name === DB_FILENAME || entry.name === `${DB_FILENAME}-wal` || entry.name === `${DB_FILENAME}-shm`) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.isSymbolicLink()) stack.push(full);
      } else if (entry.isFile() && isIndexable(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

export interface IndexStats {
  scanned: number;
  updated: number;
  removed: number;
  skipped: number;
  failed: string[];
}

/** Index one file if its hash changed. Returns 'updated' | 'unchanged' | 'failed'. */
export function indexFile(
  db: ArgusDb,
  engine: ParserEngine,
  root: string,
  absPath: string,
): 'updated' | 'unchanged' | 'failed' {
  let content: string;
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return 'failed';
    content = readFileSync(absPath, 'utf8');
  } catch {
    return 'failed';
  }
  const rel = toRelPath(root, absPath);
  const hash = sha256Hex(content);
  if (db.getFile(rel)?.hash === hash) return 'unchanged';
  const parsed = engine.parseFile(absPath, content);
  if (!parsed.ok) {
    // Parse failures still record the hash so one bad file doesn't retry forever;
    // symbols are cleared. Removal of the record happens only on file delete.
    db.replaceFile(rel, hash, [], []);
    return 'failed';
  }
  const symbols: NewSymbol[] = parsed.symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    signature: s.signature,
    docstring: s.docstring,
    startLine: s.startLine,
    endLine: s.endLine,
    isExported: s.isExported,
  }));
  const rels: NewRelationship[] = [];
  parsed.symbols.forEach((s, callerIndex) => {
    for (const c of s.calls) rels.push({ callerIndex, calleeName: c.callee, type: c.type });
  });
  db.replaceFile(rel, hash, symbols, rels);
  return 'updated';
}

/** Full scan with hash-delta: only changed files are re-parsed. Stale rows removed. */
export function syncRoot(db: ArgusDb, engine: ParserEngine, root: string): IndexStats {
  const stats: IndexStats = { scanned: 0, updated: 0, removed: 0, skipped: 0, failed: [] };
  const files = collectFiles(root);
  const seen = new Set<string>();
  for (const absPath of files) {
    stats.scanned += 1;
    seen.add(toRelPath(root, absPath));
    const outcome = indexFile(db, engine, root, absPath);
    if (outcome === 'updated') stats.updated += 1;
    else if (outcome === 'unchanged') stats.skipped += 1;
    else stats.failed.push(toRelPath(root, absPath));
  }
  for (const row of db.listFiles()) {
    if (!seen.has(row.path)) {
      db.deleteFile(row.path);
      stats.removed += 1;
    }
  }
  return stats;
}

export interface WatchHandle {
  watcher: FSWatcher;
  ready: Promise<void>;
}

/** Live recorder: re-index on add/change, cascade-delete on unlink. */
export function watchRoot(
  db: ArgusDb,
  engine: ParserEngine,
  root: string,
  onError?: (err: unknown) => void,
): WatchHandle {
  const watcher = watch(root, {
    ignored: (path: string, stats) => {
      const base = path.split(sep).pop() ?? path;
      if (base === DB_FILENAME || base === `${DB_FILENAME}-wal` || base === `${DB_FILENAME}-shm`) return true;
      if (stats?.isDirectory() === true) return IGNORE_DIRS.has(base);
      if (stats?.isFile() === true) return !isIndexable(base);
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => resolve());
  });

  const reindex = (absPath: string): void => {
    try {
      indexFile(db, engine, root, absPath);
    } catch (err) {
      onError?.(err);
    }
  };
  watcher.on('add', reindex).on('change', reindex);
  watcher.on('unlink', (absPath: string) => {
    try {
      db.deleteFile(toRelPath(root, absPath));
    } catch (err) {
      onError?.(err);
    }
  });
  watcher.on('error', (err: unknown) => onError?.(err));
  return { watcher, ready };
}
