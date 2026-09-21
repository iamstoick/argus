import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, runHttp } from '../src/http.js';
import { ParserEngine } from '../src/parser.js';
import { IndexManager } from '../src/projects.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

const TOKEN = 'test-token-123';

/** Minimal req/res doubles: the handler only uses method/url/headers + stream events. */
class MockReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(method: string, url: string, headers: Record<string, string> = {}, body = '') {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    queueMicrotask(() => {
      if (body !== '') this.emit('data', Buffer.from(body));
      this.emit('end');
    });
  }

  destroy(): this {
    return this;
  }
}

class MockRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  body = '';
  contentType = '';

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.contentType = headers['content-type'] ?? '';
    this.headersSent = true;
    return this;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.body += chunk;
    this.headersSent = true;
    this.emit('finish');
    return this;
  }

  destroy(): this {
    return this;
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

// Test-only: doubles implement the exact surface the handler touches (see classes above).
function asReq(mock: MockReq): IncomingMessage {
  return mock as unknown as IncomingMessage;
}

function asRes(mock: MockRes): ServerResponse {
  return mock as unknown as ServerResponse;
}

async function setupManager(): Promise<{ root: string; manager: IndexManager }> {
  const root = mkdtempSync(join(tmpdir(), 'argus-http-'));
  writeFileSync(
    join(root, 'calc.ts'),
    `/** Add numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function total(xs: number[]): number {\n  return xs.reduce((acc, x) => add(acc, x), 0);\n}\n`,
  );
  const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, {
    watch: false,
    onError: () => {},
  });
  return { root, manager };
}

async function teardownManager(t: { root: string; manager: IndexManager }): Promise<void> {
  await t.manager.close();
  rmSync(t.root, { recursive: true, force: true });
}

