/** `argus init`: one-command project setup (.mcp.json, AGENTS.md rule, index-first hook). */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_FILENAME = 'check-index-first.py';

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

function nodeEntry(entrypoint: string, root: string): { command: string; args: string[] } {
  if (entrypoint.endsWith('.ts')) {
    return { command: 'node', args: ['--experimental-strip-types', entrypoint, '--root', root] };
  }
  return { command: 'node', args: [entrypoint, '--root', root] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
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

  // 1. .mcp.json (merge-preserving: other servers survive).
  const mcpPath = join(opts.root, '.mcp.json');
  const entry = nodeEntry(opts.entrypoint, opts.root);
  if (!existsSync(mcpPath)) {
    writeJson(mcpPath, { mcpServers: { argus: entry } });
    actions.push({ file: mcpPath, action: 'created', detail: 'stdio entry for this project' });
  } else {
    let current: Record<string, unknown> | undefined;
    try {
      current = readJsonObject(mcpPath);
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      if (!force) throw new Error(`init: ${mcpPath} is not valid JSON (use --force to overwrite)`);
      writeJson(mcpPath, { mcpServers: { argus: entry } });
      actions.push({ file: mcpPath, action: 'updated', detail: 'invalid JSON overwritten' });
    } else {
      const servers = current['mcpServers'];
      if (servers !== undefined && !isRecord(servers)) {
        if (!force) throw new Error(`init: ${mcpPath} has a non-object "mcpServers" (use --force to overwrite)`);
        current['mcpServers'] = {};
      }
      const table = (current['mcpServers'] ??= {}) as Record<string, unknown>;
      if (table['argus'] !== undefined && !force) {
        actions.push({ file: mcpPath, action: 'unchanged', detail: 'argus entry already present (use --force to overwrite)' });
      } else {
        const existed = table['argus'] !== undefined;
        table['argus'] = entry;
        writeJson(mcpPath, current);
        actions.push({ file: mcpPath, action: 'updated', detail: existed ? 'argus entry overwritten' : 'argus entry added' });
      }
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

  // 3. Index-first hook + settings wiring.
  const hooksDir = join(opts.root, '.claude', 'hooks');
  if (opts.hooks === false) {
    actions.push({ file: hooksDir, action: 'skipped', detail: '--no-hooks' });
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
