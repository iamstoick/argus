/** SQLite storage layer (node:sqlite, embedded). All queries parameterized. */
import { DatabaseSync } from 'node:sqlite';
import type { RelationshipType, SymbolKind } from './config.js';

export interface FileRow {
  id: number;
  path: string;
  hash: string;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  signature: string;
  docstring: string | null;
  start_line: number;
  end_line: number;
  is_exported: number;
  path?: string;
}

export interface NewSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  docstring: string | null;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface NewRelationship {
  /** Index into the sibling NewSymbol array. */
  callerIndex: number;
  calleeName: string;
  type: RelationshipType;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  docstring TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  is_exported BOOLEAN NOT NULL DEFAULT 0,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS symbol_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_symbol_id INTEGER NOT NULL,
  callee_name TEXT NOT NULL,
  relationship_type TEXT,
  FOREIGN KEY(caller_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_rel_caller ON symbol_relationships(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_rel_callee ON symbol_relationships(callee_name);
`;

/** node:sqlite returns untyped records; validate shapes at the boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function reqString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new Error(`DB row: expected string at ${key}`);
  return v;
}

function reqNumber(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new Error(`DB row: expected number at ${key}`);
  return v;
}

function toFileRow(value: unknown): FileRow {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  return { id: reqNumber(value, 'id'), path: reqString(value, 'path'), hash: reqString(value, 'hash') };
}

function toSymbolRow(value: unknown): SymbolRow {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  const doc = value['docstring'];
  const path = value['path'];
  return {
    id: reqNumber(value, 'id'),
    file_id: reqNumber(value, 'file_id'),
    name: reqString(value, 'name'),
    kind: reqString(value, 'kind'),
    signature: reqString(value, 'signature'),
    docstring: typeof doc === 'string' ? doc : null,
    start_line: reqNumber(value, 'start_line'),
    end_line: reqNumber(value, 'end_line'),
    is_exported: reqNumber(value, 'is_exported'),
    ...(typeof path === 'string' ? { path } : {}),
  };
}

export interface RelationRow {
  caller_id: number;
  caller_name: string;
  caller_path: string;
  caller_line: number;
  callee_name: string;
  relationship_type: string;
}

function toRelationRow(value: unknown): RelationRow {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  return {
    caller_id: reqNumber(value, 'caller_id'),
    caller_name: reqString(value, 'caller_name'),
    caller_path: reqString(value, 'caller_path'),
    caller_line: reqNumber(value, 'caller_line'),
    callee_name: reqString(value, 'callee_name'),
    relationship_type: reqString(value, 'relationship_type'),
  };
}

/** Escape user input for LIKE patterns (ESCAPE '\'). */
export function escapeLike(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class ArgusDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getFile(path: string): FileRow | undefined {
    const row = this.db.prepare('SELECT id, path, hash FROM files WHERE path = ?').get(path);
    return row === undefined ? undefined : toFileRow(row);
  }

  listFiles(): FileRow[] {
    return this.db.prepare('SELECT id, path, hash FROM files').all().map(toFileRow);
  }

  countSymbols(): number {
    return this.count('SELECT COUNT(*) AS n FROM symbols');
  }

  countFiles(): number {
    return this.count('SELECT COUNT(*) AS n FROM files');
  }

  countRelationships(): number {
    return this.count('SELECT COUNT(*) AS n FROM symbol_relationships');
  }

  private count(sql: string): number {
    const row = this.db.prepare(sql).get();
    if (!isRecord(row)) throw new Error('DB row: expected record');
    return reqNumber(row, 'n');
  }

  /**
   * Atomically replace one file's symbols + relationships.
   * Callers outside a file replace must not interleave; single-writer process.
   */
  replaceFile(path: string, hash: string, symbols: NewSymbol[], rels: NewRelationship[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO files (path, hash) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, parsed_at = CURRENT_TIMESTAMP`,
    );
    const getId = this.db.prepare('SELECT id FROM files WHERE path = ?');
    const delSyms = this.db.prepare('DELETE FROM symbols WHERE file_id = ?');
    const insSym = this.db.prepare(
      `INSERT INTO symbols (file_id, name, kind, signature, docstring, start_line, end_line, is_exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRel = this.db.prepare(
      `INSERT INTO symbol_relationships (caller_symbol_id, callee_name, relationship_type)
       VALUES (?, ?, ?)`,
    );

    const txn = (): void => {
      upsert.run(path, hash);
      const idRow = getId.get(path);
      if (!isRecord(idRow)) throw new Error('DB: file row missing after upsert');
      const fileId = reqNumber(idRow, 'id');
      delSyms.run(fileId);
      const ids: number[] = [];
      for (const s of symbols) {
        const r = insSym.run(
          fileId,
          s.name,
          s.kind,
          s.signature,
          s.docstring,
          s.startLine,
          s.endLine,
          s.isExported ? 1 : 0,
        );
        const lastId = r.lastInsertRowid;
        if (typeof lastId !== 'number') throw new Error('DB: missing lastInsertRowid');
        ids.push(lastId);
      }
      const seen = new Set<string>();
      for (const rel of rels) {
        const callerId = ids[rel.callerIndex];
        if (callerId === undefined) continue;
        const key = `${callerId}→${rel.type}:${rel.calleeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insRel.run(callerId, rel.calleeName, rel.type);
      }
    };

    // node:sqlite has no transaction helper; use explicit SQL.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      txn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteFile(path: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  searchSymbols(query: string, kind: string | undefined, limit: number): SymbolRow[] {
    const like = `%${escapeLike(query)}%`;
    const sql = kind === undefined
      ? `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\')
         ORDER BY s.is_exported DESC, s.name LIMIT ?`
      : `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\') AND s.kind = ?
         ORDER BY s.is_exported DESC, s.name LIMIT ?`;
    const rows = kind === undefined
      ? this.db.prepare(sql).all(like, like, limit)
      : this.db.prepare(sql).all(like, like, kind, limit);
    return rows.map(toSymbolRow);
  }

