# CodeWeave Documentation Summary

## Overview
CodeWeave is an AI coding agent built on OpenCode with a **Live Context Compiler** built directly into the agent harness. It automatically indexes your codebase and injects relevant context into every LLM call — no manual setup, no external services, no API costs.

## Key Features
- **Live Context Compiler**: Builds a directed graph of your codebase using TypeScript's Compiler API.
- **Zero LLM Indexing**: Uses purely AST-based static analysis.
- **Zero Cloud Dependency**: Runs entirely locally.
- **Git-Aware Invalidation**: Edits to files trigger automatic re-indexing.
- **Smart Budget Allocation**: Renders context slices within a token budget using priority-phased allocation.

## Main Entry Points
- `bun dev`: Run TUI mode.
- `bun dev serve`: Start headless API server on port 4096.
- `bun run --cwd packages/desktop dev`: Desktop app.

## Configuration (`opencode.json`)
- `liveContextCompiler.ignorePatterns`: Glob patterns to exclude from indexing.
- `liveContextCompiler.defaultMaxTokens`: Token budget per context slice (default: 12000).
- `liveContextCompiler.renderMode`: Default allocation (`balanced`, `source-first`, `edges-first`).

## Built-in Tools
- `context_compile`: Compile context for a symbol, path, route, or table.
- `context_expand`: Compile additional context while keeping graph-first exploration.
- `context_status`: Show graph status.

## Style Guide (AGENTS.md)
- **General**: Keep things in one function unless composable; avoid `try/catch` and `any`; use Bun APIs.
- **Destructuring**: Avoid unnecessary destructuring; use dot notation.
- **Imports**: Never alias imports; never use star imports; prefer dynamic imports for heavy modules.
- **Variables**: Prefer `const`; use ternaries or early returns.
- **Control Flow**: Avoid `else` statements; prefer early returns.
- **Testing**: Avoid mocks; run tests from package dirs.
- **Type Checking**: Always run `bun typecheck` from package directories.

## Session Runtime (CONTEXT.md)
- **System Context**: Structured collection of contextual facts presented to the model.
- **Session History**: Projected chronological conversation selected for a provider turn.
- **Context Source**: One independently observed typed value within the System Context.
- **Context Epoch**: Span during which one effective agent's initially rendered System Context remains immutable.
