#!/usr/bin/env node
/** Argus CLI entry: single-project stdio or multi-project serve mode. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_TEXT, defaultProjectName, hasFlag, parseServeArgs } from './cli.js';
import {
  DEFAULT_AUDIT_INTERVAL_SECS,
  parseConfigFile,
  resolveAuditInterval,
  resolveEmbeddings,
  resolveRoot,
  resolveToken,
  type ProjectSpec,
} from './config.js';
import { OllamaEmbeddings, OpenAIEmbeddings, type EmbeddingProvider } from './embeddings.js';
import { runHttp, type HttpHandle } from './http.js';
import { runInit } from './init.js';
import { IndexManager } from './projects.js';
import { ParserEngine } from './parser.js';
import { runStdio } from './server.js';
import { startAuditWorker, type AuditWorkerHandle } from './worker.js';

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

/** Probe the embeddings sidecar; undefined keeps exact + lexical tiers only. Never fatal. */
async function probeEmbeddings(argv: string[]): Promise<EmbeddingProvider | undefined> {
  const config = resolveEmbeddings(argv, process.env);
  if (config === undefined) return undefined;
  const provider: OllamaEmbeddings | OpenAIEmbeddings =
    config.provider === 'openai'
      ? new OpenAIEmbeddings(config.url, config.model, config.apiKey, 2000)
      : new OllamaEmbeddings(config.url, config.model, 2000);
  if (await provider.probe()) {
    console.error(`[argus] semantic search: ${provider.name} ${config.model} at ${config.url}`);
    return provider;
  }
  console.error(`[argus] semantic search off (no ${provider.name} at ${config.url}; exact + lexical only)`);
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    return;
  }
  if (argv[0] === 'init') {
    const rest = argv.slice(1);
    const actions = runInit({
      root: resolve(resolveRoot(rest, process.env)),
      entrypoint: fileURLToPath(import.meta.url),
      force: hasFlag(rest, 'force'),
      agentsMd: !hasFlag(rest, 'no-agents-md'),
      hooks: !hasFlag(rest, 'no-hooks'),
    });
    for (const a of actions) console.log(`${a.action}: ${a.file} — ${a.detail}`);
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
  const embeddings = await probeEmbeddings(rest);
  const manager = await IndexManager.open(specs, engine, {
    watch: !noWatch,
    onError: (msg) => console.error(`[argus] watcher error: ${msg}`),
    embeddings,
    onVectorSync: (msg) => console.error(`[argus] ${msg}`),
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
  const auditSecs = resolveAuditInterval(argv, process.env, serveMode ? DEFAULT_AUDIT_INTERVAL_SECS : 0);
  let audit: AuditWorkerHandle | undefined;
  if (auditSecs > 0) {
    audit = startAuditWorker(manager, auditSecs * 1000, (msg) => console.error(`[argus] ${msg}`));
    console.error(`[argus] audit worker every ${auditSecs}s (dead-code + duplicates)`);
  }
  if (withStdio) {
    await runStdio(manager, version());
  }

  const shutdown = (): void => {
    void (async () => {
      try {
        audit?.stop();
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
