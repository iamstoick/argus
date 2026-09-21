/** Parser fixtures: validate each language's query pack against real grammars. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ParserEngine, type ParsedSymbol } from '../src/parser.js';

let engine: ParserEngine;

before(async () => {
  engine = await ParserEngine.create();
});

function parse(path: string, content: string): ParsedSymbol[] {
  const res = engine.parseFile(path, content);
  assert.equal(res.ok, true, `parse failed: ${res.ok ? '' : res.reason}`);
  return res.ok ? res.symbols : [];
}

function byName(symbols: ParsedSymbol[]): Map<string, ParsedSymbol> {
  return new Map(symbols.map((s) => [s.name, s]));
}

describe('typescript', () => {
  const src = `/** Adds two numbers. */
export async function add(a: number, b: number): Promise<number> {
  return a + b;
}

function helper(x: string): string {
  return x.trim();
}

export interface User {
  id: string;
  name: string;
}

export type ID = string | number;

export enum Role {
  Admin = 'admin',
}

export class Store extends Base implements Disposable {
  private items: string[] = [];

  /** Save one item. */
  save(item: string): void {
    const clean = helper(item);
    this.items.push(clean);
  }
}

export const double = (n: number): number => n * 2;
`;
  it('extracts functions, class, method, interface, type, enum, arrow const', () => {
    const m = byName(parse('a.ts', src));
    assert.equal(m.get('add')?.kind, 'function');
    assert.equal(m.get('add')?.isExported, true);
    assert.match(m.get('add')?.signature ?? '', /async function add\(a: number, b: number\): Promise<number>/);
    assert.match(m.get('add')?.docstring ?? '', /Adds two numbers/);
    assert.equal(m.get('helper')?.isExported, false);
    assert.equal(m.get('User')?.kind, 'interface');
    assert.match(m.get('User')?.signature ?? '', /id: string/);
    assert.equal(m.get('ID')?.kind, 'type');
    assert.equal(m.get('Role')?.kind, 'enum');
    assert.equal(m.get('Store')?.kind, 'class');
    assert.equal(m.get('Store.save')?.kind, 'method');
    assert.match(m.get('Store.save')?.docstring ?? '', /Save one item/);
    assert.equal(m.get('double')?.kind, 'function');
  });

  it('records calls, extends, implements', () => {
    const m = byName(parse('a.ts', src));
    const save = m.get('Store.save');
    assert.ok(save?.calls.some((c) => c.callee === 'helper' && c.type === 'calls'));
    const store = m.get('Store');
    assert.ok(store?.calls.some((c) => c.callee === 'Base' && c.type === 'extends'));
    assert.ok(store?.calls.some((c) => c.callee === 'Disposable' && c.type === 'implements'));
  });

  it('reports 1-based line ranges', () => {
    const m = byName(parse('a.ts', src));
    assert.equal(m.get('add')?.startLine, 2);
    assert.equal(m.get('add')?.endLine, 4);
  });
});

describe('javascript', () => {
  it('extracts ESM exports and marks locals unexported', () => {
    const m = byName(
      parse(
        'a.js',
        `export function pub() {\n  return inner();\n}\n\nfunction inner() {\n  return 1;\n}\n\nexport default class Widget {\n  render() {\n    return 'x';\n  }\n}\n`,
      ),
    );
    assert.equal(m.get('pub')?.kind, 'function');
    assert.equal(m.get('pub')?.isExported, true);
    assert.equal(m.get('inner')?.isExported, false);
    assert.equal(m.get('Widget')?.kind, 'class');
    assert.equal(m.get('Widget.render')?.kind, 'method');
    assert.ok(m.get('pub')?.calls.some((c) => c.callee === 'inner'));
  });
});

describe('python', () => {
  const src = `"""Module docstring."""

import os


def greet(name: str) -> str:
    """Say hello."""
    return f"hi {name}"


def _private():
    return 1


class Service(Base):
    """Does things."""

    def __init__(self, dsn: str):
        self.dsn = dsn

    @property
    def dsn(self) -> str:
        return self._dsn

    def run(self):
        return greet("x")


@decorator
def wrapped():
    pass
`;
  it('extracts functions, class, methods; binds docstrings', () => {
    const m = byName(parse('a.py', src));
    assert.equal(m.get('greet')?.kind, 'function');
    assert.equal(m.get('greet')?.isExported, true);
    assert.match(m.get('greet')?.signature ?? '', /def greet\(name: str\) -> str:/);
    assert.match(m.get('greet')?.docstring ?? '', /Say hello/);
    assert.equal(m.get('_private')?.isExported, false);
    assert.equal(m.get('Service')?.kind, 'class');
    assert.match(m.get('Service')?.docstring ?? '', /Does things/);
    assert.equal(m.get('Service.__init__')?.kind, 'method');
    assert.equal(m.get('Service.run')?.kind, 'method');
    assert.equal(m.get('wrapped')?.kind, 'function');
  });

  it('records calls and extends', () => {
    const m = byName(parse('a.py', src));
    assert.ok(m.get('Service.run')?.calls.some((c) => c.callee === 'greet'));
    assert.ok(m.get('Service')?.calls.some((c) => c.callee === 'Base' && c.type === 'extends'));
  });
});

describe('go', () => {
  const src = `package store

import "fmt"

// Store holds items.
type Store struct {
\titems []string
}

// Saver persists items.
type Saver interface {
\tSave(item string) error
}

type ID string

// NewStore builds a Store.
func NewStore() *Store {
\treturn &Store{}
}

func helper(s string) string {
\treturn s
}

