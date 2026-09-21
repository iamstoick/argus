/** MCP tool implementations (pure handlers over db + workspace root). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYMBOL_KINDS, clampLimit, truncateOutput } from './config.js';
import { ArgusDb, type SymbolRow } from './db.js';
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
  let source: string;
  try {
    source = readFileSync(join(root, row.path), 'utf8');
  } catch {
    return `Symbol #${row.id} (${row.name}) points at ${row.path}, which is no longer readable. Re-sync the index.`;
  }
  const lines = source.split('\n');
  const start = Math.max(0, row.start_line - 1);
  const end = Math.min(lines.length, row.end_line);
  const block = lines.slice(start, end).join('\n');
  return truncateOutput(
    `#${row.id} ${row.name} [${row.kind}] ${row.path}:${row.start_line}-${row.end_line}\n\`\`\`\n${block}\n\`\`\``,
  );
}

export interface BlastArgs {
  symbol_name: string;
  limit?: number | undefined;
}

export function checkBlastRadius(db: ArgusDb, args: BlastArgs): string {
  const name = args.symbol_name.trim();
  if (name === '') return 'Empty symbol_name: pass the symbol to trace.';
  const limit = clampLimit(args.limit);
  const targets = db.symbolsByNameExact(name);
  const resolved = targets.length > 0 ? targets : db.symbolsByNameLike(name, 5);
  if (resolved.length === 0) return `No symbol matching '${name}'.`;
  const ids = resolved.map((r) => r.id);
  const simpleTargets = new Set(resolved.map((r) => simpleName(r.name)));

  const out: string[] = [];
  out.push(`Blast radius for '${name}' (${resolved.length} matched symbol(s)):`);
  for (const r of resolved.slice(0, 5)) {
    out.push(`  #${r.id} ${r.name} [${r.kind}] ${r.path}:${r.start_line}`);
  }

  const outgoing = db.outgoing(ids).slice(0, limit);
  out.push('', `Outgoing dependencies (${outgoing.length}):`);
  if (outgoing.length === 0) out.push('  (none recorded)');
  for (const rel of outgoing) {
    out.push(
      `  ${rel.caller_name} --${rel.relationship_type}--> ${rel.callee_name} (${rel.caller_path}:${rel.caller_line})`,
    );
  }

  const incomingSeen = new Set<string>();
  const incomingLines: string[] = [];
  for (const simple of simpleTargets) {
    for (const rel of db.incoming(simple, limit)) {
      const key = `${rel.caller_id}:${rel.relationship_type}`;
      if (incomingSeen.has(key)) continue;
      incomingSeen.add(key);
      incomingLines.push(
        `  ${rel.caller_name} --${rel.relationship_type}--> ${rel.callee_name} (${rel.caller_path}:${rel.caller_line})`,
      );
      if (incomingLines.length >= limit) break;
    }
    if (incomingLines.length >= limit) break;
  }
  out.push('', `Incoming dependents (${incomingLines.length}${incomingLines.length >= limit ? '+' : ''}):`);
  if (incomingLines.length === 0) out.push('  (none recorded)');
  out.push(...incomingLines);
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

function formatSymbolLine(r: SymbolRow): string {
  const doc = r.docstring !== null && r.docstring !== '' ? ` — ${r.docstring}` : '';
  const exp = r.is_exported === 1 ? ' ✓exported' : '';
  return `- #${r.id} ${r.name} [${r.kind}]${exp} ${r.path}:${r.start_line}\n  ${r.signature}${doc}`;
}
