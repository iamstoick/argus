/** Shared configuration: language map, ignore rules, token budgets. */

export type LanguageId =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'php'
  | 'ruby';

/** File extension (lowercase, with dot) -> tree-sitter language. */
export const EXTENSION_LANGUAGE: ReadonlyMap<string, LanguageId> = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.php', 'php'],
  ['.rb', 'ruby'],
]);

/** Official grammar package + wasm file per language. */
export const LANGUAGE_WASM: Readonly<Record<LanguageId, { pkg: string; file: string }>> = {
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
  go: { pkg: 'tree-sitter-go', file: 'tree-sitter-go.wasm' },
  rust: { pkg: 'tree-sitter-rust', file: 'tree-sitter-rust.wasm' },
  php: { pkg: 'tree-sitter-php', file: 'tree-sitter-php.wasm' },
  ruby: { pkg: 'tree-sitter-ruby', file: 'tree-sitter-ruby.wasm' },
};

export const DB_FILENAME = '.mcp-codebase.db';

/** Directory names never indexed. */
export const IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
]);

/** Token-budget limits for tool outputs. */
export const LIMITS = {
  /** Default/max rows per tool result. */
  defaultLimit: 50,
  maxLimit: 200,
  maxSignatureChars: 500,
  maxDocstringChars: 1000,
  maxOutputChars: 12000,
} as const;

/** Symbol kinds. The plan names function/class/method/interface/struct; the
 *  extended set covers what polyglot grammars actually declare. */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'type'
  | 'module'
  | 'variable'
  | 'constant';

export const SYMBOL_KINDS: ReadonlySet<string> = new Set<string>([
  'function',
  'class',
  'method',
  'interface',
  'struct',
  'enum',
  'trait',
  'type',
  'module',
  'variable',
  'constant',
]);

export type RelationshipType = 'calls' | 'extends' | 'implements';

export function languageForPath(filePath: string): LanguageId | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_LANGUAGE.get(filePath.slice(dot).toLowerCase());
}

/** Resolve the indexed root: --root=… / --root … / ARGUS_ROOT / cwd. */
export function resolveRoot(argv: string[], env: NodeJS.ProcessEnv): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--root') {
      const next = argv[i + 1];
      if (next !== undefined) return next;
    } else if (arg.startsWith('--root=')) {
      return arg.slice('--root='.length);
    }
  }
  return env['ARGUS_ROOT'] ?? process.cwd();
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return LIMITS.defaultLimit;
  return Math.min(Math.max(1, Math.floor(raw)), LIMITS.maxLimit);
}

/** Collapse whitespace and cap length; keeps tool output token-light. */
export function compact(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return oneLine.slice(0, maxChars - 1).trimEnd() + '…';
}

/** Cap a whole tool response, noting the truncation. */
export function truncateOutput(text: string): string {
  if (text.length <= LIMITS.maxOutputChars) return text;
  const kept = text.slice(0, LIMITS.maxOutputChars);
  const cutAt = kept.lastIndexOf('\n');
  const head = cutAt > LIMITS.maxOutputChars - 500 ? kept.slice(0, cutAt) : kept;
  return `${head}\n…(truncated ${text.length - head.length} chars; refine the query or raise the limit)`;
}
