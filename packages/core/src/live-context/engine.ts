import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { classify, type PolicyName } from "./classifier"

const indexed = new Set<string>()
const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_TOKENS = 12_000
export const MIN_ALLOWED_TOKENS = 500
export const MAX_ALLOWED_TOKENS = 50_000

// Cumulative token cap per "turn" (resets on user message)
let cumulativeTokensUsed = 0
const CUMULATIVE_MULTIPLIER = 2

export function resetCumulativeTokens() {
  cumulativeTokensUsed = 0
}

export type RenderMode = "balanced" | "source-first" | "edges-first"

export type CompileInput = {
  readonly root: string
  readonly query: string
  readonly policy?: PolicyName
  readonly maxTokens?: number
  readonly renderMode?: RenderMode
  readonly forceIndex?: boolean
  readonly ignorePatterns?: readonly string[]
}

export const compile = (input: CompileInput) =>
  Effect.tryPromise({
    try: async () => {
      const root = path.resolve(input.root)
      const policy = input.policy ?? classify(input.query).policy
      const maxTokens = boundedTokens(input.maxTokens)
      await ensureIndexed(root, input.forceIndex === true, input.ignorePatterns ? [...input.ignorePatterns] : undefined)
      const args = [
        "slice",
        "--root", root,
        "--db", dbPath(root),
        "--query", input.query,
        "--policy", policy,
        "--max-tokens", String(maxTokens),
      ]
      if (input.renderMode) args.push("--render-mode", input.renderMode)
      if (input.ignorePatterns?.length) {
        for (const p of input.ignorePatterns) args.push("--ignore-patterns", p)
      }
      return runCli(root, args)
    },
    catch: normalizeError,
  })

export const status = (rootInput: string, forceIndex = false, ignorePatterns?: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const root = path.resolve(rootInput)
      await ensureIndexed(root, forceIndex, ignorePatterns)
      return runCli(root, ["stats", "--root", root, "--db", dbPath(root)])
    },
    catch: normalizeError,
  })

export const systemContext = (root: string, userMessage: string) => {
  resetCumulativeTokens()
  return compile({
    root,
    query: classify(userMessage).query,
    policy: classify(userMessage).policy,
    maxTokens: 8000,
  }).pipe(
    Effect.map((rendered) =>
      [
        "Live Context Compiler is built into this OpenCode fork.",
        "Use context_compile/context_expand/context_status before broad grep/glob exploration when repository context is needed.",
        "Verification tiers: 0 unresolved, 1 annotation, 2 pattern matched, 3 static bridge, 4 TypeScript compiler, 5 runtime.",
        "Prefer tier 4 and 5 edges. Treat tier 0 and 2 as hints.",
        "",
        rendered,
      ].join("\n"),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )
}

export function snapshot(root: string): Set<string> {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => line.slice(3).split(" -> "))
        .map((file) => file.replace(/^"|"$/g, "").replaceAll("\\", "/"))
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

export const invalidateChanged = (rootInput: string, before: Set<string>, after: Set<string>) =>
  Effect.tryPromise({
    try: async () => {
      const root = path.resolve(rootInput)
      const changed = new Set<string>()
      for (const file of before) if (!after.has(file)) changed.add(file)
      for (const file of after) if (!before.has(file)) changed.add(file)
      for (const file of changed) {
        runCli(root, ["invalidate", "--root", root, "--db", dbPath(root), "--file", file])
      }
      indexed.delete(root)
      return [...changed].sort()
    },
    catch: normalizeError,
  }).pipe(Effect.catch(() => Effect.succeed([])))

async function ensureIndexed(root: string, force: boolean, ignorePatterns?: readonly string[]) {
  if (!force && indexed.has(root) && fs.existsSync(dbPath(root))) return
  const args = ["index", "--root", root, "--db", dbPath(root)]
  if (ignorePatterns?.length) {
    for (const p of ignorePatterns) args.push("--ignore-patterns", p)
  }
  runCli(root, args)
  indexed.add(root)
}

function runCli(root: string, args: string[]) {
  const cli = compilerCli()
  const timeout = numberFromEnv("OPENCODE_LIVE_CONTEXT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
  const result = spawnSync(process.env.OPENCODE_LIVE_CONTEXT_NODE ?? process.execPath ?? "node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  })
  if (result.error) {
    throw new Error(`Live Context command failed (${args[0]}): ${result.error.message}`)
  }
  if (result.signal) {
    throw new Error(`Live Context command ${args[0]} terminated by ${result.signal}`)
  }
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `Live Context command failed: ${args.join(" ")}`
    throw new Error(message)
  }
  return result.stdout.trimEnd()
}

function dbPath(root: string) {
  return path.join(root, ".context-graph.sqlite")
}

function compilerCli() {
  const fromEnv = process.env.OPENCODE_LIVE_CONTEXT_CLI
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const here = path.dirname(fileURLToPath(import.meta.url))
  const binDir = path.dirname(process.execPath)
  const candidates = [
    path.resolve(binDir, "../lib/live-context-compiler/cli.js"),
    path.resolve(binDir, "../../lib/live-context-compiler/cli.js"),
    path.resolve(here, "../../../live-context-compiler/dist/src/cli.js"),
    path.resolve(here, "../../../../live-context-compiler/dist/src/cli.js"),
    path.resolve(process.cwd(), "packages/live-context-compiler/dist/src/cli.js"),
    path.resolve(process.cwd(), "packages/opencode/dist/opencode-linux-x64/lib/live-context-compiler/cli.js"),
  ]
  const match = candidates.find((candidate) => fs.existsSync(candidate))
  if (!match) throw new Error("Live Context Compiler CLI not found. Build packages/live-context-compiler first.")
  return match
}

function boundedTokens(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TOKENS
  // Apply 50% per-call override cap and cumulative cap
  const perCallCap = Math.floor(DEFAULT_MAX_TOKENS * 1.5)
  const remaining = Math.max(0, DEFAULT_MAX_TOKENS * CUMULATIVE_MULTIPLIER - cumulativeTokensUsed)
  const cap = Math.min(perCallCap, remaining)
  const clamped = Math.max(MIN_ALLOWED_TOKENS, Math.min(Math.floor(value), MAX_ALLOWED_TOKENS, cap))
  cumulativeTokensUsed += clamped
  return clamped
}

function numberFromEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}
