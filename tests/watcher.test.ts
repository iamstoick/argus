import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgusDb } from '../src/db.js';
import { ParserEngine } from '../src/parser.js';
import { watchRoot } from '../src/indexer.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

async function pollFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('watchRoot', () => {
  it('re-indexes on add/change and deletes on unlink', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'argus-watch-'));
    writeFileSync(join(root, 'a.ts'), 'export function one(): number {\n  return 1;\n}\n');
    const db = new ArgusDb(':memory:');
    let watchErr: string | undefined;
    const handle = watchRoot(db, engine, root, (err) => {
      watchErr = err instanceof Error ? err.message : String(err);
    });
    const skipIfUnwatchable = (): boolean => {
      if (watchErr === undefined) return false;
      t.skip(`OS file watching unavailable here (${watchErr}); skipping live-watcher test`);
      return true;
    };
    try {
      await Promise.race([
        handle.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('watcher ready timeout')), 10000)),
      ]);
      if (skipIfUnwatchable()) return;
      // add
      writeFileSync(join(root, 'b.py'), 'def two():\n    return 2\n');
      if (!(await pollFor(() => db.getFile('b.py') !== undefined, 8000))) {
        if (skipIfUnwatchable()) return;
        assert.fail('add not indexed');
      }
      // change
      const before = db.getFile('a.ts')?.hash;
      writeFileSync(join(root, 'a.ts'), 'export function one(): number {\n  return 1;\n}\nexport function uno(): number {\n  return 1;\n}\n');
      if (!(await pollFor(() => db.getFile('a.ts')?.hash !== before, 8000))) {
        if (skipIfUnwatchable()) return;
        assert.fail('change not indexed');
      }
      assert.equal(db.searchSymbols('uno', undefined, 10).length, 1);
      if (skipIfUnwatchable()) return;
      // unlink
      rmSync(join(root, 'b.py'));
      if (!(await pollFor(() => db.getFile('b.py') === undefined, 8000))) {
        if (skipIfUnwatchable()) return;
        assert.fail('unlink not indexed');
      }
    } finally {
      await handle.watcher.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
