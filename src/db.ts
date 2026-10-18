/** SQLite storage layer (node:sqlite, embedded). All queries parameterized. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS, type RelationshipType, type SymbolKind } from './config.js';
import type { EmbeddingUsage } from './embeddings.js';

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
CREATE TABLE IF NOT EXISTS symbol_vectors (
  symbol_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tool TEXT NOT NULL,
  mode TEXT,
  results INTEGER,
  chars INTEGER NOT NULL,
  tiers TEXT,
  latency_ms INTEGER NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_query_log_id ON query_log(id);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  files INTEGER NOT NULL,
  symbols INTEGER NOT NULL,
  relationships INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_reports_kind ON audit_reports(kind);
CREATE TABLE IF NOT EXISTS vector_index (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dim INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embedding_usage (
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  texts INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  reported_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (operation, provider, model)
);
`;

/**
 * Lexical search index over names/signatures/docstrings, kept in sync with
 * `symbols` by triggers. Separate from SCHEMA: on builds without FTS5 the
 * table setup throws and the caller falls back to LIKE + edit distance.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, docstring, content='symbols', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, docstring) VALUES (new.id, new.name, new.signature, new.docstring);
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring) VALUES('delete', old.id, old.name, old.signature, old.docstring);
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring) VALUES('delete', old.id, old.name, old.signature, old.docstring);
  INSERT INTO symbols_fts(rowid, name, signature, docstring) VALUES (new.id, new.name, new.signature, new.docstring);
END;
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

export interface SymbolVector {
  symbolId: number;
  dim: number;
  vec: number[];
}

export interface QueryLogEntry {
  tool: string;
  mode?: string | undefined;
  results?: number | undefined;
  chars: number;
  tiers?: Record<string, number> | undefined;
  latencyMs: number;
  degraded?: boolean | undefined;
  error?: boolean | undefined;
}

export interface QueryLogRow {
  id: number;
  ts: string;
  tool: string;
  mode: string | null;
  results: number | null;
  chars: number;
  tiers: Record<string, number> | null;
  latencyMs: number;
  degraded: boolean;
  error: boolean;
}

export interface QueryStats {
  total: number;
  byTool: Record<string, number>;
  avgLatencyMs: number;
  totalChars: number;
  /** Display estimate only (chars / 4): Argus never sees the agent's real token counts. */
  estTokens: number;
  degraded: number;
  errors: number;
}

export type EmbeddingOperation = 'sync' | 'query';

export interface EmbeddingUsageRow {
  operation: EmbeddingOperation;
  provider: string;
  model: string;
  calls: number;
  texts: number;
  chars: number;
  /** Sum of server-reported input tokens (0 when no call reported any). */
  promptTokens: number;
  /** Calls whose server reported a token count. */
  reportedCalls: number;
  /** Display estimate only (chars / 4), for calls without reported counts. */
  estTokens: number;
}

function toEmbeddingUsageRow(value: unknown): EmbeddingUsageRow {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  const operation = reqString(value, 'operation');
  if (operation !== 'sync' && operation !== 'query') throw new Error('DB row: bad embedding operation');
  const chars = reqNumber(value, 'chars');
  return {
    operation,
    provider: reqString(value, 'provider'),
    model: reqString(value, 'model'),
    calls: reqNumber(value, 'calls'),
    texts: reqNumber(value, 'texts'),
    chars,
    promptTokens: reqNumber(value, 'prompt_tokens'),
    reportedCalls: reqNumber(value, 'reported_calls'),
    estTokens: Math.round(chars / LIMITS.charsPerToken),
  };
}

/** Content fingerprint of one symbol; row ids churn on re-parse, so drift keys on path+kind+name. */
export interface SymbolFingerprint {
  path: string;
  kind: string;
  name: string;
  /** 12 hex chars of sha256(signature). */
  sig: string;
}

export interface SnapshotSummary {
  id: number;
  takenAt: string;
  files: number;
  symbols: number;
  relationships: number;
}

export interface AuditReport {
  kind: string;
  takenAt: string;
  payload: unknown;
}

function toAuditReport(value: unknown): AuditReport {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  return { kind: reqString(value, 'kind'), takenAt: reqString(value, 'taken_at'), payload: JSON.parse(reqString(value, 'payload')) as unknown };
}

