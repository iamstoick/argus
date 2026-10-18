import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgusDb } from '../src/db.js';
import { sha256Hex } from '../src/indexer.js';
import { scanLine, scanProjectSecrets, scanText } from '../src/secrets.js';
import { runAuditOnce } from '../src/worker.js';

const GITHUB_TOKEN = `ghp_${'aB1'.repeat(14)}`;
const SLACK_TOKEN = `xoxb-${'12345'.repeat(4)}`;
const STRIPE_KEY = `sk_live_${'K1mQ'.repeat(6)}`;
const OPENAI_KEY = `sk-${'Ab3'.repeat(12)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw._SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

describe('scanLine fixed-format tokens', () => {
  it('flags provider tokens and redacts the preview', () => {
    const cases: Array<[string, string, string]> = [
      [`key = "${AWS_KEY}"`, 'aws-access-key', AWS_KEY],
      [`token = "${GITHUB_TOKEN}"`, 'github-token', GITHUB_TOKEN],
      [`token = "${SLACK_TOKEN}"`, 'slack-token', SLACK_TOKEN],
      [`key = "${STRIPE_KEY}"`, 'stripe-key', STRIPE_KEY],
      [`key = "${OPENAI_KEY}"`, 'openai-key', OPENAI_KEY],
      [`Authorization: Bearer ${JWT}`, 'jwt', JWT],
    ];
    for (const [line, kind, secret] of cases) {
      const hits = scanLine(line);
      assert.equal(hits.length, 1, line);
      assert.equal(hits[0]?.kind, kind);
      assert.ok(hits[0]?.preview.includes('[REDACTED]'), line);
      assert.ok(!hits[0]?.preview.includes(secret), `${line}: raw secret leaked into preview`);
    }
  });

  it('flags private key headers verbatim (the header leaks nothing)', () => {
    for (const line of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----']) {
      const hits = scanLine(line);
      assert.equal(hits.length, 1, line);
      assert.equal(hits[0]?.kind, 'private-key');
      assert.equal(hits[0]?.preview, line);
    }
  });

  it('ignores obvious filler runs', () => {
    assert.deepEqual(scanLine('const x = "AKIAXXXXXXXXXXXXXXXX";'), []);
    assert.deepEqual(scanLine(`const x = "ghp_${'x'.repeat(36)}";`), []);
  });
});

describe('scanLine assignments', () => {
  it('flags quoted secrets across shapes', () => {
    const lines = [
      'api_key = "Zk9mQ2xP7vT4w"',
      '"api_key": "Zk9mQ2xP7vT4w"',
      'API_KEY: str = "Zk9mQ2xP7vT4w"',
      "apiKey = 'Zk9mQ2xP7vT4w'",
      'client_secret: "Zk9mQ2xP7vT4wE9=="',
      'token = "Zk9mQ2xP7vT4w"',
      'my_api_key = "Zk9mQ2xP7vT4w"',
      'config.auth_token: "Zk9mQ2xP7vT4w"',
    ];
    for (const line of lines) {
      const hits = scanLine(line);
      assert.equal(hits.length, 1, line);
      assert.equal(hits[0]?.kind, 'generic-secret');
      assert.ok(!hits[0]?.preview.includes('Zk9mQ2xP7vT4w'), `${line}: raw secret leaked`);
    }
  });

  it('flags unquoted .env-style values that mix in a digit', () => {
    for (const line of ['API_KEY=Zk9mQ2xP7vT4wE9', 'api_key: Zk9mQ2xP7vT4wE9', 'SECRET_KEY=wJalrXUtnFEMI/K7MDENG9']) {
      assert.equal(scanLine(line).length, 1, line);
    }
  });

  it('stays quiet on code-shaped assignments', () => {
    const lines = [
      'apiKey = getDefaultKey();', // no digit: identifier, not a secret
      'token = request.token', // short dotted path
      'api_key = get_key_123()', // call
      'api_key = "changeme-please-update"', // placeholder
      'api_key = "xxx"', // too short
      'api_key = process.env.API_KEY', // env indirection
      'token_source = "config-file-value"', // name must end at the key word
      '// api_key goes in the vault here',
    ];
    for (const line of lines) {
      assert.deepEqual(scanLine(line), [], line);
    }
  });

  it('flags passwords but not annotations or getters', () => {
    assert.equal(scanLine('password = "s3cret-p@ss!"')[0]?.kind, 'password-assign');
    assert.equal(scanLine('PASSWORD=s3cretp@ss99')[0]?.kind, 'password-assign');
    assert.equal(scanLine('db_password: "hunter2-hunter"')[0]?.kind, 'password-assign');
    assert.equal(scanLine('db-password = "hunter2-hunter"')[0]?.kind, 'password-assign');
    for (const line of [
      'password: string;',
      'password = getDefault()',
      'password = "example-password-1"',
      'password = config.defaults.pw',
      'repwd = "hunter2-hunter"', // suffix without a separator is a different word
      'passwords = ["hunter2-hunter"]', // name must end at the key word
    ]) {
      assert.deepEqual(scanLine(line), [], line);
    }
  });
});

describe('scanText', () => {
  it('reports 1-based line numbers and caps per file', () => {
    const findings = scanText('a.ts', `clean = 1\nkey = "${AWS_KEY}"\n`);
    assert.deepEqual(findings, [
      { path: 'a.ts', line: 2, kind: 'aws-access-key', preview: `key = "[REDACTED]"` },
    ]);
    const many = Array.from({ length: 25 }, (_, i) => `k${i} = "${AWS_KEY}"`).join('\n');
    assert.equal(scanText('big.ts', many).length, 20);
  });
});

describe('scanProjectSecrets', () => {
  function setup(): { root: string; db: ArgusDb } {
    const root = mkdtempSync(join(tmpdir(), 'argus-secrets-'));
    const db = new ArgusDb(':memory:');
    return { root, db };
  }

  function indexFile(root: string, db: ArgusDb, rel: string, content: string): void {
    writeFileSync(join(root, rel), content);
    db.replaceFile(rel, sha256Hex(content), [], []);
  }

  it('scans incrementally and carries findings for unchanged files', () => {
    const { root, db } = setup();
    try {
      indexFile(root, db, 'a.ts', `export const key = "${AWS_KEY}";\n`);
      indexFile(root, db, 'b.ts', 'export const x = 1;\n');
      const first = scanProjectSecrets(db, root);
      assert.equal(first.scanned, 2);
      assert.equal(first.findings.length, 1);
      assert.equal(first.findings[0]?.kind, 'aws-access-key');
      assert.ok(!first.findings[0]?.preview.includes(AWS_KEY));

      db.storeAuditReport('secrets', first);
      const second = scanProjectSecrets(db, root);
      assert.equal(second.scanned, 0);
      assert.equal(second.unchanged, 2);
      assert.equal(second.findings.length, 1); // carried forward, not rescanned

      // Fixing the file clears the finding on the next changed-file scan.
      const fixed = 'export const key = process.env.AWS_KEY;\n';
      writeFileSync(join(root, 'a.ts'), fixed);
      db.replaceFile('a.ts', sha256Hex(fixed), [], []);
      db.storeAuditReport('secrets', second);
      const third = scanProjectSecrets(db, root);
      assert.equal(third.scanned, 1);
      assert.equal(third.findings.length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips large, binary, and unreadable files without throwing', () => {
    const { root, db } = setup();
    try {
      indexFile(root, db, 'ok.ts', 'export const x = 1;\n');
      indexFile(root, db, 'big.ts', `x = "${'A1'.repeat(500)}"\n`);
      indexFile(root, db, 'bin.ts', 'ab\0cd');
      db.replaceFile('ghost.ts', 'hash-without-a-file', [], []);
      const payload = scanProjectSecrets(db, root, { maxBytes: 64 });
      assert.equal(payload.scanned, 1);
      assert.equal(payload.skippedLarge, 2);
      assert.equal(payload.unreadable, 1);
      assert.equal(payload.findings.length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defers work past the per-run file cap', () => {
    const { root, db } = setup();
    try {
      indexFile(root, db, 'a.ts', 'export const a = 1;\n');
      indexFile(root, db, 'b.ts', 'export const b = 2;\n');
      const payload = scanProjectSecrets(db, root, { maxFiles: 1 });
      assert.equal(payload.scanned, 1);
      assert.equal(payload.deferred, 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops findings for files that left the index and survives malformed history', () => {
    const { root, db } = setup();
    try {
      indexFile(root, db, 'a.ts', `export const key = "${AWS_KEY}";\n`);
      assert.equal(scanProjectSecrets(db, root).findings.length, 1);
      db.deleteFile('a.ts');
      db.storeAuditReport('secrets', { findings: 'nope' });
      const payload = scanProjectSecrets(db, root);
      assert.equal(payload.findings.length, 0);
      assert.equal(db.secretScanHash('a.ts'), undefined);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs inside runAuditOnce only when a root is given', () => {
    const { root, db } = setup();
    try {
      indexFile(root, db, 'a.ts', `export const key = "${AWS_KEY}";\n`);
      assert.deepEqual(runAuditOnce(db), ['dead-code', 'duplicates']);
      assert.deepEqual(runAuditOnce(db, root), ['dead-code', 'duplicates', 'secrets']);
      const kinds = db.latestAuditReports().map((r) => r.kind).sort();
      assert.deepEqual(kinds, ['dead-code', 'duplicates', 'secrets']);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
