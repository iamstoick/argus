/** Optional semantic tier: embedding providers (Ollama) + vector maintenance. */
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from './config.js';
import { ArgusDb, type SymbolRow } from './db.js';

/** Texts per /api/embed call; Ollama accepts arrays, batches bound memory. */
const EMBED_BATCH = 64;

/** Any vector source the semantic tier can use (Ollama today, others later). */
export interface EmbeddingProvider {
  readonly name: string;
  /** One vector per input, order-preserving. */
  embed(texts: string[]): Promise<number[][]>;
}

function isEmbedResponse(value: unknown): value is { embeddings: number[][] } {
  if (typeof value !== 'object' || value === null) return false;
  const e = (value as Record<string, unknown>)['embeddings'];
  return (
    Array.isArray(e) &&
    e.every((row) => Array.isArray(row) && row.every((n) => typeof n === 'number' && Number.isFinite(n)))
  );
}

/** Local Ollama server (plain fetch, no dependency). Failures throw; callers degrade. */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL, model: string = DEFAULT_OLLAMA_MODEL, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  get url(): string {
    return this.baseUrl;
  }

  get modelName(): string {
    return this.model;
  }

  /** True when an Ollama server answers; never throws. */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`ollama embed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`ollama embed failed: HTTP ${res.status}`);
    let parsed: unknown;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      throw new Error('ollama embed failed: invalid JSON response');
    }
    if (!isEmbedResponse(parsed) || parsed.embeddings.length !== texts.length) {
      throw new Error('ollama embed failed: malformed embeddings response');
    }
    return parsed.embeddings;
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Index text per symbol: name + kind + signature + docstring, single line. */
export function symbolEmbedText(row: Pick<SymbolRow, 'name' | 'kind' | 'signature' | 'docstring'>): string {
  return `${row.name} ${row.kind} ${row.signature}${row.docstring ? ` ${row.docstring}` : ''}`
    .replace(/\s+/g, ' ')
    .trim();
}

export interface VectorSyncStats {
  embedded: number;
  cleared: number;
}

/**
 * Embed every symbol lacking a vector (batched, one provider round-trip per
 * batch). The first embedding doubles as a homogeneity probe: stored vectors
 * of a different dimension (model changed) are cleared and resynced, keeping
 * the store homogeneous. Idle runs cost zero provider calls; partial batches
 * persist, so a later run resumes with whatever is still missing.
 */
export async function syncSymbolVectors(
  db: ArgusDb,
  provider: EmbeddingProvider,
  opts: { path?: string | undefined } = {},
): Promise<VectorSyncStats> {
  const inScope = (s: SymbolRow): boolean => opts.path === undefined || s.path === opts.path;
  const missing = (have: ReadonlySet<number>): SymbolRow[] =>
    db.allSymbols().filter((s) => inScope(s) && !have.has(s.id));
  const first = missing(new Set(db.symbolVectors().map((v) => v.symbolId)))[0];
  if (first === undefined) return { embedded: 0, cleared: 0 };
  const [probe] = await provider.embed([symbolEmbedText(first)]);
  if (probe === undefined || probe.length === 0) throw new Error(`${provider.name}: empty embedding`);
  db.replaceVectors([{ symbolId: first.id, dim: probe.length, vec: probe }]);
  const cleared = db.clearVectorDimsExcept(probe.length);
  const rest = missing(new Set(db.symbolVectors().map((v) => v.symbolId)));
  let embedded = 1;
  for (let i = 0; i < rest.length; i += EMBED_BATCH) {
    const batch = rest.slice(i, i + EMBED_BATCH);
    const vecs = await provider.embed(batch.map(symbolEmbedText));
    db.replaceVectors(
      batch.map((s, j) => {
        const vec = vecs[j];
        if (vec === undefined || vec.length === 0) throw new Error(`${provider.name}: short embedding batch`);
        return { symbolId: s.id, dim: vec.length, vec };
      }),
    );
    embedded += batch.length;
  }
  return { embedded, cleared };
}
