/** MCP tool implementations (pure handlers over db + workspace root). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYMBOL_KINDS, clampLimit, truncateOutput } from './config.js';
import { ArgusDb, type RelationRow, type SymbolRow } from './db.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';
import { simpleName } from './parser.js';

export interface LookupArgs {
  query: string;
  kind?: string | undefined;
  limit?: number | undefined;
}

export function lookupDictionary(db: ArgusDb, args: LookupArgs): string {
  const query = args.query.trim();
  if (query === '') return 'Empty query: pass a symbol name fragment to search for.';
  if (args.kind !== undefined && !SYMBOL_KINDS.has(args.kind)) {
    return `Unknown kind '${args.kind}'. Valid kinds: ${[...SYMBOL_KINDS].join(', ')}.`;
  }
  const limit = clampLimit(args.limit);
  const rows = db.searchSymbols(query, args.kind, limit + 1);
  if (rows.length === 0) {
    return `No symbols matching '${query}'${args.kind ? ` (kind=${args.kind})` : ''}. Safe to create.`;
  }
  const lines = rows.slice(0, limit).map((r) => formatSymbolLine(r));
  let out = `Found ${rows.length > limit ? `>${limit}` : rows.length} symbol(s) matching '${query}':\n${lines.join('\n')}`;
  if (rows.length > limit) out += `\n…more than ${limit} matches; narrow the query.`;
  return truncateOutput(out);
}

/**
 * Hybrid cascade: exact substring matches first, then lexical-similar
 * (FTS5 tokens + typo tolerance), then semantic-similar when a provider is
 * configured. Each tier only adds ids the earlier tiers missed.
 */
export async function lookupDictionaryHybrid(
  db: ArgusDb,
  args: LookupArgs,
  embeddings?: EmbeddingProvider | undefined,
): Promise<string> {
  const query = args.query.trim();
  if (query === '') return 'Empty query: pass a symbol name fragment to search for.';
  if (args.kind !== undefined && !SYMBOL_KINDS.has(args.kind)) {
    return `Unknown kind '${args.kind}'. Valid kinds: ${[...SYMBOL_KINDS].join(', ')}.`;
  }
  const limit = clampLimit(args.limit);
  const exact = db.searchSymbols(query, args.kind, limit + 1);
  const seen = new Set(exact.map((r) => r.id));
  const lexical = db.searchSymbolsFuzzy(query, args.kind, limit + 1).filter((r) => !seen.has(r.id));
  for (const r of lexical) seen.add(r.id);
  let semantic: SymbolRow[] = [];
  let degraded = false;
  if (embeddings !== undefined) {
    try {
      semantic = await semanticMatches(db, embeddings, query, args.kind, limit + 1, seen);
    } catch {
      degraded = true;
    }
  }
  const similarCount = lexical.length + semantic.length;
  if (exact.length === 0 && similarCount === 0) {
    return `No symbols matching '${query}'${args.kind ? ` (kind=${args.kind})` : ''}. Safe to create.`;
  }
  let budget = limit;
  const exactShown = exact.slice(0, budget);
  budget -= exactShown.length;
  const lexShown = lexical.slice(0, budget);
  budget -= lexShown.length;
  const semShown = semantic.slice(0, budget);
  const cut = exact.length > exactShown.length || lexical.length > lexShown.length || semantic.length > semShown.length;
  const lines: string[] = [];
  if (exactShown.length > 0) {
    lines.push(
      similarCount === 0 && !cut
        ? `Found ${exact.length} symbol(s) matching '${query}':`
        : `Found ${exact.length + similarCount} symbol(s) matching '${query}' (${exact.length} exact + ${similarCount} similar):`,
    );
    lines.push(...exactShown.map(formatSymbolLine));
  } else {
    lines.push(`No exact matches for '${query}'; ${similarCount} similar:`);
  }
  if (lexShown.length > 0) {
    lines.push('--- similar (lexical) ---', ...lexShown.map(formatSymbolLine));
  }
  if (semShown.length > 0) {
    lines.push('--- similar (semantic) ---', ...semShown.map(formatSymbolLine));
  }
  if (cut) lines.push(`…more than ${limit} matches; narrow the query.`);
  if (degraded) lines.push('(semantic tier unavailable: embedding provider failed)');
  return truncateOutput(lines.join('\n'));
}

