import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParserEngine } from '../src/parser.js';
import { IndexManager } from '../src/projects.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'argus-mgr-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

describe('IndexManager', () => {
  it('opens several projects with isolated indexes', async () => {
    const a = makeRoot({ 'a.ts': 'export function alpha(): number {\n  return 1;\n}\n' });
    const b = makeRoot({ 'b.py': 'def beta():\n    return 2\n' });
    const manager = await IndexManager.open(
      [
        { name: 'pa', path: a },
        { name: 'pb', path: b },
      ],
      engine,
      { watch: false, onError: () => {} },
    );
    try {
      assert.deepEqual(manager.names(), ['pa', 'pb']);
      const ea = manager.get('pa');
      const eb = manager.get('pb');
      assert.ok(ea && eb);
      assert.equal(ea.db.searchSymbols('alpha', undefined, 10).length, 1);
      assert.equal(ea.db.searchSymbols('beta', undefined, 10).length, 0);
      assert.equal(eb.db.searchSymbols('beta', undefined, 10).length, 1);
      assert.equal(eb.db.searchSymbols('alpha', undefined, 10).length, 0);
      const stats = manager.stats('pa');
      assert.equal(stats?.files, 1);
      assert.equal(stats?.symbols, 1);
      assert.equal(stats?.watching, false);
      assert.equal(manager.allStats().length, 2);
    } finally {
      await manager.close();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('resolve() defaults only with a single project', async () => {
    const a = makeRoot({ 'a.ts': 'export const x = 1;\n' });
    const solo = await IndexManager.open([{ name: 'only', path: a }], engine, { watch: false, onError: () => {} });
    try {
      assert.equal(solo.resolve(undefined).hasOwnProperty('entry'), true);
      assert.equal('error' in solo.resolve('nope'), true);
    } finally {
      await solo.close();
    }
    const b = makeRoot({ 'b.ts': 'export const y = 2;\n' });
    const multi = await IndexManager.open(
      [
        { name: 'pa', path: a },
        { name: 'pb', path: b },
      ],
      engine,
      { watch: false, onError: () => {} },
    );
    try {
      const amb = multi.resolve(undefined);
      assert.equal('error' in amb, true);
      const ok = multi.resolve('pb');
      assert.equal('entry' in ok, true);
    } finally {
      await multi.close();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('rejects missing paths, files, and duplicate paths', async () => {
    await assert.rejects(
      IndexManager.open([{ name: 'x', path: join(tmpdir(), 'argus-nope-missing') }], engine, {
        watch: false,
        onError: () => {},
      }),
      /does not exist/,
    );
    const root = makeRoot({ 'f.ts': 'export const z = 3;\n' });
    try {
      await assert.rejects(
        IndexManager.open([{ name: 'x', path: join(root, 'f.ts') }], engine, { watch: false, onError: () => {} }),
        /not a directory/,
      );
      await assert.rejects(
        IndexManager.open(
          [
            { name: 'a', path: root },
            { name: 'b', path: root },
          ],
          engine,
          { watch: false, onError: () => {} },
        ),
        /duplicate path/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
