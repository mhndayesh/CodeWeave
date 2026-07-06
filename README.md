# CodeWeave — Live Context for opencode

A deterministic **code-graph tool + skill** for [opencode](https://opencode.ai).

It gives the agent a `context` tool that returns a precise slice of your codebase —
a symbol's definition together with its callers and references, connected across
files — instead of grepping, globbing, and reading files one at a time. Powered by
the **Live Context Compiler** (TypeScript compiler + tree-sitter + pyright → a SQLite
code graph; no embeddings, no guesswork).

This is **not a fork of opencode.** It installs into a stock opencode using only
opencode's standard extension points (a custom tool + a skill), so it keeps working
across opencode updates.

## Install

```sh
# 1. install opencode (once), if you haven't
npm install -g opencode-ai

# 2. add the Live Context tool + skill to opencode
git clone https://github.com/mhndayesh/CodeWeave
node CodeWeave/live-context-compiler/opencode/install.mjs   # global (~/.config/opencode)
```

Restart opencode, then just ask about your code in any project:

> *"how does authentication work?"* · *"what calls `sendEmail`?"* · *"where is `User` defined?"*

The `live-context` skill steers the agent to reach for the graph first; the first
question in a project builds the graph (a few seconds), and every question after
reuses it.

## What's in here

```
live-context-compiler/          the engine — graph builder + CLI (standalone Node)
  src/ · test/                   indexer, traversal, renderer, SQLite store
  opencode/                      the opencode integration
    tools/context.ts             the `context` tool  (@opencode-ai/plugin)
    skills/live-context/         the `live-context` skill  (SKILL.md)
    install.mjs                  one-shot installer
    README.md                    integration details
```

- **Engine:** [`live-context-compiler/README.md`](live-context-compiler/README.md) —
  how the graph is built, node/edge kinds, verification tiers, CLI commands.
- **opencode integration:** [`live-context-compiler/opencode/README.md`](live-context-compiler/opencode/README.md) —
  how the tool + skill map onto opencode, and how to install project-locally.

## How it works with opencode

| Piece | Standard opencode location | Mechanism |
| --- | --- | --- |
| `context` tool | `~/.config/opencode/tools/context.ts` | [custom tool](https://opencode.ai/docs/custom-tools/) |
| `live-context` skill | `~/.config/opencode/skills/live-context/SKILL.md` | [agent skill](https://opencode.ai/docs/skills/) |
| engine | `~/.config/opencode/node_modules/live-context-compiler` | normal npm dependency |

Verify with `opencode debug skill` (lists `live-context`).

## License

MIT
