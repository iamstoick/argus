import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LIMITS } from '../src/config.js';
import { ArgusDb } from '../src/db.js';
import { createRequestHandler } from '../src/http.js';
import { watchRoot } from '../src/indexer.js';
import { ParserEngine } from '../src/parser.js';
import { IndexManager, snapshotDue } from '../src/projects.js';
import { createMcpServer } from '../src/server.js';
import { diffSnapshots, snapshotDiffData } from '../src/tools.js';
import { callApi } from './helpers.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function seedV1(db: ArgusDb): void {
  db.replaceFile(
    'a.ts',
    'h1',
    [
      { name: 'keep', kind: 'function', signature: 'keep()', docstring: null, startLine: 1, endLine: 1, isExported: true },
      { name: 'gone', kind: 'function', signature: 'gone()', docstring: null, startLine: 3, endLine: 3, isExported: true },
      { name: 'morph', kind: 'function', signature: 'morph(a)', docstring: null, startLine: 5, endLine: 5, isExported: true },
    ],
    [],
  );
}

function seedV2(db: ArgusDb): void {
  db.replaceFile(
    'a.ts',
    'h2',
    [
      { name: 'keep', kind: 'function', signature: 'keep()', docstring: null, startLine: 1, endLine: 1, isExported: true },
      { name: 'morph', kind: 'function', signature: 'morph(a, b)', docstring: null, startLine: 5, endLine: 5, isExported: true },
      { name: 'fresh', kind: 'function', signature: 'fresh()', docstring: null, startLine: 8, endLine: 8, isExported: true },
    ],
    [],
  );
}

describe('snapshot storage', () => {
  it('captures, lists, and prunes snapshots', () => {
    const db = new ArgusDb(':memory:');
    try {
      assert.equal(db.latestSnapshot(), undefined);
      assert.equal(db.snapshotFingerprints(1), undefined);
      seedV1(db);
      const first = db.takeSnapshot();
      assert.equal(first, 1);
      const latest = db.latestSnapshot();
      assert.equal(latest?.symbols, 3);
      assert.equal(db.snapshotFingerprints(1)?.length, 3);
      for (let i = 0; i < LIMITS.maxSnapshots + 2; i++) db.takeSnapshot();
      assert.equal(db.listSnapshots(100).length, LIMITS.maxSnapshots);
    } finally {
      db.close();
    }
  });
});

describe('snapshot diff', () => {
  it('reports added, removed, and signature-changed symbols', () => {
    const db = new ArgusDb(':memory:');
    try {
      seedV1(db);
      const from = db.takeSnapshot();
      seedV2(db);
      const to = db.takeSnapshot();
      const data = snapshotDiffData(db, from, to, 50);
      assert.ok(!('error' in data));
      assert.deepEqual(data.added.map((f) => f.name), ['fresh']);
      assert.deepEqual(data.removed.map((f) => f.name), ['gone']);
      assert.deepEqual(data.changed.map((f) => f.name), ['morph']);
      assert.deepEqual(data.countsAfter, { files: 1, symbols: 3, relationships: 0 });
      const text = diffSnapshots(db, {});
      assert.match(text, new RegExp(`#${from}.*#${to}`, 's'));
      assert.match(text, /Added \(1\):\n  \+ a\.ts \[function\] fresh/);
      assert.match(text, /Removed \(1\):\n  - a\.ts \[function\] gone/);
      assert.match(text, /Changed signatures \(1\):\n  ~ a\.ts \[function\] morph/);
    } finally {
      db.close();
    }
  });

  it('handles empty, single, unknown, and identical selections', () => {
    const db = new ArgusDb(':memory:');
    try {
      assert.match(diffSnapshots(db, {}), /No snapshots yet/);
      seedV1(db);
      const only = db.takeSnapshot();
      assert.match(diffSnapshots(db, {}), /oldest retained/);
      assert.match(diffSnapshots(db, { from: 99, to: only }), /Unknown snapshot id 99/);
      assert.match(diffSnapshots(db, { from: 0 }), /Invalid snapshot id/);
      const same = snapshotDiffData(db, only, only, 50);
      assert.ok(!('error' in same));
      assert.deepEqual([same.added, same.removed, same.changed], [[], [], []]);
      assert.match(diffSnapshots(db, { from: only, to: only }), /No structural changes/);
    } finally {
      db.close();
    }
  });
});

describe('snapshotDue', () => {
  it('fires on missing, old, or unparseable timestamps only', () => {
    const now = Date.parse('2026-10-12T12:01:00Z');
    assert.equal(snapshotDue(null, now, 60_000), true);
    assert.equal(snapshotDue('2026-10-12 12:00:30', now, 60_000), false);
    assert.equal(snapshotDue('2026-10-12 12:00:00', now, 60_000), true);
    assert.equal(snapshotDue('not-a-timestamp', now, 60_000), true);
  });
});

