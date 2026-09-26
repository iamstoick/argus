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

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

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

export interface ProjectSpec {
  name: string;
  path: string;
}

export interface ArgusConfig {
  projects: ProjectSpec[];
}

/** Names travel in tool params and URLs: keep them tight. */
const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && name.length <= 64;
}

/** Parse and validate an argus.json config file. Relative paths resolve from its directory. */
export function parseConfigFile(jsonText: string, configDir: string): ArgusConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error('config: invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config: top level must be an object with a "projects" array');
  }
  const projects = (parsed as Record<string, unknown>)['projects'];
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('config: "projects" must be a non-empty array');
  }
  const seen = new Set<string>();
  const out: ProjectSpec[] = [];
  for (const [i, entry] of projects.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`config: projects[${i}] must be an object with "name" and "path"`);
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec['name'] !== 'string' || !isValidProjectName(rec['name'])) {
      throw new Error(`config: projects[${i}].name must match ${PROJECT_NAME_RE.source} (<=64 chars)`);
    }
    if (typeof rec['path'] !== 'string' || rec['path'].trim() === '') {
      throw new Error(`config: projects[${i}].path must be a non-empty string`);
    }
    if (seen.has(rec['name'])) throw new Error(`config: duplicate project name '${rec['name']}'`);
    seen.add(rec['name']);
    const rawPath = rec['path'].trim();
    out.push({ name: rec['name'], path: rawPath.startsWith('/') ? rawPath : `${configDir}/${rawPath}` });
  }
  return { projects: out };
}

/** Shared bearer token for HTTP endpoints. Never read from config files. */
export interface OllamaConfig {
  url: string;
  model: string;
}

/**
 * Resolve the optional Ollama sidecar: --ollama[=url] / ARGUS_OLLAMA_URL,
 * --ollama-model[=m] / ARGUS_OLLAMA_MODEL. Auto-probed when enabled, so a
 * bare `--ollama` means "use the local default if it answers". Disabled by
 * --no-semantic or ARGUS_OLLAMA=off (exact + lexical tiers still work).
 */
export function resolveOllama(argv: string[], env: NodeJS.ProcessEnv): OllamaConfig | undefined {
  if (argv.includes('--no-semantic') || env['ARGUS_OLLAMA'] === 'off') return undefined;
  let url = env['ARGUS_OLLAMA_URL'] !== '' ? (env['ARGUS_OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL) : DEFAULT_OLLAMA_URL;
  let model =
    env['ARGUS_OLLAMA_MODEL'] !== '' ? (env['ARGUS_OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL) : DEFAULT_OLLAMA_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--ollama') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '' && !next.startsWith('--')) url = next;
    } else if (arg.startsWith('--ollama=')) {
      const value = arg.slice('--ollama='.length);
      if (value !== '') url = value;
    } else if (arg === '--ollama-model') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '' && !next.startsWith('--')) model = next;
    } else if (arg.startsWith('--ollama-model=')) {
      const value = arg.slice('--ollama-model='.length);
      if (value !== '') model = value;
    }
  }
  return { url, model };
}

export function resolveToken(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--token') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '') return next;
    } else if (arg.startsWith('--token=')) {
      const value = arg.slice('--token='.length);
      if (value !== '') return value;
    }
  }
  const fromEnv = env['ARGUS_TOKEN'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
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
