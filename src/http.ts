/** HTTP layer: MCP Streamable transport, observe-only JSON API, admin page. All token-gated. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { SYMBOL_KINDS, clampLimit, isValidProjectName } from './config.js';
import type { IndexManager } from './projects.js';
import { createMcpServer } from './server.js';
import { blastRadiusData, deadCodeData, duplicateGroupsData, symbolCodeBlock } from './tools.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Shared bearer token; required unless binding loopback. */
  token: string | undefined;
  version: string;
}

export interface HttpHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isInitializeBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return (body as Record<string, unknown>)['method'] === 'initialize';
}

function adminPageHtml(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, 'admin', 'index.html'), 'utf8');
}

export async function runHttp(manager: IndexManager, opts: HttpOptions): Promise<HttpHandle> {
  if (opts.token === undefined && !isLoopback(opts.host)) {
    throw new Error(`refusing to bind ${opts.host} without a token (pass --token or set ARGUS_TOKEN)`);
  }
  if (opts.token === undefined) {
    console.error('[argus] http without token on loopback (fine for local use; set ARGUS_TOKEN to share)');
  }

  const handler = createRequestHandler(manager, opts);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      console.error(`[argus] http error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
  console.error(`[argus] http ready on http://${opts.host}:${boundPort} (mcp + admin)`);
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** Routing + MCP session handling without the socket. Exported for socket-free tests. */
export function createRequestHandler(
  manager: IndexManager,
  opts: HttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let adminHtml: string | undefined;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS for browser dashboards (e.g. Astra): preflights carry no auth, so
    // answer OPTIONS before the auth gate and tag every response for sharing.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!authorized(req, opts.token)) {
      sendJson(res, 401, { error: 'missing or invalid bearer token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      adminHtml ??= adminPageHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(adminHtml);
      return;
    }
    if (url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: manager.allStats() });
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { version: opts.version, ...manager.health() });
      return;
    }
    const match = /^\/api\/projects\/([^/]+)\/(search|symbols|blast|duplicates|dead-code)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    const seg1 = match?.[1];
    const seg2 = match?.[2];
    const seg3 = match?.[3];
    if (seg1 === undefined || seg2 === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const projectName = decodeURIComponent(seg1);
    const action = seg2;
    const rest = seg3 !== undefined ? decodeURIComponent(seg3) : undefined;
    if (!isValidProjectName(projectName)) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    const entry = manager.get(projectName);
    if (entry === undefined) {
      sendJson(res, 404, { error: 'unknown project' });
      return;
    }
    if (action === 'search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (q === '') {
        sendJson(res, 400, { error: 'missing q' });
        return;
      }
      const kind = url.searchParams.get('kind') ?? undefined;
      if (kind !== undefined && !SYMBOL_KINDS.has(kind)) {
        sendJson(res, 400, { error: `unknown kind '${kind}'` });
        return;
      }
      const limit = clampLimit(Number(url.searchParams.get('limit') ?? Number.NaN));
      sendJson(res, 200, { symbols: entry.db.searchSymbols(q, kind, limit) });
      return;
    }
    if (action === 'symbols') {
      const id = Number(rest ?? '');
      if (rest === undefined || !Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'invalid symbol id' });
        return;
      }
      const row = entry.db.symbolById(id);
      if (row === undefined) {
        sendJson(res, 404, { error: 'no such symbol' });
        return;
      }
      sendJson(res, 200, { symbol: row, code: symbolCodeBlock(entry.root, row) ?? null });
      return;
    }
    if (action === 'duplicates') {
      const limit = clampLimit(Number(url.searchParams.get('limit') ?? Number.NaN));
      sendJson(res, 200, duplicateGroupsData(entry.db, limit));
      return;
    }
    if (action === 'dead-code') {
      const limit = clampLimit(Number(url.searchParams.get('limit') ?? Number.NaN));
      const includeExported = url.searchParams.get('include_exported') === 'true';
      sendJson(res, 200, deadCodeData(entry.db, includeExported, limit));
      return;
    }
    // action === 'blast'
    const name = url.searchParams.get('name')?.trim() ?? '';
    const limit = clampLimit(Number(url.searchParams.get('limit') ?? Number.NaN));
    const data = blastRadiusData(entry.db, name, limit);
    if ('error' in data) {
      sendJson(res, name === '' ? 400 : 404, { error: data.error });
      return;
    }
    sendJson(res, 200, data);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headerSession = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(headerSession) ? headerSession[0] : headerSession;
    const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        const text = await readBody(req);
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      if (existing !== undefined) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (!isInitializeBody(body)) {
        sendJson(res, 400, { error: 'missing or unknown mcp-session-id' });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
      };
      // Cast: the SDK's own transport/impl types disagree under exactOptionalPropertyTypes; onclose is set above.
      await createMcpServer(manager, opts.version).connect(transport as Transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && existing !== undefined) {
      await existing.handleRequest(req, res);
      return;
    }
    sendJson(res, 400, { error: 'missing or unknown mcp-session-id' });
  }

  return handleRequest;
}
