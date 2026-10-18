import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AUDIT_INTERVAL_SECS, resolveAuditInterval } from '../src/config.js';
import { ArgusDb, type AuditReport } from '../src/db.js';
import { createRequestHandler } from '../src/http.js';
import { ParserEngine } from '../src/parser.js';
import { IndexManager } from '../src/projects.js';
import { runAuditOnce, startAuditWorker } from '../src/worker.js';
import { callApi } from './helpers.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

describe('resolveAuditInterval', () => {
  it('defaults per mode and honors flag and env', () => {
    assert.equal(resolveAuditInterval([], {}, DEFAULT_AUDIT_INTERVAL_SECS), 300);
    assert.equal(resolveAuditInterval([], {}, 0), 0);
    assert.equal(resolveAuditInterval(['--audit-interval', '60'], {}, 300), 60);
    assert.equal(resolveAuditInterval(['--audit-interval=0'], {}, 300), 0);
    assert.equal(resolveAuditInterval([], { ARGUS_AUDIT_INTERVAL: '45' }, 300), 45);
    const flagged = resolveAuditInterval(['--audit-interval', '10'], { ARGUS_AUDIT_INTERVAL: '45' }, 300);
    assert.equal(flagged, 10);
  });

  it('throws on invalid values', () => {
    assert.throws(() => resolveAuditInterval(['--audit-interval', '-1'], {}, 300), /invalid --audit-interval/);
    assert.throws(() => resolveAuditInterval(['--audit-interval', 'x'], {}, 300), /invalid --audit-interval/);
    assert.throws(() => resolveAuditInterval([], { ARGUS_AUDIT_INTERVAL: '1.5' }, 300), /invalid --audit-interval/);
  });
});

describe('runAuditOnce', () => {
  function seed(): ArgusDb {
    const db = new ArgusDb(':memory:');
    db.replaceFile(
      'a.ts',
      'h1',
      [
        { name: 'lonely', kind: 'function', signature: 'lonely()', docstring: null, startLine: 1, endLine: 1, isExported: false },
        { name: 'twin', kind: 'function', signature: 'twin(a)', docstring: null, startLine: 3, endLine: 3, isExported: true },
      ],
      [],
    );
    db.replaceFile(
      'b.ts',
      'h2',
      [{ name: 'twin', kind: 'function', signature: 'twin(a)', docstring: null, startLine: 1, endLine: 1, isExported: true }],
      [],
    );
    return db;
  }

  function payloadOf(reports: AuditReport[], kind: string): { symbols?: Array<{ name: string }>; groups?: Array<{ key: string }> } {
    const found = reports.find((r) => r.kind === kind)?.payload;
    assert.ok(typeof found === 'object' && found !== null);
    return found as { symbols?: Array<{ name: string }>; groups?: Array<{ key: string }> };
  }

  it('stores dead-code and duplicate reports with real findings', () => {
    const db = seed();
    try {
      assert.deepEqual(runAuditOnce(db), ['dead-code', 'duplicates']);
      const latest = db.latestAuditReports();
      assert.equal(latest.length, 2);
      assert.ok(payloadOf(latest, 'dead-code').symbols?.some((s) => s.name === 'lonely'));
      assert.ok(payloadOf(latest, 'duplicates').groups?.some((g) => g.key === 'twin'));
      for (let i = 0; i < 12; i++) db.storeAuditReport('dead-code', { n: i });
      const history = db.auditHistory('dead-code', 50);
      assert.equal(history.length, 10);
      assert.deepEqual(history[0]?.payload, { n: 11 });
    } finally {
      db.close();
    }
  });
});

describe('audit worker wiring', () => {
  async function setupManager(): Promise<{ root: string; manager: IndexManager }> {
    const root = mkdtempSync(join(tmpdir(), 'argus-audit-'));
    writeFileSync(join(root, 'a.ts'), `function helper(): number {\n  return 1;\n}\n`);
    const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, {
      watch: false,
      onError: () => {},
    });
    return { root, manager };
  }

  async function pollFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return cond();
  }

  it('runs immediately and repeats until stopped', async () => {
    const { root, manager } = await setupManager();
    try {
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      const errors: string[] = [];
      const handle = startAuditWorker(manager, 20, (msg) => errors.push(msg));
      try {
        assert.equal(entry.db.latestAuditReports().length, 2); // immediate first run
        const repeated = await pollFor(() => entry.db.auditHistory('dead-code', 10).length >= 3, 2000);
        assert.equal(repeated, true);
        assert.deepEqual(errors, []);
      } finally {
        handle.stop();
      }
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves the latest reports over the admin API', async () => {
    const { root, manager } = await setupManager();
    try {
      const entry = manager.get('demo');
      assert.ok(entry !== undefined);
      runAuditOnce(entry.db);
      const handler = createRequestHandler(manager, { host: '127.0.0.1', port: 0, token: undefined, version: 'test' });
      const res = await callApi(handler, 'GET', '/api/projects/demo/audit');
      assert.equal(res.statusCode, 200);
      const body = res.json<{ reports: Array<{ kind: string }> }>();
      assert.deepEqual(body.reports.map((r) => r.kind).sort(), ['dead-code', 'duplicates']);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
