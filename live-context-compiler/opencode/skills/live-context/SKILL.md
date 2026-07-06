---
name: live-context
description: Understand code by querying the prebuilt code graph via the `context` tool instead of grepping or reading many files. Use it first for any "how does X work", "where is Y defined", "what calls Z", trace-a-feature, or scope-a-change question in a codebase.
---

# Live Context — graph-first code understanding

A precise **code graph** for the current project is available through the `context`
tool (the Live Context Compiler: TypeScript compiler + tree-sitter + pyright). It
returns a symbol's definition together with its callers and references, already
connected across files — far cheaper and more accurate than grep/glob or reading
files one at a time.

## When to use it
Reach for `context` **first**, before grep/glob/read, whenever the task is to
*understand code* rather than find a literal string:
- "How does <feature> work?"
- "Where is <symbol> defined?" / "What calls <function>?"
- Getting oriented in an unfamiliar area, tracing a flow, or scoping a change.

## How to use it
Call the `context` tool with a `query`:
- a symbol — `context({ query: "GraphStore" })`
- a path — `context({ query: "src/auth" })`
- a question — `context({ query: "how sessions are created" })`

The first call in a project builds the graph (a few seconds); later calls reuse it.
Pass `reindex: true` after large changes to rebuild it.

## When NOT to use it
- Searching for a literal string, log line, config key, TODO, or comment → use grep.
- Finding files by name pattern → use glob.
