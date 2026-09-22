/** MCP layer: tool registration shared by the stdio and HTTP transports. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { IndexManager, ProjectEntry } from './projects.js';
import {
  checkBlastRadius,
  findDeadCode,
  findDuplicates,
  getCodebaseMap,
  getSymbolDetails,
  lookupDictionary,
} from './tools.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };

function toolResult(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

/** Resolve the project selector, then run the handler with failures as text. */
function withProject(
  manager: IndexManager,
  toolName: string,
  project: string | undefined,
  fn: (entry: ProjectEntry) => string,
): TextResult {
  const resolved = manager.resolve(project);
  if ('error' in resolved) return toolResult(resolved.error);
  try {
    return toolResult(fn(resolved.entry));
  } catch (err) {
    return toolResult(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const projectField = z.string().optional().describe('Project name (required when several are configured)');

/** Build an MCP server bound to the index manager (one instance per transport session). */
export function createMcpServer(manager: IndexManager, version: string): McpServer {
  const server = new McpServer({ name: 'argus', version });

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
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'lookup_dictionary', args.project, (entry) => lookupDictionary(entry.db, args)),
      ),
  );

  server.registerTool(
    'get_codebase_map',
    {
      description: 'High-level architectural map: exported symbols and signatures per file.',
      inputSchema: {
        module_path: z.string().optional().describe('Only include files under this path prefix'),
        limit: z.number().optional().describe('Max symbols (default 50)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'get_codebase_map', args.project, (entry) => getCodebaseMap(entry.db, args)),
      ),
  );

  server.registerTool(
    'get_symbol_details',
    {
      description: 'Full source implementation of one symbol, for when modification is needed.',
      inputSchema: {
        symbol_id: z.number().optional().describe('Symbol id from lookup_dictionary'),
        symbol_name: z.string().optional().describe('Symbol name (exact or closest match)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'get_symbol_details', args.project, (entry) =>
          getSymbolDetails(entry.db, entry.root, args),
        ),
      ),
  );

  server.registerTool(
    'check_blast_radius',
    {
      description: 'Trace callers and dependents of a symbol before refactoring or changing signatures.',
      inputSchema: {
        symbol_name: z.string().describe('Symbol name to trace'),
        limit: z.number().optional().describe('Max refs per direction (default 50)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'check_blast_radius', args.project, (entry) => checkBlastRadius(entry.db, args)),
      ),
  );

  server.registerTool(
    'find_duplicates',
    {
      description: 'Proactive copy-paste report: symbols sharing a normalized name and signature across the project.',
      inputSchema: {
        limit: z.number().optional().describe('Max groups (default 50)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'find_duplicates', args.project, (entry) => findDuplicates(entry.db, args)),
      ),
  );

  server.registerTool(
    'find_dead_code',
    {
      description: 'Symbols nothing calls. Conservative by construction; review framework entry points before deleting.',
      inputSchema: {
        include_exported: z.boolean().optional().describe('Also scan exported symbols (default false)'),
        limit: z.number().optional().describe('Max symbols (default 50)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'find_dead_code', args.project, (entry) => findDeadCode(entry.db, args)),
      ),
  );

  return server;
}

/** Serve MCP over stdio (local agents). Blocks until the transport closes. */
export async function runStdio(manager: IndexManager, version: string): Promise<void> {
  await createMcpServer(manager, version).connect(new StdioServerTransport());
  console.error('[argus] MCP server ready on stdio');
}
