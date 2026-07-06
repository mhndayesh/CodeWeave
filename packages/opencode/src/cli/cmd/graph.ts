import { Effect } from "effect"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { LiveContext } from "@opencode-ai/core/live-context"

// Terminal entry point to the Live Context code graph — no AI, no chat. Backs the
// documented `opencode graph` command by driving the same compiler the agent's
// context_* tools use, so a big repo can be pre-built (or force-rebuilt) from a shell.
export const GraphCommand = effectCmd({
  command: "graph [action]",
  describe: "build or inspect the code graph (Live Context) for this project",
  // Pure indexer over a directory — no project InstanceContext needed.
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "status (build + show counts, default) | reindex (force rebuild) | slice (pull a context slice)",
        type: "string",
        choices: ["status", "reindex", "slice"] as const,
        default: "status",
      })
      .option("query", {
        describe: "symbol / path / phrase to slice — required for `slice`",
        type: "string",
      })
      .option("root", {
        describe: "project root to index (default: current directory)",
        type: "string",
      }),
  handler: Effect.fn("Cli.graph")(function* (args) {
    const root = (args.root as string | undefined) ?? process.cwd()
    const action = (args.action as string | undefined) ?? "status"
    const toCliError = (error: unknown) =>
      new CliError({ message: error instanceof Error ? error.message : String(error) })

    if (action === "slice") {
      const query = args.query as string | undefined
      if (!query) return yield* fail("`opencode graph slice` requires --query <symbol|path|phrase>")
      const output = yield* LiveContext.compile({ root, query }).pipe(Effect.mapError(toCliError))
      console.log(output)
      return
    }

    // status (default) or reindex (force). Both build the graph on first use.
    const output = yield* LiveContext.status(root, action === "reindex").pipe(Effect.mapError(toCliError))
    console.log(output)
  }),
})