// Save one item.
func (s *Store) Save(item string) error {
\tclean := helper(item)
\tfmt.Println(clean)
\treturn nil
}
`;
  it('extracts funcs, methods, struct, interface, alias', () => {
    const m = byName(parse('a.go', src));
    assert.equal(m.get('NewStore')?.kind, 'function');
    assert.equal(m.get('NewStore')?.isExported, true);
    assert.match(m.get('NewStore')?.docstring ?? '', /builds a Store/);
    assert.equal(m.get('helper')?.isExported, false);
    assert.equal(m.get('Store')?.kind, 'struct');
    assert.equal(m.get('Saver')?.kind, 'interface');
    assert.equal(m.get('ID')?.kind, 'type');
    assert.equal(m.get('Store.Save')?.kind, 'method');
    assert.match(m.get('Store.Save')?.signature ?? '', /func \(s \*Store\) Save\(item string\) error/);
  });

  it('records calls', () => {
    const m = byName(parse('a.go', src));
    const save = m.get('Store.Save');
    assert.ok(save?.calls.some((c) => c.callee === 'helper'));
    assert.ok(save?.calls.some((c) => c.callee === 'Println'));
  });
});

describe('rust', () => {
  const src = `//! Crate docs.

/// A user.
pub struct User {
    pub id: u64,
}

pub enum Status {
    Active,
    Gone,
}

pub trait Named {
    fn name(&self) -> &str;
}

impl User {
    /// Build one.
    pub fn new(id: u64) -> Self {
        helper();
        User { id }
    }

    fn secret(&self) {}
}

fn helper() {}

pub fn run() {
    let u = User::new(1);
    println!("{}", u.id);
}
`;
  it('extracts items, impl methods, trait', () => {
    const m = byName(parse('a.rs', src));
    assert.equal(m.get('User')?.kind, 'struct');
    assert.equal(m.get('User')?.isExported, true);
    assert.equal(m.get('Status')?.kind, 'enum');
    assert.equal(m.get('Named')?.kind, 'trait');
    assert.equal(m.get('User.new')?.kind, 'method');
    assert.equal(m.get('User.new')?.isExported, true);
    assert.match(m.get('User.new')?.docstring ?? '', /Build one/);
    assert.equal(m.get('User.secret')?.isExported, false);
    assert.equal(m.get('run')?.kind, 'function');
    assert.equal(m.get('helper')?.isExported, false);
  });

  it('records calls', () => {
    const m = byName(parse('a.rs', src));
    assert.ok(m.get('User.new')?.calls.some((c) => c.callee === 'helper'));
    assert.ok(m.get('run')?.calls.some((c) => c.callee === 'new'));
  });
});

describe('php', () => {
  const src = `<?php

declare(strict_types=1);

/** Add numbers. */
function add(int $a, int $b): int {
    return $a + $b;
}

interface Storable {
    public function save(string $item): void;
}

class Store extends BaseStore implements Storable {
    /** Save one item. */
    public function save(string $item): void {
        $clean = trim($item);
        $this->persist($clean);
        add(1, 2);
    }

    private function persist(string $item): void {
    }
}
`;
  it('extracts functions, class, methods, interface', () => {
    const m = byName(parse('a.php', src));
    assert.equal(m.get('add')?.kind, 'function');
    assert.match(m.get('add')?.docstring ?? '', /Add numbers/);
    assert.equal(m.get('Storable')?.kind, 'interface');
    assert.equal(m.get('Store')?.kind, 'class');
    assert.equal(m.get('Store.save')?.kind, 'method');
    assert.equal(m.get('Store.persist')?.kind, 'method');
  });

  it('records calls, extends, implements', () => {
    const m = byName(parse('a.php', src));
    const save = m.get('Store.save');
    assert.ok(save?.calls.some((c) => c.callee === 'trim'), JSON.stringify(save?.calls));
    assert.ok(save?.calls.some((c) => c.callee === 'add'));
    const store = m.get('Store');
    assert.ok(store?.calls.some((c) => c.callee === 'BaseStore' && c.type === 'extends'));
    assert.ok(store?.calls.some((c) => c.callee === 'Storable' && c.type === 'implements'));
  });
});

describe('ruby', () => {
  const src = `# Adds things.
def add(a, b)
  helper(a) + b
end

def helper(a)
  a
end

class Store < Base
  # Save one item.
  def save(item)
    clean = helper(item)
    persist(clean)
  end

  def self.build
    new
  end
end

module Queue
  def push(x)
  end
end
`;
  it('extracts methods, classes, modules with qualified names', () => {
    const m = byName(parse('a.rb', src));
    assert.equal(m.get('add')?.kind, 'function');
    assert.match(m.get('add')?.docstring ?? '', /Adds things/);
    assert.equal(m.get('Store')?.kind, 'class');
    assert.equal(m.get('Store.save')?.kind, 'method');
    assert.equal(m.get('Store.build')?.kind, 'method');
    assert.equal(m.get('Queue')?.kind, 'module');
    assert.equal(m.get('Queue.push')?.kind, 'method');
  });

  it('records calls and extends', () => {
    const m = byName(parse('a.rb', src));
    assert.ok(m.get('add')?.calls.some((c) => c.callee === 'helper'));
    assert.ok(m.get('Store')?.calls.some((c) => c.callee === 'Base' && c.type === 'extends'));
  });
});

describe('robustness', () => {
  it('skips unsupported extensions', () => {
    const res = engine.parseFile('a.txt', 'hello');
    assert.equal(res.ok, false);
  });

  it('handles syntax-broken files without throwing', () => {
    const res = engine.parseFile('a.ts', 'export function broken( {\n  const x = ;;;\n');
    assert.equal(res.ok, true);
  });

  it('loads every planned grammar', () => {
    const langs = engine.supportedLanguages().sort();
    assert.deepEqual(langs, ['go', 'javascript', 'php', 'python', 'ruby', 'rust', 'tsx', 'typescript']);
  });
});
