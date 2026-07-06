import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

// Resolve the Live Context Compiler CLI from the installed `live-context-compiler`
// package (a normal dependency of this opencode config). No hardcoded paths, so it
// keeps working across opencode updates and if the source repo moves.
const CLI = createRequire(import.meta.url).resolve("live-context-compiler/cli")

// The compiler uses node:sqlite, so it must run under a real Node (not bun).
// Node is on PATH; override with LIVE_CONTEXT_NODE if needed.
const NODE = process.env.LIVE_CONTEXT_NODE || "node"

function runCli(root: string, extra: string[]): string {
  return execFileSync(NODE, [CLI, ...extra, "--root", root], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
  })
}

export default tool({
  description:
    "Compile precise code-graph context for a symbol, file/dir path, or plain-language question: the definition plus its callers and references, connected across files. Prefer this over grep/glob/read for understanding how code works, where something is defined, or what calls what. Backed by the Live Context Compiler (TypeScript compiler + tree-sitter + pyright).",
  args: {
    query: tool.schema
      .string()
      .describe(
        'What to understand: a symbol, a file/dir path, or a phrase — e.g. "GraphStore", "src/auth", "how login works".',
      ),
    reindex: tool.schema
      .boolean()
      .optional()
      .describe("Rebuild the graph from scratch first (use after large changes or if results look stale)."),
  },
  async execute(args, context) {
    const root = context.directory
    const db = join(root, ".context-graph.sqlite")
    try {
      if (args.reindex || !existsSync(db)) runCli(root, ["index"])
      return runCli(root, ["slice", "--query", args.query])
    } catch (err: any) {
      const detail = (err?.stderr?.toString?.() || err?.message || String(err)).trim()
      return `Live Context is unavailable for "${args.query}": ${detail}`
    }
  },
})
