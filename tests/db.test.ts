import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgusDb } from '../src/db.js';

function seed(db: ArgusDb): void {
  db.replaceFile(
    'src/a.ts',
    'h1',
    [
      { name: 'add', kind: 'function', signature: 'add(a, b)', docstring: null, startLine: 1, endLine: 3, isExported: true },
      { name: 'Store.save', kind: 'method', signature: 'save(x)', docstring: 'Saves.', startLine: 5, endLine: 8, isExported: true },
    ],
    [
      { callerIndex: 1, calleeName: 'add', type: 'calls' },
      { callerIndex: 1, calleeName: 'Base', type: 'extends' },
    ],
  );
  db.replaceFile(
    'src/b.py',
    'h2',
    [{ name: 'greet', kind: 'function', signature: 'def greet(n):', docstring: null, startLine: 1, endLine: 2, isExported: true }],
    [],
  );
}

describe('ArgusDb', () => {
  it('upserts files and replaces symbols atomically', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      assert.equal(db.getFile('src/a.ts')?.hash, 'h1');
      assert.equal(db.countSymbols(), 3);
      // Replace with fewer symbols: old rows gone.
      db.replaceFile('src/a.ts', 'h1b', [], []);
      assert.equal(db.getFile('src/a.ts')?.hash, 'h1b');
      assert.equal(db.countSymbols(), 1);
    } finally {
      db.close();
    }
  });

  it('cascades file delete to symbols and relationships', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      db.deleteFile('src/a.ts');
      assert.equal(db.getFile('src/a.ts'), undefined);
      assert.equal(db.countSymbols(), 1);
      assert.deepEqual(db.outgoing([1, 2]), []);
    } finally {
      db.close();
    }
  });

  it('searches by name/signature with kind filter', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      assert.equal(db.searchSymbols('sav', undefined, 10).length, 1);
      assert.equal(db.searchSymbols('save', 'method', 10).length, 1);
      assert.equal(db.searchSymbols('save', 'function', 10).length, 0);
      const rows = db.searchSymbols('greet', undefined, 10);
      assert.equal(rows[0]?.path, 'src/b.py');
    } finally {
      db.close();
    }
  });

  it('treats LIKE wildcards in queries literally', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      assert.equal(db.searchSymbols('%', undefined, 10).length, 0);
      assert.equal(db.searchSymbols('_', undefined, 10).length, 0);
    } finally {
      db.close();
    }
  });

  it('resolves outgoing and incoming relationships', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      const save = db.symbolsByNameExact('Store.save');
      assert.equal(save.length, 1);
      const callerId = save[0]?.id ?? 0;
      const out = db.outgoing([callerId]);
      assert.ok(out.some((r) => r.callee_name === 'add' && r.relationship_type === 'calls'));
      assert.ok(out.some((r) => r.callee_name === 'Base' && r.relationship_type === 'extends'));
      const incoming = db.incoming('add', 10);
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0]?.caller_name, 'Store.save');
      assert.equal(incoming[0]?.caller_path, 'src/a.ts');
    } finally {
      db.close();
    }
  });

  it('dedupes repeated identical relationships', () => {
    const db = new ArgusDb(':memory:');
    try {
      db.replaceFile(
        'a.ts',
        'h',
        [{ name: 'f', kind: 'function', signature: 'f()', docstring: null, startLine: 1, endLine: 1, isExported: true }],
        [
          { callerIndex: 0, calleeName: 'g', type: 'calls' },
          { callerIndex: 0, calleeName: 'g', type: 'calls' },
        ],
      );
      assert.equal(db.outgoing([1]).length, 1);
    } finally {
      db.close();
    }
  });

  it('reports last parse time and kind counts', () => {
    const db = new ArgusDb(':memory:');
    try {
      assert.equal(db.lastParsedAt(), null);
      assert.deepEqual(db.countByKind(), {});
      seed(db);
      assert.match(db.lastParsedAt() ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.deepEqual(db.countByKind(), { function: 2, method: 1 });
    } finally {
      db.close();
    }
  });

  it('lists exported symbols by module prefix', () => {
    const db = new ArgusDb(':memory:');
    try {
      seed(db);
      assert.equal(db.exportedSymbolsByFile(undefined, 10).length, 3);
      assert.equal(db.exportedSymbolsByFile('src/a', 10).length, 2);
      assert.equal(db.exportedSymbolsByFile('nope', 10).length, 0);
    } finally {
      db.close();
    }
  });
});
