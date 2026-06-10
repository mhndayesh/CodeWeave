# Live Context Compiler

**Deterministic context compilation for LLMs over live code graphs.**

Compiles task-specific context slices from deterministic code relationships — no embeddings, no LLM guesswork. Optimized for large codebases (100k+ files).

## How It Works

The indexer parses source files and builds a directed graph of `SymbolIdentity`-keyed nodes (files, functions, classes, routes, DB tables, env vars, events) connected by typed edges (`CALLS`, `IMPORTS`, `EXTENDS`, `EXPOSES_ROUTE`, `READS_TABLE`, 20 kinds total). A step-based traversal engine walks the graph from entry symbols following configurable policies, and a tier-based renderer produces raw source excerpts with strict token budgets.

```
Source files → Parser → Graph (SQLite) → Traversal → Rendered Slice → LLM
                                                 ↕
                                        Slice Cache (version-gated)
```

## Commands

```
init                    Create graph store with security defaults
index                   Index all files (TS/JS/PY/RS/GO)
watch                   Watch for file changes (auto-reindex)
query --query <s>       Search indexed nodes by name
slice --query <s>       Generate context slice with policy & token budget
invalidate [--file <p>] Show or trigger transitive dirty propagation
reindex                 Re-index only dirty files
container build|list|status   Discover, inspect physical/feature/relation containers
cache clear|status      Manage the slice cache
import-test-trace       Import JSON test traces → OBSERVED_CALL edges
import-otel             Import OpenTelemetry spans → OBSERVED_CALL edges
import-coverage         Import lcov coverage → COVERS_LINE edges
security status|check|redact   Exclusion rules, path guard, secret redaction
serve                   Start MCP server over stdio (5 tools)
stats                   Node/edge/container/cache counts
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--root <dir>` | cwd | Repository root |
| `--db <path>` | `.context-graph.sqlite` | Database path |
| `--query <s>` | — | Search string |
| `--policy <name>` | `impact` | Traversal policy: `minimal`, `function_edit`, `endpoint_edit`, `schema_edit`, `impact` |
| `--max-tokens <n>` | per-policy | Token budget for slice |

## Quick Start

```bash
npm install
npx tsx src/cli.ts init --root /path/to/repo
npx tsx src/cli.ts index --root /path/to/repo
npx tsx src/cli.ts slice --query login --policy impact --root /path/to/repo
```

For a guided first run, see [ONBOARDING.md](./ONBOARDING.md).

## Architecture

### Core Graph (`src/types.ts`)

- **13 node kinds**: file, function, class, method, interface, type, enum, variable, property, route, db_table, db_column, event, config, package
- **20 edge kinds**: CONTAINS, IMPORTS, EXPORTS, EXTENDS, IMPLEMENTS, REFERENCES, CALLS, EXPOSES_ROUTE, CONSUMES_ROUTE, EMITS_EVENT, CONSUMES_EVENT, READS_TABLE, WRITES_TABLE, CONSUMES_API, EXPOSES_API, DEPENDS_ON_PACKAGE, UNRESOLVED_CALL, UNRESOLVED_IMPORT, OBSERVED_CALL, COVERS_LINE
- **6 verification tiers**: UNRESOLVED=0, ANNOTATION_ONLY=1, PATTERN_MATCHED=2, VERIFIED_STATIC=3, VERIFIED_COMPILER=4, VERIFIED_RUNTIME=5
- **SymbolIdentity**: `stableId` (SHA-256 of repo+lang+qualified-name) + `versionHash` (body hash) + lineage via `previousStableId`

### Storage (`src/db.ts`)

SQLite via `node:sqlite` with FTS5 full-text search (LIKE fallback). Tables:
- `nodes` — SHA-256 PK, version_hash, previous_stable_id for rename lineage
- `edges` — unique constraint on (source_id, target_id, kind), edge_evidence accumulation
- `imports_index` — fast lookup for cross-file reference resolution
- `containers` / `container_members` / `container_deps` — relation containers
- `slice_cache` — version-gated cache entries
- `dirty_files` — tracked for incremental re-indexing

### Indexers

| Language | Parser | File Extensions |
|----------|--------|-----------------|
| TypeScript/JavaScript | TS Compiler API | `.ts`, `.tsx`, `.js`, `.jsx` |
| Python | Regex | `.py` |
| Rust | Regex | `.rs` |
| Go | Regex | `.go` |

### Contract Bridges (`src/contracts/`)

11 bridges extract domain-specific nodes during indexing:

