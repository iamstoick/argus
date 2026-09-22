import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgusDb } from '../src/db.js';
import { deadCodeData, duplicateGroupsData, findDeadCode, findDuplicates } from '../src/tools.js';

function seed(): ArgusDb {
  const db = new ArgusDb(':memory:');
  db.replaceFile(
    'a.ts',
    'h1',
    [
      { name: 'boot', kind: 'function', signature: 'boot()', docstring: null, startLine: 1, endLine: 3, isExported: true },
      { name: 'used', kind: 'function', signature: 'used()', docstring: null, startLine: 5, endLine: 6, isExported: false },
      { name: 'lonely', kind: 'function', signature: 'lonely()', docstring: null, startLine: 8, endLine: 9, isExported: false },
      { name: 'main', kind: 'function', signature: 'main()', docstring: null, startLine: 11, endLine: 12, isExported: false },
      { name: 'Pub', kind: 'class', signature: 'class Pub', docstring: null, startLine: 14, endLine: 15, isExported: true },
      { name: 'Widget.__init__', kind: 'method', signature: '__init__(self)', docstring: null, startLine: 17, endLine: 18, isExported: false },
      { name: 'formatDate', kind: 'function', signature: 'formatDate(d)', docstring: null, startLine: 20, endLine: 21, isExported: false },
      { name: 'overloaded', kind: 'function', signature: 'overloaded(a)', docstring: null, startLine: 23, endLine: 24, isExported: false },
      { name: 'Repo.save', kind: 'method', signature: 'save(self, x)', docstring: null, startLine: 26, endLine: 27, isExported: false },
      { name: 'Config', kind: 'class', signature: 'class Config', docstring: null, startLine: 29, endLine: 30, isExported: true },
    ],
    [{ callerIndex: 0, calleeName: 'used', type: 'calls' }],
  );
  db.replaceFile(
    'b.ts',
    'h2',
    [
      { name: 'format_date', kind: 'function', signature: 'format_date(d)', docstring: null, startLine: 1, endLine: 2, isExported: false },
      { name: 'overloaded', kind: 'function', signature: 'overloaded(a, b)', docstring: null, startLine: 4, endLine: 5, isExported: false },
      { name: 'Store.save', kind: 'method', signature: 'save(self, x)', docstring: null, startLine: 7, endLine: 8, isExported: false },
      { name: 'Config', kind: 'class', signature: 'class Config', docstring: null, startLine: 10, endLine: 11, isExported: true },
    ],
    [],
  );
  return db;
}

describe('duplicateGroupsData', () => {
  it('groups same-name same-signature symbols across separator styles', () => {
    const db = seed();
    try {
      const data = duplicateGroupsData(db, undefined);
      assert.equal(data.truncated, false);
      assert.equal(data.groups.length, 2);
      const keys = data.groups.map((g) => g.key).sort();
      assert.deepEqual(keys, ['config', 'formatdate']);
      const fmt = data.groups.find((g) => g.key === 'formatdate');
      assert.equal(fmt?.symbols.length, 2);
      assert.deepEqual(
        fmt?.symbols.map((s) => s.path).sort(),
        ['a.ts', 'b.ts'],
      );
    } finally {
      db.close();
    }
  });

  it('ignores same-name-different-signature and same-name methods', () => {
    const db = seed();
    try {
      const data = duplicateGroupsData(db, undefined);
      assert.ok(!data.groups.some((g) => g.key === 'overloaded'));
      assert.ok(!data.groups.some((g) => g.key === 'save'));
    } finally {
      db.close();
    }
  });

  it('truncates to the limit', () => {
    const db = seed();
    try {
      const data = duplicateGroupsData(db, 1);
      assert.equal(data.groups.length, 1);
      assert.equal(data.truncated, true);
      assert.match(findDuplicates(db, {}), /duplicate group\(s\)/);
      const empty = new ArgusDb(':memory:');
      try {
        assert.equal(findDuplicates(empty, {}), 'No likely duplicates found.');
      } finally {
        empty.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('deadCodeData', () => {
  it('reports unexported orphans, skipping entries and constructors', () => {
    const db = seed();
    try {
      const data = deadCodeData(db, undefined, undefined);
      const names = data.symbols.map((s) => s.name).sort();
      // used = called; main/__init__ = entryish; Pub/boot/Config = exported.
      // formatDate/format_date/overloaded/Repo.save/Store.save have no callers either.
      assert.ok(names.includes('lonely'));
      assert.ok(!names.includes('used'));
      assert.ok(!names.includes('main'));
      assert.ok(!names.includes('Widget.__init__'));
      assert.ok(!names.includes('Pub'));
      assert.ok(!names.includes('boot'));
    } finally {
      db.close();
    }
  });

  it('includes exported orphans only on request', () => {
    const db = seed();
    try {
      const withPublic = deadCodeData(db, true, undefined);
      const names = withPublic.symbols.map((s) => s.name);
      assert.ok(names.includes('Pub'));
      assert.ok(names.includes('boot'));
      assert.match(findDeadCode(db, {}), /possibly-dead/);
      assert.match(findDeadCode(db, { include_exported: true }), /✓exported/);
    } finally {
      db.close();
    }
  });
});
