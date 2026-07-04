# CodeWeave — Commands & Usage

Everything you can do, from most-common to advanced. If you only read one thing:
**just run `opencode` in your project and use it normally — the code graph takes care of itself.**

---

## 1. The one you'll actually use

| Command | What it does |
| --- | --- |
| **`opencode`** | Start the AI assistant in the current folder. This is your day-to-day tool. |

```sh
cd your-project
opencode
```

Ask naturally (*"what does X call?"*, *"how does auth work?"*). The AI builds and uses the
code graph **automatically** the first time it needs it. Nothing else required.

---

## 2. Slash commands (inside opencode)

Type these after starting `opencode`:

| Slash command | What it does |
| --- | --- |
| **`/context <symbol or question>`** | Ask the AI to pull precise graph context, e.g. `/context Session.request` |
| **`/reindex`** | Rebuild the code graph from scratch (after big changes) |
| `/help`, `/agents`, `/compact`, … | Standard opencode commands |

> Tip: you usually **don't need `/context`** — just ask in a normal sentence and the AI
> reaches for the graph itself. Use `/context` only when you want to force it.

---

## 3. AI tools (the AI calls these — you don't)

These are how the AI talks to the code graph. Listed so you know what you're seeing in the output:

| Tool | Purpose |
| --- | --- |
| `context_compile` | Pull the graph slice for a symbol/path/phrase (definition + callers + references) |
| `context_expand` | Pull an additional/adjacent slice while staying graph-first |
| `context_status` | Show graph status (file / node / edge counts) |

---

## 4. Terminal helper commands

Run these in a normal terminal (not inside opencode):

| Command | What it does |
| --- | --- |
| **`opencode-graph`** | Build the full code graph for the current folder **directly — no AI, no chat.** Useful to pre-build a big repo. `opencode` then reuses it. |
| **`opencode-help`** | Print the quick cheat-sheet. |

```sh
cd your-project
opencode-graph      # pure code indexer, builds .context-graph.sqlite
```

---

## 5. Environment variables (advanced / setup)

The compiler runs as a small Node process next to the opencode binary. These control it:

| Variable | Purpose | Typical value |
| --- | --- | --- |
| `OPENCODE_LIVE_CONTEXT_NODE` | Path to real `node` used to run the compiler | `.../node.exe` |
| `OPENCODE_LIVE_CONTEXT_CLI` | Path to the compiler bundle `cli.js` | `.../lib/live-context-compiler/cli.js` |
| `OPENCODE_LIVE_CONTEXT_TIMEOUT_MS` | Max time for one index (raise for huge repos) | `300000` (5 min) |
| `NODE_OPTIONS` | Give Node more heap for large monorepos | `--max-old-space-size=8192` |
| `OPENCODE_LIVE_CONTEXT_AUTOINJECT` | `1` = inject context every turn (old behavior, **breaks caching**). Default off = on-demand. | unset |

> On the compiled binary, `NODE` and `CLI` are **required** — the bundled exe can't run a
> plain `.js` by itself, so it needs a real Node and the explicit path to `cli.js`.

---

## 6. Common tasks

| I want to… | Do this |
| --- | --- |
| Just work / ask about my code | `opencode` |
| Pre-build the graph (no AI) | `opencode-graph` |
| Refresh the graph after big changes | `/reindex` (in opencode) or `opencode-graph` again |
| Force the AI to use the graph now | `/context <symbol>` |
| See what commands exist | `opencode-help` |
| Rebuild the whole CodeWeave binary | `cd packages/opencode && bun run script/build.ts --single --skip-embed-web-ui` |

---

## 7. Speed notes

- **First message** in a project builds the graph → a bit slower. **Every message after** reuses
  the cache → fast. This is by design (the graph is built once, then reused).
- The graph is **on-demand**: it's not stuffed into every prompt (that would defeat the model's
  cache). The AI pulls it via a tool only when needed, which keeps follow-ups fast.
- Big monorepos: the first index can take a minute and needs memory — that's what the
  `TIMEOUT_MS` and `NODE_OPTIONS` settings above are for.
