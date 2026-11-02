/** Confidence labels: parser provenance, stored edges, blast/dead surfacing. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArgusDb } from '../src/db.js';
import { ParserEngine } from '../src/parser.js';
import { syncRoot } from '../src/indexer.js';
import { checkBlastRadius, deadCodeData, findDeadCode } from '../src/tools.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function seedRoot(): { root: string; db: ArgusDb } {
  const root = mkdtempSync(join(tmpdir(), 'argus-confidence-'));
  writeFileSync(
    join(root, 'lib.ts'),
    `export class A {\n  save(x: string): string {\n    return x;\n  }\n  load(x: string): string {\n    return x;\n  }\n}\n\nexport class B {\n  save(x: string): string {\n    return x;\n  }\n}\n`,
  );
  writeFileSync(
    join(root, 'main.ts'),
    `import { A } from './lib';\n\nfunction run(): string {\n  return save('x');\n}\n\nfunction boot(a: A): string {\n  return a.load('x');\n}\n`,
  );
  const db = new ArgusDb(':memory:');
  syncRoot(db, engine, root);
  return { root, db };
}

describe('relationship confidence', () => {
  it('labels direct calls EXTRACTED and member calls INFERRED', () => {
    const res = engine.parseFile(
      'a.ts',
      [
        'export function save(doc: string): void {}',
        'export class Store {',
        '  persist(item: string): void {',
        '    save(item);',
        '    item.trim();',
        '  }',
        '}',
        'export class Archive extends Store {}',
        '',
      ].join('\n'),
    );
    assert.equal(res.ok, true, `parse failed: ${res.ok ? '' : res.reason}`);
    const byName = new Map((res.ok ? res.symbols : []).map((s) => [s.name, s]));
    const persist = byName.get('Store.persist');
    assert.ok(persist);
    const byCallee = new Map(persist.calls.map((c) => [c.callee, c.confidence]));
    assert.equal(byCallee.get('save'), 'EXTRACTED');
    assert.equal(byCallee.get('trim'), 'INFERRED');
    const archive = byName.get('Archive');
    assert.ok(archive);
    assert.equal(archive.calls.find((c) => c.callee === 'Store')?.confidence, 'EXTRACTED');
  });

  it('tags blast radius edges with effective confidence', () => {
    const { root, db } = seedRoot();
    try {
      // save() is a direct call but two classes share the simple name: ambiguous.
      const ambiguous = checkBlastRadius(db, { symbol_name: 'run' });
      assert.match(ambiguous, /save/);
      assert.match(ambiguous, /\[AMBIGUOUS\]/);
      // a.load() is a member call rebound by name with one candidate: inferred.
      const inferred = checkBlastRadius(db, { symbol_name: 'boot' });
      assert.match(inferred, /load/);
      assert.match(inferred, /\[INFERRED\]/);
      assert.match(inferred, /Confidence:/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags symbols kept alive by inferred refs only for review', () => {
    const { root, db } = seedRoot();
    try {
      const data = deadCodeData(db, true, undefined);
      const dead = data.symbols.map((s) => s.name);
      const review = data.review.map((s) => s.name);
      // A.load is only ever called as a.load(...) — never report it dead, but flag it.
      assert.ok(!dead.includes('A.load'));
      assert.ok(review.includes('A.load'));
      // A.save/B.save share one direct-call name: alive but ambiguous, so review.
      assert.ok(review.includes('A.save'));
      assert.match(findDeadCode(db, { include_exported: true }), /review/i);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates pre-confidence databases to EXTRACTED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-conf-mig-'));
    try {
      const dbPath = join(dir, 'm.db');
      const db = new ArgusDb(dbPath);
      db.replaceFile(
        'a.ts',
        'h1',
        [{ name: 'f', kind: 'function', signature: 'f()', docstring: null, startLine: 1, endLine: 2, isExported: false }],
        [{ callerIndex: 0, calleeName: 'g', type: 'calls', confidence: 'INFERRED' }],
      );
      db.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec('ALTER TABLE symbol_relationships DROP COLUMN confidence');
      raw.close();
      const migrated = new ArgusDb(dbPath);
      try {
        const ids = migrated.symbolsByNameExact('f').map((s) => s.id);
        const out = migrated.outgoing(ids);
        assert.equal(out[0]?.confidence, 'EXTRACTED');
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
