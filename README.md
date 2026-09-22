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

**Single project, local agent (stdio):**

```bash
node dist/src/index.js --root /path/to/project
ARGUS_ROOT=/path/to/project node dist/src/index.js
node dist/src/index.js --root /path/to/project --no-watch  # CI / restricted sandboxes
```

**Multi-project server (team / shared / admin):**

```bash
# argus.json: { "projects": [{ "name": "web", "path": "/srv/web" }] }
ARGUS_TOKEN=$(openssl rand -hex 24) node dist/src/index.js serve --config argus.json
node dist/src/index.js serve --root /path/to/project --port 3000   # solo, one project
```

Serve mode exposes, on one port:

- `/mcp` — MCP over Streamable HTTP (remote agents)
- `/` — admin web UI (observe: health, stats, search, details, blast radius)
- `/api/*` — JSON API backing the admin UI

All HTTP endpoints require `Authorization: Bearer <token>` when a token is set
(`--token` or `ARGUS_TOKEN`; never put it in the config file). Binding a
non-loopback address without a token is refused. Add `--stdio` to serve MCP over
stdio alongside HTTP.

Each project keeps its own `<root>/.mcp-codebase.db` index (plus `-wal`/`-shm`
sidecars — gitignore them). Nothing is shared between projects. Logs go to
**stderr**. On startup the server runs a hash-delta sync per project (unchanged
files are skipped), then watches for changes. Parse failures and watcher errors
are logged, never fatal: the server keeps serving what it has.

## Deployment scenarios

| Setup | How |
|---|---|
| Solo, local | `argus --root <project>` + stdio MCP entry |
| Solo, share later | `argus serve` on your machine; teammates point their agent at your host (token required), or copy the `.mcp-codebase.db` files |
| Distributed team | `argus serve --config argus.json` on a shared host with the repos checked out; every agent connects over Streamable HTTP; admin UI for visibility |

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

**Remote agents against `serve` mode** — Streamable HTTP entry (Muse
`~/.config/muse/settings.json`, or any MCP client with HTTP support):

```json
{
  "mcpServers": {
    "argus-team": {
      "type": "streamable-http",
      "url": "https://argus.internal:3000/mcp",
      "headers": { "Authorization": "Bearer <team token>" },
      "mode": "optional"
    }
  }
}
```

With several projects configured, pass `"project": "<name>"` on every tool call
(single-project servers default to it).

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
| `find_duplicates` | `limit` (optional) | Symbols sharing normalized name + signature |
| `find_dead_code` | `include_exported` (optional), `limit` (optional) | Symbols nothing calls (conservative) |

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
  index.ts    CLI entry (stdio + serve orchestration)
  cli.ts      Argument parsing (pure, tested)
  server.ts   MCP tool registration + stdio transport
  http.ts     HTTP: MCP Streamable, JSON API, admin page, token auth
  admin/      Admin web UI (single static page, observe-only)
  projects.ts Multi-project index manager (isolated DB + watcher per project)
  tools.ts    The 6 tool handlers + analysis (duplicates, dead code)
  indexer.ts  SHA-256 delta sync + chokidar watcher
  parser.ts   Tree-sitter engine: symbols, signatures, docstrings, refs
  queries.ts  S-expression query packs per language
  config.ts   Language map, ignore rules, token budgets, argus.json parsing
  db.ts       SQLite schema + parameterized data access
tests/        node:test suite (53 tests: parser fixtures, db, indexer, tools,
              projects, config, http handler + live socket, watcher)
```
