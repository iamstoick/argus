/** Shared socket-free handler-test doubles (plain GET calls; see http.test.ts for body-bearing mocks). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createRequestHandler } from '../src/http.js';

export class MockReq {
  method: string;
  url: string;
  headers: Record<string, string>;

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    this.method = method;
    this.url = url;
    this.headers = headers;
  }
}

export class MockRes {
  statusCode = 200;
  headersSent = false;
  body = '';

  setHeader(): void {}

  writeHead(status: number): void {
    this.statusCode = status;
    this.headersSent = true;
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk;
    this.headersSent = true;
  }

  json<T>(): T {
    return JSON.parse(this.body) as T;
  }
}

export async function callApi(
  handler: ReturnType<typeof createRequestHandler>,
  method: string,
  url: string,
): Promise<MockRes> {
  const res = new MockRes();
  await handler(new MockReq(method, url) as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}
