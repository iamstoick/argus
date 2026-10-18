import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgusDb } from '../src/db.js';
import type { EmbeddingProvider } from '../src/embeddings.js';
import { HnswIndex, cosineDistance, mulberry32 } from '../src/hnsw.js';
import { lookupDictionaryHybrid, type HybridStats } from '../src/tools.js';
import { VectorIndex } from '../src/vectorIndex.js';

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomUnit(rand: () => number, dim: number): number[] {
  const v = Array.from({ length: dim }, () => gaussian(rand));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function bruteTopK(points: number[][], q: number[], k: number): number[] {
  return points
    .map((p, id) => ({ id, dist: cosineDistance(q, p) }))
    .sort((a, b) => a.dist - b.dist || a.id - b.id)
    .slice(0, k)
    .map((h) => h.id);
}

describe('HnswIndex', () => {
  it('recalls brute-force neighbors on clustered data', () => {
    const dim = 32;
    const perCluster = 75;
    const clusters = 8;
    const rand = mulberry32(7);
    const centers = Array.from({ length: clusters }, () => randomUnit(rand, dim));
    const points: number[][] = [];
    for (const c of centers) {
      for (let i = 0; i < perCluster; i++) {
        const p = c.map((x) => x + gaussian(rand) * 0.25);
        const norm = Math.sqrt(p.reduce((s, x) => s + x * x, 0)) || 1;
        points.push(p.map((x) => x / norm));
      }
    }
    const index = new HnswIndex();
    points.forEach((p, id) => index.insert(id, p));
    assert.equal(index.size, points.length);
    let recallSum = 0;
    const queries = 20;
    for (let i = 0; i < queries; i++) {
      const center = centers[i % clusters] as number[];
      const qRaw = center.map((x) => x + gaussian(rand) * 0.1);
      const norm = Math.sqrt(qRaw.reduce((s, x) => s + x * x, 0)) || 1;
      const q = qRaw.map((x) => x / norm);
      const expected = new Set(bruteTopK(points, q, 10));
      const got = index.query(q, 10).map((h) => h.id);
      recallSum += got.filter((id) => expected.has(id)).length / 10;
    }
    assert.ok(recallSum / queries >= 0.9, `recall@${10} = ${recallSum / queries}`);
  });

  it('builds deterministically for the same insertion order', () => {
    const rand = mulberry32(99);
    const points = Array.from({ length: 120 }, () => randomUnit(rand, 16));
    const queries = Array.from({ length: 10 }, () => randomUnit(rand, 16));
    const build = (): number[][] => {
      const index = new HnswIndex();
      points.forEach((p, id) => index.insert(id, p));
      return queries.map((q) => index.query(q, 5).map((h) => h.id));
    };
    assert.deepEqual(build(), build());
  });

  it('round-trips through serialize and drops vectorless nodes on attach', () => {
    const rand = mulberry32(3);
    const points = Array.from({ length: 60 }, () => randomUnit(rand, 8));
    const index = new HnswIndex();
    points.forEach((p, id) => index.insert(id, p));
    const q = randomUnit(rand, 8);
    const before = index.query(q, 5).map((h) => h.id);
    const payload = index.serialize();
    const restored = new HnswIndex();
    restored.deserialize(payload);
    restored.attach(new Map(points.map((p, id) => [id, p] as [number, number[]])));
    assert.deepEqual(
      restored.query(q, 5).map((h) => h.id),
      before,
    );
    assert.throws(() => new HnswIndex().deserialize('{"v":99}'), /unsupported payload version/);
    assert.throws(() => new HnswIndex().deserialize('{"v":1}'), /malformed payload/);
    assert.throws(() => new HnswIndex().deserialize('nope'), SyntaxError);
    const partial = new HnswIndex();
    partial.deserialize(payload);
    partial.attach(new Map([[0, points[0] as number[]]]));
    assert.equal(partial.size, 1);
  });

  it('hides lazy-deleted ids and flags rebuild pressure', () => {
    const rand = mulberry32(11);
    const index = new HnswIndex();
    const points = Array.from({ length: 40 }, () => randomUnit(rand, 8));
    points.forEach((p, id) => index.insert(id, p));
    const q = points[0] as number[];
    assert.ok(index.query(q, 3).some((h) => h.id === 0));
    index.remove(0);
    assert.ok(!index.query(q, 5).some((h) => h.id === 0));
    assert.equal(index.has(0), false);
    assert.equal(index.needsRebuild, false);
    for (let id = 1; id <= 12; id++) index.remove(id);
    assert.equal(index.needsRebuild, true);
  });

  it('rejects dimension mismatches and empty queries', () => {
    const index = new HnswIndex();
    index.insert(1, [1, 0]);
    assert.throws(() => index.insert(2, [1, 0, 0]), /dimension mismatch/);
    assert.deepEqual(index.query([1, 0, 0], 5), []);
    assert.deepEqual(index.query([1, 0], 0), []);
    assert.deepEqual(new HnswIndex().query([1, 0], 5), []);
  });
});

describe('VectorIndex', () => {
  function seedDb(): { db: ArgusDb; ids: number[] } {
    const db = new ArgusDb(':memory:');
    db.replaceFile(
      'a.ts',
      'h1',
      [
        { name: 'north', kind: 'function', signature: 'north()', docstring: null, startLine: 1, endLine: 1, isExported: true },
        { name: 'northEast', kind: 'function', signature: 'northEast()', docstring: null, startLine: 3, endLine: 3, isExported: true },
        { name: 'south', kind: 'function', signature: 'south()', docstring: null, startLine: 5, endLine: 5, isExported: true },
      ],
      [],
    );
    const ids = ['north', 'northEast', 'south'].map((n) => {
      const row = db.symbolsByNameExact(n)[0];
      assert.ok(row !== undefined);
      return row.id;
    });
    db.replaceVectors([
      { symbolId: ids[0] as number, dim: 4, vec: [1, 0, 0, 0] },
      { symbolId: ids[1] as number, dim: 4, vec: [0.9, 0.1, 0, 0] },
      { symbolId: ids[2] as number, dim: 4, vec: [-1, 0, 0, 0] },
    ]);
    return { db, ids: ids as number[] };
  }

  it('rebuilds from stored vectors and gates on positive similarity', async () => {
    const { db, ids } = seedDb();
    try {
      const index = VectorIndex.empty();
      assert.equal(index.search([1, 0, 0, 0], 5, new Set()), undefined); // not ready yet
      await index.sync(db);
      assert.equal(index.isReady, true);
      assert.equal(index.lastSyncMode, 'rebuild');
      assert.equal(index.dimension, 4);
      const northId = ids[0] as number;
      const northEastId = ids[1] as number;
      const hits = index.search([1, 0, 0, 0], 5, new Set());
      assert.deepEqual(hits, [northId, northEastId]); // opposite vector gated out (sim <= 0)
      const excluded = index.search([1, 0, 0, 0], 5, new Set([northId]));
      assert.deepEqual(excluded, [northEastId]);
      assert.equal(index.search([1, 0], 5, new Set()), undefined); // dim mismatch
    } finally {
      db.close();
    }
  });

  it('catches up incrementally on add and remove', async () => {
    const { db, ids } = seedDb();
    try {
      const index = VectorIndex.empty();
      await index.sync(db);
      db.replaceFile(
        'b.ts',
        'h2',
        [{ name: 'northWest', kind: 'function', signature: 'northWest()', docstring: null, startLine: 1, endLine: 1, isExported: true }],
        [],
      );
      const added = db.symbolsByNameExact('northWest')[0];
      assert.ok(added !== undefined);
      db.replaceVectors([{ symbolId: added.id, dim: 4, vec: [0.95, -0.05, 0, 0] }]);
      await index.sync(db);
      assert.equal(index.lastSyncMode, 'incremental');
      const hits = index.search([1, 0, 0, 0], 5, new Set());
      assert.ok(hits?.includes(added.id));
      db.deleteFile('b.ts'); // cascades to symbol_vectors
      await index.sync(db);
      assert.ok(!index.search([1, 0, 0, 0], 5, new Set())?.includes(added.id));
      assert.ok(ids.length === 3);
    } finally {
      db.close();
    }
  });

  it('rebuilds on dimension change and reattaches persisted graphs', async () => {
    const { db } = seedDb();
    try {
      const index = VectorIndex.empty();
      await index.sync(db);
      assert.equal(index.attachedFromDisk, false);
      const again = VectorIndex.empty();
      await again.sync(db);
      assert.equal(again.attachedFromDisk, true);
      assert.equal(again.lastSyncMode, 'incremental');
      assert.deepEqual(again.search([1, 0, 0, 0], 5, new Set()), index.search([1, 0, 0, 0], 5, new Set()));
      const old = db.symbolVectors();
      db.clearVectorDimsExcept(2);
      for (const v of old) db.replaceVectors([{ symbolId: v.symbolId, dim: 2, vec: v.vec.slice(0, 2) }]);
      await index.sync(db);
      assert.equal(index.lastSyncMode, 'rebuild');
      assert.equal(index.dimension, 2);
      assert.ok((index.search([1, 0], 5, new Set())?.length ?? 0) > 0);
    } finally {
      db.close();
    }
  });

  it('recovers from corrupt persisted graphs', async () => {
    const { db } = seedDb();
    try {
      const index = VectorIndex.empty();
      await index.sync(db);
      db.setVectorIndex(4, '{"v":1,"broken":true}');
      const fresh = VectorIndex.empty();
      await fresh.sync(db);
      assert.equal(fresh.attachedFromDisk, false);
      assert.equal(fresh.lastSyncMode, 'rebuild');
      assert.ok((fresh.search([1, 0, 0, 0], 5, new Set())?.length ?? 0) > 0);
    } finally {
      db.close();
    }
  });

  it('serves hybrid semantic matches end to end', async () => {
    const { db } = seedDb();
    try {
      const index = VectorIndex.empty();
      await index.sync(db);
      const provider: EmbeddingProvider = { name: 'stub', embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])) };
      const stats: HybridStats = { exact: 0, lexical: 0, semantic: 0, degraded: false };
      const out = await lookupDictionaryHybrid(db, { query: 'qqq zzz' }, provider, stats, index);
      assert.match(out, /similar \(semantic\)/);
      assert.match(out, /north/);
      assert.equal(stats.semantic, 2);
    } finally {
      db.close();
    }
  });
});
