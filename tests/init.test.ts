import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_RULE,
  HOOK_FILENAME,
  defaultHooksSourceDir,
  parseClientList,
  runInit,
  stripJsonComments,
  type ClientName,
} from '../src/init.js';

function runHook(script: string, input: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'ignore'] });
    if (child.stdin === null || child.stdout === null) {
      reject(new Error('hook stdio unavailable'));
      return;
    }
    const stdin = child.stdin;
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    stdin.write(input);
    stdin.end();
  });
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'argus-init-'));
}

function makeHookSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'argus-hook-src-'));
  writeFileSync(join(dir, HOOK_FILENAME), '# fixture hook\n');
  return dir;
}

describe('runInit', () => {
  it('creates .mcp.json, AGENTS.md rule, hook, and settings wiring', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      const actions = runInit({ root, entrypoint: '/opt/argus/dist/src/index.js', hooksSourceDir });
      assert.deepEqual(actions.map((a) => a.action), ['created', 'created', 'created', 'created']);
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
        mcpServers: { argus: { command: string; args: string[] } };
      };
      assert.deepEqual(mcp.mcpServers.argus, {
        command: 'node',
        args: ['/opt/argus/dist/src/index.js', '--root', root],
      });
      const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
      assert.ok(agents.includes('## Argus index rule'));
      assert.equal(agents.match(/lookup_dictionary/g)?.length, 1);
      assert.equal(readFileSync(join(root, '.claude', 'hooks', HOOK_FILENAME), 'utf8'), '# fixture hook\n');
      const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      assert.equal(settings.hooks.PreToolUse[0]?.matcher, 'Write');
      assert.equal(
        settings.hooks.PreToolUse[0]?.hooks[0]?.command,
        `python3 ${join(root, '.claude', 'hooks', HOOK_FILENAME)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('is idempotent and never duplicates the rule', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      runInit({ root, entrypoint: '/x/index.js', hooksSourceDir });
      const second = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir });
      assert.ok(second.every((a) => a.action === 'unchanged'));
      assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8').match(/lookup_dictionary/g)?.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('merges with existing configs and honors force', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
      writeFileSync(join(root, 'AGENTS.md'), '# Prior notes\n');
      const actions = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir });
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
      assert.ok(mcp.mcpServers['other'] !== undefined && mcp.mcpServers['argus'] !== undefined);
      const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
      assert.ok(agents.startsWith('# Prior notes\n'));
      assert.ok(agents.includes(AGENTS_RULE.trim()));
      assert.equal(actions.find((a) => a.file.endsWith('.mcp.json'))?.action, 'updated');

      const kept = runInit({ root, entrypoint: '/y/index.js', hooksSourceDir });
      assert.equal(kept.find((a) => a.file.endsWith('.mcp.json'))?.action, 'unchanged');
      const forced = runInit({ root, entrypoint: '/y/index.js', hooksSourceDir, force: true });
      assert.equal(forced.find((a) => a.file.endsWith('.mcp.json'))?.action, 'updated');
      const mcp2 = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
        mcpServers: { argus: { args: string[] } };
      };
      assert.equal(mcp2.mcpServers.argus.args[0], '/y/index.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('replaces stale hook wiring and preserves unrelated hooks', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      runInit({ root, entrypoint: '/x/index.js', hooksSourceDir });
      const settingsPath = join(root, '.claude', 'settings.json');
      const stale = {
        hooks: {
          PreToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: `python3 /moved/${HOOK_FILENAME}` }] },
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(stale));
      const actions = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, force: true });
      assert.equal(actions.find((a) => a.file === settingsPath)?.action, 'updated');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
      assert.ok(commands.some((c) => c === `python3 ${join(root, '.claude', 'hooks', HOOK_FILENAME)}`));
      assert.ok(!commands.some((c) => c.includes('/moved/')));
      assert.ok(commands.includes('echo hi'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('throws on invalid JSON, missing roots, and missing templates', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      writeFileSync(join(root, '.mcp.json'), '{nope');
      assert.throws(() => runInit({ root, entrypoint: '/x/index.js', hooksSourceDir }), /not valid JSON/);
      const forced = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, force: true });
      assert.equal(forced.find((a) => a.file.endsWith('.mcp.json'))?.action, 'updated');
      assert.throws(
        () => runInit({ root: join(root, 'missing'), entrypoint: '/x/index.js', hooksSourceDir }),
        /does not exist/,
      );
      const fileRoot = join(root, 'AGENTS.md');
      assert.throws(() => runInit({ root: fileRoot, entrypoint: '/x/index.js', hooksSourceDir }), /not a directory/);
      assert.throws(
        () => runInit({ root, entrypoint: '/x/index.js', hooksSourceDir: join(root, 'nope') }),
        /hook template missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('supports ts entrypoints and skip flags', () => {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    try {
      const actions = runInit({
        root,
        entrypoint: '/repo/src/index.ts',
        hooksSourceDir,
        agentsMd: false,
        hooks: false,
      });
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
        mcpServers: { argus: { args: string[] } };
      };
      assert.deepEqual(mcp.mcpServers.argus.args, ['--experimental-strip-types', '/repo/src/index.ts', '--root', root]);
      assert.equal(actions.find((a) => a.file.endsWith('AGENTS.md'))?.action, 'skipped');
      assert.equal(actions.find((a) => a.file.endsWith('hooks'))?.action, 'skipped');
      assert.equal(existsSync(join(root, 'AGENTS.md')), false);
      assert.equal(existsSync(join(root, '.claude')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('installs the real hook template from the packaged examples', () => {
    const root = makeRoot();
    try {
      const actions = runInit({ root, entrypoint: '/x/index.js' });
      const dest = join(root, '.claude', 'hooks', HOOK_FILENAME);
      assert.equal(actions.find((a) => a.file === dest)?.action, 'created');
      assert.match(readFileSync(dest, 'utf8'), /lookup_dictionary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseClientList', () => {
  it('defaults to Claude Code and parses all flag forms', () => {
    assert.deepEqual(parseClientList([]), ['claude']);
    assert.deepEqual(parseClientList(['--root', '.']), ['claude']);
    assert.deepEqual(parseClientList(['--client', 'cursor']), ['cursor']);
    assert.deepEqual(parseClientList(['--client=vscode']), ['vscode']);
    assert.deepEqual(parseClientList(['--client', 'cursor,vscode']), ['cursor', 'vscode']);
    assert.deepEqual(parseClientList(['--client', 'cursor', '--client=vscode']), ['cursor', 'vscode']);
    assert.deepEqual(parseClientList(['--client', 'cursor,cursor']), ['cursor']);
    assert.deepEqual(parseClientList(['--client', 'all']), ['claude', 'cursor', 'vscode']);
    assert.deepEqual(parseClientList(['--client', 'vscode', '--client', 'all']), ['claude', 'cursor', 'vscode']);
  });

  it('ignores empty values and bare flags, throws on unknown names', () => {
    assert.deepEqual(parseClientList(['--client=']), ['claude']);
    assert.deepEqual(parseClientList(['--client', '--force']), ['claude']);
    assert.deepEqual(parseClientList(['--client', ' ,cursor, ']), ['cursor']);
    assert.throws(() => parseClientList(['--client', 'windsurf']), /unknown --client 'windsurf'/);
    assert.throws(() => parseClientList(['--client=Claude']), /unknown --client/);
  });
});

describe('stripJsonComments', () => {
  it('strips line and block comments but keeps strings intact', () => {
    const text = '{\n// leading comment\n"a": 1, /* inline */ "url": "http://x//y", "b": "/*not*/", "c": "q\\"//q"\n}';
    const parsed = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
    assert.deepEqual(parsed, { a: 1, url: 'http://x//y', b: '/*not*/', c: 'q"//q' });
    assert.equal(stripJsonComments('{"a":1}'), '{"a":1}');
  });
});

describe('runInit clients', () => {
  function clientsRoot(): { root: string; hooksSourceDir: string } {
    const root = makeRoot();
    const hooksSourceDir = makeHookSource();
    return { root, hooksSourceDir };
  }

  it('writes per-client configs with native shapes', () => {
    const { root, hooksSourceDir } = clientsRoot();
    try {
      const clients: ClientName[] = ['cursor', 'vscode'];
      const actions = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, clients });
      assert.equal(existsSync(join(root, '.mcp.json')), false);
      const cursor = JSON.parse(readFileSync(join(root, '.cursor/mcp.json'), 'utf8')) as {
        mcpServers: { argus: { command: string; args: string[] } };
      };
      assert.deepEqual(cursor.mcpServers.argus, { command: 'node', args: ['/x/index.js', '--root', root] });
      const vscode = JSON.parse(readFileSync(join(root, '.vscode/mcp.json'), 'utf8')) as {
        servers: { argus: { type: string; command: string; args: string[] } };
      };
      assert.deepEqual(vscode.servers.argus, {
        type: 'stdio',
        command: 'node',
        args: ['/x/index.js', '--root', root],
      });
      assert.equal(actions.find((a) => a.file.endsWith(join('.claude', 'hooks')))?.action, 'skipped');
      assert.equal(existsSync(join(root, 'AGENTS.md')), true);
      // Idempotent rerun.
      const second = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, clients });
      assert.ok(second.every((a) => a.action === 'unchanged' || a.action === 'skipped'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('merges into commented VS Code files without losing servers', () => {
    const { root, hooksSourceDir } = clientsRoot();
    try {
      mkdirSync(join(root, '.vscode'), { recursive: true });
      writeFileSync(
        join(root, '.vscode/mcp.json'),
        '{\n  // Managed section below\n  "servers": {\n    /* keep me */ "other": { "type": "stdio", "command": "x" }\n  }\n}\n',
      );
      const actions = runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, clients: ['vscode'] });
      assert.equal(actions.find((a) => a.file.endsWith('mcp.json'))?.action, 'updated');
      const merged = JSON.parse(readFileSync(join(root, '.vscode/mcp.json'), 'utf8')) as {
        servers: Record<string, unknown>;
      };
      assert.ok(merged.servers['other'] !== undefined && merged.servers['argus'] !== undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });

  it('installs hooks only when Claude is selected', () => {
    const { root, hooksSourceDir } = clientsRoot();
    try {
      runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, clients: ['vscode'] });
      assert.equal(existsSync(join(root, '.claude')), false);
      runInit({ root, entrypoint: '/x/index.js', hooksSourceDir, clients: ['vscode', 'claude'] });
      assert.equal(existsSync(join(root, '.claude', 'hooks', HOOK_FILENAME)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(hooksSourceDir, { recursive: true, force: true });
    }
  });
});

describe('check-index-first hook', () => {
  function pythonAvailable(): boolean {
    if (process.platform === 'win32') return false;
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it('nudges on new code files and stays silent otherwise', async (t) => {
    if (!pythonAvailable()) {
      t.skip('python3 unavailable here; skipping hook script test');
      return;
    }
    const script = join(defaultHooksSourceDir(), HOOK_FILENAME);
    if (!existsSync(script)) {
      t.skip('packaged hook template missing (build did not copy examples); skipping');
      return;
    }
    const run = async (input: string): Promise<string> => {
      const { code, stdout } = await runHook(script, input);
      assert.equal(code, 0);
      return stdout;
    };
    const fresh = join(tmpdir(), `argus-hook-new-${Date.now()}.py`);
    const out = await run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: fresh } }));
    const parsed = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(parsed.hookSpecificOutput.additionalContext, /lookup_dictionary/);

    const existing = join(tmpdir(), `argus-hook-old-${Date.now()}.py`);
    writeFileSync(existing, 'x = 1\n');
    try {
      assert.equal(await run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: existing } })), '');
      assert.equal(await run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: fresh } })), '');
      assert.equal(await run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: fresh.replace(/\.py$/, '.md') } })), '');
      assert.equal(await run('not json{{'), '');
    } finally {
      rmSync(existing, { force: true });
    }
  });

  it('ships a valid settings snippet', () => {
    const snippet = JSON.parse(readFileSync(join(defaultHooksSourceDir(), 'claude-hooks.json'), 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    assert.equal(snippet.hooks.PreToolUse[0]?.matcher, 'Write');
    assert.equal(snippet.hooks.PreToolUse[0]?.hooks[0]?.type, 'command');
    assert.ok(snippet.hooks.PreToolUse[0]?.hooks[0]?.command.includes(HOOK_FILENAME));
  });
});
