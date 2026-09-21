import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgusDb } from '../src/db.js';
import { ParserEngine } from '../src/parser.js';
import { indexFile, syncRoot, toRelPath } from '../src/indexer.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'argus-idx-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(join(root, 'src', 'b.py'), 'def greet(name):\n    return f"hi {name}"\n');
  writeFileSync(join(root, 'src', 'notes.txt'), 'not code');
  writeFileSync(join(root, 'node_modules', 'dep', 'x.js'), 'export function hidden() {}\n');
  return root;
}

describe('indexer', () => {
  it('syncs supported files and skips ignored dirs/extensions', () => {
    const root = makeRoot();
    const db = new ArgusDb(':memory:');
    try {
      const stats = syncRoot(db, engine, root);
      assert.equal(stats.scanned, 2);
      assert.equal(stats.updated, 2);
      assert.equal(stats.removed, 0);
      assert.ok(db.getFile('src/a.ts'));
      assert.ok(db.getFile('src/b.py'));
      assert.equal(db.getFile('node_modules/dep/x.js'), undefined);
      assert.ok(db.searchSymbols('add', undefined, 10).length === 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when nothing changed (hash delta)', () => {
    const root = makeRoot();
    const db = new ArgusDb(':memory:');
    try {
      syncRoot(db, engine, root);
      const stats = syncRoot(db, engine, root);
      assert.equal(stats.updated, 0);
      assert.equal(stats.skipped, 2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-indexes only the modified file', () => {
    const root = makeRoot();
    const db = new ArgusDb(':memory:');
    try {
      syncRoot(db, engine, root);
      writeFileSync(join(root, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n');
      const stats = syncRoot(db, engine, root);
      assert.equal(stats.updated, 1);
      assert.equal(stats.skipped, 1);
      assert.equal(db.searchSymbols('sub', undefined, 10).length, 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes stale rows for deleted files', () => {
    const root = makeRoot();
    const db = new ArgusDb(':memory:');
    try {
      syncRoot(db, engine, root);
      rmSync(join(root, 'src', 'b.py'));
      const stats = syncRoot(db, engine, root);
      assert.equal(stats.removed, 1);
      assert.equal(db.getFile('src/b.py'), undefined);
      assert.equal(db.searchSymbols('greet', undefined, 10).length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexFile reports unchanged/updated/failed distinctly', () => {
    const root = makeRoot();
    const db = new ArgusDb(':memory:');
    try {
      const abs = join(root, 'src', 'a.ts');
      assert.equal(indexFile(db, engine, root, abs), 'updated');
      assert.equal(indexFile(db, engine, root, abs), 'unchanged');
      assert.equal(indexFile(db, engine, root, join(root, 'missing.ts')), 'failed');
      assert.equal(toRelPath(root, abs), 'src/a.ts');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
