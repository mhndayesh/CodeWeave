<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" height="96" alt="CodeWeave">
  </picture>
</p>

<h1 align="center">CodeWeave</h1>

<p align="center">
  <strong>AI coding agent with built-in repository context — no indexing overhead, no plugin config.</strong>
</p>

CodeWeave is a fork of [OpenCode](https://opencode.ai) with the **Live Context Compiler** built directly into the agent harness. It automatically indexes your codebase and injects relevant context into every LLM call — no manual setup, no external services, no API costs.

## What Makes It Different

Most AI coding tools require you to manually select files, configure RAG pipelines, or wait for cloud-based indexing. CodeWeave's Live Context Compiler runs **entirely locally** and **deterministically** — it builds a graph of your codebase using TypeScript's compiler API, then renders the most relevant slice into the model's context automatically.

- **Zero LLM calls for indexing** — purely AST-based static analysis
- **Zero cloud dependency** — everything runs on your machine
- **Zero plugin config** — built into the agent, not bolted on
- **Git-aware invalidation** — edits to files trigger automatic re-indexing

## How It Works

1. Open a project directory.
2. Run `codeweave`.
3. The Live Context Compiler silently indexes your codebase (`.ts`, `.tsx`, `.js`, `.jsx`), building a graph of symbols, types, imports, and call relationships.
4. Before each model call, CodeWeave automatically extracts a relevant context slice — functions, files, routes, schemas — and injects it into the system prompt.
5. The model can also call `context_compile`, `context_expand`, and `context_status` directly for deeper exploration.

## Built-in Tools

| Tool | Description |
|------|-------------|
| `context_compile` | Compile context for a symbol, path, route, or table. Supports traversal policies: `minimal`, `function_edit`, `endpoint_edit`, `schema_edit`, `impact`. |
| `context_expand` | Compile additional context while keeping graph-first exploration. |
| `context_status` | Show graph status — file, node, edge, and container counts. |

## Smart Budget Allocation

Each context slice is rendered within a token budget with priority-phased allocation:

| Phase | Content |
|-------|---------|
| 1. Entry source | Always rendered — the matched symbol/function/file |
| 2. Entry edges | Direct relationships (imports, calls, contains) |
| 3. Tier 0-1 source | Nearby functions, classes, files with context lines |
| 4. Other edges | Broader graph relationships |
| 5. Routes / Unresolved | Route registrations and unresolved references |

Per-call overrides via `renderMode` (`balanced`, `source-first`, `edges-first`) let the model tilt allocation as needed.

## Optional Runtime Data

CodeWeave can import real execution data to produce Tier 5 (highest confidence) edges:

- **Test traces** — `**/.test-traces/*.json` — which functions each test actually calls
- **OpenTelemetry** — `**/.otel-traces/*.json` — distributed trace topology and production call patterns
- **Coverage** — `**/coverage/lcov.info` — line-level execution frequency

These are optional. Without them, the compiler still produces Tier 3-4 edges from TypeScript static analysis.

## Configuration

Configure via `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "liveContextCompiler": {
    "ignorePatterns": ["**/generated/**"],
    "defaultMaxTokens": 12000,
    "renderMode": "balanced"
  }
}
```

| Key | Description |
|-----|-------------|
| `ignorePatterns` | Glob patterns to exclude from indexing |
| `defaultMaxTokens` | Token budget per context slice (default: 12000, max: 50000) |
| `renderMode` | Default allocation: `balanced`, `source-first`, or `edges-first` |

## Performance

On a real-world benchmark (Directus, 5.23M tokens, 3,037 files):

| Phase | Time |
|-------|------|
| Full index | ~30s |
| FTS5 query | ~260ms |
| Context slice (impact/8K) | ~1.8s |
| Container build | ~24s baseline |

The graph database is a local SQLite file (`.context-graph.sqlite`, ~124MB for the Directus benchmark).

## Safety

CodeWeave includes built-in security exclusions — `.env*`, `.npmrc`, `.pypirc`, `.netrc`, SSH keys, private keys, `node_modules`, `dist`, coverage output, and the graph database itself are all excluded from indexing by default.

## License

This project is based on [OpenCode](https://opencode.ai), which is licensed under the Apache License 2.0.