/** Top cosine-similar symbols with positive similarity, excluding seen ids. */
async function semanticMatches(
  db: ArgusDb,
  provider: EmbeddingProvider,
  query: string,
  kind: string | undefined,
  limit: number,
  exclude: ReadonlySet<number>,
): Promise<SymbolRow[]> {
  const [qvec] = await provider.embed([query]);
  if (qvec === undefined || qvec.length === 0) return [];
  const scored: Array<{ id: number; sim: number }> = [];
  for (const v of db.symbolVectors()) {
    if (v.dim !== qvec.length || exclude.has(v.symbolId)) continue;
    const sim = cosineSimilarity(qvec, v.vec);
    if (sim > 0) scored.push({ id: v.symbolId, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const out: SymbolRow[] = [];
  for (const s of scored.slice(0, limit)) {
    const row = db.symbolById(s.id);
    if (row === undefined) continue;
    if (kind !== undefined && row.kind !== kind) continue;
    out.push(row);
  }
  return out;
}

export interface MapArgs {
  module_path?: string | undefined;
  limit?: number | undefined;
}

export function getCodebaseMap(db: ArgusDb, args: MapArgs): string {
  const limit = clampLimit(args.limit);
  const prefix = args.module_path?.trim() === '' ? undefined : args.module_path?.trim();
  const rows = db.exportedSymbolsByFile(prefix, limit + 1);
  if (rows.length === 0) {
    return prefix === undefined
      ? 'Index is empty: no exported symbols found. The workspace may still be syncing.'
      : `No exported symbols under '${prefix}'.`;
  }
  const shown = rows.slice(0, limit);
  const lines: string[] = [];
  let currentFile = '';
  for (const r of shown) {
    if (r.path !== currentFile) {
      currentFile = r.path ?? '(unknown)';
      lines.push(`${currentFile}:`);
    }
    lines.push(`  [${r.kind}] ${r.name} — ${r.signature}`);
  }
  let out = `Codebase map${prefix ? ` for '${prefix}'` : ''} (${shown.length} exported symbol(s)):\n${lines.join('\n')}`;
  if (rows.length > limit) out += `\n…more than ${limit} symbols; pass module_path to narrow.`;
  return truncateOutput(out);
}

export interface DetailsArgs {
  symbol_id?: number | undefined;
  symbol_name?: string | undefined;
}

export function getSymbolDetails(db: ArgusDb, root: string, args: DetailsArgs): string {
  const resolved = resolveSymbol(db, args);
  if (typeof resolved === 'string') return resolved;
  const row = resolved;
  if (row.path === undefined) return `Symbol #${row.id} has no file path.`;
  const block = symbolCodeBlock(root, row);
  if (block === undefined) {
    return `Symbol #${row.id} (${row.name}) points at ${row.path}, which is no longer readable. Re-sync the index.`;
  }
  return truncateOutput(
    `#${row.id} ${row.name} [${row.kind}] ${row.path}:${row.start_line}-${row.end_line}\n\`\`\`\n${block}\n\`\`\``,
  );
}

/** Exact source lines for a symbol row, or undefined when the file is unreadable. */
export function symbolCodeBlock(root: string, row: SymbolRow): string | undefined {
  if (row.path === undefined) return undefined;
  let source: string;
  try {
    source = readFileSync(join(root, row.path), 'utf8');
  } catch {
    return undefined;
  }
  const lines = source.split('\n');
  const start = Math.max(0, row.start_line - 1);
  const end = Math.min(lines.length, row.end_line);
  return lines.slice(start, end).join('\n');
}

export interface BlastArgs {
  symbol_name: string;
  limit?: number | undefined;
}

export interface BlastData {
  matched: SymbolRow[];
  outgoing: RelationRow[];
  incoming: RelationRow[];
  incomingTruncated: boolean;
}

/** Structured blast radius shared by the MCP tool and the admin JSON API. */
export function blastRadiusData(db: ArgusDb, rawName: string, rawLimit: number | undefined): BlastData | { error: string } {
  const name = rawName.trim();
  if (name === '') return { error: 'Empty symbol_name: pass the symbol to trace.' };
  const limit = clampLimit(rawLimit);
  const targets = db.symbolsByNameExact(name);
  const matched = targets.length > 0 ? targets : db.symbolsByNameLike(name, 5);
  if (matched.length === 0) return { error: `No symbol matching '${name}'.` };
  const ids = matched.map((r) => r.id);
  const outgoing = db.outgoing(ids).slice(0, limit);
  const incomingSeen = new Set<string>();
  const incoming: RelationRow[] = [];
  for (const simple of new Set(matched.map((r) => simpleName(r.name)))) {
    for (const rel of db.incoming(simple, limit)) {
      const key = `${rel.caller_id}:${rel.relationship_type}`;
      if (incomingSeen.has(key)) continue;
      incomingSeen.add(key);
      incoming.push(rel);
      if (incoming.length >= limit) break;
    }
    if (incoming.length >= limit) break;
  }
  return { matched, outgoing, incoming, incomingTruncated: incoming.length >= limit };
}

export function checkBlastRadius(db: ArgusDb, args: BlastArgs): string {
  const data = blastRadiusData(db, args.symbol_name, args.limit);
  if ('error' in data) return data.error;
  const out: string[] = [];
  out.push(`Blast radius for '${args.symbol_name.trim()}' (${data.matched.length} matched symbol(s)):`);
  for (const r of data.matched.slice(0, 5)) {
    out.push(`  #${r.id} ${r.name} [${r.kind}] ${r.path}:${r.start_line}`);
  }
  out.push('', `Outgoing dependencies (${data.outgoing.length}):`);
  if (data.outgoing.length === 0) out.push('  (none recorded)');
  for (const rel of data.outgoing) {
    out.push(
      `  ${rel.caller_name} --${rel.relationship_type}--> ${rel.callee_name} (${rel.caller_path}:${rel.caller_line})`,
    );
  }
  out.push('', `Incoming dependents (${data.incoming.length}${data.incomingTruncated ? '+' : ''}):`);
  if (data.incoming.length === 0) out.push('  (none recorded)');
  for (const rel of data.incoming) {
    out.push(
      `  ${rel.caller_name} --${rel.relationship_type}--> ${rel.callee_name} (${rel.caller_path}:${rel.caller_line})`,
    );
  }
  return truncateOutput(out.join('\n'));
}

/** Resolve a symbol reference to a row, or an explanatory message. */
function resolveSymbol(db: ArgusDb, args: DetailsArgs): SymbolRow | string {
  if (args.symbol_id !== undefined) {
    if (!Number.isInteger(args.symbol_id) || args.symbol_id <= 0) {
      return 'Invalid symbol_id: pass a positive integer.';
    }
    const row = db.symbolById(args.symbol_id);
    return row ?? `No symbol with id ${args.symbol_id}.`;
  }
  if (args.symbol_name === undefined || args.symbol_name.trim() === '') {
    return 'Pass symbol_id or symbol_name.';
  }
  const name = args.symbol_name.trim();
  const exact = db.symbolsByNameExact(name);
  if (exact.length === 1) {
    const row = exact[0];
    if (row !== undefined) return row;
  } else if (exact.length > 1) {
    return (
      `Ambiguous name '${name}' (${exact.length} matches); refine with symbol_id:\n` +
      exact.slice(0, 20).map(candidateLine).join('\n')
    );
  }
  const like = db.symbolsByNameLike(name, 21);
  if (like.length === 0) return `No symbol named '${name}'.`;
  const first = like[0];
  if (like.length === 1 && first !== undefined) return first;
  return `No exact match for '${name}'; closest (${like.length}):\n${like.slice(0, 20).map(candidateLine).join('\n')}`;
}

function candidateLine(r: SymbolRow): string {
  return `  #${r.id} ${r.name} [${r.kind}] ${r.path}:${r.start_line}`;
}

export interface DuplicateGroup {
  /** Normalized name the members share. */
  key: string;
  symbols: SymbolRow[];
}

export interface DuplicatesData {
  groups: DuplicateGroup[];
  truncated: boolean;
}

/** Kinds eligible for duplicate detection; methods are excluded (same name across classes is polymorphism, not copying). */
const DUPLICATE_KINDS: ReadonlySet<string> = new Set([
  'function',
  'class',
  'interface',
  'struct',
  'enum',
  'trait',
  'type',
  'module',
]);

function normalizeName(simple: string): string {
  return simple.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSignature(signature: string): string {
  return signature.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Copy-paste candidates: same normalized name AND signature, distinct declarations. */
export function duplicateGroupsData(db: ArgusDb, rawLimit: number | undefined): DuplicatesData {
  const limit = clampLimit(rawLimit);
  const buckets = new Map<string, SymbolRow[]>();
  for (const row of db.allSymbols()) {
    if (!DUPLICATE_KINDS.has(row.kind)) continue;
    const key = `${normalizeName(simpleName(row.name))}||${normalizeSignature(row.signature)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const first = members[0];
    if (first === undefined) continue;
    groups.push({ key: normalizeName(simpleName(first.name)), symbols: members });
  }
  groups.sort((a, b) => b.symbols.length - a.symbols.length || (a.key < b.key ? -1 : 1));
  return { groups: groups.slice(0, limit), truncated: groups.length > limit };
}

export interface DuplicatesArgs {
  limit?: number | undefined;
}

export function findDuplicates(db: ArgusDb, args: DuplicatesArgs): string {
  const data = duplicateGroupsData(db, args.limit);
  if (data.groups.length === 0) return 'No likely duplicates found.';
  const lines: string[] = [`Found ${data.groups.length} duplicate group(s):`];
  for (const g of data.groups) {
    lines.push(`'${g.key}' (${g.symbols.length} copies):`);
    for (const s of g.symbols) {
      lines.push(`  #${s.id} ${s.name} [${s.kind}] ${s.path}:${s.start_line}`);
    }
  }
  if (data.truncated) lines.push('…more groups exist; raise the limit.');
  return truncateOutput(lines.join('\n'));
}

export interface DeadCodeData {
  symbols: SymbolRow[];
  truncated: boolean;
}

/** Implicitly-invoked names that never appear as call targets (conservative: never reported dead). */
const ENTRY_NAMES: ReadonlySet<string> = new Set(['main', 'constructor', '__construct', '__init__', 'initialize']);

function isEntryish(simple: string): boolean {
  if (ENTRY_NAMES.has(simple)) return true;
  return /^__[a-zA-Z0-9_]+__$/.test(simple);
}

/**
 * Symbols nothing calls. Conservative by construction: callee matching uses
 * simple names, so any same-named call keeps a symbol alive. Framework entry
 * points wired by decorator (route handlers) can still appear dead — review
 * before deleting.
 */
export function deadCodeData(
  db: ArgusDb,
  rawIncludeExported: boolean | undefined,
  rawLimit: number | undefined,
): DeadCodeData {
  const limit = clampLimit(rawLimit);
  const includeExported = rawIncludeExported === true;
  const callees = db.allCalleeNames();
  const dead = db
    .allSymbols()
    .filter((s) => {
      if (!includeExported && s.is_exported === 1) return false;
      const simple = simpleName(s.name);
      if (isEntryish(simple)) return false;
      return !callees.has(simple);
    })
    .sort((a, b) => {
      const pa = a.path ?? '';
      const pb = b.path ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : a.start_line - b.start_line;
    });
  return { symbols: dead.slice(0, limit), truncated: dead.length > limit };
}

export interface DeadCodeArgs {
  include_exported?: boolean | undefined;
  limit?: number | undefined;
}

export function findDeadCode(db: ArgusDb, args: DeadCodeArgs): string {
  const data = deadCodeData(db, args.include_exported, args.limit);
  if (data.symbols.length === 0) {
    return args.include_exported === true
      ? 'No dead code found (including exported symbols).'
      : 'No dead code found among unexported symbols. Pass include_exported to also scan the public surface.';
  }
  const lines: string[] = [
    `Found ${data.symbols.length} possibly-dead symbol(s)${data.truncated ? ' (truncated)' : ''}:`,
    ...data.symbols.map((s) => `- #${s.id} ${s.name} [${s.kind}]${s.is_exported === 1 ? ' ✓exported' : ''} ${s.path}:${s.start_line}`),
    'Review before deleting: framework entry points (e.g. route handlers) can appear dead.',
  ];
  if (data.truncated) lines.push('…more exist; raise the limit.');
  return truncateOutput(lines.join('\n'));
}

function formatSymbolLine(r: SymbolRow): string {
  const doc = r.docstring !== null && r.docstring !== '' ? ` — ${r.docstring}` : '';
  const exp = r.is_exported === 1 ? ' ✓exported' : '';
  return `- #${r.id} ${r.name} [${r.kind}]${exp} ${r.path}:${r.start_line}\n  ${r.signature}${doc}`;
}
