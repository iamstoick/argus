/** MCP layer: tool registration shared by the stdio and HTTP transports. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getProjectBrief } from './brief.js';
import type { IndexManager, ProjectEntry } from './projects.js';
import {
  checkBlastRadius,
  diffSnapshots,
  findDeadCode,
  findDuplicates,
  getCodebaseMap,
  getSymbolDetails,
  lookupDictionary,
  lookupDictionaryHybrid,
  type HybridStats,
} from './tools.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };

function toolResult(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

/** Extra telemetry detail a tool handler may attach (mode + hybrid tier counts). */
export interface TelemetryContext {
  mode?: string | undefined;
  stats?: HybridStats | undefined;
}

/** Best-effort telemetry: logging failures never break tool calls. */
function logTelemetry(
  entry: ProjectEntry,
  toolName: string,
  tc: TelemetryContext,
  text: string,
  latencyMs: number,
  error: boolean,
): void {
  try {
    const s = tc.stats;
    entry.db.logQuery({
      tool: toolName,
      mode: tc.mode,
      results: s === undefined ? undefined : s.exact + s.lexical + s.semantic,
      tiers: s === undefined ? undefined : { exact: s.exact, lexical: s.lexical, semantic: s.semantic },
      chars: text.length,
      latencyMs,
      degraded: s?.degraded ?? false,
      error,
    });
  } catch {
    // Telemetry is observability, not the request path; swallow and serve.
  }
}

/** Resolve the project selector, then run the handler with failures as text. */
function withProject(
  manager: IndexManager,
  toolName: string,
  project: string | undefined,
  fn: (entry: ProjectEntry) => string,
  tc: TelemetryContext = {},
): TextResult {
  const resolved = manager.resolve(project);
  if ('error' in resolved) return toolResult(resolved.error);
  const start = Date.now();
  try {
    const text = fn(resolved.entry);
    logTelemetry(resolved.entry, toolName, tc, text, Date.now() - start, false);
    return toolResult(text);
  } catch (err) {
    logTelemetry(resolved.entry, toolName, tc, '', Date.now() - start, true);
    return toolResult(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Async variant for handlers awaiting the semantic tier. */
async function withProjectAsync(
  manager: IndexManager,
  toolName: string,
  project: string | undefined,
  fn: (entry: ProjectEntry) => Promise<string>,
  tc: TelemetryContext = {},
): Promise<TextResult> {
  const resolved = manager.resolve(project);
  if ('error' in resolved) return toolResult(resolved.error);
  const start = Date.now();
  try {
    const text = await fn(resolved.entry);
    logTelemetry(resolved.entry, toolName, tc, text, Date.now() - start, false);
    return toolResult(text);
  } catch (err) {
    logTelemetry(resolved.entry, toolName, tc, '', Date.now() - start, true);
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
        mode: z
          .enum(['exact', 'hybrid'])
          .optional()
          .describe('exact: substring match (default). hybrid: also adds typo-tolerant and semantic-similar matches.'),
        project: projectField,
      },
    },
    (args) => {
      if (args.mode === 'hybrid') {
        const stats: HybridStats = { exact: 0, lexical: 0, semantic: 0, degraded: false };
        return withProjectAsync(
          manager,
          'lookup_dictionary',
          args.project,
          (entry) => lookupDictionaryHybrid(entry.db, args, entry.embeddings, stats, entry.vectorIndex),
          { mode: 'hybrid', stats },
        );
      }
      return Promise.resolve(
        withProject(manager, 'lookup_dictionary', args.project, (entry) => lookupDictionary(entry.db, args), {
          mode: 'exact',
        }),
      );
    },
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
    'get_project_brief',
    {
      description:
        'Orientation digest for an unfamiliar project: size, languages, largest files, most-referenced symbols, latest drift, audit posture, and recent agent activity.',
      inputSchema: {
        limit: z.number().optional().describe('Entries per section (default 8, max 10)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'get_project_brief', args.project, (entry) =>
          getProjectBrief(entry.db, entry.name, args),
        ),
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

  server.registerTool(
    'diff_snapshots',
    {
      description:
        'Structural drift: symbols added, removed, or signature-changed between two index snapshots (defaults: previous to latest).',
      inputSchema: {
        from: z.number().optional().describe('Older snapshot id (default: previous)'),
        to: z.number().optional().describe('Newer snapshot id (default: latest)'),
        take: z.boolean().optional().describe('Capture a fresh snapshot first, then diff against the previous one'),
        limit: z.number().optional().describe('Max entries per section (default 50)'),
        project: projectField,
      },
    },
    (args) =>
      Promise.resolve(
        withProject(manager, 'diff_snapshots', args.project, (entry) => {
          if (args.take === true) {
            const prev = entry.db.latestSnapshot();
            const id = entry.db.takeSnapshot();
            if (prev === undefined) return `Captured baseline snapshot #${id}. Make changes, then diff again.`;
            return `Captured snapshot #${id}.\n${diffSnapshots(entry.db, { from: prev.id, to: id, limit: args.limit })}`;
          }
          return diffSnapshots(entry.db, args);
        }),
      ),
  );

  return server;
}

/** Serve MCP over stdio (local agents). Blocks until the transport closes. */
export async function runStdio(manager: IndexManager, version: string): Promise<void> {
  await createMcpServer(manager, version).connect(new StdioServerTransport());
  console.error('[argus] MCP server ready on stdio');
}
