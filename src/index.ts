#!/usr/bin/env node
/** Argus CLI entry: single-project stdio or multi-project serve mode. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_TEXT, defaultProjectName, hasFlag, parseServeArgs } from './cli.js';
import { parseConfigFile, resolveRoot, resolveToken, type ProjectSpec } from './config.js';
import { runHttp, type HttpHandle } from './http.js';
import { IndexManager } from './projects.js';
import { ParserEngine } from './parser.js';
import { runStdio } from './server.js';

function version(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadSpecs(args: { configPath: string | undefined; root: string | undefined }): ProjectSpec[] {
  if (args.configPath !== undefined && args.root !== undefined) {
    throw new Error('pass either --config or --root, not both');
  }
  if (args.configPath !== undefined) {
    const abs = resolve(args.configPath);
    return parseConfigFile(readFileSync(abs, 'utf8'), dirname(abs)).projects;
  }
  if (args.root !== undefined) {
    const root = resolve(args.root);
    return [{ name: defaultProjectName(root), path: root }];
  }
  throw new Error('serve mode needs --config <file> or --root <path>');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    return;
  }
  const serveMode = argv[0] === 'serve';
  const rest = serveMode ? argv.slice(1) : argv;

  let specs: ProjectSpec[];
  let host = '127.0.0.1';
  let port = 3000;
  let noWatch = false;
  let withStdio = !serveMode;
  if (serveMode) {
    const parsed = parseServeArgs(rest);
    specs = loadSpecs(parsed);
    host = parsed.host;
    port = parsed.port;
    noWatch = parsed.noWatch;
    withStdio = parsed.stdio;
  } else {
    const root = resolveRoot(rest, process.env);
    specs = [{ name: defaultProjectName(root), path: root }];
    noWatch = hasFlag(rest, 'no-watch');
  }

  const token = resolveToken(argv, process.env);
  const engine = await ParserEngine.create();
  for (const [lang, reason] of engine.unavailableLanguages()) {
    console.error(`[argus] grammar '${lang}' unavailable: ${reason}`);
  }
  const manager = await IndexManager.open(specs, engine, {
    watch: !noWatch,
    onError: (msg) => console.error(`[argus] watcher error: ${msg}`),
  });
  for (const name of manager.names()) {
    const s = manager.stats(name);
    if (s?.lastSync) {
      const st = s.lastSync;
      console.error(
        `[argus] [${name}] ${s.root}: ${st.scanned} files, ${st.updated} updated, ` +
          `${st.removed} removed, ${st.skipped} unchanged, ${st.failed.length} failed`,
      );
    }
  }

  let http: HttpHandle | undefined;
  if (serveMode) {
    http = await runHttp(manager, { host, port, token, version: version() });
  }
  if (withStdio) {
    await runStdio(manager, version());
  }

  const shutdown = (): void => {
    void (async () => {
      try {
        await http?.close();
      } finally {
        await manager.close();
        engine.dispose();
      }
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(`[argus] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
