/** `argus init`: one-command project setup (client configs, AGENTS.md rule, index-first hook). */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_FILENAME = 'check-index-first.py';

/** AI clients with project-local MCP config files that init can write. */
export type ClientName = 'claude' | 'cursor' | 'vscode';

export interface ClientSpec {
  name: ClientName;
  /** Config path relative to the project root. */
  file: string;
  /** Top-level servers table key (`servers` for VS Code, `mcpServers` elsewhere). */
  tableKey: string;
  /** VS Code requires an explicit transport type on stdio entries. */
  entryType: string | undefined;
}

export const CLIENT_SPECS: Record<ClientName, ClientSpec> = {
  claude: { name: 'claude', file: '.mcp.json', tableKey: 'mcpServers', entryType: undefined },
  cursor: { name: 'cursor', file: '.cursor/mcp.json', tableKey: 'mcpServers', entryType: undefined },
  vscode: { name: 'vscode', file: '.vscode/mcp.json', tableKey: 'servers', entryType: 'stdio' },
};

const CLIENT_ORDER: ClientName[] = ['claude', 'cursor', 'vscode'];

/**
 * Parse repeatable/comma-separated `--client <name>` flags. `all` expands to
 * every known client. Empty segments are ignored; unknown names throw.
 * No flag means the historical default: Claude Code only.
 */
