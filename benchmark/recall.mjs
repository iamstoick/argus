#!/usr/bin/env node
/** ANN recall benchmark: HNSW vs brute force on synthetic clustered data.
 *
 * Deeper than the unit-test recall gate (tests/hnsw.test.ts): more points,
 * more queries, latency percentiles. Deterministic seed, so runs compare.
 * Run with `npm run benchmark` (builds first). Exits nonzero when mean
 * recall@k drops below threshold.
 */
import { HnswIndex, cosineDistance, mulberry32 } from '../dist/src/hnsw.js';

const DIM = 64;
const CLUSTERS = 20;
const PER_CLUSTER = 200; // 4000 points total
const QUERIES = 100;
const K = 10;
const THRESHOLD = 0.9;

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomUnit(rand, dim) {
  const v = Array.from({ length: dim }, () => gaussian(rand));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function bruteTopK(points, q, k) {
  return points
    .map((p, id) => ({ id, dist: cosineDistance(q, p) }))
    .sort((a, b) => a.dist - b.dist || a.id - b.id)
    .slice(0, k)
    .map((h) => h.id);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const rand = mulberry32(20261012);
const centers = Array.from({ length: CLUSTERS }, () => randomUnit(rand, DIM));
const points = [];
for (const c of centers) {
  for (let i = 0; i < PER_CLUSTER; i++) {
    const p = c.map((x) => x + gaussian(rand) * 0.25);
    const norm = Math.sqrt(p.reduce((s, x) => s + x * x, 0)) || 1;
    points.push(p.map((x) => x / norm));
  }
}
const queries = Array.from({ length: QUERIES }, (_, i) => {
  const center = centers[i % CLUSTERS];
  const raw = center.map((x) => x + gaussian(rand) * 0.1);
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
  return raw.map((x) => x / norm);
});

const buildStart = performance.now();
const index = new HnswIndex();
points.forEach((p, id) => index.insert(id, p));
const buildMs = performance.now() - buildStart;

let recallSum = 0;
const annLat = [];
let bruteMs = 0;
for (const q of queries) {
  const t0 = performance.now();
  const expected = new Set(bruteTopK(points, q, K));
  bruteMs += performance.now() - t0;
  const t1 = performance.now();
  const got = index.query(q, K).map((h) => h.id);
  annLat.push(performance.now() - t1);
  recallSum += got.filter((id) => expected.has(id)).length / K;
}
const meanRecall = recallSum / QUERIES;
annLat.sort((a, b) => a - b);
const annMs = annLat.reduce((s, x) => s + x, 0);

console.log(`points=${points.length} dim=${DIM} queries=${QUERIES} k=${K}`);
console.log(`build_ms=${buildMs.toFixed(1)}`);
console.log(`brute_total_ms=${bruteMs.toFixed(1)} ann_total_ms=${annMs.toFixed(1)}`);
console.log(`ann_query_ms_p50=${percentile(annLat, 50).toFixed(3)} p99=${percentile(annLat, 99).toFixed(3)}`);
console.log(`recall@${K}_mean=${meanRecall.toFixed(4)} threshold=${THRESHOLD}`);
if (meanRecall < THRESHOLD) {
  console.log('RESULT=FAIL');
  process.exit(1);
}
console.log('RESULT=PASS');
