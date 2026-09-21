/** Polyglot AST engine: parses files with tree-sitter, extracts symbols + call refs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import {
  LANGUAGE_WASM,
  LIMITS,
  compact,
  languageForPath,
  type LanguageId,
  type RelationshipType,
  type SymbolKind,
} from './config.js';
import { queriesFor } from './queries.js';

export interface ParsedCall {
  callee: string;
  type: RelationshipType;
}

export interface ParsedSymbol {
  /** Qualified name, e.g. `UserService.getUser`. */
  name: string;
  kind: SymbolKind;
  signature: string;
  docstring: string | null;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  isExported: boolean;
  calls: ParsedCall[];
}

export type ParseResult =
  | { ok: true; symbols: ParsedSymbol[] }
  | { ok: false; reason: string };

interface LoadedLanguage {
  language: Language;
  symbolQuery: Query;
  refQuery: Query;
}

/** Body node types used when the `body` field is absent. */
const BODY_TYPES: ReadonlySet<string> = new Set([
  'block',
  'statement_block',
  'class_body',
  'declaration_list',
  'suite',
  'compound_statement',
]);

/** Signature keeps full text for these (fields/variants are the interface). */
const FULL_TEXT_KINDS: ReadonlySet<SymbolKind> = new Set(['struct', 'interface', 'enum', 'type']);

/** Kinds that build a qualified-name scope chain. */
const SCOPE_KINDS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'struct',
  'enum',
  'trait',
  'module',
]);

/** When several patterns match one node, highest priority wins. */
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  method: 100,
  class: 90,
  interface: 80,
  struct: 70,
  enum: 60,
  trait: 50,
  module: 40,
  type: 30,
  function: 20,
  variable: 10,
  constant: 10,
};

/** Safety cap so pathological files cannot flood the relationships table. */
const MAX_CALLS_PER_SYMBOL = 500;

interface DeclEntry {
  node: Node;
  kind: string;
  nameNode: Node | undefined;
}

function declKey(node: Node): string {
  return `${node.startIndex}:${node.endIndex}:${node.type}`;
}

function isComment(node: Node): boolean {
  return node.type === 'comment' || node.type.includes('comment');
}

/**
 * True when a comment sits directly above a node with no blank line between.
 * Line comments consume their trailing newline (end column 0), block comments
 * do not — the two cases need different row arithmetic.
 */
function isAdjacentAbove(sib: Node, cursor: Node): boolean {
  if (sib.endPosition.column === 0) {
    return sib.endPosition.row === cursor.startPosition.row;
  }
  return cursor.startPosition.row - sib.endPosition.row <= 1;
}

/** Last segment of `a.b`, `a::b`, `*Foo` — used for callee matching. */
export function simpleName(text: string): string {
  const cleaned = text.replace(/^[*&]+/, '').trim();
  const parts = cleaned.split(/::|\./);
  return parts[parts.length - 1] ?? cleaned;
}

export class ParserEngine {
  private readonly parser: Parser;
  private readonly loaded = new Map<LanguageId, LoadedLanguage>();
  private readonly unavailable = new Map<LanguageId, string>();

  private constructor(parser: Parser) {
    this.parser = parser;
  }

