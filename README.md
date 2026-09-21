# Argus — Codebase Dictionary & Evolution MCP Server

Argus indexes the **structure** of a polyglot codebase (symbols, signatures, docstrings, call
relationships) into a local SQLite database and serves it to AI coding assistants over the
[Model Context Protocol](https://modelcontextprotocol.io). Agents query the index instead of
scanning raw files, which prevents code duplication and cuts context-token consumption.

```
[ Workspace Files ]
          │  (chokidar watcher / SHA-256 hash delta)
          ▼
[ Incremental Tree-sitter Parser ]
          │  (signatures + call graph, bodies stripped)
          ▼
[ Local SQLite Database (.mcp-codebase.db) ]
          │  (MCP stdio interface)
          ▼
[ AI Agent ]
```

## Requirements

- Node.js >= 22.12 (uses the built-in `node:sqlite`)

## Install & build

```bash
npm install
npm run build
npm test      # 35 tests + 1 live-watcher test (skips where OS watching is blocked)
```

## Run

```bash
# Index + serve the current directory
node dist/src/index.js

# Index + serve another workspace
node dist/src/index.js --root /path/to/project
ARGUS_ROOT=/path/to/project node dist/src/index.js

# One-shot sync without the live watcher (CI, restricted sandboxes)
node dist/src/index.js --root /path/to/project --no-watch
```

The index lives at `<root>/.mcp-codebase.db` (plus `-wal`/`-shm` sidecars — gitignore them).
Logs go to **stderr**; stdout carries the MCP stdio protocol. On startup the server runs a
hash-delta sync (unchanged files are skipped), then watches for changes. Parse failures and
watcher errors are logged, never fatal: the server keeps serving what it has.

## Client setup

Build once, then point your MCP client at the absolute entrypoint:

```bash
npm run build
# entrypoint: /Users/gerald/Apps/argus/dist/src/index.js
```

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/Users/gerald/Apps/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

or via CLI: `Muse mcp add argus -- node /Users/gerald/Apps/argus/dist/src/index.js --root /path/to/project`

**Cursor / Windsurf** (`.cursor/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/Users/gerald/Apps/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

## Agent rule

Add this to the indexed project's `AGENTS.md` / `.cursorrules` so agents actually use the index:

> Before generating any new function, utility, module, or class, you MUST call the
> `lookup_dictionary` MCP tool to check if equivalent or reusable code already exists in the
> project. Never scan raw project files using shell commands (cat, grep, find) unless
> explicitly requested for inline editing.

## Tools

| Tool | Parameters | Output |
|---|---|---|
| `lookup_dictionary` | `query` (string), `kind` (optional), `limit` (optional) | Matching signatures, file paths, line numbers, docstrings |
| `get_codebase_map` | `module_path` (optional prefix), `limit` (optional) | Exported symbols + signatures per file |
| `get_symbol_details` | `symbol_id` or `symbol_name` | Exact source block for one symbol |
| `check_blast_radius` | `symbol_name`, `limit` (optional) | Incoming dependents + outgoing dependencies |

Outputs are token-budgeted (50 results / ~12k chars by default, with truncation notices).

## Supported languages

| Extensions | Grammar | Symbols |
|---|---|---|
| `.ts` `.mts` `.cts` | TypeScript | functions, classes, methods, interfaces, types, enums |
| `.tsx` | TSX | same as TypeScript |
| `.js` `.jsx` `.mjs` `.cjs` | JavaScript | functions, classes, methods |
| `.py` `.pyi` | Python | functions, classes, methods (docstrings bound) |
| `.go` | Go | functions, methods (+receiver), structs, interfaces, type aliases |
| `.rs` | Rust | functions, impl methods, structs, enums, traits, modules |
| `.php` | PHP | functions, classes, methods, interfaces, traits, enums |
| `.rb` | Ruby | methods, classes, modules |

Method names are qualified (`UserService.getUser`, `Store.Save`) so cross-file lookup is
precise. `node_modules`, `.git`, `dist`, `vendor`, `target`, `__pycache__`, etc. are never indexed.

## Known limitations

- CommonJS (`module.exports`) is not treated as exported; only ESM `export` marks JS/TS
  symbols exported. (Python/Go/Rust/Ruby/PHP use per-language publicity rules instead.)
- Inner closures/nested functions are not indexed as symbols, but calls inside them still
  count toward the enclosing symbol's relationships.
- Environments without file-watching support should use `--no-watch` (index stays as of
  startup sync; restart to re-sync).

## Project layout

```
src/
  index.ts    CLI entry (--root, --no-watch, --help)
  server.ts   MCP server: tool registration + stdio transport
  tools.ts    The 4 tool handlers
  indexer.ts  SHA-256 delta sync + chokidar watcher
  parser.ts   Tree-sitter engine: symbols, signatures, docstrings, refs
  queries.ts  S-expression query packs per language
  config.ts   Language map, ignore rules, token budgets
  db.ts       SQLite schema + parameterized data access
tests/        node:test suite (parser fixtures per language, db, indexer, tools, watcher)
```
