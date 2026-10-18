/** Secret scanning for the background audit worker (flag-only, never redacts the index).
 *
 * Only high-precision patterns: fixed-format provider tokens plus
 * key/secret/password assignments with placeholder filtering, so committed
 * `.env` accidents surface while `password: string` annotations and
 * `api_key = "changeme"` fixtures stay quiet. Stored findings carry a
 * redacted preview — the raw secret never lands in the database.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ArgusDb } from './db.js';

export interface SecretFinding {
  path: string;
  line: number;
  kind: string;
  /** Source line with the secret replaced by [REDACTED] (verbatim only for key headers, which leak nothing). */
  preview: string;
}

export interface SecretScanPayload {
  findings: SecretFinding[];
  /** Files fully scanned this round. */
  scanned: number;
  /** Files skipped: content hash unchanged since the last scan. */
  unchanged: number;
  /** Files skipped: over the size cap or binary. */
  skippedLarge: number;
  /** Files skipped: unreadable from disk (deleted or permissioned). */
  unreadable: number;
  /** Changed files left for a later round (per-run file cap). */
  deferred: number;
  truncated: boolean;
}

interface SecretPattern {
  kind: string;
  /** Global regex; the secret is capture group `secretGroup` (0 = whole match). */
  re: RegExp;
  secretGroup: number;
  /** Fixed-format tokens skip the placeholder filter (their shape is the evidence). */
  fixedFormat: boolean;
  /** Verbatim preview: safe only when the match itself leaks nothing. */
  revealMatch: boolean;
}

/**
 * Assignment shapes. Quoted values accept anything long enough (a quoted
 * 12+ char `api_key` value is never code); unquoted values must mix in a
 * digit and must not be a call, which keeps `apiKey = getDefaultKey()` and
 * `token = request.token` quiet while `.env`-style `API_KEY=abc123…` lines
 * still match. An optional `: Type` annotation covers `KEY: str = "…"`.
 */
/** Left boundary that also accepts db_password / db-password style prefixes (but not repwd). */
const EDGE = String.raw`(?:\b|(?<=[_-]))`;
const KEY_NAMES = 'api[_-]?key|api[_-]?secret|api[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|private[_-]?token|secret|token';
const PW_NAMES = 'password|passwd|pwd';
const ANNOT = String.raw`(?:\s*:\s*[A-Za-z_]\w*(?:\[[^\]]*\])?)?`;
const UNQUOTED_VALUE = '[A-Za-z0-9_\\-+/=]';
const UNQUOTED_PW = '[A-Za-z0-9_\\-+/=!@#$%^&*.]';

const PATTERNS: SecretPattern[] = [
  { kind: 'aws-access-key', re: /\b(AKIA[0-9A-Z]{16})\b/g, secretGroup: 1, fixedFormat: true, revealMatch: false },
  {
    kind: 'github-token',
    re: /\b(ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|ghr_[A-Za-z0-9]{36,})\b/g,
    secretGroup: 1,
    fixedFormat: true,
    revealMatch: false,
  },
  {
    kind: 'slack-token',
    re: /\b(xox[baprs]-[A-Za-z0-9-]{10,72})\b/g,
    secretGroup: 1,
    fixedFormat: true,
    revealMatch: false,
  },
  {
    kind: 'stripe-key',
    re: /\b((?:sk|rk)_live_[A-Za-z0-9]{16,}|(?:sk|rk)_test_[A-Za-z0-9]{16,})\b/g,
    secretGroup: 1,
    fixedFormat: true,
    revealMatch: false,
  },
  {
    kind: 'openai-key',
    re: /\b(sk-(?:proj-)?[A-Za-z0-9_\-]{20,})\b/g,
    secretGroup: 1,
    fixedFormat: true,
    revealMatch: false,
  },
  {
    kind: 'jwt',
    re: /\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})\b/g,
    secretGroup: 1,
    fixedFormat: true,
    revealMatch: false,
  },
  {
    kind: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    secretGroup: 0,
    fixedFormat: true,
    revealMatch: true,
  },
  {
    kind: 'generic-secret',
    re: new RegExp(`${EDGE}(${KEY_NAMES})['"]?${ANNOT}\\s*[:=]\\s*['"](${UNQUOTED_VALUE}{12,128})['"]`, 'gi'),
    secretGroup: 2,
    fixedFormat: false,
    revealMatch: false,
  },
  {
    kind: 'generic-secret',
    re: new RegExp(
      `${EDGE}(${KEY_NAMES})\\s*[:=]\\s*(?=${UNQUOTED_VALUE}*[0-9])(${UNQUOTED_VALUE}{12,128})(?!\\()`,
      'gi',
    ),
    secretGroup: 2,
    fixedFormat: false,
    revealMatch: false,
  },
  {
    kind: 'password-assign',
    re: new RegExp(`${EDGE}(${PW_NAMES})['"]?${ANNOT}\\s*[:=]\\s*['"]([^'"]{8,128})['"]`, 'gi'),
    secretGroup: 2,
    fixedFormat: false,
    revealMatch: false,
  },
  {
    kind: 'password-assign',
    re: new RegExp(`${EDGE}(${PW_NAMES})\\s*[:=]\\s*(?=${UNQUOTED_PW}*[0-9])(${UNQUOTED_PW}{8,64})(?!\\()`, 'gi'),
    secretGroup: 2,
    fixedFormat: false,
    revealMatch: false,
  },
];

