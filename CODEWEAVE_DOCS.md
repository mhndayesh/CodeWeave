# CodeWeave

CodeWeave is [opencode](https://github.com/sst/opencode) with a **Live Context Compiler** built in.

In plain terms: it gives the AI a fast, accurate **map of your codebase** so it actually *understands* your code — instead of blindly grepping and reading files one by one.

---

## Why it matters

When you ask about your code, the AI can pull a precise map — **which function calls which, where things are defined, how a feature flows** — built by **real code analysis, not the AI guessing**:

- **TypeScript compiler API** — TS/JS (highest accuracy)
- **tree-sitter** — 30+ languages (Python, Rust, Go, Java, C/C++, Ruby, PHP, Swift, Kotlin, …)
- **pyright** — semantic, type-aware Python

The design is simple and deliberate:

> **The AI only *triggers* it. The *code* does the work. The result is cached.**

So it builds **once** on first use, then reuses — your 2nd, 3rd, 4th messages stay fast (no re-reading the whole codebase every time).

---

## Quick start

```sh
cd your-project
opencode
```

Then just ask naturally:

- *"What does `Session.send` call?"*
- *"How does auth work in this repo?"*
- *"Trace the flow when a request comes in."*

The AI pulls the code map on its own when it needs to. **You don't have to do anything extra.**

👉 Full command list and options: **[COMMANDS.md](./COMMANDS.md)**

---

## How it works (one level deeper)

1. The compiler indexes your project into a **graph** (nodes = functions/classes/files, edges = calls/references/imports) and stores it in `.context-graph.sqlite` at your project root.
2. Each edge has a **confidence tier**: tier‑4 = compiler/type-checker resolved, tier‑2 = tree-sitter/heuristic, tier‑0 = unresolved hint. When a slice has to fit a token budget, the compiler **keeps the highest-confidence edges first** and drops the fuzzy ones — so the AI gets precise, verified relationships, not noise.
3. The AI calls the `context_compile` tool with a symbol/path/phrase → the compiler returns the relevant slice (definition + callers + references), already connected across files. The entry point is the **best** match for your query, not an arbitrary one.
4. Edits update the graph **incrementally** — only changed files are re-analyzed, and re-indexing an unchanged project is near-instant.
5. For Python, deep **type-aware (pyright)** resolution runs in the background and is **resumable** — re-index a big repo a few times and its precise coverage climbs toward complete, instead of stalling.

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

Everything else (env vars, all commands) is in **[COMMANDS.md](./COMMANDS.md)**.
