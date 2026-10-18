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
  'Project setup (one command):',
  '  argus init [--root <path>] [--client <name>] [--force] [--no-agents-md] [--no-hooks]',
  '',
  'Single-project stdio (local agent use):',
  '  argus [--root <path>] [--no-watch] [--ollama[=url]] [--ollama-model <m>] [--no-semantic]',
  '',
  'Multi-project server (team / shared / admin use):',
  '  argus serve (--config <file> | --root <path>) [--host <addr>] [--port <n>]',
  '              [--token <secret>] [--no-watch] [--stdio]',
  '              [--ollama[=url]] [--ollama-model <m>] [--no-semantic]',
  '',
  '  init           Write MCP config files, append the index-first rule',
  '                 to AGENTS.md, and install the Write hook (.claude/)',
  '  --client <name> Init target, repeatable or comma-separated:',
  '                 claude (default, .mcp.json), cursor (.cursor/mcp.json),',
  '                 vscode (.vscode/mcp.json), or all',
  '  --force        Overwrite existing managed entries / invalid JSON (init)',
  '  --no-agents-md Skip the AGENTS.md rule (init)',
  '  --no-hooks     Skip the index-first hook install (init)',
  '  --config <file>  JSON: { "projects": [{ "name": "web", "path": "/srv/web" }] }',
  '  --root <path>    Serve one project (name derived from the directory)',
  '  --host <addr>    Bind address (default 127.0.0.1)',
  '  --port <n>       HTTP port (default 3000)',
  '  --token <secret> Bearer token for HTTP (or ARGUS_TOKEN env; required off-loopback)',
  '  --no-watch       Sync once; disable the live file watcher',
  '  --audit-interval <secs>',
  '                   Background dead-code + duplicates reports (default 300 in',
  '                   serve mode, off in stdio; 0 disables; or ARGUS_AUDIT_INTERVAL)',
  '  --stdio          Also serve MCP over stdio alongside HTTP',
  '  --ollama[=url]   Semantic search via Ollama (default http://127.0.0.1:11434;',
  '                   or ARGUS_OLLAMA_URL; auto-probed, absence is not an error)',
  '  --ollama-model   Embedding model (default nomic-embed-text; or ARGUS_OLLAMA_MODEL)',
  '  --embeddings-provider <p>',
  '                   Embedding backend: ollama (default) or openai for any',
  '                   OpenAI-compatible /v1 server (or ARGUS_EMBEDDINGS_PROVIDER)',
  '  --embeddings-url <url>',
  '                   Server URL for provider=openai; also a fallback URL for',
  '                   ollama (default http://127.0.0.1:11434/v1; or ARGUS_EMBEDDINGS_URL)',
  '  --embeddings-model <m>',
  '                   Embedding model for provider=openai; also a fallback model',
  '                   for ollama (default nomic-embed-text; or ARGUS_EMBEDDINGS_MODEL)',
  '  --embeddings-key <secret>',
  '                   API key for provider=openai (or ARGUS_EMBEDDINGS_KEY;',
  '                   omit for local servers)',
  '  --no-semantic    Disable semantic search (or ARGUS_OLLAMA=off)',
  '',
  'HTTP endpoints: /mcp (MCP Streamable), / (admin UI), /api/* (JSON).',
  'Each project keeps its own <root>/.mcp-codebase.db index.',
].join('\n');
