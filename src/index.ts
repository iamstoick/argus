#!/usr/bin/env node
/** Argus CLI entry: resolves the workspace root and starts the MCP server. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './config.js';
import { runServer } from './server.js';

function version(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'argus — Codebase Dictionary & Evolution MCP Server',
        '',
        'Usage: argus [--root <path>] [--no-watch] [--help]',
        '',
        '  --root <path>   Workspace to index (default: $ARGUS_ROOT or cwd)',
        '  --no-watch      Sync once and serve without the live file watcher',
        '  --help          Show this help',
        '',
        'The index is stored at <root>/.mcp-codebase.db. Logs go to stderr;',
        'stdout carries the MCP stdio protocol.',
      ].join('\n'),
    );
    return;
  }
  const root = resolveRoot(argv, process.env);
  const noWatch = argv.includes('--no-watch');
  runServer(root, { noWatch, version: version() }).catch((err: unknown) => {
    console.error(`[argus] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

main();
