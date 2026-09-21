/** MCP server layer: registers the 4 dictionary tools over stdio transport. */
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DB_FILENAME } from './config.js';
import { ArgusDb } from './db.js';
import { syncRoot, watchRoot } from './indexer.js';
import { ParserEngine } from './parser.js';
import { checkBlastRadius, getCodebaseMap, getSymbolDetails, lookupDictionary } from './tools.js';

export interface ServerOptions {
  /** Disable the live file watcher (one-shot sync, e.g. for CI). */
  noWatch: boolean;
  /** Version string reported to MCP clients. */
  version: string;
}

function toolResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function safe(handler: () => string, toolName: string): { content: Array<{ type: 'text'; text: string }> } {
  try {
    return toolResult(handler());
  } catch (err) {
    return toolResult(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runServer(root: string, options: ServerOptions): Promise<void> {
  const db = new ArgusDb(join(root, DB_FILENAME));
  const engine = await ParserEngine.create();
  for (const [lang, reason] of engine.unavailableLanguages()) {
    console.error(`[argus] grammar '${lang}' unavailable: ${reason}`);
  }

  const stats = syncRoot(db, engine, root);
  console.error(
    `[argus] indexed ${root}: ${stats.scanned} files, ${stats.updated} updated, ` +
      `${stats.removed} removed, ${stats.skipped} unchanged, ${stats.failed.length} failed`,
  );

  let watcher: { close: () => Promise<void> } | undefined;
  if (!options.noWatch) {
    const handle = watchRoot(db, engine, root, (err) => {
      console.error(`[argus] watcher error: ${err instanceof Error ? err.message : String(err)}`);
    });
    await handle.ready;
    watcher = handle.watcher;
    console.error('[argus] watching for changes');
  }

  const server = new McpServer({ name: 'argus', version: options.version });

  server.registerTool(
    'lookup_dictionary',
    {
      description:
        'Search existing symbols, functions, classes, or interfaces by name. ' +
        'Call BEFORE generating any new function, utility, module, or class to reuse code and prevent duplication.',
      inputSchema: {
        query: z.string().describe('Name/signature fragment to search for'),
        kind: z.string().optional().describe('Filter by kind: function, class, method, interface, struct, enum, ...'),
        limit: z.number().optional().describe('Max results (default 50)'),
      },
    },
    (args) => Promise.resolve(safe(() => lookupDictionary(db, args), 'lookup_dictionary')),
  );

  server.registerTool(
    'get_codebase_map',
    {
      description: 'High-level architectural map: exported symbols and signatures per file.',
      inputSchema: {
        module_path: z.string().optional().describe('Only include files under this path prefix'),
        limit: z.number().optional().describe('Max symbols (default 50)'),
      },
    },
    (args) => Promise.resolve(safe(() => getCodebaseMap(db, args), 'get_codebase_map')),
  );

  server.registerTool(
    'get_symbol_details',
    {
      description: 'Full source implementation of one symbol, for when modification is needed.',
      inputSchema: {
        symbol_id: z.number().optional().describe('Symbol id from lookup_dictionary'),
        symbol_name: z.string().optional().describe('Symbol name (exact or closest match)'),
      },
    },
    (args) => Promise.resolve(safe(() => getSymbolDetails(db, root, args), 'get_symbol_details')),
  );

  server.registerTool(
    'check_blast_radius',
    {
      description: 'Trace callers and dependents of a symbol before refactoring or changing signatures.',
      inputSchema: {
        symbol_name: z.string().describe('Symbol name to trace'),
        limit: z.number().optional().describe('Max refs per direction (default 50)'),
      },
    },
    (args) => Promise.resolve(safe(() => checkBlastRadius(db, args), 'check_blast_radius')),
  );

  const shutdown = (): void => {
    void (async () => {
      try {
        await watcher?.close();
      } finally {
        engine.dispose();
        db.close();
      }
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  console.error('[argus] MCP server ready on stdio');
}
