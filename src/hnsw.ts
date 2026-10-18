/**
 * Minimal deterministic HNSW index over numeric ids (cosine distance).
 * Simplified neighbor pruning (closest-M, no heuristic diversification):
 * slightly lower recall than full HNSW, much less code, still far above
 * brute-force cost at scale. Single-threaded use; the owner serializes syncs.
 */
export interface HnswParams {
  /** Max neighbors per node per upper layer. */
  m: number;
  /** Max neighbors per node on layer 0. */
  mMax0: number;
  /** Beam width while inserting. */
  efConstruction: number;
  /** Hard cap on node levels. */
  maxLevel: number;
  /** Level-assignment seed; same seed + insertion order = identical graph. */
  seed: number;
}

export const DEFAULT_HNSW_PARAMS: HnswParams = {
  m: 16,
  mMax0: 32,
  efConstruction: 100,
  maxLevel: 16,
  seed: 0x51ab3f,
};

/** Rebuild the graph once tombstones pass this share of nodes. */
const REBUILD_TOMBSTONE_RATIO = 0.25;

interface HnswNode {
  id: number;
  level: number;
  links: number[][];
}

export interface HnswHit {
  id: number;
  /** Cosine distance (0 = identical, 1 = orthogonal, 2 = opposite). */
  dist: number;
}