export function parseClientList(argv: string[]): ClientName[] {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--client') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '' && !next.startsWith('--')) raw.push(next);
    } else if (arg.startsWith('--client=')) {
      const value = arg.slice('--client='.length);
      if (value !== '') raw.push(value);
    }
  }
  const names = raw.flatMap((chunk) => chunk.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  if (names.length === 0) return ['claude'];
  if (names.includes('all')) return [...CLIENT_ORDER];
  const out: ClientName[] = [];
  for (const name of names) {
    if (name !== 'claude' && name !== 'cursor' && name !== 'vscode') {
      throw new Error(`init: unknown --client '${name}' (want claude|cursor|vscode|all)`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export const AGENTS_RULE = [
  '## Argus index rule',
  '',
  'Before generating any new function, utility, module, or class, you MUST call the',
  '`lookup_dictionary` MCP tool to check if equivalent or reusable code already exists in the',
  'project. Use `mode: "hybrid"` when exploring (typo-tolerant + semantic matches);',
  'default `exact` mode is enough when you know the name. Never scan raw project files',
  'using shell commands (cat, grep, find) unless explicitly requested for inline editing.',
  '',
].join('\n');

export interface InitOpts {
  root: string;
  entrypoint: string;
  force?: boolean | undefined;
  agentsMd?: boolean | undefined;
  hooks?: boolean | undefined;
  /** Target clients (default: Claude Code only). */
  clients?: ClientName[] | undefined;
  /** Override the hook template dir (tests); defaults next to the package examples. */
  hooksSourceDir?: string | undefined;
}

export interface InitAction {
  file: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  detail: string;
}

export function defaultHooksSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
}

function nodeEntry(
  spec: ClientSpec,
  entrypoint: string,
  root: string,
): { type?: string | undefined; command: string; args: string[] } {
  const args =
    entrypoint.endsWith('.ts') ? ['--experimental-strip-types', entrypoint, '--root', root] : [entrypoint, '--root', root];
  if (spec.entryType === undefined) return { command: 'node', args };
  return { type: spec.entryType, command: 'node', args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip // and block comments outside strings (VS Code ships commented
 * mcp.json files). Merging still rewrites files as plain JSON: comments in
 * an existing file are lost on the first merge, servers never are.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1] as string | undefined;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path}: top level must be an object`);
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hookCommandFor(dest: string): string {
  return `python3 ${dest}`;
}

/** True when settings already route Write through this exact hook command. */
function hookAlreadyWired(settings: Record<string, unknown>, command: string): boolean {
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return false;
  const pre = hooks['PreToolUse'];
  if (!Array.isArray(pre)) return false;
  return pre.some(
    (item) =>
      isRecord(item) &&
      item['matcher'] === 'Write' &&
      Array.isArray(item['hooks']) &&
      (item['hooks'] as unknown[]).some((h) => isRecord(h) && h['command'] === command),
  );
}

/** Drop stale entries for our hook script (e.g. after the project moved), then wire fresh. */
function wireHook(settings: Record<string, unknown>, command: string): void {
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return;
  const pre = hooks['PreToolUse'];
  if (!Array.isArray(pre)) return;
  const kept: unknown[] = [];
  for (const item of pre) {
    if (!isRecord(item) || item['matcher'] !== 'Write' || !Array.isArray(item['hooks'])) {
      kept.push(item);
      continue;
    }
    const rest = (item['hooks'] as unknown[]).filter(
      (h) => !(isRecord(h) && typeof h['command'] === 'string' && h['command'].includes(HOOK_FILENAME)),
    );
    if (rest.length > 0) kept.push({ ...item, hooks: rest });
  }
  kept.push({ matcher: 'Write', hooks: [{ type: 'command', command }] });
  hooks['PreToolUse'] = kept;
}

export function runInit(opts: InitOpts): InitAction[] {
  const actions: InitAction[] = [];
  let st;
  try {
    st = statSync(opts.root);
  } catch {
    throw new Error(`init: root does not exist: ${opts.root}`);
  }
  if (!st.isDirectory()) throw new Error(`init: root is not a directory: ${opts.root}`);
  const force = opts.force === true;
  const clients = opts.clients ?? ['claude'];

  // 1. Per-client MCP configs (merge-preserving: other servers survive).
  for (const name of clients) {
    const spec = CLIENT_SPECS[name];
    const mcpPath = join(opts.root, spec.file);
    const entry = nodeEntry(spec, opts.entrypoint, opts.root);
    if (!existsSync(mcpPath)) {
      mkdirSync(dirname(mcpPath), { recursive: true });
      writeJson(mcpPath, { [spec.tableKey]: { argus: entry } });
      actions.push({ file: mcpPath, action: 'created', detail: `stdio entry for ${spec.name}` });
      continue;
    }
    let current: Record<string, unknown> | undefined;
    try {
      current = readJsonObject(mcpPath);
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      if (!force) throw new Error(`init: ${mcpPath} is not valid JSON (use --force to overwrite)`);
      writeJson(mcpPath, { [spec.tableKey]: { argus: entry } });
      actions.push({ file: mcpPath, action: 'updated', detail: 'invalid JSON overwritten' });
      continue;
    }
    const servers = current[spec.tableKey];
    if (servers !== undefined && !isRecord(servers)) {
      if (!force) throw new Error(`init: ${mcpPath} has a non-object "${spec.tableKey}" (use --force to overwrite)`);
      current[spec.tableKey] = {};
    }
    const table = (current[spec.tableKey] ??= {}) as Record<string, unknown>;
    if (table['argus'] !== undefined && !force) {
      actions.push({ file: mcpPath, action: 'unchanged', detail: 'argus entry already present (use --force to overwrite)' });
    } else {
      const existed = table['argus'] !== undefined;
      table['argus'] = entry;
      writeJson(mcpPath, current);
      actions.push({ file: mcpPath, action: 'updated', detail: existed ? 'argus entry overwritten' : 'argus entry added' });
    }
  }

  // 2. AGENTS.md rule (never duplicated).
  const agentsPath = join(opts.root, 'AGENTS.md');
  if (opts.agentsMd === false) {
    actions.push({ file: agentsPath, action: 'skipped', detail: '--no-agents-md' });
  } else if (existsSync(agentsPath) && readFileSync(agentsPath, 'utf8').includes('lookup_dictionary')) {
    actions.push({ file: agentsPath, action: 'unchanged', detail: 'already mentions lookup_dictionary' });
  } else {
    const existed = existsSync(agentsPath);
    const prev = existed ? readFileSync(agentsPath, 'utf8') : '';
    const sep = prev === '' ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(agentsPath, `${prev}${sep}${AGENTS_RULE}`);
    actions.push({ file: agentsPath, action: existed ? 'updated' : 'created', detail: 'index-first rule appended' });
  }

  // 3. Index-first hook + settings wiring (Claude Code only).
  const hooksDir = join(opts.root, '.claude', 'hooks');
  if (opts.hooks === false) {
    actions.push({ file: hooksDir, action: 'skipped', detail: '--no-hooks' });
    return actions;
  }
  if (!clients.includes('claude')) {
    actions.push({ file: hooksDir, action: 'skipped', detail: 'no Claude client selected' });
    return actions;
  }
  const source = join(opts.hooksSourceDir ?? defaultHooksSourceDir(), HOOK_FILENAME);
  if (!existsSync(source)) throw new Error(`init: hook template missing: ${source}`);
  mkdirSync(hooksDir, { recursive: true });
  const dest = join(hooksDir, HOOK_FILENAME);
  if (existsSync(dest) && !force) {
    actions.push({ file: dest, action: 'unchanged', detail: 'already installed (use --force to refresh)' });
  } else {
    const existed = existsSync(dest);
    copyFileSync(source, dest);
    try {
      chmodSync(dest, 0o755);
    } catch {
      // Non-POSIX: the python3 invocation does not need the exec bit.
    }
    actions.push({ file: dest, action: existed ? 'updated' : 'created', detail: 'index-first hook installed' });
  }
  const settingsPath = join(opts.root, '.claude', 'settings.json');
  const command = hookCommandFor(dest);
  if (!existsSync(settingsPath)) {
    writeJson(settingsPath, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }] } });
    actions.push({ file: settingsPath, action: 'created', detail: 'PreToolUse hook wired' });
    return actions;
  }
  let settings: Record<string, unknown>;
  try {
    settings = readJsonObject(settingsPath);
  } catch {
    if (!force) throw new Error(`init: ${settingsPath} is not valid JSON (use --force to overwrite)`);
    writeJson(settingsPath, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }] } });
    actions.push({ file: settingsPath, action: 'updated', detail: 'invalid JSON overwritten' });
    return actions;
  }
  const hooks = settings['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) {
    if (!force) throw new Error(`init: ${settingsPath} has a non-object "hooks" (use --force to overwrite)`);
    settings['hooks'] = {};
  }
  const hooksObj = (settings['hooks'] ??= {}) as Record<string, unknown>;
  const pre = hooksObj['PreToolUse'];
  if (pre !== undefined && !Array.isArray(pre)) {
    if (!force) throw new Error(`init: ${settingsPath} has a non-array "hooks.PreToolUse" (use --force to overwrite)`);
    hooksObj['PreToolUse'] = [];
  }
  if (hookAlreadyWired(settings, command)) {
    actions.push({ file: settingsPath, action: 'unchanged', detail: 'hook already wired' });
    return actions;
  }
  wireHook(settings, command);
  writeJson(settingsPath, settings);
  actions.push({ file: settingsPath, action: 'updated', detail: 'PreToolUse hook wired' });
  return actions;
}