/** Lowercase substrings marking a generic/password value as a placeholder. */
const PLACEHOLDERS = [
  'example',
  'changeme',
  'changeit',
  'sample',
  'dummy',
  'placeholder',
  'yourkey',
  'your-key',
  'your_api',
  'todo',
  'xxx',
];

function isPlaceholder(secret: string): boolean {
  if (/^(.)\1+$/.test(secret)) return true; // aaaa…, ****…
  if (/[<>${}\s]/.test(secret)) return true; // <token>, ${VAR}, your key here
  const lower = secret.toLowerCase();
  return PLACEHOLDERS.some((p) => lower.includes(p));
}

function redactPreview(line: string, secret: string): string {
  const redacted = line.split(secret).join('[REDACTED]').trim();
  return redacted.length <= 200 ? redacted : `${redacted.slice(0, 197)}…`;
}

export interface LineFinding {
  kind: string;
  preview: string;
}

/** All pattern hits on one line, placeholders dropped. Pure: no I/O. */
export function scanLine(line: string): LineFinding[] {
  const out: LineFinding[] = [];
  const taken: Array<[number, number]> = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(line); m !== null; m = p.re.exec(line)) {
      const secret = m[p.secretGroup] ?? '';
      if (secret === '') continue;
      // Fixed-format shapes are self-evident, except obvious filler runs (AKIAXXXX…).
      if (p.fixedFormat ? /(.)\1{7,}$/.test(secret) : isPlaceholder(secret)) continue;
      // Overlapping ranges dedupe: fixed-format patterns run first, so the
      // specific kind (github-token) wins over the generic one on one line.
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && a < end)) continue;
      taken.push([start, end]);
      out.push({ kind: p.kind, preview: p.revealMatch ? m[0].trim() : redactPreview(line, secret) });
    }
  }
  return out;
}

/** Findings for one file's full text, capped per file. Pure: no I/O. */
export function scanText(path: string, content: string, maxPerFile = 20): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < maxPerFile; i++) {
    for (const hit of scanLine(lines[i] ?? '')) {
      if (out.length >= maxPerFile) break;
      out.push({ path, line: i + 1, kind: hit.kind, preview: hit.preview });
    }
  }
  return out;
}

export interface SecretScanOpts {
  maxFiles?: number | undefined;
  maxBytes?: number | undefined;
  maxFindings?: number | undefined;
}

/** Previous findings, validated — a malformed prior payload degrades to []. */
function previousFindings(db: ArgusDb): SecretFinding[] {
  const payload = db.auditHistory('secrets', 1)[0]?.payload;
  if (typeof payload !== 'object' || payload === null) return [];
  const arr = (payload as Record<string, unknown>)['findings'];
  if (!Array.isArray(arr)) return [];
  const out: SecretFinding[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec['path'] !== 'string' ||
      typeof rec['line'] !== 'number' ||
      typeof rec['kind'] !== 'string' ||
      typeof rec['preview'] !== 'string'
    ) {
      continue;
    }
    out.push({ path: rec['path'], line: rec['line'], kind: rec['kind'], preview: rec['preview'] });
  }
  return out;
}

/**
 * Incremental secret scan over the indexed files. Only files whose content
 * hash changed since the last scan are re-read; findings for unscanned files
 * carry forward from the previous report, and files that left the index drop
 * their findings. Per-file I/O failures never throw.
 */
export function scanProjectSecrets(db: ArgusDb, root: string, opts: SecretScanOpts = {}): SecretScanPayload {
  const maxFiles = opts.maxFiles ?? 500;
  const maxBytes = opts.maxBytes ?? 262_144;
  const maxFindings = opts.maxFindings ?? 50;
  const files = db.listFiles();
  const indexed = new Set(files.map((f) => f.path));
  const carriedByPath = new Map<string, SecretFinding[]>();
  for (const f of previousFindings(db)) {
    if (!indexed.has(f.path)) continue;
    const bucket = carriedByPath.get(f.path);
    if (bucket === undefined) carriedByPath.set(f.path, [f]);
    else bucket.push(f);
  }
  const findings: SecretFinding[] = [];
  let scanned = 0;
  let unchanged = 0;
  let skippedLarge = 0;
  let unreadable = 0;
  let deferred = 0;
  for (const file of files) {
    const carried = carriedByPath.get(file.path) ?? [];
    if (db.secretScanHash(file.path) === file.hash) {
      unchanged += 1;
      findings.push(...carried);
      continue;
    }
    if (scanned >= maxFiles) {
      deferred += 1;
      findings.push(...carried);
      continue;
    }
    let content: string;
    try {
      if (statSync(join(root, file.path)).size > maxBytes) {
        skippedLarge += 1;
        findings.push(...carried);
        continue;
      }
      content = readFileSync(join(root, file.path), 'utf8');
    } catch {
      unreadable += 1;
      findings.push(...carried);
      continue;
    }
    if (content.includes('\0')) {
      skippedLarge += 1;
      findings.push(...carried);
      continue;
    }
    scanned += 1;
    db.setSecretScanHash(file.path, file.hash);
    findings.push(...scanText(file.path, content));
  }
  try {
    db.pruneSecretScanState();
  } catch {
    // Best effort: stale scan rows only cost a rescan next round.
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return {
    findings: findings.slice(0, maxFindings),
    scanned,
    unchanged,
    skippedLarge,
    unreadable,
    deferred,
    truncated: findings.length > maxFindings,
  };
}
