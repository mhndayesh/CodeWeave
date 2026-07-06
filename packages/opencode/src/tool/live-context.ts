import { LiveContext } from "@opencode-ai/core/live-context"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import DESCRIPTION from "./live-context.txt"
import * as Tool from "./tool"

// Dead-simple params, matching grep/glob: one required field, plain description.
export const CompileParameters = Schema.Struct({
  query: Schema.String.annotate({
    description: 'A symbol, file/dir path, or plain phrase to understand (e.g. "Session.request", "packages/core/src/auth", "how login works").',
  }),
})

export const StatusParameters = Schema.Struct({
  forceIndex: Schema.optional(Schema.Boolean).annotate({ description: "Rebuild the graph from scratch first." }),
})

// Read the `liveContextCompiler` block from the user's config once at tool init and
// close over it, so these tools honor ignorePatterns / defaultMaxTokens / renderMode the
// same way the core builtin tools do. (execute must stay requirement-free — Def.execute is
// R=never — so the read happens here, in the init effect, not per call.)
const liveContextConfig = Effect.gen(function* () {
  const config = yield* Config.Service
  const cfg = yield* config.get()
  const lcc = cfg.liveContextCompiler
  return {
    ignorePatterns: lcc?.ignorePatterns,
    defaultMaxTokens: lcc?.defaultMaxTokens,
    renderMode: lcc?.renderMode,
  }
})

export const ContextCompileTool = Tool.define(
  "context_compile",
  Effect.gen(function* () {
    const cfg = yield* liveContextConfig
    return {
      description: DESCRIPTION,
      parameters: CompileParameters,
      execute: (params: Schema.Schema.Type<typeof CompileParameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const output = yield* LiveContext.compile({
            root: instance.directory,
            query: params.query,
            maxTokens: cfg.defaultMaxTokens,
            renderMode: cfg.renderMode,
            ignorePatterns: cfg.ignorePatterns,
          })
          return {
            title: params.query,
            metadata: { query: params.query, truncated: false },
            output,
          }
        }).pipe(Effect.catch((error: unknown) => unavailable(params.query, error, { query: params.query }))),
    }
  }),
)

export const ContextExpandTool = Tool.define(
  "context_expand",
  Effect.gen(function* () {
    const cfg = yield* liveContextConfig
    return {
      description:
        "Pull an additional code-graph slice for another symbol/path/phrase while staying graph-first. Same as context_compile — use it to widen understanding to an adjacent piece of code.",
      parameters: CompileParameters,
      execute: (params: Schema.Schema.Type<typeof CompileParameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const output = yield* LiveContext.compile({
            root: instance.directory,
            query: params.query,
            maxTokens: cfg.defaultMaxTokens,
            renderMode: cfg.renderMode,
            ignorePatterns: cfg.ignorePatterns,
          })
          return {
            title: params.query,
            metadata: { query: params.query, truncated: false },
            output,
          }
        }).pipe(Effect.catch((error: unknown) => unavailable(params.query, error, { query: params.query }))),
    }
  }),
)

export const ContextStatusTool = Tool.define(
  "context_status",
  Effect.gen(function* () {
    const cfg = yield* liveContextConfig
    return {
      description: "Show the code-graph status (file/node/edge counts) for the current project. Pass forceIndex to rebuild it.",
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const output = yield* LiveContext.status(instance.directory, params.forceIndex, cfg.ignorePatterns)
          return {
            title: "Live Context status",
            metadata: { truncated: false },
            output,
          }
        }).pipe(Effect.catch((error: unknown) => unavailable("Live Context status", error))),
    }
  }),
)

function unavailable<M extends Record<string, unknown>>(title: string, error: unknown, metadata = {} as M) {
  return Effect.succeed({
    title,
    metadata: { ...metadata, truncated: false, error: true } as M & { truncated: false; error: true },
    output: `Live Context is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  })
}
