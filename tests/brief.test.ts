import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectBrief, projectBriefData } from '../src/brief.js';
import { ArgusDb } from '../src/db.js';
import { createRequestHandler } from '../src/http.js';
import { ParserEngine } from '../src/parser.js';
import { IndexManager } from '../src/projects.js';
import { callApi } from './helpers.js';

function seed(): ArgusDb {
  const db = new ArgusDb(':memory:');
  db.replaceFile(
    'src/auth.ts',
    'h1',
    [
      { name: 'login', kind: 'function', signature: 'login()', docstring: null, startLine: 1, endLine: 5, isExported: true },
      { name: 'logout', kind: 'function', signature: 'logout()', docstring: null, startLine: 7, endLine: 9, isExported: false },
      { name: 'User', kind: 'class', signature: 'class User', docstring: null, startLine: 11, endLine: 20, isExported: true },
    ],
    [
      { callerIndex: 0, calleeName: 'clamp', type: 'calls' },
      { callerIndex: 1, calleeName: 'clamp', type: 'calls' },
    ],
  );
  db.replaceFile(
    'src/util.ts',
    'h2',
    [{ name: 'clamp', kind: 'function', signature: 'clamp(n)', docstring: null, startLine: 1, endLine: 3, isExported: true }],
    [],
  );
  db.takeSnapshot();
  db.replaceFile(
    'src/auth.ts',
    'h3',
    [
      { name: 'login', kind: 'function', signature: 'login(opts)', docstring: null, startLine: 1, endLine: 5, isExported: true },
      { name: 'logout', kind: 'function', signature: 'logout()', docstring: null, startLine: 7, endLine: 9, isExported: false },
      { name: 'User', kind: 'class', signature: 'class User', docstring: null, startLine: 11, endLine: 20, isExported: true },
    ],
    [
      { callerIndex: 0, calleeName: 'clamp', type: 'calls' },
      { callerIndex: 1, calleeName: 'clamp', type: 'calls' },
    ],
  );
  db.takeSnapshot();
  db.logQuery({ tool: 'lookup_dictionary', chars: 100, latencyMs: 5 });
  db.logQuery({ tool: 'lookup_dictionary', chars: 200, latencyMs: 7 });
  db.logQuery({ tool: 'get_codebase_map', chars: 400, latencyMs: 3 });
  db.storeAuditReport('dead-code', { symbols: [{ name: 'logout' }], truncated: false });
  return db;
}

describe('projectBriefData', () => {
  it('assembles counts, hubs, drift, audits, and activity', () => {
    const db = seed();
    try {
      const data = projectBriefData(db, 'demo', undefined);
      assert.equal(data.project, 'demo');
      assert.equal(data.files, 2);
      assert.equal(data.symbols, 4);
      assert.equal(data.exported, 3);
      assert.equal(data.relationships, 2);
      assert.deepEqual(data.languages, [{ ext: 'ts', files: 2 }]);
      assert.deepEqual(data.byKind, { function: 3, class: 1 });
      assert.deepEqual(data.topFiles[0], { path: 'src/auth.ts', symbols: 3 });
      assert.deepEqual(data.mostReferenced[0], { name: 'clamp', refs: 2, path: 'src/util.ts', line: 1 });
      assert.ok(data.drift !== null);
      assert.deepEqual(data.drift.changed, ['src/auth.ts [function] login']);
      assert.deepEqual(data.drift.added, []);
      assert.deepEqual(data.drift.removed, []);
      assert.deepEqual(data.audits, [{ kind: 'dead-code', takenAt: data.audits[0]?.takenAt, findings: 1 }]);
      assert.equal(data.queries.total, 3);
      assert.deepEqual(data.queries.topTools[0], { tool: 'lookup_dictionary', calls: 2 });
    } finally {
      db.close();
    }
  });

  it('scales sections to the limit and reports no drift on one snapshot', () => {
    const db = seed();
    try {
      const data = projectBriefData(db, 'demo', 1);
      assert.equal(data.topFiles.length, 1);
      assert.equal(data.mostReferenced.length, 1);
      assert.equal(data.languages.length, 1);
      const fresh = new ArgusDb(':memory:');
      try {
        fresh.replaceFile('a.ts', 'h', [], []);
        fresh.takeSnapshot();
        assert.equal(projectBriefData(fresh, 'demo', undefined).drift, null);
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('getProjectBrief', () => {
  it('renders every section within budget', () => {
    const db = seed();
    try {
      const text = getProjectBrief(db, 'demo', {});
      assert.match(text, /Project brief for 'demo': 2 files, 4 symbols \(3 exported\), 2 recorded calls\./);
      assert.match(text, /Languages: ts \(2\)\./);
      assert.match(text, /Symbols by kind: function \(3\), class \(1\)\./);
      assert.match(text, /Largest files: src\/auth\.ts \(3\), src\/util\.ts \(1\)\./);
      assert.match(text, /Most referenced: clamp ×2 \(src\/util\.ts:1\)\./);
      assert.match(text, /Latest drift \(#1 → #2\): ~src\/auth\.ts \[function\] login/);
      assert.match(text, /Audit posture: dead-code \(1 findings @ .*\)\./);
      assert.match(text, /Agent activity: 3 tool calls, mostly lookup_dictionary \(2\), get_codebase_map \(1\)\./);
      assert.ok(text.length < 6000, `brief too long: ${text.length}`);
    } finally {
      db.close();
    }
  });

  it('says so on an empty index', () => {
    const db = new ArgusDb(':memory:');
    try {
      assert.match(getProjectBrief(db, 'demo', {}), /no indexed files yet/);
    } finally {
      db.close();
    }
  });
});

describe('brief API', () => {
  let engine: ParserEngine;
  before(async () => {
    engine = await ParserEngine.create();
  });

  it('serves the brief JSON for a live project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'argus-brief-'));
    writeFileSync(join(root, 'a.ts'), 'export function helper(): number {\n  return 1;\n}\n');
    const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, { watch: false, onError: () => {} });
    try {
      const handler = createRequestHandler(manager, { host: '127.0.0.1', port: 0, token: undefined, version: 'test' });
      const res = await callApi(handler, 'GET', '/api/projects/demo/brief');
      assert.equal(res.statusCode, 200);
      const body = res.json<{ project: string; files: number; mostReferenced: unknown[] }>();
      assert.equal(body.project, 'demo');
      assert.equal(body.files, 1);
    } finally {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
