/** CLI argument parsing (pure; tested). */
import { basename } from 'node:path';
import { isValidProjectName } from './config.js';

export function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined) return next;
    } else if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export interface ServeArgs {
  configPath: string | undefined;
  root: string | undefined;
  host: string;
  port: number;
  noWatch: boolean;
  stdio: boolean;
}

export function parseServeArgs(argv: string[]): ServeArgs {
  const portRaw = flagValue(argv, 'port') ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port '${portRaw}' (want 1-65535)`);
  }
  return {
    configPath: flagValue(argv, 'config'),
    root: flagValue(argv, 'root'),
    host: flagValue(argv, 'host') ?? '127.0.0.1',
    port,
    noWatch: hasFlag(argv, 'no-watch'),
    stdio: hasFlag(argv, 'stdio'),
  };
}

/** Derive a valid project name from a directory path, falling back to 'project'. */
export function defaultProjectName(rootPath: string): string {
  const cleaned = basename(rootPath).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '');
  if (cleaned !== '' && isValidProjectName(cleaned)) return cleaned;
  return 'project';
}

export const HELP_TEXT = [
  'argus — Codebase Dictionary & Evolution MCP Server',
  '',
  'Single-project stdio (local agent use):',
  '  argus [--root <path>] [--no-watch] [--ollama[=url]] [--ollama-model <m>] [--no-semantic]',
  '',
  'Multi-project server (team / shared / admin use):',
  '  argus serve (--config <file> | --root <path>) [--host <addr>] [--port <n>]',
  '              [--token <secret>] [--no-watch] [--stdio]',
  '              [--ollama[=url]] [--ollama-model <m>] [--no-semantic]',
  '',
  '  --config <file>  JSON: { "projects": [{ "name": "web", "path": "/srv/web" }] }',
  '  --root <path>    Serve one project (name derived from the directory)',
  '  --host <addr>    Bind address (default 127.0.0.1)',
  '  --port <n>       HTTP port (default 3000)',
  '  --token <secret> Bearer token for HTTP (or ARGUS_TOKEN env; required off-loopback)',
  '  --no-watch       Sync once; disable the live file watcher',
  '  --stdio          Also serve MCP over stdio alongside HTTP',
  '  --ollama[=url]   Semantic search via Ollama (default http://127.0.0.1:11434;',
  '                   or ARGUS_OLLAMA_URL; auto-probed, absence is not an error)',
  '  --ollama-model   Embedding model (default nomic-embed-text; or ARGUS_OLLAMA_MODEL)',
  '  --no-semantic    Disable semantic search (or ARGUS_OLLAMA=off)',
  '',
  'HTTP endpoints: /mcp (MCP Streamable), / (admin UI), /api/* (JSON).',
  'Each project keeps its own <root>/.mcp-codebase.db index.',
].join('\n');