  static async create(): Promise<ParserEngine> {
    const require = createRequire(import.meta.url);
    const runtimeWasm = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
    await Parser.init({
      locateFile: (name: string) => (name.endsWith('.wasm') ? runtimeWasm : name),
    });
    const engine = new ParserEngine(new Parser());
    const ids: LanguageId[] = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'php', 'ruby'];
    for (const id of ids) {
      try {
        const spec = LANGUAGE_WASM[id];
        const wasmPath = join(dirname(require.resolve(`${spec.pkg}/package.json`)), spec.file);
        const bytes = readFileSync(wasmPath);
        const language = await Language.load(bytes);
        const pack = queriesFor(id);
        engine.loaded.set(id, {
          language,
          symbolQuery: new Query(language, pack.symbols),
          refQuery: new Query(language, pack.refs),
        });
      } catch (err) {
        engine.unavailable.set(id, err instanceof Error ? err.message : String(err));
      }
    }
    return engine;
  }

  /** Languages that loaded successfully. */
  supportedLanguages(): LanguageId[] {
    return [...this.loaded.keys()];
  }

  unavailableLanguages(): ReadonlyMap<LanguageId, string> {
    return this.unavailable;
  }

  dispose(): void {
    for (const lang of this.loaded.values()) {
      lang.symbolQuery.delete();
      lang.refQuery.delete();
    }
    this.parser.delete();
  }

  parseFile(filePath: string, content: string): ParseResult {
    const lang = languageForPath(filePath);
    if (lang === undefined) return { ok: false, reason: 'unsupported extension' };
    const loaded = this.loaded.get(lang);
    if (loaded === undefined) {
      return { ok: false, reason: `grammar unavailable: ${this.unavailable.get(lang) ?? lang}` };
    }
    let tree;
    try {
      this.parser.setLanguage(loaded.language);
      tree = this.parser.parse(content);
    } catch (err) {
      return { ok: false, reason: `parse threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (tree === null) return { ok: false, reason: 'parse returned null' };
    try {
      return { ok: true, symbols: this.extractSymbols(lang, tree.rootNode) };
    } catch (err) {
      return { ok: false, reason: `extract threw: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      tree.delete();
    }
  }

  // ---- extraction ----

  private extractSymbols(lang: LanguageId, root: Node): ParsedSymbol[] {
    const loaded = this.loaded.get(lang);
    if (loaded === undefined) return [];

    // 1. Collect declaration captures, deduping nodes matched by several patterns.
    const decls = new Map<string, DeclEntry>();
    for (const match of loaded.symbolQuery.matches(root)) {
      let kind: string | undefined;
      let declNode: Node | undefined;
      let nameNode: Node | undefined;
      for (const cap of match.captures) {
        if (cap.name.startsWith('sym.') && cap.name !== 'sym.name') {
          kind = cap.name.slice('sym.'.length);
          declNode = cap.node;
        } else if (cap.name === 'sym.name') {
          nameNode = cap.node;
        }
      }
      if (kind === undefined || declNode === undefined) continue;
      const key = declKey(declNode);
      const prev = decls.get(key);
      const prio = KIND_PRIORITY[kind] ?? 0;
      if (prev === undefined || prio > (KIND_PRIORITY[prev.kind] ?? 0)) {
        decls.set(key, { node: declNode, kind, nameNode: nameNode ?? prev?.nameNode });
      } else if (prev.nameNode === undefined && nameNode !== undefined) {
        prev.nameNode = nameNode;
      }
    }

    // 2. Resolve each declaration to a symbol.
    const out: ParsedSymbol[] = [];
    for (const entry of decls.values()) {
      // Skip closures/inner functions nested inside another function-like decl.
      if (this.hasAncestorDecl(decls, entry.node, new Set(['function', 'method']))) continue;
      const simple = this.declSimpleName(entry);
      if (simple === '') continue;
      const kind = this.resolveKind(lang, entry);
      const scopes = this.scopeChain(lang, decls, entry.node, simple);
      const name = scopes.length > 0 ? `${scopes.join('.')}.${simple}` : simple;
      const signature = this.extractSignature(entry.node, kind);
      if (signature === '') continue;
      // Climb wrappers (export, decorators) so lines + doc comments attach correctly.
      let outer = entry.node;
      while (
        outer.parent !== null &&
        (outer.parent.type === 'decorated_definition' || outer.parent.type === 'export_statement')
      ) {
        outer = outer.parent;
      }
      const docstring = this.extractDocstring(lang, entry.node, outer);
      out.push({
        name,
        kind,
        signature,
        docstring,
        startLine: outer.startPosition.row + 1,
        endLine: outer.endPosition.row + 1,
        isExported: this.computeExported(lang, entry.node, simple),
        calls: this.extractCalls(loaded, entry.node),
      });
    }
    out.sort((a, b) => a.startLine - b.startLine);
    return out;
  }

  private hasAncestorDecl(decls: Map<string, DeclEntry>, node: Node, kinds: ReadonlySet<string>): boolean {
    let cur = node.parent;
    while (cur !== null) {
      const hit = decls.get(declKey(cur));
      if (hit !== undefined && kinds.has(hit.kind)) return true;
      cur = cur.parent;
    }
    return false;
  }

  private declSimpleName(entry: DeclEntry): string {
    if (entry.nameNode !== undefined) return entry.nameNode.text.trim();
    const field = entry.node.childForFieldName('name');
    if (field !== null) return field.text.trim();
    const ident = entry.node.namedChildren.find(
      (c) => c.type === 'identifier' || c.type === 'name' || c.type === 'type_identifier' || c.type === 'field_identifier',
    );
    return ident?.text.trim() ?? '';
  }

  /** Reclassify ambiguous captures (Python/Ruby `def` inside a class is a method). */
  private resolveKind(lang: LanguageId, entry: DeclEntry): SymbolKind {
    // Note: Python's root node is literally named `module` — it is not a scope.
    const scopeTypes = lang === 'python' ? ['class_definition'] : lang === 'ruby' ? ['class', 'module'] : [];
    if (entry.kind === 'function' && scopeTypes.length > 0) {
      let cur = entry.node.parent;
      while (cur !== null) {
        if (scopeTypes.includes(cur.type)) return 'method';
        cur = cur.parent;
      }
    }
    return entry.kind as SymbolKind;
  }

  private scopeChain(
    lang: LanguageId,
    decls: Map<string, DeclEntry>,
    node: Node,
    selfSimple: string,
  ): string[] {
    // Go methods: receiver type; Rust methods: enclosing impl type.
    if (lang === 'go' && node.type === 'method_declaration') {
      const recv = this.goReceiverType(node);
      return recv === undefined ? [] : [recv];
    }
    if (lang === 'rust') {
      let cur = node.parent;
      while (cur !== null) {
        if (cur.type === 'impl_item') {
          const ty = cur.childForFieldName('type');
          if (ty !== null && ty.text.trim() !== '') return [simpleName(ty.text)];
          break;
        }
        cur = cur.parent;
      }
    }
    const scopes: string[] = [];
    let cur = node.parent;
    while (cur !== null) {
      const hit = decls.get(declKey(cur));
      if (hit !== undefined && SCOPE_KINDS.has(hit.kind as SymbolKind)) {
        const seg = this.declSimpleName(hit);
        if (seg !== '' && seg !== selfSimple) scopes.unshift(seg);
      }
      cur = cur.parent;
    }
    return scopes;
  }

  private goReceiverType(node: Node): string | undefined {
    const recv = node.childForFieldName('receiver');
    if (recv === null) return undefined;
    const text = recv.text.replace(/[()\s]/g, '');
    const lastSpace = text.lastIndexOf(',');
    const ty = (lastSpace >= 0 ? text.slice(lastSpace + 1) : text).replace(/^[*]+/, '');
    // `(s *Service)` -> text `s*Service`; take trailing identifier.
    const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(ty);
    return m?.[1];
  }

  private extractSignature(node: Node, kind: SymbolKind): string {
    if (FULL_TEXT_KINDS.has(kind)) return compact(node.text, LIMITS.maxSignatureChars);
    const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => BODY_TYPES.has(c.type));
    const raw = body !== undefined && body !== null ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
    return compact(raw, LIMITS.maxSignatureChars);
  }

  private extractDocstring(lang: LanguageId, node: Node, outer: Node): string | null {
    if (lang === 'python') {
      const inner = this.pythonDocstring(node);
      if (inner !== null) return inner;
    }
    const comments: string[] = [];
    let cursor: Node = outer;
    let guard = 0;
    while (guard++ < 25) {
      const sib = cursor.previousNamedSibling;
      if (sib === null || !isComment(sib)) break;
      if (!isAdjacentAbove(sib, cursor)) break;
      comments.unshift(sib.text);
      cursor = sib;
    }
    if (comments.length === 0) return null;
    return compact(comments.join('\n'), LIMITS.maxDocstringChars);
  }

  private pythonDocstring(node: Node): string | null {
    const body = node.childForFieldName('body');
    if (body === null) return null;
    const first = body.namedChildren[0];
    if (first?.type !== 'expression_statement') return null;
    const str = first.namedChildren[0];
    if (str === undefined || (str.type !== 'string' && str.type !== 'string_content')) return null;
    const text = str.text.replace(/^["']{1,3}|["']{1,3}$/g, '').trim();
    return text === '' ? null : compact(text, LIMITS.maxDocstringChars);
  }

  private computeExported(lang: LanguageId, node: Node, simple: string): boolean {
    switch (lang) {
      case 'javascript':
      case 'typescript':
      case 'tsx': {
        let cur = node.parent;
        while (cur !== null) {
          if (cur.type === 'export_statement') return true;
          cur = cur.parent;
        }
        return false;
      }
      case 'python':
        return !simple.startsWith('_');
      case 'go':
        return /^[A-Z]/.test(simple);
      case 'rust':
        return node.namedChildren.some((c) => c.type === 'visibility_modifier');
      case 'php':
      case 'ruby':
        return true;
    }
  }

  private extractCalls(loaded: LoadedLanguage, declNode: Node): ParsedCall[] {
    const calls: ParsedCall[] = [];
    const seen = new Set<string>();
    for (const match of loaded.refQuery.matches(declNode)) {
      for (const cap of match.captures) {
        let type: RelationshipType | undefined;
        if (cap.name === 'ref.calls') type = 'calls';
        else if (cap.name === 'ref.extends') type = 'extends';
        else if (cap.name === 'ref.implements') type = 'implements';
        if (type === undefined) continue;
        const callee = simpleName(cap.node.text);
        if (callee === '') continue;
        const key = `${type}:${callee}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ callee, type });
        if (calls.length >= MAX_CALLS_PER_SYMBOL) return calls;
      }
    }
    return calls;
  }
}
