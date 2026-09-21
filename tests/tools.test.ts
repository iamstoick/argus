import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgusDb } from '../src/db.js';
import { ParserEngine } from '../src/parser.js';
import { syncRoot } from '../src/indexer.js';
import { checkBlastRadius, getCodebaseMap, getSymbolDetails, lookupDictionary } from '../src/tools.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function seedRoot(): { root: string; db: ArgusDb } {
  const root = mkdtempSync(join(tmpdir(), 'argus-tools-'));
  writeFileSync(
    join(root, 'users.ts'),
    `/** Fetch one user. */\nexport async function getUser(id: string): Promise<string> {\n  return normalize(id);\n}\n\nfunction normalize(id: string): string {\n  return id.trim();\n}\n\nexport class UserStore {\n  /** Load and cache. */\n  load(id: string): string {\n    return normalize(id);\n  }\n}\n`,
  );
  writeFileSync(join(root, 'main.py'), `def run():\n    """Entry point."""\n    return 0\n`);
  const db = new ArgusDb(':memory:');
  syncRoot(db, engine, root);
  return { root, db };
}

describe('lookup_dictionary', () => {
  it('finds symbols with signatures, paths, lines, docstrings', () => {
    const { root, db } = seedRoot();
    try {
      const out = lookupDictionary(db, { query: 'getUser' });
      assert.match(out, /getUser/);
      assert.match(out, /users\.ts:2/);
      assert.match(out, /async function getUser\(id: string\): Promise<string>/);
      assert.match(out, /Fetch one user/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters by kind and reports no-match safely', () => {
    const { root, db } = seedRoot();
    try {
      assert.match(lookupDictionary(db, { query: 'load', kind: 'method' }), /UserStore\.load/);
      assert.match(lookupDictionary(db, { query: 'load', kind: 'class' }), /No symbols matching/);
      assert.match(lookupDictionary(db, { query: 'zzz-nope' }), /Safe to create/);
      assert.match(lookupDictionary(db, { query: 'x', kind: 'bogus' }), /Unknown kind/);
      assert.match(lookupDictionary(db, { query: '   ' }), /Empty query/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('get_codebase_map', () => {
  it('groups exported symbols per file and filters by prefix', () => {
    const { root, db } = seedRoot();
    try {
      const out = getCodebaseMap(db, {});
      assert.match(out, /users\.ts:/);
      assert.match(out, /getUser/);
      assert.match(out, /main\.py:/);
      assert.doesNotMatch(out, /normalize/); // unexported
      assert.match(getCodebaseMap(db, { module_path: 'main' }), /main\.py/);
      assert.doesNotMatch(getCodebaseMap(db, { module_path: 'main' }), /users\.ts/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('get_symbol_details', () => {
  it('returns the exact source block by id and by name', () => {
    const { root, db } = seedRoot();
    try {
      const [row] = db.symbolsByNameExact('UserStore.load');
      assert.ok(row);
      const byId = getSymbolDetails(db, root, { symbol_id: row.id });
      assert.match(byId, /load\(id: string\): string/);
      assert.match(byId, /return normalize\(id\);/);
      const byName = getSymbolDetails(db, root, { symbol_name: 'UserStore.load' });
      assert.equal(byName, byId);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles missing and ambiguous references', () => {
    const { root, db } = seedRoot();
    try {
      assert.match(getSymbolDetails(db, root, { symbol_id: 9999 }), /No symbol with id/);
      assert.match(getSymbolDetails(db, root, { symbol_name: 'zzz' }), /No symbol named/);
      assert.match(getSymbolDetails(db, root, {}), /Pass symbol_id or symbol_name/);
      assert.match(getSymbolDetails(db, root, { symbol_id: -1 }), /Invalid symbol_id/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check_blast_radius', () => {
  it('traces incoming and outgoing refs', () => {
    const { root, db } = seedRoot();
    try {
      const out = checkBlastRadius(db, { symbol_name: 'normalize' });
      assert.match(out, /Incoming dependents/);
      assert.match(out, /getUser/);
      assert.match(out, /UserStore\.load/);
      const out2 = checkBlastRadius(db, { symbol_name: 'getUser' });
      assert.match(out2, /Outgoing dependencies/);
      assert.match(out2, /normalize/);
      assert.match(checkBlastRadius(db, { symbol_name: 'zzz' }), /No symbol matching/);
      assert.match(checkBlastRadius(db, { symbol_name: '  ' }), /Empty symbol_name/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
