import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArgusDb } from '../src/db.js';
import type { EmbeddingProvider } from '../src/embeddings.js';
import { createRequestHandler } from '../src/http.js';
import { ParserEngine } from '../src/parser.js';
import { IndexManager } from '../src/projects.js';
import { createMcpServer } from '../src/server.js';
import { lookupDictionaryHybrid, type HybridStats } from '../src/tools.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

describe('query_log storage', () => {
  it('logs queries, aggregates stats, prunes old rows', () => {
    const db = new ArgusDb(':memory:');
    try {
      assert.deepEqual(db.queryStats(), {
        total: 0,
        byTool: {},
        avgLatencyMs: 0,
        totalChars: 0,
        degraded: 0,
        errors: 0,
      });
      db.logQuery({ tool: 'lookup_dictionary', mode: 'hybrid', results: 3, chars: 100, tiers: { exact: 1, lexical: 2, semantic: 0 }, latencyMs: 10 });
      db.logQuery({ tool: 'lookup_dictionary', mode: 'exact', chars: 50, latencyMs: 20 });
      db.logQuery({ tool: 'find_dead_code', chars: 30, latencyMs: 30, error: true });
      const recent = db.recentQueries(10);
      assert.equal(recent.length, 3);
      assert.equal(recent[0]?.tool, 'find_dead_code');
      assert.equal(recent[0]?.error, true);
      assert.equal(recent[2]?.mode, 'hybrid');
      assert.deepEqual(recent[2]?.tiers, { exact: 1, lexical: 2, semantic: 0 });
      assert.equal(recent[1]?.tiers, null);
      assert.deepEqual(db.queryStats(), {
        total: 3,
        byTool: { lookup_dictionary: 2, find_dead_code: 1 },
        avgLatencyMs: 20,
        totalChars: 180,
        degraded: 0,
        errors: 1,
      });
      assert.equal(db.pruneQueryLog(2), 1);
      assert.equal(db.recentQueries(10).length, 2);
      assert.equal(db.pruneQueryLog(0), 0);
    } finally {
      db.close();
    }
  });
});

describe('hybrid tier stats', () => {
  function seed(): ArgusDb {
    const db = new ArgusDb(':memory:');
    db.replaceFile(
      'a.ts',
      'h1',
      [
        { name: 'getUser', kind: 'function', signature: 'getUser(id)', docstring: null, startLine: 1, endLine: 2, isExported: true },
        { name: 'saveUser', kind: 'function', signature: 'saveUser(u)', docstring: null, startLine: 4, endLine: 5, isExported: true },
      ],
      [],
    );
    return db;
  }

  it('fills tier counts on the happy path', async () => {
    const db = seed();
    try {
      const stats: HybridStats = { exact: -1, lexical: -1, semantic: -1, degraded: true };
      const out = await lookupDictionaryHybrid(db, { query: 'getUser' }, undefined, stats);
      assert.match(out, /getUser/);
      assert.deepEqual(stats, { exact: 1, lexical: 0, semantic: 0, degraded: false });
    } finally {
      db.close();
    }
  });

  it('fills zeros on validation failures and flags degraded providers', async () => {
    const db = seed();
    try {
      const empty: HybridStats = { exact: 9, lexical: 9, semantic: 9, degraded: true };
      await lookupDictionaryHybrid(db, { query: '   ' }, undefined, empty);
      assert.deepEqual(empty, { exact: 0, lexical: 0, semantic: 0, degraded: false });
      const failing: EmbeddingProvider = {
        name: 'boom',
        embed: () => Promise.reject(new Error('down')),
      };
      const stats: HybridStats = { exact: 0, lexical: 0, semantic: 0, degraded: false };
      const out = await lookupDictionaryHybrid(db, { query: 'getUser' }, failing, stats);
      assert.match(out, /semantic tier unavailable/);
      assert.equal(stats.degraded, true);
      assert.equal(stats.exact, 1);
    } finally {
      db.close();
    }
  });
});

describe('telemetry wiring', () => {
  async function setupManager(): Promise<{ root: string; manager: IndexManager }> {
    const root = mkdtempSync(join(tmpdir(), 'argus-telemetry-'));
    writeFileSync(join(root, 'a.ts'), `export function alpha(): number {\n  return 1;\n}\n`);
    const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, {
      watch: false,
      onError: () => {},
    });
    return { root, manager };
  }

  it('records MCP tool calls with tier detail', async () => {
    const { root, manager } = await setupManager();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(manager, 'test');
    const client = new Client({ name: 'telemetry-test', version: '0.0.0' });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: 'lookup_dictionary',
        arguments: { query: 'alpha', mode: 'hybrid' },
      });
      const text = JSON.stringify(result.content);
      assert.match(text, /alpha/);
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      const rows = entry.db.recentQueries(5);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.tool, 'lookup_dictionary');
      assert.equal(rows[0]?.mode, 'hybrid');
      assert.equal(rows[0]?.results, 1);
      assert.deepEqual(rows[0]?.tiers, { exact: 1, lexical: 0, semantic: 0 });
      assert.ok((rows[0]?.chars ?? 0) > 0);
      assert.equal(rows[0]?.error, false);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves telemetry over the admin API', async () => {
    const { root, manager } = await setupManager();
    try {
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      entry.db.logQuery({ tool: 'find_duplicates', chars: 12, latencyMs: 3 });
      const handler = createRequestHandler(manager, {
        host: '127.0.0.1',
        port: 0,
        token: undefined,
        version: 'test',
      });
      const req = { method: 'GET', url: '/api/projects/demo/queries?limit=10', headers: {} };
      const res = {
        statusCode: 200,
        headersSent: false,
        body: '',
        setHeader(): void {},
        writeHead(status: number): void {
          this.statusCode = status;
          this.headersSent = true;
        },
        end(chunk?: string): void {
          if (chunk !== undefined) this.body += chunk;
          this.headersSent = true;
        },
      };
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body) as {
        stats: { total: number };
        queries: Array<{ tool: string; chars: number }>;
      };
      assert.equal(parsed.stats.total, 1);
      assert.equal(parsed.queries.length, 1);
      assert.equal(parsed.queries[0]?.tool, 'find_duplicates');
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