/** Deterministic PRNG (mulberry32) so indexes build identically every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function compareHits(a: HnswHit, b: HnswHit): number {
  return a.dist - b.dist || a.id - b.id;
}

export class HnswIndex {
  private params: HnswParams;
  private rand: () => number;
  private readonly nodes = new Map<number, HnswNode>();
  private vectors = new Map<number, readonly number[]>();
  private readonly deleted = new Set<number>();
  private entry = -1;
  private topLevel = 0;
  private dim = 0;

  constructor(params: Partial<HnswParams> = {}) {
    this.params = { ...DEFAULT_HNSW_PARAMS, ...params };
    this.rand = mulberry32(this.params.seed);
  }

  /** Live (non-tombstoned) node count. */
  get size(): number {
    return this.nodes.size - this.deleted.size;
  }

  get dimension(): number {
    return this.dim;
  }

  get tombstones(): number {
    return this.deleted.size;
  }

  get needsRebuild(): boolean {
    return this.nodes.size > 0 && this.deleted.size / this.nodes.size > REBUILD_TOMBSTONE_RATIO;
  }

  has(id: number): boolean {
    return this.nodes.has(id) && !this.deleted.has(id);
  }

  ids(): number[] {
    return [...this.nodes.keys()];
  }

  clear(): void {
    this.nodes.clear();
    this.vectors.clear();
    this.deleted.clear();
    this.entry = -1;
    this.topLevel = 0;
    this.dim = 0;
    this.rand = mulberry32(this.params.seed);
  }

  private randomLevel(): number {
    const r = this.rand();
    if (r <= 0) return this.params.maxLevel;
    const mL = 1 / Math.log(this.params.m);
    return Math.min(Math.floor(-Math.log(r) * mL), this.params.maxLevel);
  }

  private distTo(q: readonly number[], id: number): number {
    const v = this.vectors.get(id);
    if (v === undefined) return Number.POSITIVE_INFINITY;
    return cosineDistance(q, v);
  }

  private greedyClosest(q: readonly number[], start: number, layer: number): number {
    let cur = start;
    let best = this.distTo(q, cur);
    for (;;) {
      let improved = false;
      const links = this.nodes.get(cur)?.links[layer] ?? [];
      for (const nb of links) {
        const d = this.distTo(q, nb);
        if (d < best) {
          best = d;
          cur = nb;
          improved = true;
        }
      }
      if (!improved) return cur;
    }
  }

  /** Beam search on one layer; returns up to ef closest, ascending. */
  private searchLayer(q: readonly number[], entryIds: number[], ef: number, layer: number): HnswHit[] {
    const visited = new Set<number>(entryIds);
    const candidates: HnswHit[] = entryIds.map((id) => ({ id, dist: this.distTo(q, id) }));
    const results: HnswHit[] = [];
    const worstResult = (): number => {
      if (results.length < ef) return Number.POSITIVE_INFINITY;
      return results[results.length - 1]?.dist ?? Number.POSITIVE_INFINITY;
    };
    while (candidates.length > 0) {
      candidates.sort(compareHits);
      const cur = candidates.shift();
      if (cur === undefined) break;
      if (cur.dist > worstResult()) break;
      results.push(cur);
      results.sort(compareHits);
      if (results.length > ef) results.pop();
      const links = this.nodes.get(cur.id)?.links[layer] ?? [];
      for (const nb of links) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const d = this.distTo(q, nb);
        if (results.length < ef || d < worstResult()) candidates.push({ id: nb, dist: d });
      }
    }
    results.sort(compareHits);
    return results;
  }

  insert(id: number, vec: readonly number[]): void {
    const existing = this.nodes.get(id);
    if (existing !== undefined) {
      if (vec.length !== this.dim) {
        throw new Error(`hnsw: dimension mismatch for ${id} (want ${this.dim}, got ${vec.length})`);
      }
      this.vectors.set(id, vec);
      this.deleted.delete(id);
      return;
    }
    if (this.dim === 0) this.dim = vec.length;
    if (vec.length !== this.dim) {
      throw new Error(`hnsw: dimension mismatch for ${id} (want ${this.dim}, got ${vec.length})`);
    }
    const level = this.randomLevel();
    const node: HnswNode = { id, level, links: Array.from({ length: level + 1 }, () => [] as number[]) };
    this.nodes.set(id, node);
    this.vectors.set(id, vec);
    if (this.entry < 0) {
      this.entry = id;
      this.topLevel = level;
      return;
    }
    let cur = this.entry;
    for (let lc = this.topLevel; lc > level; lc--) cur = this.greedyClosest(vec, cur, lc);
    for (let lc = Math.min(level, this.topLevel); lc >= 0; lc--) {
      const candidates = this.searchLayer(vec, [cur], this.params.efConstruction, lc);
      const first = candidates[0];
      if (first !== undefined) cur = first.id;
      const cap = lc === 0 ? this.params.mMax0 : this.params.m;
      const selected = candidates.slice(0, cap).map((c) => c.id);
      node.links[lc] = selected;
      for (const nb of selected) this.connect(nb, id, lc);
    }
    if (level > this.topLevel) {
      this.entry = id;
      this.topLevel = level;
    }
  }

  /** Bidirectional link with closest-M pruning on the neighbor side. */
  private connect(a: number, b: number, layer: number): void {
    const node = this.nodes.get(a);
    const avec = this.vectors.get(a);
    if (node === undefined || avec === undefined) return;
    while (node.links.length <= layer) node.links.push([]);
    const links = node.links[layer];
    if (links === undefined) return;
    if (!links.includes(b)) links.push(b);
    const cap = layer === 0 ? this.params.mMax0 : this.params.m;
    if (links.length > cap) {
      const byDist = (x: number, y: number): number => {
        const dx = cosineDistance(avec, this.vectors.get(x) ?? []);
        const dy = cosineDistance(avec, this.vectors.get(y) ?? []);
        return dx - dy || x - y;
      };
      node.links[layer] = [...links].sort(byDist).slice(0, cap);
    }
  }

  /** Up to k live hits, ascending distance. Empty when the index is empty or dims mismatch. */
  query(q: readonly number[], k: number, ef: number = Math.max(64, k)): HnswHit[] {
    if (this.entry < 0 || k <= 0 || q.length !== this.dim) return [];
    let cur = this.entry;
    for (let lc = this.topLevel; lc > 0; lc--) cur = this.greedyClosest(q, cur, lc);
    const out: HnswHit[] = [];
    for (const hit of this.searchLayer(q, [cur], Math.max(ef, k), 0)) {
      if (this.deleted.has(hit.id) || !this.vectors.has(hit.id)) continue;
      out.push(hit);
      if (out.length >= k) break;
    }
    return out;
  }

  /** Lazy delete: filtered from results, still traversed. Rebuild past the tombstone ratio. */
  remove(id: number): void {
    if (this.nodes.has(id)) this.deleted.add(id);
  }

  serialize(): string {
    return JSON.stringify({
      v: 1,
      params: this.params,
      dim: this.dim,
      entry: this.entry,
      top: this.topLevel,
      nodes: [...this.nodes.values()].map((n) => [n.id, n.level, n.links]),
      deleted: [...this.deleted],
    });
  }

  /** Restore a serialized graph; vectors attach separately via attach(). */
  deserialize(payload: string): void {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('hnsw: malformed payload');
    const rec = parsed as Record<string, unknown>;
    if (rec['v'] !== 1) throw new Error('hnsw: unsupported payload version');
    const params = rec['params'];
    if (typeof params !== 'object' || params === null) throw new Error('hnsw: malformed payload');
    const prec = params as Record<string, unknown>;
    for (const key of ['m', 'mMax0', 'efConstruction', 'maxLevel', 'seed']) {
      if (typeof prec[key] !== 'number' || !Number.isFinite(prec[key] as number)) {
        throw new Error('hnsw: malformed payload');
      }
    }
    const dim = rec['dim'];
    const entry = rec['entry'];
    const top = rec['top'];
    const nodes = rec['nodes'];
    const deleted = rec['deleted'];
    if (typeof dim !== 'number' || typeof entry !== 'number' || typeof top !== 'number') {
      throw new Error('hnsw: malformed payload');
    }
    if (!Array.isArray(nodes) || !Array.isArray(deleted) || !deleted.every((d) => typeof d === 'number')) {
      throw new Error('hnsw: malformed payload');
    }
    const restored = new Map<number, HnswNode>();
    for (const item of nodes) {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== 'number' ||
        typeof item[1] !== 'number' ||
        !Array.isArray(item[2]) ||
        !(item[2] as unknown[]).every(
          (layer) => Array.isArray(layer) && (layer as unknown[]).every((n) => typeof n === 'number'),
        )
      ) {
        throw new Error('hnsw: malformed payload');
      }
      const [id, level, links] = item as [number, number, number[][]];
      restored.set(id, { id, level, links: links.map((l) => [...l]) });
    }
    this.clear();
    this.params = {
      m: prec['m'] as number,
      mMax0: prec['mMax0'] as number,
      efConstruction: prec['efConstruction'] as number,
      maxLevel: prec['maxLevel'] as number,
      seed: prec['seed'] as number,
    };
    this.dim = dim;
    this.entry = entry;
    this.topLevel = top;
    for (const [id, node] of restored) this.nodes.set(id, node);
    for (const d of deleted as number[]) this.deleted.add(d);
  }

  /** Attach vectors to a deserialized graph; drops nodes with no vector. */
  attach(vectors: Map<number, readonly number[]>): void {
    this.vectors = new Map(vectors);
    for (const id of [...this.nodes.keys()]) {
      if (!this.vectors.has(id)) {
        this.nodes.delete(id);
        this.deleted.delete(id);
      }
    }
    let top = 0;
    for (const node of this.nodes.values()) top = Math.max(top, node.level);
    this.topLevel = top;
    if (this.entry >= 0 && !this.nodes.has(this.entry)) {
      const remaining = [...this.nodes.keys()];
      const first = remaining[0];
      this.entry = first === undefined ? -1 : first;
    }
    if (this.nodes.size === 0) this.entry = -1;
  }
}