interface Ctx {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function authed(path: string, body = ''): { req: MockReq; res: MockRes } {
  return {
    req: new MockReq(body === '' ? 'GET' : 'POST', path, { authorization: `Bearer ${TOKEN}` }, body),
    res: new MockRes(),
  };
}

describe('http handler', () => {
  it('rejects missing/invalid tokens', async () => {
    const t = await setupManager();
    try {
      const handler = createRequestHandler(t.manager, { host: '127.0.0.1', port: 0, token: TOKEN, version: 'test' });
      const anon = new MockRes();
      await handler(asReq(new MockReq('GET', '/api/projects')), asRes(anon));
      assert.equal(anon.statusCode, 401);
      const bad = new MockRes();
      await handler(asReq(new MockReq('GET', '/api/projects', { authorization: 'Bearer nope' })), asRes(bad));
      assert.equal(bad.statusCode, 401);
    } finally {
      await teardownManager(t);
    }
  });

  it('serves projects, search, symbols, blast as JSON', async () => {
    const t = await setupManager();
    try {
      const ctx: Ctx = {
        handler: createRequestHandler(t.manager, { host: '127.0.0.1', port: 0, token: TOKEN, version: 'test' }),
      };
      const get = async (path: string): Promise<MockRes> => {
        const { req, res } = authed(path);
        await ctx.handler(asReq(req), asRes(res));
        return res;
      };
      const projects = (await get('/api/projects')).json() as {
        projects: Array<{ name: string; symbols: number }>;
      };
      assert.equal(projects.projects.length, 1);
      assert.equal(projects.projects[0]?.name, 'demo');
      assert.equal(projects.projects[0]?.symbols, 2);

      const search = (await get('/api/projects/demo/search?q=add')).json() as {
        symbols: Array<{ id: number; name: string }>;
      };
      assert.equal(search.symbols.length >= 1, true);
      const add = search.symbols.find((s) => s.name === 'add');
      assert.ok(add);

      assert.equal((await get('/api/projects/demo/search?q=add&kind=bogus')).statusCode, 400);
      assert.equal((await get('/api/projects/demo/search')).statusCode, 400);
      assert.equal((await get('/api/projects/nope/search?q=add')).statusCode, 404);
      assert.equal((await get('/api/projects/bad%20name/search?q=add')).statusCode, 404);
      assert.equal((await get('/nope')).statusCode, 404);

      const detail = (await get(`/api/projects/demo/symbols/${add.id}`)).json() as {
        symbol: { name: string };
        code: string | null;
      };
      assert.equal(detail.symbol.name, 'add');
      assert.match(detail.code ?? '', /return a \+ b/);
      assert.equal((await get('/api/projects/demo/symbols/9999')).statusCode, 404);
      assert.equal((await get('/api/projects/demo/symbols/abc')).statusCode, 400);

      const blast = (await get('/api/projects/demo/blast?name=add')).json() as {
        matched: unknown[];
        incoming: Array<{ caller_name: string }>;
      };
      assert.equal(blast.matched.length, 1);
      assert.ok(blast.incoming.some((r) => r.caller_name === 'total'));
      assert.equal((await get('/api/projects/demo/blast?name=zzz')).statusCode, 404);
      assert.equal((await get('/api/projects/demo/blast')).statusCode, 400);
    } finally {
      await teardownManager(t);
    }
  });

  it('serves the admin page', async () => {
    const t = await setupManager();
    try {
      const handler = createRequestHandler(t.manager, { host: '127.0.0.1', port: 0, token: TOKEN, version: 'test' });
      const { req, res } = authed('/');
      await handler(asReq(req), asRes(res));
      assert.equal(res.statusCode, 200);
      assert.match(res.contentType, /text\/html/);
      assert.match(res.body, /Argus/);
    } finally {
      await teardownManager(t);
    }
  });

  it('rejects MCP posts without a session', async () => {
    const t = await setupManager();
    try {
      const handler = createRequestHandler(t.manager, { host: '127.0.0.1', port: 0, token: TOKEN, version: 'test' });
      const { req, res } = authed('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      await handler(asReq(req), asRes(res));
      assert.equal(res.statusCode, 400);
      const bad = new MockRes();
      const badReq = new MockReq('POST', '/mcp', { authorization: `Bearer ${TOKEN}` }, '{oops');
      await handler(asReq(badReq), asRes(bad));
      assert.equal(bad.statusCode, 400);
    } finally {
      await teardownManager(t);
    }
  });

  it('refuses non-loopback binds without a token', async () => {
    const t = await setupManager();
    try {
      await assert.rejects(
        runHttp(t.manager, { host: '0.0.0.0', port: 0, token: undefined, version: 'test' }),
        /refusing to bind/,
      );
    } finally {
      await teardownManager(t);
    }
  });
});

describe('http server (live socket)', () => {
  it('speaks MCP over Streamable HTTP end to end', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'argus-live-'));
    writeFileSync(join(root, 'a.ts'), 'export function total(): number {\n  return 1;\n}\n');
    const manager = await IndexManager.open([{ name: 'demo', path: root }], engine, {
      watch: false,
      onError: () => {},
    });
    let http: Awaited<ReturnType<typeof runHttp>> | undefined;
    try {
      try {
        http = await runHttp(manager, { host: '127.0.0.1', port: 0, token: TOKEN, version: 'test' });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'EPERM' || code === 'EACCES') {
          t.skip(`socket bind blocked here (${code}); skipping live-socket test`);
          return;
        }
        throw err;
      }
      const base = `http://127.0.0.1:${http.port}`;
      const headers = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      };
      const initRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      });
      assert.equal(initRes.status, 200);
      const session = initRes.headers.get('mcp-session-id');
      assert.ok(session);
      const withSession = { ...headers, 'mcp-session-id': session as string };
      const listRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: withSession,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      assert.equal(listRes.status, 200);
      const listText = await listRes.text();
      assert.match(listText, /lookup_dictionary/);
      assert.match(listText, /check_blast_radius/);
      const callRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: withSession,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'lookup_dictionary', arguments: { query: 'total' } },
        }),
      });
      assert.equal(callRes.status, 200);
      assert.match(await callRes.text(), /total/);
      const anon = await fetch(`${base}/api/projects`);
      assert.equal(anon.status, 401);
    } finally {
      await http?.close();
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
