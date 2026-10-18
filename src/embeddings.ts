/** Optional semantic tier: embedding providers (Ollama, OpenAI-compatible) + vector maintenance. */
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_URL } from './config.js';
import { ArgusDb, type SymbolRow } from './db.js';

/** Texts per /api/embed call; Ollama accepts arrays, batches bound memory. */
const EMBED_BATCH = 64;

/** What one embed call consumed. Token counts are exact when the server reports them. */
export interface EmbeddingUsage {
  provider: string;
  model: string;
  inputTexts: number;
  inputChars: number;
  /** Server-reported input tokens (OpenAI `usage`, Ollama `prompt_eval_count`); else undefined. */
  promptTokens?: number | undefined;
}

export interface EmbedResult {
  /** One vector per input, order-preserving. */
  vectors: number[][];
  usage: EmbeddingUsage;
}

/** Any vector source the semantic tier can use (Ollama today, others later). */
export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

function baseUsage(provider: string, model: string, texts: string[]): EmbeddingUsage {
  return {
    provider,
    model,
    inputTexts: texts.length,
    inputChars: texts.reduce((sum, t) => sum + t.length, 0),
  };
}

/** Optional non-negative integer field (server-reported usage); undefined when absent/invalid. */
function optTokenCount(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const n = (value as Record<string, unknown>)[key];
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
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

  async embed(texts: string[]): Promise<EmbedResult> {
    const usage = baseUsage(this.name, this.model, texts);
    if (texts.length === 0) return { vectors: [], usage };
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
    const promptTokens = optTokenCount(parsed, 'prompt_eval_count');
    if (promptTokens !== undefined) usage.promptTokens = promptTokens;
    return { vectors: parsed.embeddings, usage };
  }
}

interface OpenAIEmbeddingRow {
  embedding: number[];
  index: number;
}

function isEmbeddingsData(value: unknown): value is { data: OpenAIEmbeddingRow[] } {
  if (typeof value !== 'object' || value === null) return false;
  const data = (value as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return false;
  return data.every(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      Array.isArray((row as Record<string, unknown>)['embedding']) &&
      ((row as Record<string, unknown>)['embedding'] as unknown[]).every(
        (n) => typeof n === 'number' && Number.isFinite(n),
      ) &&
      typeof (row as Record<string, unknown>)['index'] === 'number',
  );
}

/**
 * Any OpenAI-compatible embeddings server: OpenAI, vLLM, LM Studio, llama.cpp,
 * Ollama's /v1. baseUrl is the version root (…/v1); the key is optional since
 * local servers need none. Failures throw; callers degrade.
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string = DEFAULT_OPENAI_URL,
    model: string = DEFAULT_OPENAI_MODEL,
    apiKey: string | undefined = undefined,
    timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get url(): string {
    return this.baseUrl;
  }

  get modelName(): string {
    return this.model;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` };
  }

  /** True when a /v1 server answers; never throws. */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const usage = baseUsage(this.name, this.model, texts);
    if (texts.length === 0) return { vectors: [], usage };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`openai embed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`openai embed failed: HTTP ${res.status}`);
    let parsed: unknown;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      throw new Error('openai embed failed: invalid JSON response');
    }
    if (!isEmbeddingsData(parsed) || parsed.data.length !== texts.length) {
      throw new Error('openai embed failed: malformed embeddings response');
    }
    const vectors = [...parsed.data]
      .sort((a, b) => a.index - b.index)
      .map((row) => {
        if (row.embedding.length === 0) throw new Error('openai embed failed: empty embedding vector');
        return row.embedding;
      });
    const usageBlock = (parsed as { usage?: unknown }).usage;
    const promptTokens = optTokenCount(usageBlock, 'prompt_tokens') ?? optTokenCount(usageBlock, 'total_tokens');
    if (promptTokens !== undefined) usage.promptTokens = promptTokens;
    return { vectors, usage };
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
  const probeRes = await provider.embed([symbolEmbedText(first)]);
  const probe = probeRes.vectors[0];
  if (probe === undefined || probe.length === 0) throw new Error(`${provider.name}: empty embedding`);
  db.replaceVectors([{ symbolId: first.id, dim: probe.length, vec: probe }]);
  db.addEmbeddingUsage('sync', probeRes.usage);
  const cleared = db.clearVectorDimsExcept(probe.length);
  const rest = missing(new Set(db.symbolVectors().map((v) => v.symbolId)));
  let embedded = 1;
  for (let i = 0; i < rest.length; i += EMBED_BATCH) {
    const batch = rest.slice(i, i + EMBED_BATCH);
    const res = await provider.embed(batch.map(symbolEmbedText));
    db.replaceVectors(
      batch.map((s, j) => {
        const vec = res.vectors[j];
        if (vec === undefined || vec.length === 0) throw new Error(`${provider.name}: short embedding batch`);
        return { symbolId: s.id, dim: vec.length, vec };
      }),
    );
    db.addEmbeddingUsage('sync', res.usage);
    embedded += batch.length;
  }
  return { embedded, cleared };
}