function toSnapshotSummary(value: unknown): SnapshotSummary {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  return {
    id: reqNumber(value, 'id'),
    takenAt: reqString(value, 'taken_at'),
    files: reqNumber(value, 'files'),
    symbols: reqNumber(value, 'symbols'),
    relationships: reqNumber(value, 'relationships'),
  };
}

function parseFingerprints(payload: string): SymbolFingerprint[] {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) throw new Error('DB row: malformed snapshot payload');
  return parsed.map((item) => {
    if (!isRecord(item)) throw new Error('DB row: malformed snapshot payload');
    return {
      path: reqString(item, 'path'),
      kind: reqString(item, 'kind'),
      name: reqString(item, 'name'),
      sig: reqString(item, 'sig'),
    };
  });
}

function toQueryLogRow(value: unknown): QueryLogRow {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  const mode = value['mode'];
  const results = value['results'];
  const tiersRaw = value['tiers'];
  let tiers: Record<string, number> | null = null;
  if (typeof tiersRaw === 'string') {
    try {
      const parsed = JSON.parse(tiersRaw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        tiers = parsed as Record<string, number>;
      }
    } catch {
      tiers = null;
    }
  }
  return {
    id: reqNumber(value, 'id'),
    ts: reqString(value, 'ts'),
    tool: reqString(value, 'tool'),
    mode: typeof mode === 'string' ? mode : null,
    results: typeof results === 'number' ? results : null,
    chars: reqNumber(value, 'chars'),
    tiers,
    latencyMs: reqNumber(value, 'latency_ms'),
    degraded: reqNumber(value, 'degraded') !== 0,
    error: reqNumber(value, 'error') !== 0,
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

/** Lowercase alphanumeric tokens; FTS5-safe by construction (no syntax chars survive). */
export function lexicalTokens(raw: string): string[] {
  return [...new Set(raw.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

/** Unqualified name (mirrors parser.simpleName without the import). */
function baseName(qualified: string): string {
  const dot = qualified.lastIndexOf('.');
  return dot >= 0 ? qualified.slice(dot + 1) : qualified;
}

/** Typo budget per token: short tokens allow 1 edit, longer ones 2. */
function editBudget(token: string): number {
  return token.length <= 4 ? 1 : 2;
}

/**
 * Levenshtein distance capped at max+1, with early exit. Small names make the
 * full scan cheap; the cap keeps pathological pairs from dominating.
 */
export function cappedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] as number + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] as number;
}

function encodeVector(vec: number[]): Buffer {
  return Buffer.from(new Float64Array(vec).buffer);
}

function decodeVector(value: unknown, dim: number): number[] {
  if (!(value instanceof Uint8Array) || value.byteLength !== dim * 8) {
    throw new Error('DB row: malformed vector blob');
  }
  const view = new Float64Array(value.buffer, value.byteOffset, dim);
  return [...view];
}

function toSymbolVector(value: unknown): SymbolVector {
  if (!isRecord(value)) throw new Error('DB row: expected record');
  const dim = reqNumber(value, 'dim');
  return { symbolId: reqNumber(value, 'symbol_id'), dim, vec: decodeVector(value['vec'], dim) };
}

export class ArgusDb {
  private readonly db: DatabaseSync;
  private ftsReady = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.setupFts();
  }

  private setupFts(): void {
    try {
      // Pre-FTS databases lack the sync triggers: index once after creating
      // them. (COUNT(*) on the FTS table itself is useless here — without a
      // MATCH clause it reads through to the content table.)
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'
           AND name IN ('symbols_fts_ai', 'symbols_fts_ad', 'symbols_fts_au')`,
        )
        .get();
      if (!isRecord(row)) throw new Error('DB row: expected record');
      const hadTriggers = reqNumber(row, 'n');
      this.db.exec(FTS_SCHEMA);
      if (hadTriggers === 0) {
        this.db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
      }
      this.ftsReady = true;
    } catch {
      this.ftsReady = false;
    }
  }

  /** False on SQLite builds without FTS5 (lexical tier degrades to edit distance). */
  get ftsAvailable(): boolean {
    return this.ftsReady;
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

  /** UTC "YYYY-MM-DD HH:MM:SS" of the newest parse, or null when empty. */
  lastParsedAt(): string | null {
    const row = this.db.prepare('SELECT MAX(parsed_at) AS m FROM files').get();
    if (!isRecord(row)) throw new Error('DB row: expected record');
    const value = row['m'];
    return typeof value === 'string' ? value : null;
  }

  countByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind').all()) {
      if (!isRecord(row)) throw new Error('DB row: expected record');
      out[reqString(row, 'kind')] = reqNumber(row, 'n');
    }
    return out;
  }

  /** Every symbol with its file path, for whole-index analyses. */
  allSymbols(): SymbolRow[] {
    return this.db
      .prepare('SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY s.name')
      .all()
      .map(toSymbolRow);
  }

  /** Every distinct recorded callee name (liveness set for dead-code analysis). */
  allCalleeNames(): Set<string> {
    const out = new Set<string>();
    for (const row of this.db.prepare('SELECT DISTINCT callee_name AS n FROM symbol_relationships').all()) {
      if (!isRecord(row)) throw new Error('DB row: expected record');
      out.add(reqString(row, 'n'));
    }
    return out;
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

  /**
   * Lexical tier: FTS5 token/prefix matches over name+signature+docstring
   * (bm25 order), then edit-distance typo matches on names. Never throws on
   * query syntax: tokens are alphanumeric-only by construction.
   */
  searchSymbolsFuzzy(query: string, kind: string | undefined, limit: number): SymbolRow[] {
    const terms = lexicalTokens(query);
    if (terms.length === 0 || limit <= 0) return [];
    const seen = new Map<number, SymbolRow>();
    if (this.ftsReady) {
      try {
        for (const row of this.ftsMatch(terms, kind, limit)) seen.set(row.id, row);
      } catch {
        // Corrupt FTS index: edit distance below still answers.
      }
    }
    for (const row of this.editDistanceMatch(terms, kind, limit, seen)) seen.set(row.id, row);
    return [...seen.values()].slice(0, limit);
  }

  private ftsMatch(terms: string[], kind: string | undefined, limit: number): SymbolRow[] {
    const match = terms.map((t) => `"${t}"*`).join(' OR ');
    const sql = kind === undefined
      ? `SELECT s.*, f.path FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
         JOIN files f ON f.id = s.file_id
         WHERE symbols_fts MATCH ? ORDER BY bm25(symbols_fts) LIMIT ?`
      : `SELECT s.*, f.path FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
         JOIN files f ON f.id = s.file_id
         WHERE symbols_fts MATCH ? AND s.kind = ? ORDER BY bm25(symbols_fts) LIMIT ?`;
    const rows = kind === undefined
      ? this.db.prepare(sql).all(match, limit)
      : this.db.prepare(sql).all(match, kind, limit);
    return rows.map(toSymbolRow);
  }

  private editDistanceMatch(
    terms: string[],
    kind: string | undefined,
    limit: number,
    exclude: ReadonlyMap<number, SymbolRow>,
  ): SymbolRow[] {
    const scored: Array<{ row: SymbolRow; dist: number }> = [];
    for (const row of this.allSymbols()) {
      if (exclude.has(row.id)) continue;
      if (kind !== undefined && row.kind !== kind) continue;
      const candidates = [row.name.toLowerCase(), baseName(row.name).toLowerCase()];
      let best = Number.POSITIVE_INFINITY;
      for (const term of terms) {
        const budget = editBudget(term);
        for (const cand of candidates) {
          // Gate on the per-term budget: cappedEditDistance returns budget+1
          // on overflow, which must not qualify.
          const d = cappedEditDistance(term, cand, budget);
          if (d <= budget && d < best) best = d;
        }
      }
      if (best <= 2) scored.push({ row, dist: best });
    }
    scored.sort(
      (a, b) => a.dist - b.dist || b.row.is_exported - a.row.is_exported || (a.row.name < b.row.name ? -1 : 1),
    );
    return scored.slice(0, limit).map((s) => s.row);
  }

  /** Upsert embedding vectors keyed by symbol id. */
  replaceVectors(rows: SymbolVector[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO symbol_vectors (symbol_id, dim, vec) VALUES (?, ?, ?) ON CONFLICT(symbol_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) stmt.run(r.symbolId, r.dim, encodeVector(r.vec));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  symbolVectors(): SymbolVector[] {
    return this.db.prepare('SELECT symbol_id, dim, vec FROM symbol_vectors').all().map(toSymbolVector);
  }

  vectorById(id: number): SymbolVector | undefined {
    const row = this.db.prepare('SELECT symbol_id, dim, vec FROM symbol_vectors WHERE symbol_id = ?').get(id);
    return row === undefined ? undefined : toSymbolVector(row);
  }

  vectorIds(): number[] {
    const out: number[] = [];
    for (const row of this.db.prepare('SELECT symbol_id AS id FROM symbol_vectors').all()) {
      if (!isRecord(row)) throw new Error('DB row: expected record');
      out.push(reqNumber(row, 'id'));
    }
    return out;
  }

  getVectorIndex(): { dim: number; payload: string } | undefined {
    const row = this.db.prepare('SELECT dim, payload FROM vector_index WHERE id = 1').get();
    if (row === undefined || !isRecord(row)) return undefined;
    return { dim: reqNumber(row, 'dim'), payload: reqString(row, 'payload') };
  }

  setVectorIndex(dim: number, payload: string): void {
    this.db
      .prepare(
        'INSERT INTO vector_index (id, dim, payload) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, payload = excluded.payload',
      )
      .run(dim, payload);
  }

  clearVectorIndex(): void {
    this.db.prepare('DELETE FROM vector_index WHERE id = 1').run();
  }

  countVectors(): number {
    return this.count('SELECT COUNT(*) AS n FROM symbol_vectors');
  }

  /** Drop vectors whose dimension differs (embedding model changed); returns rows cleared. */
  clearVectorDimsExcept(dim: number): number {
    const r = this.db.prepare('DELETE FROM symbol_vectors WHERE dim != ?').run(dim);
    return Number(r.changes ?? 0);
  }

  /** Record one MCP tool call; best-effort callers treat failures as non-fatal. */
  logQuery(entry: QueryLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO query_log (tool, mode, results, chars, tiers, latency_ms, degraded, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool,
        entry.mode ?? null,
        entry.results ?? null,
        Math.max(0, Math.floor(entry.chars)),
        entry.tiers === undefined ? null : JSON.stringify(entry.tiers),
        Math.max(0, Math.floor(entry.latencyMs)),
        entry.degraded === true ? 1 : 0,
        entry.error === true ? 1 : 0,
      );
    this.pruneQueryLog(LIMITS.maxQueryLogRows);
  }

  /** Keep only the newest maxRows telemetry rows; returns rows removed. */
  pruneQueryLog(maxRows: number): number {
    if (maxRows < 1) return 0;
    const r = this.db
      .prepare('DELETE FROM query_log WHERE id NOT IN (SELECT id FROM query_log ORDER BY id DESC LIMIT ?)')
      .run(maxRows);
    return Number(r.changes ?? 0);
  }

  /** Newest telemetry rows first. */
  recentQueries(limit: number): QueryLogRow[] {
    return this.db
      .prepare(
        'SELECT id, ts, tool, mode, results, chars, tiers, latency_ms, degraded, error FROM query_log ORDER BY id DESC LIMIT ?',
      )
      .all(Math.max(0, Math.floor(limit)))
      .map(toQueryLogRow);
  }

  queryStats(): QueryStats {
    const byTool: Record<string, number> = {};
    let total = 0;
    let latencySum = 0;
    let totalChars = 0;
    let degraded = 0;
    let errors = 0;
    for (const row of this.db
      .prepare('SELECT tool, latency_ms, chars, degraded, error FROM query_log')
      .all()) {
      if (!isRecord(row)) throw new Error('DB row: expected record');
      const tool = reqString(row, 'tool');
      byTool[tool] = (byTool[tool] ?? 0) + 1;
      total += 1;
      latencySum += reqNumber(row, 'latency_ms');
      totalChars += reqNumber(row, 'chars');
      if (reqNumber(row, 'degraded') !== 0) degraded += 1;
      if (reqNumber(row, 'error') !== 0) errors += 1;
    }
    return {
      total,
      byTool,
      avgLatencyMs: total === 0 ? 0 : Math.round((latencySum / total) * 10) / 10,
      totalChars,
      estTokens: Math.round(totalChars / LIMITS.charsPerToken),
      degraded,
      errors,
    };
  }

  /** Accumulate one embed call's usage into the per-operation/provider/model counters. */
  addEmbeddingUsage(operation: EmbeddingOperation, usage: EmbeddingUsage): void {
    this.db
      .prepare(
        `INSERT INTO embedding_usage (operation, provider, model, calls, texts, chars, prompt_tokens, reported_calls)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(operation, provider, model) DO UPDATE SET
           calls = calls + 1,
           texts = texts + excluded.texts,
           chars = chars + excluded.chars,
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           reported_calls = reported_calls + excluded.reported_calls`,
      )
      .run(
        operation,
        usage.provider,
        usage.model,
        Math.max(0, Math.floor(usage.inputTexts)),
        Math.max(0, Math.floor(usage.inputChars)),
        usage.promptTokens ?? 0,
        usage.promptTokens === undefined ? 0 : 1,
      );
  }

  /** Cumulative embedding spend, one row per operation/provider/model. */
  embeddingUsageStats(): EmbeddingUsageRow[] {
    return this.db
      .prepare(
        `SELECT operation, provider, model, calls, texts, chars, prompt_tokens, reported_calls
         FROM embedding_usage ORDER BY operation, provider, model`,
      )
      .all()
      .map(toEmbeddingUsageRow);
  }

  /** Capture a structural snapshot of the current index; returns the new id. */
  takeSnapshot(): number {
    const prints: SymbolFingerprint[] = this.allSymbols().map((s) => ({
      path: s.path ?? '(unknown)',
      kind: s.kind,
      name: s.name,
      sig: createHash('sha256').update(s.signature, 'utf8').digest('hex').slice(0, 12),
    }));
    prints.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.name < b.name ? -1 : 1));
    const r = this.db
      .prepare('INSERT INTO snapshots (files, symbols, relationships, payload) VALUES (?, ?, ?, ?)')
      .run(this.countFiles(), this.countSymbols(), this.countRelationships(), JSON.stringify(prints));
    const lastId = r.lastInsertRowid;
    if (typeof lastId !== 'number') throw new Error('DB: missing lastInsertRowid');
    this.db
      .prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)')
      .run(LIMITS.maxSnapshots);
    return lastId;
  }

  /** Newest snapshot summaries first. */
  listSnapshots(limit: number): SnapshotSummary[] {
    return this.db
      .prepare(
        'SELECT id, taken_at, files, symbols, relationships FROM snapshots ORDER BY id DESC LIMIT ?',
      )
      .all(Math.max(0, Math.floor(limit)))
      .map(toSnapshotSummary);
  }

  latestSnapshot(): SnapshotSummary | undefined {
    return this.listSnapshots(1)[0];
  }

  /** Fingerprints for one snapshot, or undefined when the id is unknown. */
  snapshotFingerprints(id: number): SymbolFingerprint[] | undefined {
    const row = this.db.prepare('SELECT payload FROM snapshots WHERE id = ?').get(id);
    if (row === undefined || !isRecord(row)) return undefined;
    return parseFingerprints(reqString(row, 'payload'));
  }

  /** Store one background-audit report; keeps the newest MAX_AUDIT_REPORTS per kind. */
  storeAuditReport(kind: string, payload: unknown): void {
    this.db.prepare('INSERT INTO audit_reports (kind, payload) VALUES (?, ?)').run(kind, JSON.stringify(payload));
    this.db
      .prepare(
        `DELETE FROM audit_reports WHERE kind = ? AND id NOT IN
         (SELECT id FROM audit_reports WHERE kind = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(kind, kind, LIMITS.maxAuditReports);
  }

  /** Latest report per kind, newest first. */
  latestAuditReports(): AuditReport[] {
    return this.db
      .prepare(
        `SELECT kind, taken_at, payload FROM audit_reports
         WHERE id IN (SELECT MAX(id) FROM audit_reports GROUP BY kind)
         ORDER BY taken_at DESC, kind`,
      )
      .all()
      .map(toAuditReport);
  }

  /** Report history for one kind, newest first. */
  auditHistory(kind: string, limit: number): AuditReport[] {
    return this.db
      .prepare('SELECT kind, taken_at, payload FROM audit_reports WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, Math.max(0, Math.floor(limit)))
      .map(toAuditReport);
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
