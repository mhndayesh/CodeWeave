<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" height="96" alt="CodeWeave">
  </picture>
</p>

<h1 align="center">CodeWeave</h1>

<p align="center">
  <strong>An AI coding agent with a built-in, code-aware graph of your repo —<br/>so the model <em>understands</em> your codebase instead of grepping around it.</strong>
</p>

CodeWeave is a fork of [OpenCode](https://opencode.ai) with the **Live Context Compiler** built in: a fast, deterministic **code graph** the AI uses to understand your project precisely. The heavy lifting is done by **real code analysis** — the TypeScript compiler, tree-sitter, and pyright — while the AI just *asks for what it needs, on demand*.

📖 **[Overview](./CODEWEAVE_DOCS.md)** · 🧭 **[Commands & usage](./COMMANDS.md)**

---

## What makes it different

- **Real code analysis, not LLM guessing.** The graph is built by the **TypeScript compiler API** (TS/JS), **tree-sitter** (30+ languages), and **pyright** (semantic Python). The AI only *triggers* it; the *code* does the work.
- **On-demand + cached.** Context is pulled **once, when needed**, then reused. Your 2nd/3rd/4th messages only process what you typed — not the whole codebase again. (First message builds it; the rest are fast.)
- **Local & deterministic.** Everything runs on your machine — no cloud indexing, no API costs. Same input → same graph.
- **Confidence tiers.** Every edge is tagged **tier‑4** (compiler/type-resolved), **tier‑2** (tree-sitter/heuristic), or **tier‑0** (hint), so the model knows what to trust.

---

## Languages

| Fidelity | Languages | How |
|---|---|---|
| **Highest** | `.ts` `.tsx` `.js` `.jsx` | TypeScript compiler API |
| **Semantic** | `.py` | pyright (type-aware) + tree-sitter |
| **Structural** | Rust, Go, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Lua, Dart, and ~20 more | tree-sitter |

Cross-file references are resolved for all of them; Python and TS/JS get true type-aware resolution.

---

## Quick start

```sh
cd your-project
opencode
```

Then just **ask naturally**:

- *"What does `Session.send` call?"*
- *"How does auth work in this repo?"*

The AI pulls the code map on its own when it needs to — **you don't have to do anything extra.**

---

## Commands

| Command | What it does |
|---|---|
| **`opencode`** | Start the assistant (your day-to-day tool) |
| **`/context <symbol>`** | *(inside opencode)* force a precise graph pull, e.g. `/context Session.request` |
| **`/reindex`** | *(inside opencode)* rebuild the graph after big changes |
| **`opencode-graph`** | Build the graph directly in a terminal — **no AI**, pure indexer |
| **`opencode-help`** | Print the quick cheat-sheet |

Full reference → **[COMMANDS.md](./COMMANDS.md)**.

### AI tools (the model calls these — you don't)

| Tool | Purpose |
|---|---|
| `context_compile` | Pull the graph slice for a symbol/path/phrase (definition + callers + references) |
| `context_expand` | Pull an additional/adjacent slice |
| `context_status` | Show graph status (file / node / edge counts) |

---

## How it works

1. The compiler indexes your project into a **graph** (`.context-graph.sqlite` at the project root) using real parsers — no LLM involved.
2. The AI calls `context_compile` with a symbol/path/phrase → gets the relevant slice (definition + callers + references), already connected across files.
3. The graph **builds once** on first use and updates **incrementally** on edits.
4. Context is **on-demand**, not force-injected every turn — that's what keeps prompt caching (and your follow-up messages) fast.

> Want the old always-on injection back? Set `OPENCODE_LIVE_CONTEXT_AUTOINJECT=1`.

---

## Benchmarks

Measured locally (Windows), first-time **full** index. The graph builds **once**, then re-indexes incrementally — much faster after that.

| Repo | Files | Nodes | Edges | First index |
|---|---|---|---|---|
| **CodeWeave** (this TS monorepo) | 1,827 | 12,622 | 92,516 | ~50s |
| **psf/requests** (Python) | 37 | 757 | 2,176 (1,508 tier‑4 pyright) | ~10s |
| **townsim** (Python) | 67 | 934 | 2,457 (with pyright) | ~25s · re-index **~2s** |

- **Query / symbol lookup:** effectively instant (SQLite FTS5-backed).
- **Context slice:** sub-second from the built graph.
- **Large monorepos** need more Node heap (`NODE_OPTIONS=--max-old-space-size=8192`) and a higher timeout — see [COMMANDS.md](./COMMANDS.md#5-environment-variables-advanced--setup).

*Numbers vary by machine and whether pyright's semantic pass runs (Python only).*

---

## Configuration (`opencode.json`)

```jsonc
{
  "liveContextCompiler": {
    "ignorePatterns": ["**/node_modules/**", "**/dist/**", "**/.venv/**"],
    "defaultMaxTokens": 12000,
    "renderMode": "balanced"   // balanced | source-first | edges-first
  }
}
```

Environment variables (paths, timeouts, memory) are documented in **[COMMANDS.md](./COMMANDS.md#5-environment-variables-advanced--setup)**.

---

## Optional runtime data (tier‑5, highest confidence)

CodeWeave can import real execution data to add the most trustworthy edges:

- **Test traces** — which functions each test actually calls
- **OpenTelemetry** — production call topology
- **Coverage** (`lcov`) — line-level execution frequency

These are optional; without them, the compiler still produces tier‑2 to tier‑4 edges from static analysis.

---

## Safety

Secrets and noise are excluded from indexing by default — `.env*`, `.npmrc`, `.netrc`, SSH/private keys, `node_modules`, `dist`, `.venv`, coverage output, and the graph database itself.

---

## License

Based on [OpenCode](https://opencode.ai), licensed under the Apache License 2.0.
