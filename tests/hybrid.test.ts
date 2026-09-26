import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArgusDb } from '../src/db.js';
import { ParserEngine } from '../src/parser.js';
import { syncRoot } from '../src/indexer.js';
import { lookupDictionary, lookupDictionaryHybrid } from '../src/tools.js';
import {
  OllamaEmbeddings,
  cosineSimilarity,
  symbolEmbedText,
  syncSymbolVectors,
  type EmbeddingProvider,
} from '../src/embeddings.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function seedRoot(): { root: string; db: ArgusDb } {
  const root = mkdtempSync(join(tmpdir(), 'argus-hybrid-'));
  writeFileSync(
    join(root, 'users.ts'),
    `/** Fetch one user. */\nexport async function getUser(id: string): Promise<string> {\n  return normalize(id);\n}\n\nfunction normalize(id: string): string {\n  return id.trim();\n}\n\nexport class UserStore {\n  /** Load and cache. */\n  load(id: string): string {\n    return normalize(id);\n  }\n}\n`,
  );
  writeFileSync(
    join(root, 'retry.ts'),
    `/** Retry an operation with backoff. */\nexport function withRetry(fn: () => void): void {\n  fn();\n}\n`,
  );
  const db = new ArgusDb(':memory:');
  syncRoot(db, engine, root);
  return { root, db };
}