| Bridge | Pattern | Edges |
|--------|---------|-------|
| Express | `app.get/post/put/patch/delete` | EXPOSES_ROUTE |
| Fastify | `fastify.get/post` | EXPOSES_ROUTE |
| Next.js | App Router file path → route | EXPOSES_ROUTE |
| Events | `emit/publish/send`, `on/subscribe` | EMITS_EVENT, CONSUMES_EVENT |
| Generic | `fetch`, `prisma.find/create` | CONSUMES_API, WRITES_TABLE |
| Env | `process.env.XXX`, `env()` | config nodes + READS_TABLE |
| Drizzle | `pgTable` definitions | db_table/db_column |
| OpenAPI | `.json`/`.yaml` spec | EXPOSES_ROUTE + CONSUMES_API |
| Prisma | `.prisma` schema parser | db_table/db_column |
| SQL | `CREATE TABLE` / `CREATE INDEX` | db_table/db_column |
| GraphQL | `.graphql`/`.gql` types | db_table nodes |

### Runtime Evidence (`src/runtime/`)

Import runtime data as verified edges:

- **TestTraceImporter** — JSON trace entries → `OBSERVED_CALL` (VERIFIED_RUNTIME)
- **OtelImporter** — OpenTelemetry spans → `OBSERVED_CALL` + `REFERENCES`
- **CoverageImporter** — lcov.info → `COVERS_LINE`

### Containers (`src/container-builder.ts`)

Automatic discovery of relation containers: physical (workspace packages, tsconfig roots, directory groups), feature (cross-cutting), and relation (contract-path traced). Members assigned `primary`/`related`/`utility` roles. Container dirty propagation cascades through the graph.

### Traversal Policies (`src/traversal.ts`)

| Policy | Stop Rules | Use Case |
|--------|-----------|----------|
| `minimal` | Immediate hub stop | Quick symbol lookup |
| `function_edit` | Moderate hubs | Editing a single function |
| `endpoint_edit` | Route + module hubs | Editing an API endpoint |
| `schema_edit` | Table read/write focus | Editing schema, migrations, and adjacent data access |
| `impact` | Conservative hubs | Understanding change impact |

### Security (`src/security.ts`)

- **Exclusion patterns**: skip/redact node_modules, .git, dist, .pem, .key, .min.js, .env files
- **Path traversal guard**: prevents `../` escapes from repo root
- **Secret redaction**: API keys, tokens, PEM private keys, AWS keys in indexed content

## MCP Server

Start the MCP server over stdio JSON-RPC:

```bash
npx tsx src/cli.ts serve --root /path/to/repo
```

### Tools

| Tool | Description |
|------|-------------|
| `compile_context` | Compile context slice from query + policy + token budget |
| `expand_slice` | Expand existing slice with additional entry nodes |
| `explore` | Query nodes and their connected edges |
| `search` | Full-text search across node names |
| `stats` | Repository statistics |

## Requirements

- Node.js 22.13+ (for `node:sqlite`)
- npm

## Development

```bash
npm test            # Run all 163 tests (vitest)
npm run typecheck   # TypeScript check
npm run check       # Typecheck + tests
npm run bench       # Run gold-set benchmarks
```

## Project Structure

```
src/
  cli.ts              — CLI entry point (18 commands)
  db.ts               — GraphStore (SQLite + FTS5)
  types.ts            — SymbolIdentity, 20 edge kinds, 6 verification tiers
  indexer.ts          — TS Compiler API indexer
  resolver.ts         — Module resolution with cache
  invalidator.ts      — Transitive dirty propagation
  traversal.ts        — 5 step-based traversal policies
  render.ts           — Tier-based rendering with token budget
  render-diff.ts      — Diff-as-annotation rendering
  budget.ts           — TokenBudget with configurable safety margin
  hash.ts             — SHA-256 stableId, versionHash
  container-builder.ts — Container discovery and member assignment
  slice-cache.ts      — Version-gated cache
  security.ts         — Exclusion rules, path guard, secret redaction
  watcher.ts          — Chokidar file watcher with debounce
  benchmark.ts        — Gold-set benchmark harness
  contracts/          — 11 contract bridges
  runtime/            — 3 runtime importers (test-trace, otel, coverage)
  languages/          — 3 multi-language indexers (python, rust, go)
  mcp/                — MCP server (stdio JSON-RPC)
test/
  index.test.ts       — 66 Phase 1 tests
  phase2.test.ts      — 21 container tests
  phase3.test.ts      — 21 contract bridge tests
  phase4.test.ts      — 17 context compiler tests
  phase5.test.ts      — 10 runtime evidence tests
  phase6.test.ts      — 7 multi-language tests
  security.test.ts    — 21 security tests
```
