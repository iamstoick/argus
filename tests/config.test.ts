import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProjectName, flagValue, hasFlag, parseServeArgs } from '../src/cli.js';
import { isValidProjectName, parseConfigFile, resolveToken } from '../src/config.js';

describe('parseConfigFile', () => {
  it('accepts a valid config and resolves relative paths', () => {
    const cfg = parseConfigFile(
      JSON.stringify({ projects: [{ name: 'web', path: '/srv/web' }, { name: 'api', path: 'rel/api' }] }),
      '/base',
    );
    assert.deepEqual(cfg.projects, [
      { name: 'web', path: '/srv/web' },
      { name: 'api', path: '/base/rel/api' },
    ]);
  });

  it('rejects malformed configs', () => {
    assert.throws(() => parseConfigFile('nope', '/b'), /invalid JSON/);
    assert.throws(() => parseConfigFile('[]', '/b'), /must be an object/);
    assert.throws(() => parseConfigFile('{}', '/b'), /non-empty array/);
    assert.throws(() => parseConfigFile(JSON.stringify({ projects: [] }), '/b'), /non-empty array/);
    assert.throws(() => parseConfigFile(JSON.stringify({ projects: [{}] }), '/b'), /projects\[0\].name/);
    assert.throws(
      () => parseConfigFile(JSON.stringify({ projects: [{ name: 'bad name!', path: '/x' }] }), '/b'),
      /projects\[0\].name/,
    );
    assert.throws(
      () => parseConfigFile(JSON.stringify({ projects: [{ name: 'a', path: '' }] }), '/b'),
      /projects\[0\].path/,
    );
    assert.throws(
      () =>
        parseConfigFile(
          JSON.stringify({ projects: [{ name: 'a', path: '/x' }, { name: 'a', path: '/y' }] }),
          '/b',
        ),
      /duplicate project name/,
    );
  });
});

describe('isValidProjectName', () => {
  it('allows alphanumerics, dash, underscore', () => {
    assert.equal(isValidProjectName('web-2_api'), true);
    assert.equal(isValidProjectName(''), false);
    assert.equal(isValidProjectName('-lead'), false);
    assert.equal(isValidProjectName('has space'), false);
    assert.equal(isValidProjectName('a'.repeat(65)), false);
  });
});

describe('resolveToken', () => {
  it('prefers --token over env', () => {
    assert.equal(resolveToken(['--token', 'abc'], {}), 'abc');
    assert.equal(resolveToken(['--token=abc'], {}), 'abc');
    assert.equal(resolveToken([], { ARGUS_TOKEN: 'env' }), 'env');
    assert.equal(resolveToken(['--token', 'abc'], { ARGUS_TOKEN: 'env' }), 'abc');
    assert.equal(resolveToken([], {}), undefined);
    assert.equal(resolveToken([], { ARGUS_TOKEN: '' }), undefined);
  });
});

describe('parseServeArgs', () => {
  it('parses flags with defaults', () => {
    assert.deepEqual(parseServeArgs(['--config', 'a.json']), {
      configPath: 'a.json',
      root: undefined,
      host: '127.0.0.1',
      port: 3000,
      noWatch: false,
      stdio: false,
    });
    const full = parseServeArgs(['--root=/x', '--host=0.0.0.0', '--port=8080', '--no-watch', '--stdio']);
    assert.deepEqual(full, { configPath: undefined, root: '/x', host: '0.0.0.0', port: 8080, noWatch: true, stdio: true });
  });

  it('rejects bad ports', () => {
    assert.throws(() => parseServeArgs(['--port=abc']), /invalid --port/);
    assert.throws(() => parseServeArgs(['--port=99999']), /invalid --port/);
  });
});

describe('cli helpers', () => {
  it('flagValue and hasFlag', () => {
    assert.equal(flagValue(['--a', '1'], 'a'), '1');
    assert.equal(flagValue(['--a=2'], 'a'), '2');
    assert.equal(flagValue([], 'a'), undefined);
    assert.equal(hasFlag(['--x'], 'x'), true);
    assert.equal(hasFlag([], 'x'), false);
  });

  it('defaultProjectName sanitizes directory basenames', () => {
    assert.equal(defaultProjectName('/srv/my-web'), 'my-web');
    assert.equal(defaultProjectName('/srv/weird name!'), 'weird-name-');
    assert.equal(defaultProjectName('/'), 'project');
  });
});