function withSeededDb(fn: (db: ArgusDb) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const { root, db } = seedRoot();
    try {
      await fn(db);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('lexical fuzzy search', () => {
  it(
    'finds docstring-only tokens that exact search misses',
    withSeededDb((db) => {
      assert.equal(db.searchSymbols('cache', undefined, 10).length, 0);
      const rows = db.searchSymbolsFuzzy('cache', undefined, 10);
      assert.ok(rows.some((r) => r.name === 'UserStore.load'));
    }),
  );

  it(
    'tolerates typos that exact search misses',
    withSeededDb((db) => {
      assert.equal(db.searchSymbols('noramlize', undefined, 10).length, 0);
      assert.ok(db.searchSymbolsFuzzy('noramlize', undefined, 10).some((r) => r.name === 'normalize'));
      assert.ok(db.searchSymbolsFuzzy('getUsre', undefined, 10).some((r) => r.name === 'getUser'));
    }),
  );

  it(
    'matches prefix fragments and multi-token queries',
    withSeededDb((db) => {
      assert.ok(db.searchSymbolsFuzzy('getUs', undefined, 10).some((r) => r.name === 'getUser'));
      assert.ok(db.searchSymbolsFuzzy('retry backoff', undefined, 10).some((r) => r.name === 'withRetry'));
    }),
  );

  it(
    'respects the kind filter',
    withSeededDb((db) => {
      assert.equal(db.searchSymbolsFuzzy('load', 'class', 10).length, 0);
      assert.equal(db.searchSymbolsFuzzy('load', 'method', 10).length, 1);
    }),
  );

  it(
    'never throws on FTS syntax or empty input',
    withSeededDb((db) => {
      for (const q of ['" OR * : NEAR(', '!!!', '', '   ', 'a"b"c']) {
        assert.ok(Array.isArray(db.searchSymbolsFuzzy(q, undefined, 10)));
      }
    }),
  );

  it('rebuilds the FTS index for pre-existing databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-fts-migrate-'));
    const dbPath = join(dir, '.mcp-codebase.db');
    try {
      // Simulate a pre-FTS database: files + symbols tables only, no FTS objects.
      const raw = new DatabaseSync(dbPath);
      raw.exec(
        `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, docstring TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, is_exported BOOLEAN NOT NULL DEFAULT 0);`,
      );
      raw.exec(`INSERT INTO files (path, hash) VALUES ('old.ts', 'h')`);
      raw.exec(
        `INSERT INTO symbols (file_id, name, kind, signature, docstring, start_line, end_line, is_exported)
         VALUES (1, 'legacyWidget', 'function', 'legacyWidget()', 'Ancient helper.', 1, 3, 1)`,
      );
      raw.close();
      const db = new ArgusDb(dbPath);
      try {
        assert.ok(db.searchSymbolsFuzzy('legacy', undefined, 10).some((r) => r.name === 'legacyWidget'));
        assert.ok(db.searchSymbolsFuzzy('ancient helper', undefined, 10).some((r) => r.name === 'legacyWidget'));
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('symbol vectors', () => {
  it(
    'round-trips vectors and clears stale rows on replace and delete',
    withSeededDb((db) => {
      const [target] = db.symbolsByNameExact('getUser');
      assert.ok(target);
      db.replaceVectors([{ symbolId: target.id, dim: 2, vec: [0.5, -0.25] }]);
      assert.equal(db.countVectors(), 1);
      const stored = db.symbolVectors();
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.symbolId, target.id);
      assert.equal(stored[0]?.dim, 2);
      assert.deepEqual(stored[0]?.vec, [0.5, -0.25]);
      // Replacing the file drops its vectors (symbol ids are regenerated).
      db.replaceFile('users.ts', 'h-new', [], []);
      assert.equal(db.countVectors(), 0);
      const [retry] = db.symbolsByNameExact('withRetry');
      assert.ok(retry);
      db.replaceVectors([{ symbolId: retry.id, dim: 2, vec: [1, 0] }]);
      assert.equal(db.countVectors(), 1);
      db.deleteFile('retry.ts');
      assert.equal(db.countVectors(), 0);
    }),
  );
});

describe('lookupDictionaryHybrid', () => {
  it(
    'keeps default lookup exact-only',
    withSeededDb((db) => {
      assert.match(lookupDictionary(db, { query: 'noramlize' }), /Safe to create/);
      assert.match(lookupDictionary(db, { query: 'cache' }), /Safe to create/);
    }),
  );

  it(
    'finds similar symbols when exact misses',
    withSeededDb(async (db) => {
      const out = await lookupDictionaryHybrid(db, { query: 'noramlize' });
      assert.match(out, /No exact matches/);
      assert.match(out, /normalize/);
      const out2 = await lookupDictionaryHybrid(db, { query: 'cache' });
      assert.match(out2, /UserStore\.load/);
    }),
  );

  it(
    'lists exact matches before similar ones',
    withSeededDb(async (db) => {
      const out = await lookupDictionaryHybrid(db, { query: 'getUser' });
      assert.match(out, /Found .* matching 'getUser'/);
      assert.match(out, /getUser/);
      const divider = out.indexOf('--- similar');
      if (divider >= 0) {
        assert.ok(out.indexOf('getUser') < divider);
      }
    }),
  );

  it(
    'validates kind and empty query like exact mode',
    withSeededDb(async (db) => {
      assert.match(await lookupDictionaryHybrid(db, { query: 'x', kind: 'bogus' }), /Unknown kind/);
      assert.match(await lookupDictionaryHybrid(db, { query: '   ' }), /Empty query/);
      assert.match(await lookupDictionaryHybrid(db, { query: 'zzz-nope' }), /Safe to create/);
      assert.match(await lookupDictionaryHybrid(db, { query: 'load', kind: 'class' }), /Safe to create/);
    }),
  );
});

/** Canned provider: probe query maps to e1, everything else to e2. */
function stubProvider(calls: string[][]): EmbeddingProvider {
  return {
    name: 'stub',
    embed: (texts: string[]) => {
      calls.push(texts);
      return Promise.resolve(
        texts.map((t) => (t.includes('SEMANTIC_PROBE') ? [1, 0] : [0, 1])),
      );
    },
  };
}

describe('semantic cascade', () => {
  it(
    'blends semantic matches after lexical ones',
    withSeededDb(async (db) => {
      const [retry] = db.symbolsByNameExact('withRetry');
      const [user] = db.symbolsByNameExact('getUser');
      assert.ok(retry && user);
      db.replaceVectors([
        { symbolId: retry.id, dim: 2, vec: [1, 0] },
        { symbolId: user.id, dim: 2, vec: [0, 1] },
      ]);
      const out = await lookupDictionaryHybrid(db, { query: 'SEMANTIC_PROBE zzzqqq' }, stubProvider([]));
      assert.match(out, /withRetry/);
      assert.match(out, /semantic/);
      assert.doesNotMatch(out, /getUser/);
    }),
  );

  it(
    'skips the semantic tier on dimension mismatch',
    withSeededDb(async (db) => {
      const [retry] = db.symbolsByNameExact('withRetry');
      assert.ok(retry);
      db.replaceVectors([{ symbolId: retry.id, dim: 2, vec: [1, 0] }]);
      const wrongDim: EmbeddingProvider = {
        name: 'wrong-dim',
        embed: (texts: string[]) => Promise.resolve(texts.map(() => [1, 0, 0])),
      };
      const out = await lookupDictionaryHybrid(db, { query: 'SEMANTIC_PROBE zzzqqq' }, wrongDim);
      assert.match(out, /Safe to create/);
    }),
  );
});

describe('OllamaEmbeddings', () => {
  function startStub(handler: (body: string, url: string | undefined, method: string | undefined) => { status: number; json: unknown }): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const { status, json } = handler(body, req.url, req.method);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
      });
    });
  }

  /** Same convention as the HTTP live-socket test: sandboxes may block bind. */
  function isBindBlocked(err: unknown): boolean {
    const code = (err as { code?: string }).code;
    return code === 'EPERM' || code === 'EACCES';
  }

  it('probes presence and absence', async (t) => {
    let stub: { server: Server; port: number };
    try {
      stub = await startStub(() => ({ status: 200, json: { models: [] } }));
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      assert.equal(await new OllamaEmbeddings(`http://127.0.0.1:${stub.port}`).probe(), true);
    } finally {
      stub.server.close();
    }
    // Ephemeral closed port: connection refused -> false, never throws.
    const probe = await startStub(() => ({ status: 200, json: {} }));
    const closedPort = probe.port;
    probe.server.close();
    assert.equal(await new OllamaEmbeddings(`http://127.0.0.1:${closedPort}`, 'm', 500).probe(), false);
  });

  it('embeds batches and tolerates a trailing slash', async (t) => {
    const seen: Array<{ url: string | undefined; body: string }> = [];
    let server: Server;
    let port: number;
    try {
      ({ server, port } = await startStub((body, url) => {
        seen.push({ url, body });
        return { status: 200, json: { embeddings: [[0.1, 0.2], [0.3, 0.4]] } };
      }));
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      const provider = new OllamaEmbeddings(`http://127.0.0.1:${port}/`, 'embed-model');
      const vecs = await provider.embed(['a', 'b']);
      assert.deepEqual(vecs, [[0.1, 0.2], [0.3, 0.4]]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.url, '/api/embed');
      assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), { model: 'embed-model', input: ['a', 'b'] });
    } finally {
      server.close();
    }
  });

  it('throws a readable error on bad responses', async (t) => {
    let server: Server;
    let port: number;
    try {
      ({ server, port } = await startStub(() => ({ status: 500, json: { error: 'boom' } })));
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      await assert.rejects(() => new OllamaEmbeddings(`http://127.0.0.1:${port}`).embed(['a']), /ollama/i);
    } finally {
      server.close();
    }
    const bad = await startStub(() => ({ status: 200, json: { embeddings: 'nope' } }));
    try {
      await assert.rejects(() => new OllamaEmbeddings(`http://127.0.0.1:${bad.port}`).embed(['a']), /ollama/i);
    } finally {
      bad.server.close();
    }
  });

  it('computes cosine similarity and embed text', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    const text = symbolEmbedText({ name: 'getUser', kind: 'function', signature: 'getUser(id)', docstring: 'Fetch.' });
    assert.match(text, /getUser/);
    assert.match(text, /function/);
    assert.match(text, /Fetch\./);
  });

  it(
    'syncs only missing vectors and heals dimension changes',
    withSeededDb(async (db) => {
      const calls: string[][] = [];
      const first = await syncSymbolVectors(db, stubProvider(calls));
      assert.equal(first.embedded, db.countSymbols());
      assert.equal(first.cleared, 0);
      assert.equal(db.countVectors(), db.countSymbols());
      const callsBefore = calls.length;
      const second = await syncSymbolVectors(db, stubProvider(calls));
      assert.equal(second.embedded, 0);
      assert.equal(calls.length, callsBefore); // no HTTP when nothing is missing
    }),
  );

  it('heals dimension changes when new symbols arrive', async () => {
    const db = new ArgusDb(':memory:');
    try {
      db.replaceFile(
        'a.ts',
        'h1',
        [{ name: 'alpha', kind: 'function', signature: 'alpha()', docstring: null, startLine: 1, endLine: 1, isExported: true }],
        [],
      );
      db.replaceFile(
        'b.ts',
        'h2',
        [{ name: 'beta', kind: 'function', signature: 'beta()', docstring: null, startLine: 1, endLine: 1, isExported: true }],
        [],
      );
      // Stale dim-2 vector for alpha only; beta is missing -> sync must heal.
      const [alpha] = db.symbolsByNameExact('alpha');
      assert.ok(alpha);
      db.replaceVectors([{ symbolId: alpha.id, dim: 2, vec: [1, 0] }]);
      const dim3: EmbeddingProvider = {
        name: 'dim3',
        embed: (texts: string[]) => Promise.resolve(texts.map(() => [1, 0, 0])),
      };
      const stats = await syncSymbolVectors(db, dim3);
      assert.equal(stats.cleared, 1);
      assert.equal(stats.embedded, 2);
      assert.ok(db.symbolVectors().every((v) => v.dim === 3));
    } finally {
      db.close();
    }
  });
});