  exportedSymbolsByFile(prefix: string | undefined, limit: number): SymbolRow[] {
    const sql = prefix === undefined
      ? `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1 ORDER BY f.path, s.start_line LIMIT ?`
      : `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1 AND f.path LIKE ? ESCAPE '\\' ORDER BY f.path, s.start_line LIMIT ?`;
    const rows = prefix === undefined
      ? this.db.prepare(sql).all(limit)
      : this.db.prepare(sql).all(`${escapeLike(prefix)}%`, limit);
    return rows.map(toSymbolRow);
  }

  symbolById(id: number): SymbolRow | undefined {
    const row = this.db
      .prepare('SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?')
      .get(id);
    return row === undefined ? undefined : toSymbolRow(row);
  }

  symbolsByNameExact(name: string): SymbolRow[] {
    return this.db
      .prepare('SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY f.path, s.start_line')
      .all(name)
      .map(toSymbolRow);
  }

  symbolsByNameLike(name: string, limit: number): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? ESCAPE '\\' ORDER BY s.is_exported DESC, s.name LIMIT ?`,
      )
      .all(`%${escapeLike(name)}%`, limit)
      .map(toSymbolRow);
  }

  outgoing(callerIds: number[]): RelationRow[] {
    if (callerIds.length === 0) return [];
    const placeholders = callerIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT r.caller_symbol_id AS caller_id, s.name AS caller_name, f.path AS caller_path,
                s.start_line AS caller_line, r.callee_name, r.relationship_type
         FROM symbol_relationships r
         JOIN symbols s ON s.id = r.caller_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE r.caller_symbol_id IN (${placeholders})
         ORDER BY r.callee_name`,
      )
      .all(...callerIds)
      .map(toRelationRow);
  }

  incoming(calleeName: string, limit: number): RelationRow[] {
    return this.db
      .prepare(
        `SELECT r.caller_symbol_id AS caller_id, s.name AS caller_name, f.path AS caller_path,
                s.start_line AS caller_line, r.callee_name, r.relationship_type
         FROM symbol_relationships r
         JOIN symbols s ON s.id = r.caller_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE r.callee_name = ? ORDER BY f.path, s.start_line LIMIT ?`,
      )
      .all(calleeName, limit)
      .map(toRelationRow);
  }
}
