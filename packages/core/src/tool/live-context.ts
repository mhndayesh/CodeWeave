export * as LiveContextTool from "./live-context"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { Config } from "../config"
import { compile, status } from "../live-context/engine"
import type { RenderMode } from "../live-context/engine"
import { Tool } from "./tool"
import { Tools } from "./tools"

const RenderModeSchema = Schema.Union([
  Schema.Literal("balanced"),
  Schema.Literal("source-first"),
  Schema.Literal("edges-first"),
])

export const ContextCompileInput = Schema.Struct({
  query: Schema.String.annotate({ description: "Symbol, file path, route, table, or task phrase to compile context for." }),
  policy: Schema.Union([
    Schema.Literal("minimal"),
    Schema.Literal("function_edit"),
    Schema.Literal("endpoint_edit"),
    Schema.Literal("schema_edit"),
    Schema.Literal("impact"),
  ])
    .pipe(Schema.optional)
    .annotate({ description: "Traversal policy. Omit to use deterministic classification." }),
  maxTokens: Schema.Number.pipe(Schema.optional).annotate({ description: "Maximum rendered context tokens." }),
  renderMode: RenderModeSchema.pipe(Schema.optional).annotate({ description: "Override render allocation: balanced, source-first, edges-first." }),
  forceIndex: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Force a full graph re-index first." }),
})

export const ContextExpandInput = Schema.Struct({
  query: Schema.String.annotate({ description: "Additional symbol, path, route, or table to compile." }),
  policy: Schema.Union([
    Schema.Literal("minimal"),
    Schema.Literal("function_edit"),
    Schema.Literal("endpoint_edit"),
    Schema.Literal("schema_edit"),
    Schema.Literal("impact"),
  ]).pipe(Schema.optional),
  maxTokens: Schema.Number.pipe(Schema.optional),
  renderMode: RenderModeSchema.pipe(Schema.optional),
})

export const ContextStatusInput = Schema.Struct({
  forceIndex: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Force a full graph re-index first." }),
})

const Output = Schema.String

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const configEntries = yield* config.entries()
    const lccConfig = Config.latest(configEntries, "liveContextCompiler")
    const ignorePatterns = lccConfig?.ignorePatterns
    const defaultMaxTokens = lccConfig?.defaultMaxTokens
    const configRenderMode = lccConfig?.renderMode

    yield* tools
      .register({
        context_compile: Tool.make({
          description:
            "Compile deterministic repository context from the built-in Live Context Compiler graph. Use before broad grep/glob when the task needs codebase understanding.",
          input: ContextCompileInput,
          output: Output,
          execute: (input) =>
            compile({
              root: location.directory,
              query: input.query,
              policy: input.policy,
              maxTokens: input.maxTokens ?? defaultMaxTokens,
              renderMode: input.renderMode ?? configRenderMode,
              forceIndex: input.forceIndex,
              ignorePatterns,
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) }))),
        }),
        context_expand: Tool.make({
          description:
            "Compile another Live Context slice for an adjacent symbol/path/route/table while keeping graph-first exploration.",
          input: ContextExpandInput,
          output: Output,
          execute: (input) =>
            compile({
              root: location.directory,
              query: input.query,
              policy: input.policy,
              maxTokens: input.maxTokens ?? defaultMaxTokens,
              renderMode: input.renderMode ?? configRenderMode,
              ignorePatterns,
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) }))),
        }),
        context_status: Tool.make({
          description: "Show built-in Live Context Compiler graph status for the active project.",
          input: ContextStatusInput,
          output: Output,
          execute: (input) =>
            status(location.directory, input.forceIndex, ignorePatterns).pipe(
              Effect.mapError((error) => new ToolFailure({ message: String(error) })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
