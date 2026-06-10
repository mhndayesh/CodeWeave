import { LiveContext } from "@opencode-ai/core/live-context"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"

const Policy = Schema.Union([
  Schema.Literal("minimal"),
  Schema.Literal("function_edit"),
  Schema.Literal("endpoint_edit"),
  Schema.Literal("schema_edit"),
  Schema.Literal("impact"),
])

export const CompileParameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Symbol, path, route, table, or task phrase to compile context for." }),
  policy: Policy.pipe(Schema.optional).annotate({ description: "Traversal policy. Omit for automatic classification." }),
  maxTokens: Schema.Number.pipe(Schema.optional).annotate({ description: "Maximum rendered context tokens." }),
  forceIndex: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Force a full graph re-index first." }),
})

export const StatusParameters = Schema.Struct({
  forceIndex: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Force a full graph re-index first." }),
})

export const ContextCompileTool = Tool.define(
  "context_compile",
  Effect.succeed({
    description:
      "Compile deterministic repository context from the built-in Live Context Compiler graph. Use before broad grep/glob when the task needs codebase understanding.",
    parameters: CompileParameters,
    execute: (params: Schema.Schema.Type<typeof CompileParameters>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const output = yield* LiveContext.compile({
          root: instance.directory,
          query: params.query,
          policy: params.policy,
          maxTokens: params.maxTokens,
          forceIndex: params.forceIndex,
        })
        return {
          title: params.query,
          metadata: {
            query: params.query,
            policy: params.policy,
            truncated: false,
          },
          output,
        }
      }).pipe(
        Effect.catch((error: unknown) =>
          unavailable(params.query, error, { query: params.query, policy: params.policy }),
        ),
      ),
  }),
)

export const ContextExpandTool = Tool.define(
  "context_expand",
  Effect.succeed({
    description:
      "Compile another Live Context slice for an adjacent symbol/path/route/table while keeping graph-first exploration.",
    parameters: CompileParameters,
    execute: (params: Schema.Schema.Type<typeof CompileParameters>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const output = yield* LiveContext.compile({
          root: instance.directory,
          query: params.query,
          policy: params.policy,
          maxTokens: params.maxTokens,
          forceIndex: params.forceIndex,
        })
        return {
          title: params.query,
          metadata: {
            query: params.query,
            policy: params.policy,
            truncated: false,
          },
          output,
        }
      }).pipe(
        Effect.catch((error: unknown) =>
          unavailable(params.query, error, { query: params.query, policy: params.policy }),
        ),
      ),
  }),
)

export const ContextStatusTool = Tool.define(
  "context_status",
  Effect.succeed({
    description: "Show built-in Live Context Compiler graph status for the active project.",
    parameters: StatusParameters,
    execute: (params: Schema.Schema.Type<typeof StatusParameters>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const output = yield* LiveContext.status(instance.directory, params.forceIndex)
        return {
          title: "Live Context status",
          metadata: { truncated: false },
          output,
        }
      }).pipe(Effect.catch((error: unknown) => unavailable("Live Context status", error))),
  }),
)

function unavailable<M extends Record<string, unknown>>(title: string, error: unknown, metadata = {} as M) {
  return Effect.succeed({
    title,
    metadata: { ...metadata, truncated: false, error: true } as M & { truncated: false; error: true },
    output: `Live Context is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  })
}