describe('snapshot wiring', () => {
  async function setupManager(): Promise<{ root: string; manager: IndexManager }> {
    const root = mkdtempSync(join(tmpdir(), 'argus-snap-'));
    writeFileSync(join(root, 'a.ts'), `export function alpha(): number {\n  return 1;\n}\n`);
    const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, {
      watch: false,
      onError: () => {},
    });
    return { root, manager };
  }

  it('takes a baseline snapshot on first open', async () => {
    const { root, manager } = await setupManager();
    try {
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      assert.equal(entry.db.listSnapshots(10).length, 1);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves list, diff, take, and invalid ids over the admin API', async () => {
    const { root, manager } = await setupManager();
    try {
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      entry.db.replaceFile(
        'a.ts',
        'hx',
        [
          { name: 'alpha', kind: 'function', signature: 'alpha()', docstring: null, startLine: 1, endLine: 2, isExported: true },
          { name: 'beta', kind: 'function', signature: 'beta()', docstring: null, startLine: 4, endLine: 5, isExported: true },
        ],
        [],
      );
      const handler = createRequestHandler(manager, { host: '127.0.0.1', port: 0, token: undefined, version: 'test' });
      const taken = await callApi(handler, 'GET', '/api/projects/demo/snapshots?take=1');
      assert.equal(taken.statusCode, 200);
      const takenBody = taken.json<{ snapshot: { id: number }; previousId: number; diff: { added: Array<{ name: string }> } }>();
      assert.equal(takenBody.previousId, 1);
      assert.deepEqual(takenBody.diff.added.map((f) => f.name), ['beta']);
      const list = await callApi(handler, 'GET', '/api/projects/demo/snapshots');
      assert.equal(list.json<{ snapshots: unknown[] }>().snapshots.length, 2);
      const diff = await callApi(handler, 'GET', '/api/projects/demo/snapshots?from=1&to=2');
      assert.equal(diff.statusCode, 200);
      assert.equal(diff.json<{ removed: unknown[] }>().removed.length, 0);
      const bad = await callApi(handler, 'GET', '/api/projects/demo/snapshots?from=0');
      assert.equal(bad.statusCode, 400);
      const missing = await callApi(handler, 'GET', '/api/projects/demo/snapshots?from=1&to=99');
      assert.equal(missing.statusCode, 404);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('diffs via MCP and captures on demand with take', async () => {
    const { root, manager } = await setupManager();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(manager, 'test');
    const client = new Client({ name: 'snapshot-test', version: '0.0.0' });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      entry.db.replaceFile(
        'a.ts',
        'hy',
        [
          { name: 'alpha', kind: 'function', signature: 'alpha()', docstring: null, startLine: 1, endLine: 2, isExported: true },
          { name: 'gamma', kind: 'function', signature: 'gamma()', docstring: null, startLine: 4, endLine: 5, isExported: true },
        ],
        [],
      );
      const result = await client.callTool({ name: 'diff_snapshots', arguments: { take: true } });
      const text = JSON.stringify(result.content);
      assert.match(text, /Captured snapshot #2/);
      assert.match(text, /Added.*gamma/s);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('watchRoot afterIndex', () => {
  async function pollFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  }

  it('reports add and unlink outcomes', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'argus-watch-hook-'));
    writeFileSync(join(root, 'a.ts'), 'export function one(): number {\n  return 1;\n}\n');
    const db = new ArgusDb(':memory:');
    const outcomes: string[] = [];
    let watchErr: string | undefined;
    const handle = watchRoot(
      db,
      engine,
      root,
      (err) => {
        watchErr = err instanceof Error ? err.message : String(err);
      },
      undefined,
      (outcome) => {
        outcomes.push(outcome);
      },
    );
    try {
      await Promise.race([
        handle.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('watcher ready timeout')), 10000)),
      ]);
      if (watchErr !== undefined) {
        t.skip(`OS file watching unavailable here (${watchErr}); skipping live-watcher test`);
        return;
      }
      writeFileSync(join(root, 'b.py'), 'def two():\n    return 2\n');
      if (!(await pollFor(() => outcomes.includes('updated'), 8000))) {
        if (watchErr !== undefined) {
          t.skip(`OS file watching unavailable here (${watchErr}); skipping live-watcher test`);
          return;
        }
        assert.fail('add outcome not reported');
      }
      rmSync(join(root, 'b.py'));
      if (!(await pollFor(() => outcomes.includes('removed'), 8000))) {
        if (watchErr !== undefined) {
          t.skip(`OS file watching unavailable here (${watchErr}); skipping live-watcher test`);
          return;
        }
        assert.fail('unlink outcome not reported');
      }
    } finally {
      await handle.watcher.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
