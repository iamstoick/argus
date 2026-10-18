import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, resolveEmbeddings } from '../src/config.js';
import { OpenAIEmbeddings } from '../src/embeddings.js';

describe('resolveEmbeddings', () => {
  it('defaults to the local Ollama sidecar', () => {
    assert.deepEqual(resolveEmbeddings([], {}), {
      provider: 'ollama',
      url: DEFAULT_OLLAMA_URL,
      model: DEFAULT_OLLAMA_MODEL,
      apiKey: undefined,
    });
  });

  it('shares the off switch with the Ollama resolver', () => {
    assert.equal(resolveEmbeddings(['--no-semantic'], {}), undefined);
    assert.equal(resolveEmbeddings([], { ARGUS_OLLAMA: 'off' }), undefined);
    assert.equal(
      resolveEmbeddings(['--embeddings-provider', 'openai', '--no-semantic'], {}),
      undefined,
    );
  });

  it('honors legacy ollama flags under the default provider', () => {
    assert.deepEqual(resolveEmbeddings(['--ollama', 'http://x:11434'], {}), {
      provider: 'ollama',
      url: 'http://x:11434',
      model: DEFAULT_OLLAMA_MODEL,
      apiKey: undefined,
    });
    assert.deepEqual(resolveEmbeddings(['--ollama-model=m'], {}), {
      provider: 'ollama',
      url: DEFAULT_OLLAMA_URL,
      model: 'm',
      apiKey: undefined,
    });
  });

  it('falls back to generic flags under provider=ollama', () => {
    assert.deepEqual(resolveEmbeddings(['--embeddings-url', 'http://g:11434'], {}), {
      provider: 'ollama',
      url: 'http://g:11434',
      model: DEFAULT_OLLAMA_MODEL,
      apiKey: undefined,
    });
    // Legacy flags win over generic ones for ollama.
    const cfg = resolveEmbeddings(['--ollama=http://legacy', '--embeddings-url=http://generic'], {});
    assert.equal(cfg?.url, 'http://legacy');
  });

  it('resolves provider=openai from flag or env', () => {
    assert.deepEqual(resolveEmbeddings(['--embeddings-provider', 'openai'], {}), {
      provider: 'openai',
      url: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text',
      apiKey: undefined,
    });
    const cfg = resolveEmbeddings(
      [],
      {
        ARGUS_EMBEDDINGS_PROVIDER: 'openai',
        ARGUS_EMBEDDINGS_URL: 'https://api.example.com/v1',
        ARGUS_EMBEDDINGS_MODEL: 'e5',
        ARGUS_EMBEDDINGS_KEY: 'k',
      },
    );
    assert.deepEqual(cfg, {
      provider: 'openai',
      url: 'https://api.example.com/v1',
      model: 'e5',
      apiKey: 'k',
    });
  });

  it('prefers openai flags over env', () => {
    const cfg = resolveEmbeddings(['--embeddings-provider=openai', '--embeddings-model=flag-m'], {
      ARGUS_EMBEDDINGS_MODEL: 'env-m',
    });
    assert.equal(cfg?.model, 'flag-m');
  });

  it('throws on unknown provider names', () => {
    assert.throws(() => resolveEmbeddings(['--embeddings-provider', 'cohere'], {}), /invalid embeddings provider/);
  });
});

describe('OpenAIEmbeddings', () => {
  type Handler = (
    body: string,
    url: string | undefined,
    method: string | undefined,
    headers: IncomingMessage['headers'],
  ) => { status: number; json: unknown };

  function startStub(handler: Handler): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const { status, json } = handler(body, req.url, req.method, req.headers);
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

  function isBindBlocked(err: unknown): boolean {
    const code = (err as { code?: string }).code;
    return code === 'EPERM' || code === 'EACCES';
  }

  it('posts to /embeddings and restores index order', async (t) => {
    const seen: Array<{ url: string | undefined; body: string; auth: unknown }> = [];
    let server: Server;
    let port: number;
    try {
      ({ server, port } = await startStub((body, url, _method, headers) => {
        seen.push({ url, body, auth: headers['authorization'] });
        return {
          status: 200,
          json: {
            data: [
              { embedding: [0.3, 0.4], index: 1 },
              { embedding: [0.1, 0.2], index: 0 },
            ],
          },
        };
      }));
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      const vecs = await new OpenAIEmbeddings(`http://127.0.0.1:${port}/v1/`, 'e5', 'secret').embed(['a', 'b']);
      assert.deepEqual(vecs, [
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.url, '/v1/embeddings');
      assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), { model: 'e5', input: ['a', 'b'] });
      assert.equal(seen[0]?.auth, 'Bearer secret');
    } finally {
      server.close();
    }
  });

  it('omits the auth header without a key and probes /models', async (t) => {
    let stub: { server: Server; port: number };
    try {
      stub = await startStub((_body, url) => {
        if (url === '/v1/embeddings') return { status: 200, json: { data: [{ embedding: [1], index: 0 }] } };
        return { status: 200, json: { data: [] } };
      });
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      const provider = new OpenAIEmbeddings(`http://127.0.0.1:${stub.port}/v1`);
      assert.equal(await provider.probe(), true);
      assert.deepEqual(await provider.embed(['a']), [[1]]);
    } finally {
      stub.server.close();
    }
    const closed = await startStub(() => ({ status: 200, json: {} }));
    const closedPort = closed.port;
    closed.server.close();
    assert.equal(await new OpenAIEmbeddings(`http://127.0.0.1:${closedPort}/v1`, 'm', undefined, 500).probe(), false);
  });

  it('throws readable errors on bad responses', async (t) => {
    let stub: { server: Server; port: number };
    try {
      stub = await startStub(() => ({ status: 500, json: { error: 'boom' } }));
    } catch (err) {
      if (isBindBlocked(err)) {
        t.skip('socket bind blocked here; skipping live-socket test');
        return;
      }
      throw err;
    }
    try {
      await assert.rejects(
        () => new OpenAIEmbeddings(`http://127.0.0.1:${stub.port}/v1`).embed(['a']),
        /openai embed failed: HTTP 500/,
      );
    } finally {
      stub.server.close();
    }
    for (const json of [
      { data: 'nope' },
      { data: [{ embedding: [0.1], index: 0 }, { embedding: [0.2], index: 1 }] }, // length mismatch
      { data: [{ embedding: [], index: 0 }] }, // empty vector
      { data: [{ embedding: ['x'], index: 0 }] }, // non-numeric
    ]) {
      const bad = await startStub(() => ({ status: 200, json }));
      try {
        await assert.rejects(
          () => new OpenAIEmbeddings(`http://127.0.0.1:${bad.port}/v1`).embed(['a']),
          /openai embed failed/,
        );
      } finally {
        bad.server.close();
      }
    }
  });
});
