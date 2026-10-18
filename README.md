<img width="1376" height="768" alt="argus" src="https://github.com/user-attachments/assets/b453a0b5-a70c-4158-93c6-fbc8db13b79e" />


# Argus: Codebase Dictionary & Evolution MCP Server

<p align="center">
  <strong>Shared structural memory for AI coding agents.</strong><br>
  Agents query the index instead of scanning raw files — no more duplicated
  code, wasted tokens, or blind refactors.
</p>

<p align="center">
  <a href="https://buymeacoffee.com/stoickthevast"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?style=flat&logo=buy-me-a-coffee" alt="Buy Me A Coffee"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-brightgreen" alt="Node >= 22.12">
  <img src="https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-blue" alt="MCP stdio + HTTP">
</p>

Argus indexes the **structure** of a polyglot codebase (symbols, signatures, docstrings, call
relationships) into a local SQLite database and serves it to AI coding assistants over the
[Model Context Protocol](https://modelcontextprotocol.io).

## Architecture

<img width="1216" height="880" alt="image" src="https://github.com/user-attachments/assets/1b0b2579-7fd1-4847-89e2-cea19ab8d463" />

Each project keeps its own isolated `.mcp-codebase.db` index; nothing is shared
between projects. Parse failures and watcher errors are logged, never fatal.

Agents never scan your source files for discovery: every tool reads the index.
The index is written only through the sync pipeline (startup full sync, live
file watcher, background vector sync, audit worker).

## Contents

- [Requirements](#requirements)
- [Install & build](#install--build)
- [Quick start](#quick-start)
- [Project setup (`argus init`)](#project-setup-argus-init)
- [Run](#run)
- [Authentication](#authentication)
- [Deployment scenarios](#deployment-scenarios)
- [Client setup](#client-setup)
- [Agent rule](#agent-rule)
- [Tools](#tools)
- [Hybrid search & embeddings](#hybrid-search--embeddings)
- [Observe & evolve](#observe--evolve)
- [Admin UI & HTTP API](#admin-ui--http-api)
- [Configuration reference](#configuration-reference)
- [Data & storage](#data--storage)
- [Supported languages](#supported-languages)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)
- [Support](#support)

## Requirements

- **Node.js >= 22.12** (uses the built-in `node:sqlite`; check with
  `node --version`). No other runtime dependencies: tree-sitter grammars ship
  as npm packages.
- Optional, only for what you use:
  - **Ollama** (or any OpenAI-compatible embeddings server) for semantic search.
  - **Python 3** for the Claude Code index-first hook.
  - **`sqlite3` CLI** for inspecting the index directly.

## Install & build

```bash
npm install
npm run build   # tsc -> dist/, plus the admin page and hook template
npm test        # 135 tests (live-socket/watcher tests skip where the sandbox blocks them)
```

`npm run build` compiles `src/` and `tests/` to `dist/`, copies the admin page
to `dist/src/admin/`, and stages the hook template and settings snippet in
`dist/examples/` (so `argus init` works from the build alone). Throughout this
guide, `argus …` is shorthand for `node dist/src/index.js …` (run `npm link`
inside this repo if you want a real `argus` command).

## Quick start

```bash
npm install && npm run build
node dist/src/index.js init --root /path/to/project
# restart your agent/IDE so it picks up the new .mcp.json, then ask it
# to "look up <something> with lookup_dictionary"
```

That is the whole happy path for solo local use. Read on for teams
(`serve` mode), semantic search, and the admin UI.

## Project setup (`argus init`)

`argus init --root <path>` (defaults to the current directory) wires the
project for one or more AI clients. It never touches your source files:

| File | What it does |
|---|---|
| MCP config (per `--client`, see below) | Client entry: runs `node <argus>/dist/src/index.js --root <project>` over stdio. Merged: other servers in an existing file are preserved. |
| `AGENTS.md` | Appends the index-first rule (created if missing, never duplicated). Read by virtually every coding agent — this part is client-agnostic. |
| `.claude/hooks/check-index-first.py` | Claude Code hook: reminds the agent to query the index when creating new code files. Installed executable. |
| `.claude/settings.json` | Wires the hook as a `PreToolUse` matcher on `Write`. Merged: unrelated hooks are preserved; stale argus entries are refreshed. |

`--client <name>` selects the MCP config files to write (repeatable or
comma-separated; default `claude`):

| `--client` | File written | Format |
|---|---|---|
| `claude` | `.mcp.json` | `{ "mcpServers": { "argus": { "command", "args" } } }` |
| `cursor` | `.cursor/mcp.json` | Same `mcpServers` shape as Claude |
| `vscode` | `.vscode/mcp.json` | `{ "servers": { "argus": { "type": "stdio", "command", "args" } } }` (VS Code uses `servers`, not `mcpServers`) |
| `all` | all three | — |

```bash
argus init --root /path/to/project --client all
argus init --root /path/to/project --client cursor,vscode
```

The hook is Claude Code-specific, so it installs only when `claude` is among
the selected clients (otherwise that step reports `skipped`). Other flags:

| Flag | Effect |
|---|---|
| `--root <path>` | Project to set up (must exist; default: cwd, or `ARGUS_ROOT`). |
| `--force` | Overwrite the managed `argus` entry, refresh the hook, and replace invalid JSON instead of aborting. Without it, existing managed entries are left alone (`unchanged`). |
| `--no-agents-md` | Skip `AGENTS.md`. |
| `--no-hooks` | Skip the hook + settings wiring. |

`init` is idempotent: run it again any time; second runs report `unchanged`
everywhere. It prints one `created/updated/unchanged/skipped: <file> — <detail>`
line per file, and fails loudly (missing root, unknown `--client`, invalid
JSON without `--force`, missing hook template) instead of half-writing. It
needs no engine or index: it works before the first sync. Two merge notes:
existing files may contain `//` or `/* */` comments (VS Code ships them) —
those parse fine, but the merged file is rewritten as plain JSON, so comments
are lost on the first merge; servers never are.

Clients with **global-only** configs (Muse, Windsurf, Codex) can't be
project-wired by `init` — see [Client setup](#client-setup) for manual
snippets.

## Run

### Single project, local agent (stdio)

```bash
argus --root /path/to/project
ARGUS_ROOT=/path/to/project argus
argus --root /path/to/project --no-watch  # CI / restricted sandboxes
```

The process lives as long as the agent session: it syncs once, watches for
changes, and serves MCP over stdin/stdout. All logs go to **stderr** (stdout
is the MCP protocol — nothing else may write there). `--root` falls back to
`ARGUS_ROOT`, then to the current directory; the project name is derived from
the directory name. This mode needs no token and opens no ports.

### Multi-project server (team / shared / admin)

```bash
# argus.json: { "projects": [{ "name": "web", "path": "/srv/web" }] }
ARGUS_TOKEN=$(openssl rand -hex 24) argus serve --config argus.json
argus serve --root /path/to/project --port 3000   # solo, one project
```

Serve mode exposes three things on one port (`--host`, default `127.0.0.1`;
`--port`, default `3000`):

- `/mcp` — MCP over Streamable HTTP (remote agents)
- `/` — admin web UI (observe: health, stats, search, details, blast radius,
  query telemetry, snapshots, background audits)
- `/api/*` — JSON API backing the admin UI (see
  [Admin UI & HTTP API](#admin-ui--http-api))

Useful serve flags: `--stdio` serves MCP over stdio *alongside* HTTP (local
agent + team sharing from one process); `--no-watch` syncs once and never
watches; `--audit-interval <secs>` tunes the background audits (default 300,
`0` disables).

The config file holds **only** `projects` (never secrets):

```json
{
  "projects": [
    { "name": "web", "path": "/srv/web" },
    { "name": "api", "path": "../api" }
  ]
}
```

Relative paths resolve from the config file's directory. Names must match
`^[A-Za-z0-9][A-Za-z0-9_-]*$` (≤ 64 chars) and be unique, as must paths.

### What happens at startup

1. Arguments are validated (`--port`, `--audit-interval`, provider names —
   typos fail fast here).
2. The embeddings sidecar is probed (see
   [Hybrid search](#hybrid-search--embeddings)); absence only disables the
   semantic tier.
3. Each project is hash-delta synced, with one line per project:
   `[argus] [web] /srv/web: 812 files, 3 updated, 0 removed, 809 unchanged, 0 failed`.
   A baseline structural snapshot is captured when the sync changed anything
   (or when none exists yet).
4. The file watcher starts (unless `--no-watch`), vector catch-up runs in the
   background, and the audit worker takes its first reports.
5. `serve` prints `[argus] http ready on http://<host>:<port> (mcp + admin)`;
   stdio prints `[argus] MCP server ready on stdio`.

### Sync & watcher behavior

- **Hash-delta sync:** only files whose SHA-256 changed are re-parsed;
  unchanged files are skipped, deleted files are purged (symbols, vectors,
  and relationships cascade).
- **Parse failures** still record the file's hash (with symbols cleared) so
  one bad file doesn't retry forever; the file is re-parsed on its next
  change. Failures are listed in the sync line and logged, never fatal.
- **Watcher:** re-indexes on add/change (with write-settling, so saves
  mid-write don't index half a file), cascade-deletes on unlink. Watcher
  errors are logged and skipped. Where the OS forbids watching, use
  `--no-watch` and restart to re-sync.
- Run **one server per project set**: two processes syncing the same roots
  will trip over each other in SQLite (a busy index can fail a sync).

## Authentication

HTTP (`serve` mode) uses one shared bearer token. MCP-over-stdio has no auth
(it is a local child process).

**Setting the token.** `--token <secret>` wins, else `ARGUS_TOKEN` from the
environment. Generate one with `openssl rand -hex 24`. The token is **never**
read from `argus.json`. It must be **exported** to reach the server:

```bash
export ARGUS_TOKEN=...   # in ~/.zshrc / ~/.bashrc, then reload the shell
env | grep -c ARGUS_TOKEN  # must print 1 (visible to child processes)
```

A bare `ARGUS_TOKEN=...` without `export` sets a shell-only variable the
server never sees — the classic cause of "it worked in one terminal".

**When it is required.** Binding a non-loopback `--host` (e.g. `0.0.0.0`)
without a token is refused at startup:
`refusing to bind 0.0.0.0 without a token (pass --token or set ARGUS_TOKEN)`.
On loopback the token is optional: no token means all requests are allowed
(handy for solo local use, wrong for anything shared).

**Scope.** When a token is set, *every* HTTP endpoint requires
`Authorization: Bearer <token>` — `/mcp`, `/api/*`, and the `/` admin page
itself. Anything else gets:

```json
{ "error": "missing or invalid bearer token" }
```

Read that error carefully: it means the **request** lacked (or had the wrong)
token. If the *server* had no token, it would either have refused to bind
off-loopback, or let everything through.

**Browser catch-22.** Because `/` itself is gated, a plain browser visit
always 401s when a token is set — you can't load the page to reach the token
field. Pick one:

- `curl -H "Authorization: Bearer $ARGUS_TOKEN" http://127.0.0.1:3000/api/health`
  for API use;
- a header-injecting browser extension for the UI; or
- run tokenless on loopback for strictly local use.

Once the admin page loads, its token field persists per browser tab
(`sessionStorage`) and auto-connects on revisit.

**Rotation.** Set the new token and restart the server; every client entry
holding the old `Authorization` header must be updated to match.

## Deployment scenarios

| Setup | How |
|---|---|
| Solo, local | `argus init` in the project + restart the agent (stdio entry) |
| Solo, share later | `argus serve` on your machine; teammates point their agent at your host (token required), or copy the `.mcp-codebase.db*` files with the server stopped |
| Distributed team | `argus serve --config argus.json` on a shared host with the repos checked out; every agent connects over Streamable HTTP; admin UI for visibility |

## Client setup

`argus init --client all` writes the project-local entries for you; this
section is the manual equivalent, plus remote-client and global-config
clients. Always use **absolute paths**. After changing entries, restart the
client (or reload its MCP config) and confirm the `argus` tools are listed.

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/path/to/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

or via CLI: `claude mcp add argus -- node /path/to/argus/dist/src/index.js --root /path/to/project`

**Cursor** (project `.cursor/mcp.json`, or global `~/.cursor/mcp.json`):
same `mcpServers` shape as Claude Code above.

**VS Code** (workspace `.vscode/mcp.json`): note the `servers` key (not
`mcpServers`) and the required `"type": "stdio"`:

```json
{
  "servers": {
    "argus": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

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

Paste the **literal** token into `headers`. Most clients do *not* expand
`$VARS` there — a literal `$ARGUS_TOKEN` string is sent as-is, the server
401s, and some clients misreport that as "requires OAuth sign-in"
(`mcp login` cannot fix a static-token server; fix the token/URL instead).

**Windsurf** (global `~/.codeium/windsurf/mcp_config.json` — Windsurf has no
project-level MCP config, so `init` doesn't write it; merge this by hand):

```json
{
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/path/to/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

**Codex** (user-level `~/.codex/config.toml` TOML — likewise global, so not
`init`-managed; `codex mcp add` also works):

```toml
[mcp_servers.argus]
command = "node"
args = ["/path/to/argus/dist/src/index.js", "--root", "/path/to/project"]
```

**Muse** (user-global `~/.config/muse/settings.json`, `$XDG_CONFIG_HOME`
honored — Muse reads MCP servers only from this one file, so merge by hand
rather than via `init`):

```json
{
  "schema_version": 1,
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/path/to/argus/dist/src/index.js", "--root", "/path/to/project"]
    }
  }
}
```

Keep `"schema_version": 1` (a settings file without it fails every command).
For `serve` mode instead of stdio, use a `streamable-http` entry with the
`/mcp` URL and bearer header, as in the remote-agents example above.

**The `project` parameter.** Every tool accepts an optional `project` name.
Single-project servers default to their only project; multi-project servers
require it on every call (`Pass "project" (one of: web, api).`) and reject
unknown names (`Unknown project 'x' (one of: …).`) — there are no silent
cross-project reads.

## Agent rule

Add this to the indexed project's `AGENTS.md` / `.cursorrules` so agents actually use the index
(`argus init` does it for `AGENTS.md`):

> Before generating any new function, utility, module, or class, you MUST call the
> `lookup_dictionary` MCP tool to check if equivalent or reusable code already exists in the
> project. Use `mode: "hybrid"` when exploring (typo-tolerant + semantic matches);
> default `exact` mode is enough when you know the name. Never scan raw project files
> using shell commands (cat, grep, find) unless explicitly requested for inline editing.

**Enforcement.** The rule above is advisory; `argus init` also installs a
Claude Code `PreToolUse` hook (`.claude/hooks/check-index-first.py`, wired in
`.claude/settings.json`) that injects this reminder whenever an agent creates
a **new** code file. Mechanics, so there are no surprises:

- Fires only on `Write` (not `Edit`), only when the target doesn't exist yet,
  and only for indexed source extensions (`.ts/.tsx/.js/.py/.go/.rs/.php/.rb`
  families) — docs and overwrites stay silent.
- Needs `python3` on `PATH`; any failure (missing interpreter, bad input)
  exits 0 silently — the hook can never block an agent.
- Manual install: copy `examples/check-index-first.py` to
  `<project>/.claude/hooks/` (`chmod +x`), then merge
  `examples/claude-hooks.json` into `<project>/.claude/settings.json`,
  replacing the command path with your absolute destination path.
- Test it: `echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/new-x.py"}}' |
  python3 .claude/hooks/check-index-first.py` should print JSON containing
  `additionalContext`.

## Tools

Eight tools, all read-only against your source tree. Every tool also accepts
the optional `project` selector on multi-project servers (see
[Client setup](#client-setup)).

| Tool | Parameters | Output |
|---|---|---|
| `lookup_dictionary` | `query` (string), `kind` (optional), `limit` (optional), `mode` (`exact`/`hybrid`, optional) | Matching signatures, file paths, line numbers, docstrings |
| `get_codebase_map` | `module_path` (optional prefix), `limit` (optional) | Exported symbols + signatures per file |
| `get_project_brief` | `limit` (optional) | Orientation digest: size, languages, hubs, drift, audits, activity |
| `get_symbol_details` | `symbol_id` or `symbol_name` | Exact source block for one symbol |
| `check_blast_radius` | `symbol_name`, `limit` (optional) | Incoming dependents + outgoing dependencies |
| `find_duplicates` | `limit` (optional) | Symbols sharing normalized name + signature |
| `find_dead_code` | `include_exported` (optional), `limit` (optional) | Symbols nothing calls (conservative) |
| `diff_snapshots` | `from`/`to` (optional), `take` (optional), `limit` (optional) | Symbols added, removed, or signature-changed between snapshots |

**Budgets (all tools).** `limit` defaults to 50 and clamps to 1–200; whole
outputs cap at ~12,000 chars with a `…(truncated N chars; refine the query or
raise the limit)` notice. Signatures are stored truncated to 500 chars and
docstrings to 1000 chars at index time. Exception: `get_project_brief`'s
`limit` is entries *per section* (default 8, max 10), since a digest with 50
rows per section would defeat its purpose.

### `lookup_dictionary`

The tool the agent rule is about. `query` matches against names and
signatures. `kind` filters to one of `function, class, method, interface,
struct, enum, trait, type, module, variable, constant` (anything else is
rejected with the valid list). `mode: "exact"` (default) is deterministic
substring matching, exported symbols first; `mode: "hybrid"` adds
typo-tolerant and semantic matches (see
[Hybrid search](#hybrid-search--embeddings)). Empty result? The tool says
`No symbols matching '…'` and — the point of the whole workflow —
`Safe to create.`

### `get_codebase_map`

Architecture overview: **exported** symbols only, grouped by file, ordered by
path and line. `module_path` restricts to a path prefix (`src/auth`). Empty
index? `Index is empty: no exported symbols found. The workspace may still be
syncing.`

### `get_project_brief`

Orientation digest for an unfamiliar project — call it first in a new repo.
Assembled live from the index (never stale, no storage, no LLM credentials
needed since the calling agent does the narrating): file/symbol/call counts,
languages, symbols by kind, largest files, most-referenced symbols (with
declaration sites), latest snapshot drift, audit posture per kind, and what
agents recently asked about. `limit` sets entries per section (default 8,
max 10); the whole brief stays a few thousand chars.

### `get_symbol_details`

Full source block for one symbol. Prefer `symbol_id` (stable within an
unchanged file; ids churn when a file is re-parsed). `symbol_name` accepts an
exact name, disambiguates multiples by listing `#id` candidates, and falls
back to closest matches when nothing is exact. If the file changed under the
index, it says so instead of showing stale code.

### `check_blast_radius`

`symbol_name` first tries an exact match, then a `LIKE` fallback (up to 5
candidates). Output has two halves: **outgoing** (everything the matched
symbols call) and **incoming** (everything calling the matched simple names,
deduped, with a `+` marker when the limit cut the list). Always call this
before renaming or re-signaturing.

### `find_duplicates`

Groups of 2+ declarations sharing a **normalized** name *and* signature
(lowercased, punctuation stripped). Eligible kinds: function, class,
interface, struct, enum, trait, type, module — `method` is deliberately
excluded (same method name across classes is polymorphism, not copy-paste),
as are variables/constants. Sorted largest group first.

### `find_dead_code`

Symbols nothing calls. Conservative by construction: callee matching uses
simple names, so *any* same-named call keeps a symbol alive; `main`,
constructors (`constructor`, `__construct`, `__init__`, `initialize`) and
dunder methods (`__len__`, …) are never reported. Exported symbols are
skipped unless `include_exported: true`. Caveat: framework entry points wired
by decorator/string (route handlers, callbacks) can still look dead — review
before deleting.

### `diff_snapshots`

Structural drift between two snapshots (see [Observe & evolve](#observe--evolve)):
added, removed, and signature-changed symbols, each capped by `limit`.
Defaults diff previous → latest; `from`/`to` pin ids (validated: unknown ids
and `0` are reported, not silently clamped). `take: true` captures a fresh
snapshot first, then diffs previous → new (handy right after a refactor).
With one or zero snapshots it tells you to capture more instead of failing.

## Hybrid search & embeddings

`lookup_dictionary` has two modes. `exact` (default) is substring matching —
deterministic, zero dependencies. `hybrid` adds two recall tiers after the
exact hits; each tier only adds ids the earlier tiers missed:

1. **Lexical** (always on, zero dependencies): token/prefix search over
   names, signatures, and docstrings via SQLite FTS5, plus edit-distance typo
   tolerance — short tokens allow 1 edit, longer ones 2 (`noramlize` finds
   `normalize`). On SQLite builds without FTS5 it degrades to edit distance
   alone rather than failing.
2. **Semantic** (optional, local sidecar): embedding similarity over
   `name + kind + signature + docstring` for conceptual queries ("retry with
   backoff" finds `withRetry` even when no word overlaps). Only
   positive-similarity matches are returned; a provider failure degrades with
   a `(semantic tier unavailable: …)` notice instead of failing the query.

### Embedding providers

Two backends, selected by `--embeddings-provider ollama|openai`
(`ARGUS_EMBEDDINGS_PROVIDER`, default `ollama`). An unknown name fails fast
at startup.

| | `ollama` (default) | `openai` |
|---|---|---|
| Speaks to | Ollama `/api/embed` | Any OpenAI-compatible `/v1`: OpenAI, vLLM, LM Studio, llama.cpp, Ollama's own `/v1` |
| URL | `--ollama[=url]` / `ARGUS_OLLAMA_URL` (default `http://127.0.0.1:11434`) | `--embeddings-url` / `ARGUS_EMBEDDINGS_URL` (default `http://127.0.0.1:11434/v1`) |
| Model | `--ollama-model` / `ARGUS_OLLAMA_MODEL` (default `nomic-embed-text`) | `--embeddings-model` / `ARGUS_EMBEDDINGS_MODEL` (default `nomic-embed-text`) |
| Key | — (not needed) | `--embeddings-key` / `ARGUS_EMBEDDINGS_KEY` (omit for local servers) |

The generic `--embeddings-url`/`--embeddings-model` also work as fallbacks
under `provider=ollama` (explicit `--ollama*` flags win).

```bash
argus --root /path/to/project --ollama                     # default local URL
argus serve --root /path/to/project --ollama-model my-embed # custom model
ARGUS_OLLAMA=off argus --root /path/to/project              # force exact+lexical

argus --root /path/to/project --embeddings-provider openai \
  --embeddings-url https://api.openai.com/v1 \
  --embeddings-model text-embedding-3-small --embeddings-key "$OPENAI_API_KEY"
```

Ollama setup: `ollama pull nomic-embed-text`, then make sure Ollama is
serving. Argus auto-probes the sidecar at startup (2s timeout) and prints
either `[argus] semantic search: ollama nomic-embed-text at
http://127.0.0.1:11434` or `[argus] semantic search off (no ollama at …;
exact + lexical only)`. Disable explicitly with `--no-semantic` (or
`ARGUS_OLLAMA=off`) regardless of provider. In `serve` mode the server does
all embedding work — agents just send query text, so one sidecar covers the
whole team.

### How vectors are stored & served

- Vectors live in each project's own `.mcp-codebase.db`, synced in the
  background (batched, resumable: a run only embeds symbols still missing
  vectors, so idle runs cost zero provider calls).
- **Model changes are self-healing:** stored vectors whose dimension differs
  from freshly embedded ones are cleared and resynced automatically (watch
  for the `cleared` count in the `semantic index ready (…)` line).
- Queries run against a **persisted HNSW index** (approximate nearest
  neighbors, pure TypeScript, no native dependencies): incremental on new
  vectors, tombstones on deleted symbols, automatic rebuild past 25%
  tombstones or on dimension change, graph persisted in SQLite so restarts
  reattach instead of rebuilding. Until the index is ready (or on any
  mismatch), queries transparently fall back to brute-force cosine — recall
  first, speed second.
- Ranking quality is guarded two ways: a fast recall gate inside `npm test`
  (`tests/hnsw.test.ts`) plus a deeper benchmark — `npm run benchmark`
  builds, then measures HNSW-vs-brute-force recall@10, latency percentiles,
  and speedup on 4000 synthetic points (deterministic seed, ~10s). It exits
  nonzero when mean recall drops below 0.9, so it fits in CI as a perf gate.

## Observe & evolve

Three always-on histories live in each project's `.mcp-codebase.db`. All
three show up in the admin UI, all three have JSON endpoints, and all three
are best-effort observability: they never break indexing or tool calls.

### Query telemetry

Every **MCP tool call** is logged with tool name, mode (`exact`/`hybrid` for
lookups), result count, per-tier counts (`{exact, lexical, semantic}` for
hybrid), output chars, latency in ms, and degraded/error flags. Only the
newest 1000 rows per project are kept (oldest pruned on insert). Deliberately
*not* logged: admin-UI/API reads (they'd recurse) and unresolved project
selectors.

```bash
curl -H "Authorization: Bearer $ARGUS_TOKEN" \
  "http://127.0.0.1:3000/api/projects/web/queries?limit=20"
# { "stats": { "total", "byTool", "avgLatencyMs", "totalChars", "estTokens", "degraded", "errors" },
#   "queries": [{ "id", "ts", "tool", "mode", "results", "chars", "tiers", "latencyMs", ... }],
#   "embeddingUsage": [{ "operation", "provider", "model", "calls", "texts", "chars",
#                        "promptTokens", "reportedCalls", "estTokens" }] }

sqlite3 /srv/web/.mcp-codebase.db \
  "SELECT ts, tool, mode, results, chars, latency_ms FROM query_log ORDER BY id DESC LIMIT 20;"
```

Empty? Agents haven't called any tools yet — telemetry reflects MCP usage,
not UI browsing.

### Token consumption

Two different numbers, both available:

- **Tokens served to agents (estimated).** `stats.estTokens` is `totalChars /
  4` — the standard heuristic. It estimates what the agent's model must read,
  not a meter reading: Argus makes zero LLM calls and never sees the agent's
  real token counts. Shown in the admin panel as `~N tokens (est.)`.
- **Embedding spend (measured where possible).** Every embed call accumulates
  into per-operation (`sync` vs `query`) / provider / model counters: calls,
  texts, chars, plus `promptTokens` summed from server-reported counts
  (OpenAI's `usage`, Ollama's `prompt_eval_count`). `reportedCalls` tells you
  how many calls actually reported a count; `estTokens` (chars/4) covers the
  rest. Cumulative (never pruned — one small row per combination):

```bash
sqlite3 /srv/web/.mcp-codebase.db \
  "SELECT operation, provider, model, calls, texts, prompt_tokens, reported_calls FROM embedding_usage;"
```

### Structural snapshots

A snapshot fingerprints every symbol (`path + kind + name` → signature hash;
row ids churn on re-parse, so drift keys on content, not ids). Captured
automatically: on first open (baseline), after every sync that changed the
index, and on watcher add/change/unlink throttled to one per minute. The last
20 are kept. Semantics to know:

- **Rename/move** of a symbol or file shows as an add + a remove (same key,
  different path/name) — there is no rename detection.
- **Signature change** (same path/kind/name, different hash) shows under
  `changed`. Whitespace-only edits that don't alter the recorded signature
  don't appear at all.
- Pruned snapshots are gone: diffs against them report unknown ids.

```bash
curl -H "Authorization: Bearer $ARGUS_TOKEN" \
  "http://127.0.0.1:3000/api/projects/web/snapshots"              # list, newest first
curl -H "Authorization: Bearer $ARGUS_TOKEN" \
  "http://127.0.0.1:3000/api/projects/web/snapshots?from=1&to=2"  # diff
curl -H "Authorization: Bearer $ARGUS_TOKEN" \
  "http://127.0.0.1:3000/api/projects/web/snapshots?take=1"       # capture now (+ diff vs previous)
```

The `diff_snapshots` MCP tool wraps the same data (defaults: previous →
latest; `take: true` captures first). The admin panel lists snapshots and
diffs any two.

### Background audits

In `serve` mode a worker precomputes dead-code (unexported), duplicate, and
suspected-secret reports on startup and every `--audit-interval` seconds
(default 300; `ARGUS_AUDIT_INTERVAL`; `0` disables; off by default in stdio
mode — look for `[argus] audit worker every 300s …`). Each kind keeps its 10
newest reports; each report holds the top 50 findings. Failures are logged
and skipped, per kind.

The `secrets` scan is flag-only: it never edits or redacts your code, and
stored findings carry a `[REDACTED]` preview — the raw secret never lands in
the database. It matches fixed-format provider tokens (AWS, GitHub, Slack,
Stripe, OpenAI, JWTs, private-key headers) plus `api_key`/`secret`/`token` /
`password` assignments, with placeholder filtering (`changeme`, `xxx`,
`${VAR}`, …) and code-shape guards so `password: string` annotations and
`apiKey = getDefaultKey()` stay quiet. Scanning is incremental: only files
whose content hash changed are re-read (state in `secret_scan_state`), files
over 256 KB and binaries are skipped, and findings for unchanged files carry
forward from the previous report.

```bash
curl -H "Authorization: Bearer $ARGUS_TOKEN" \
  "http://127.0.0.1:3000/api/projects/web/audit"
# { "reports": [{ "kind": "dead-code"|"duplicates"|"secrets", "takenAt",
#                 "payload": { "symbols"|"groups"|"findings", "truncated", ... } }] }
```

## Admin UI & HTTP API

**Admin UI.** Open `http://<host>:<port>/` (with the token caveat in
[Authentication](#authentication)). Enter the bearer token once per tab,
press Connect, pick a project. Panels: index stats, symbol search (+
click-through details and blast radius), query telemetry, structural
snapshots (capture + diff any two), background audits. The UI is strictly
observe-only except snapshot capture — it never edits your code.

**HTTP API.** All `GET`, all JSON, all token-gated when a token is set
([Authentication](#authentication)). `limit` params behave like tool limits
(default 50, clamp 1–200).

| Method & path | Params | Response |
|---|---|---|
| `GET /api/health` | — | `{ version, startedAt, projects, grammars: { loaded, unavailable } }` |
| `GET /api/projects` | — | `{ projects: [{ name, root, files, symbols, relationships, watching, lastSync, lastSyncAt, byExtension, byKind }] }` |
| `GET /api/projects/<n>/search` | `q` (required), `kind`, `limit` | `{ symbols: […] }` (exact matching, like `mode: "exact"`) |
| `GET /api/projects/<n>/symbols/<id>` | — | `{ symbol, code }` (`code` is null when the file is unreadable) |
| `GET /api/projects/<n>/blast` | `name` (required), `limit` | `{ matched, outgoing, incoming, incomingTruncated }` |
| `GET /api/projects/<n>/brief` | `limit` (entries per section, default 8, max 10) | Project-brief JSON (`project`, `languages`, `topFiles`, `mostReferenced`, `drift`, `audits`, `queries`) |
| `GET /api/projects/<n>/duplicates` | `limit` | `{ groups, truncated }` |
| `GET /api/projects/<n>/dead-code` | `limit`, `include_exported=true` | `{ symbols, truncated }` |
| `GET /api/projects/<n>/queries` | `limit` | `{ stats, queries, embeddingUsage }` (see [Observe & evolve](#observe--evolve)) |
| `GET /api/projects/<n>/snapshots` | `limit` | `{ snapshots: […] }`, newest first |
| `GET /api/projects/<n>/snapshots` | `from`, `to`, `limit` | diff object (`added`/`removed`/`changed`, counts, `truncated`) |
| `GET /api/projects/<n>/snapshots` | `take=1` | `{ snapshot, previousId, diff }` (`diff` null when it's the first) |
| `GET /api/projects/<n>/audit` | — | `{ reports: […] }`, latest per kind |

**Errors** are JSON with HTTP status: `401 { error: "missing or invalid
bearer token" }`, `400` for bad input (`missing q`, `invalid symbol id`,
`invalid snapshot id`, `unknown kind '…'`), `404` for misses (`unknown
project`, `no such symbol`, unknown snapshot ids, unknown paths).
`POST /mcp` additionally rejects bodies over 1 MB and malformed JSON with
`400`. CORS is permissive (`*`, `OPTIONS` preflights answered) so browser
dashboards can call the API directly.

## Configuration reference

Every knob in one place. CLI flags beat env vars; an explicit value beats a
default. Startup validates `--port`, `--audit-interval`, and the provider
name — typos exit loudly instead of silently misconfiguring.

| Flag | Env | Default | Used by | Meaning |
|---|---|---|---|---|
| `--config <file>` | — | — | serve | `argus.json` project list (exclusive with `--root`) |
| `--root <path>` | `ARGUS_ROOT` (stdio/init) | cwd (stdio/init) | all | Project root (serve: single-project mode) |
| `--host <addr>` | — | `127.0.0.1` | serve | Bind address |
| `--port <n>` | — | `3000` | serve | HTTP port (1–65535) |
| `--token <secret>` | `ARGUS_TOKEN` | none (open) | serve | Shared HTTP bearer token (required off-loopback) |
| `--no-watch` | — | watching | all | Sync once; disable the live watcher |
| `--stdio` | — | off | serve | Also serve MCP over stdio |
| `--ollama[=url]` | `ARGUS_OLLAMA_URL` | `http://127.0.0.1:11434` | all | Ollama server URL |
| `--ollama-model <m>` | `ARGUS_OLLAMA_MODEL` | `nomic-embed-text` | all | Ollama embedding model |
| `--embeddings-provider <p>` | `ARGUS_EMBEDDINGS_PROVIDER` | `ollama` | all | `ollama` or `openai` |
| `--embeddings-url <url>` | `ARGUS_EMBEDDINGS_URL` | `…/11434/v1` (openai) / fallback (ollama) | all | OpenAI-compatible base URL |
| `--embeddings-model <m>` | `ARGUS_EMBEDDINGS_MODEL` | `nomic-embed-text` | all | Embedding model (openai; fallback for ollama) |
| `--embeddings-key <secret>` | `ARGUS_EMBEDDINGS_KEY` | none | all | API key (openai only; omit locally) |
| `--no-semantic` | `ARGUS_OLLAMA=off` | on (probed) | all | Disable the semantic tier entirely |
| `--audit-interval <secs>` | `ARGUS_AUDIT_INTERVAL` | 300 (serve), 0 (stdio) | all | Background audit cadence; `0` disables |
| `--client <name>` | — | `claude` | init | `claude`, `cursor`, `vscode`, or `all` (repeatable/comma-separated) |
| `--force` | — | off | init | Overwrite managed entries / invalid JSON |
| `--no-agents-md` | — | off | init | Skip `AGENTS.md` |
| `--no-hooks` | — | off | init | Skip the hook install |

## Data & storage

Each project root holds its index next to the code:

```
<project>/.mcp-codebase.db        # the index (SQLite, WAL mode)
<project>/.mcp-codebase.db-wal    # write-ahead log sidecar
<project>/.mcp-codebase.db-shm    # shared-memory sidecar
```

Gitignore all three:

```gitignore
.mcp-codebase.db*
```

**Tables** (all queries parameterized; open with any SQLite client):
`files` (path → content hash), `symbols` + `symbols_fts` (lexical index),
`symbol_relationships`, `symbol_vectors` + `vector_index` (semantic tier +
persisted HNSW graph), `query_log` (telemetry, 1000 rows), `embedding_usage`
(cumulative embedding counters), `snapshots` (drift history, 20 kept),
`audit_reports` (10 per kind), `secret_scan_state` (per-file scan watermarks).
Vectors dominate size (`dim × 8 bytes` per symbol plus the HNSW graph).

**Sharing / backup:** stop the server, copy all three sidecars together (a
live `-wal` copied alone is inconsistent), drop them at the recipient's
project root. The next startup hash-syncs and picks up any source drift.
Nothing is ever shared *between* projects: each DB is a sealed per-project
world.

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

## Troubleshooting

**`{"error":"missing or invalid bearer token"}`.** The request lacked (or had
the wrong) `Authorization: Bearer <token>` header — see
[Authentication](#authentication). Fixes: send the header (curl), run
tokenless on loopback for local-only use, or use a header extension for the
browser UI. Do *not* "fix" it by embedding the token in `argus.json` (never
read) — it must come from `--token` / `ARGUS_TOKEN`.

**MCP client says the server "requires OAuth sign-in".** Some clients (e.g.
Muse) read any HTTP 401 as an OAuth prompt. Argus has no OAuth: this always
means wrong/missing token or wrong URL. Check the entry's `url` (server
listening there?) and paste the literal token into `headers` (no `$VAR`
expansion). `mcp login` cannot help.

**`refusing to bind 0.0.0.0 without a token`.** Either export a token
(`export ARGUS_TOKEN=…`, verify with `env | grep -c ARGUS_TOKEN` → `1`) or
bind loopback. Note a running server's environment is frozen at startup:
changing the shell afterwards requires a restart.

**`env | grep -c ARGUS_TOKEN` prints `0`.** The variable isn't exported
(missing `export` in your dotfiles) or the shell wasn't reloaded. Child
processes — including the server — can't see it.

**Index is empty / missing symbols.** Check the startup sync line: `failed`
lists unparseable files (logged, with reasons). Otherwise: is the extension
in [Supported languages](#supported-languages)? Is the file under an ignored
dir (`node_modules`, `dist`, `target`, …)? Running `--no-watch` with a stale
index? Restart to re-sync.

**Changes aren't picked up.** The watcher logs errors instead of dying —
read stderr. Sandboxes/containers often forbid watching (`EMFILE`, `EPERM`):
use `--no-watch` and restart. Note saves settle briefly before indexing, so
allow a beat before querying.

**`semantic search off (…)`.** The sidecar didn't answer within 2s at
startup. Is Ollama serving (`ollama list`)? Is the model pulled? Is the URL
right (`--ollama`, `ARGUS_OLLAMA_URL`, or the openai equivalents)? This is
never fatal: exact + lexical keep working.

**`invalid --port` / `invalid --audit-interval` / `invalid embeddings
provider`.** Argument validation failed at startup; fix the value and
restart. `audit-interval` wants seconds ≥ 0 (`0` disables).

**Port already in use.** `listen EADDRINUSE` names the clash — pick another
`--port` or stop the holder. (Any `EPERM` on bind instead means the sandbox,
not a conflict.)

**Hook doesn't fire.** Check: `python3` on `PATH`? `.claude/settings.json`
`PreToolUse` command uses the *absolute* hook path? Fires only on `Write` of
*new* code files — edits, overwrites, and docs are silent by design. Test
manually per [Agent rule](#agent-rule); exit code must be `0` with JSON on
stdout for a new `.py` path.

**Admin UI "Connection failed".** Token field empty or wrong (it's per-tab);
server unreachable at that host/port; or a non-JSON error page from something
else on that port. Check `/api/health` with curl first.

**Diff shows add+remove instead of a rename.** Expected: drift keys on
`path + kind + name` with no rename detection (see
[Observe & evolve](#observe--evolve)).

## Known limitations

- CommonJS (`module.exports`) is not treated as exported; only ESM `export` marks JS/TS
  symbols exported. (Python/Go/Rust/Ruby/PHP use per-language publicity rules instead.)
- Inner closures/nested functions are not indexed as symbols, but calls inside them still
  count toward the enclosing symbol's relationships.
- Environments without file-watching support should use `--no-watch` (index stays as of
  startup sync; restart to re-sync).
- Snapshot diffs have no rename/move detection: a rename is an add plus a remove.
- Semantic top-k is approximate (HNSW); exact brute force is only the pre-ready fallback.
- Histories are capped: 1000 telemetry rows, 20 snapshots, 10 audit reports per kind.
- `/mcp` request bodies cap at 1 MB.
- The index-first hook targets Claude Code (`PreToolUse` + `python3`); other clients
  get the advisory `AGENTS.md` rule only.
- One server per project set: concurrent writers to the same `.mcp-codebase.db`
  can fail syncs with `SQLITE_BUSY`.

## Project layout

```
src/
  index.ts    CLI entry (stdio + serve orchestration)
  cli.ts      Argument parsing (pure, tested)
  init.ts     `argus init`: .mcp.json, AGENTS.md rule, hook install
  server.ts   MCP tool registration + stdio transport
  http.ts     HTTP: MCP Streamable, JSON API, admin page, token auth
  admin/      Admin web UI (single static page, observe-only)
  projects.ts Multi-project index manager (isolated DB + watcher per project)
  tools.ts    Tool handlers + analysis (duplicates, dead code, diffs)
  brief.ts    Project-brief digest (MCP tool + JSON API shape)
  secrets.ts  Secret-scan patterns + incremental project scan
  embeddings.ts Optional semantic tier: providers (Ollama, OpenAI), vector sync
  hnsw.ts     Deterministic HNSW ANN index (pure TS, no native deps)
  vectorIndex.ts Per-project ANN wrapper: incremental sync + SQLite persistence
  worker.ts   Background audit worker (dead-code + duplicates + secrets reports)
  indexer.ts  SHA-256 delta sync + chokidar watcher
  parser.ts   Tree-sitter engine: symbols, signatures, docstrings, refs
  queries.ts  S-expression query packs per language
  config.ts   Language map, ignore rules, token budgets, argus.json parsing
  db.ts       SQLite schema + parameterized data access
examples/     Claude Code hook (index-first nudge) + settings snippet
tests/        node:test suite: parser fixtures, db, indexer, tools, projects,
              config, http handler + live socket, watcher, hybrid, embeddings
              providers, telemetry, snapshots, audits, HNSW, init, brief, secrets
benchmark/    ANN recall benchmark (`npm run benchmark`; outside `npm test`)
```

## Support

Argus is built and maintained in the open. If it saves your agents some tokens
(or saves you from a blind refactor), consider fuelling the next feature:

<p align="center">
  <a href="https://buymeacoffee.com/stoickthevast"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?style=for-the-badge&logo=buy-me-a-coffee" alt="Buy Me A Coffee"></a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/stoickthevast">buymeacoffee.com/stoickthevast</a>
</p>
