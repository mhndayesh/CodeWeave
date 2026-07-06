# Live Context for opencode — tool + skill

Add the Live Context Compiler to a stock [opencode](https://opencode.ai) install as
a **tool** and a **skill**, using only opencode's standard extension points. No fork,
no patched binary — it survives opencode updates.

## What you get

- **`context` tool** — `context({ query })` returns a precise code-graph slice
  (a symbol's definition plus its callers and references, connected across files).
  Backed by the compiler CLI (TypeScript compiler + tree-sitter + pyright → SQLite).
- **`live-context` skill** — tells the agent to reach for `context` first, instead
  of grepping/globbing/reading many files, for "how does X work / where is Y / what
  calls Z" questions.

## Install

```sh
# global (~/.config/opencode) — applies to every project
node opencode/install.mjs

# or project-local (./.opencode)
node opencode/install.mjs .
```

The installer builds the compiler, packs it into a self-contained tarball, installs
it as a normal npm dependency of your opencode config, and copies the tool + skill
into place. **Restart opencode** afterwards (config is loaded once at startup).

## How it maps to opencode

| Piece | Standard opencode location | Mechanism |
| --- | --- | --- |
| Tool | `~/.config/opencode/tools/context.ts` | [custom tool](https://opencode.ai/docs/custom-tools/) (`@opencode-ai/plugin`) |
| Skill | `~/.config/opencode/skills/live-context/SKILL.md` | [agent skill](https://opencode.ai/docs/skills/) |
| Engine | `~/.config/opencode/node_modules/live-context-compiler` | normal npm dependency |

The tool resolves the compiler via `require.resolve("live-context-compiler/cli")` —
no hardcoded paths. Override the Node used to run it with `LIVE_CONTEXT_NODE` if
`node` isn't on opencode's PATH.

## Verify

```sh
opencode debug skill        # lists the `live-context` skill
cd your-project && opencode  # then ask: "how does <feature> work?"
```
