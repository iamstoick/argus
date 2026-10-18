/** Project brief: a dense orientation digest assembled live from the index.
 *
 * The consumer is an LLM agent starting work in an unfamiliar repo, so the
 * brief is structured data, not pre-narrated prose: counts, hubs, recent
 * drift, audit posture, and what agents recently asked about. Computed on
 * every call (like the codebase map), so it is never stale and needs no
 * storage or chat credentials.
 */
import { truncateOutput } from './config.js';
import { ArgusDb } from './db.js';
import { snapshotDiffData } from './tools.js';

export interface BriefArgs {
  /** Entries per section (default 8, max 10). */
  limit?: number | undefined;
}

export interface BriefReferencedSymbol {
  name: string;
  refs: number;
  /** Best-effort declaration site (callee names are call-site spellings). */
  path?: string | undefined;
  line?: number | undefined;
}

export interface BriefDrift {
  fromId: number;
  toId: number;
  fromTakenAt: string;
  toTakenAt: string;
  added: string[];
  removed: string[];
  changed: string[];
  truncated: boolean;
}

export interface BriefAuditSummary {
  kind: string;
  takenAt: string;
  findings: number;
}

export interface BriefQueryActivity {
  total: number;
  topTools: Array<{ tool: string; calls: number }>;
  /** Display estimate only (chars / 4). */
  estTokens: number;
}

export interface ProjectBriefData {
  project: string;
  files: number;
  symbols: number;
  exported: number;
  relationships: number;
  lastSyncAt: string | null;
  /** File counts by lowercase extension, most common first. */
  languages: Array<{ ext: string; files: number }>;
  byKind: Record<string, number>;
  topFiles: Array<{ path: string; symbols: number }>;
  mostReferenced: BriefReferencedSymbol[];
  /** Null until two snapshots exist to diff. */
  drift: BriefDrift | null;
  audits: BriefAuditSummary[];
  queries: BriefQueryActivity;
}

function sectionLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw)) return 8;
  return Math.max(1, Math.min(10, raw));
}

/** Best-effort declaration site for a call-site callee spelling. */
function locateSymbol(db: ArgusDb, name: string): { path: string; line: number } | undefined {
  const exact = db.symbolsByNameExact(name)[0];
  const row = exact ?? db.symbolsByNameLike(name, 1)[0];
  if (row?.path === undefined) return undefined;
  return { path: row.path, line: row.start_line };
}

/** Count findings in an audit payload without trusting its shape. */
function countAuditFindings(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const rec = payload as Record<string, unknown>;
  for (const key of ['symbols', 'groups', 'findings']) {
    const arr = rec[key];
    if (Array.isArray(arr)) return arr.length;
  }
  return 0;
}

/** Structured brief shared by the MCP tool and the admin JSON API. */
export function projectBriefData(db: ArgusDb, project: string, rawLimit: number | undefined): ProjectBriefData {
  const n = sectionLimit(rawLimit);
  const files = db.listFiles();
  const byExt = new Map<string, number>();
  for (const f of files) {
    const dot = f.path.lastIndexOf('.');
    const ext = dot >= 0 ? f.path.slice(dot + 1).toLowerCase() : '?';
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const languages = [...byExt.entries()]
    .map(([ext, count]) => ({ ext, files: count }))
    .sort((a, b) => b.files - a.files || (a.ext < b.ext ? -1 : 1))
    .slice(0, n);

  const diff = snapshotDiffData(db, undefined, undefined, 3);
  const drift: BriefDrift | null =
    'error' in diff
      ? null
      : {
          fromId: diff.fromId,
          toId: diff.toId,
          fromTakenAt: diff.fromTakenAt,
          toTakenAt: diff.toTakenAt,
          added: diff.added.map((f) => `${f.path} [${f.kind}] ${f.name}`),
          removed: diff.removed.map((f) => `${f.path} [${f.kind}] ${f.name}`),
          changed: diff.changed.map((f) => `${f.path} [${f.kind}] ${f.name}`),
          truncated: diff.truncated,
        };

  const stats = db.queryStats();
  const topTools = Object.entries(stats.byTool)
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1))
    .slice(0, 3);

  return {
    project,
    files: db.countFiles(),
    symbols: db.countSymbols(),
    exported: db.countExported(),
    relationships: db.countRelationships(),
    lastSyncAt: db.lastParsedAt(),
    languages,
    byKind: db.countByKind(),
    topFiles: db.topFilesBySymbols(n),
    mostReferenced: db.topReferencedCallees(n).map((c) => ({ ...c, ...locateSymbol(db, c.name) })),
    drift,
    audits: db.latestAuditReports().map((r) => ({ kind: r.kind, takenAt: r.takenAt, findings: countAuditFindings(r.payload) })),
    queries: { total: stats.total, topTools, estTokens: stats.estTokens },
  };
}

export function getProjectBrief(db: ArgusDb, project: string, args: BriefArgs): string {
  const data = projectBriefData(db, project, args.limit);
  if (data.files === 0) {
    return `Project '${project}' has no indexed files yet. The workspace may still be syncing.`;
  }
  const lines: string[] = [
    `Project brief for '${data.project}': ${data.files} files, ${data.symbols} symbols (${data.exported} exported), ${data.relationships} recorded calls.`,
  ];
  if (data.lastSyncAt !== null) lines.push(`Last synced ${data.lastSyncAt} UTC.`);
  if (data.languages.length > 0) {
    lines.push(`Languages: ${data.languages.map((l) => `${l.ext} (${l.files})`).join(', ')}.`);
  }
  const kinds = Object.entries(data.byKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (kinds.length > 0) lines.push(`Symbols by kind: ${kinds.map(([k, c]) => `${k} (${c})`).join(', ')}.`);
  if (data.topFiles.length > 0) {
    lines.push(`Largest files: ${data.topFiles.map((f) => `${f.path} (${f.symbols})`).join(', ')}.`);
  }
  if (data.mostReferenced.length > 0) {
    lines.push(
      'Most referenced: ' +
        data.mostReferenced
          .map((s) => `${s.name} ×${s.refs}${s.path === undefined ? '' : ` (${s.path}:${s.line})`}`)
          .join(', ') +
        '.',
    );
  }
  if (data.drift === null) {
    lines.push('Drift: fewer than two snapshots; capture more to track structural change.');
  } else {
    const d = data.drift;
    const parts: string[] = [];
    if (d.added.length > 0) parts.push(`+${d.added.join('; ')}`);
    if (d.removed.length > 0) parts.push(`-${d.removed.join('; ')}`);
    if (d.changed.length > 0) parts.push(`~${d.changed.join('; ')}`);
    lines.push(
      `Latest drift (#${d.fromId} → #${d.toId}): ${parts.length > 0 ? parts.join(' ') : 'no structural changes.'}${d.truncated ? ' (more; see diff_snapshots)' : ''}`,
    );
  }
  if (data.audits.length > 0) {
    lines.push(
      `Audit posture: ${data.audits.map((a) => `${a.kind} (${a.findings} findings @ ${a.takenAt})`).join(', ')}.`,
    );
  } else {
    lines.push('Audit posture: no background reports yet (the worker runs in serve mode).');
  }
  if (data.queries.total > 0) {
    lines.push(
      `Agent activity: ${data.queries.total} tool calls` +
        (data.queries.topTools.length > 0
          ? `, mostly ${data.queries.topTools.map((t) => `${t.tool} (${t.calls})`).join(', ')}`
          : '') +
        `.`,
    );
  }
  return truncateOutput(lines.join('\n'));
}
