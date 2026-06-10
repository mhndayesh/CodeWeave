import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { compile, status, systemContext } from "../src/live-context/engine"

async function withTmp<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-context-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function fakeCli(dir: string, source: string) {
  const file = path.join(dir, "fake-live-context-cli.mjs")
  await fs.writeFile(file, source)
  return file
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("LiveContext engine", () => {
  test("indexes before compiling and clamps excessive token requests", async () =>
    withTmp(async (dir) => {
      const log = path.join(dir, "calls.jsonl")
      const cli = await fakeCli(
        dir,
        `
          import fs from "node:fs";
          const args = process.argv.slice(2);
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
          if (args[0] === "index") console.log("Indexed");
          else if (args[0] === "slice") console.log("// fake slice " + args[args.indexOf("--max-tokens") + 1]);
          else if (args[0] === "stats") console.log("Files: 1");
          else if (args[0] === "invalidate") console.log("dirty");
        `,
      )

      await withEnv({ OPENCODE_LIVE_CONTEXT_CLI: cli }, async () => {
        const output = await Effect.runPromise(compile({ root: dir, query: "login", maxTokens: 999_999 }))
        expect(output).toContain("// fake slice 50000")
      })

      const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(calls.map((args) => args[0])).toEqual(["index", "slice"])
    }))

  test("status can force reindex", async () =>
    withTmp(async (dir) => {
      const log = path.join(dir, "calls.jsonl")
      const cli = await fakeCli(
        dir,
        `
          import fs from "node:fs";
          const args = process.argv.slice(2);
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
          console.log(args[0] === "stats" ? "Files: 1" : "Indexed");
        `,
      )

      await withEnv({ OPENCODE_LIVE_CONTEXT_CLI: cli }, async () => {
        expect(await Effect.runPromise(status(dir, true))).toContain("Files: 1")
      })

      const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)[0])
      expect(calls).toEqual(["index", "stats"])
    }))

  test("returns undefined system context when the compiler fails", async () =>
    withTmp(async (dir) => {
      const cli = await fakeCli(dir, `console.error("boom"); process.exit(1);`)
      await withEnv({ OPENCODE_LIVE_CONTEXT_CLI: cli }, async () => {
        expect(await Effect.runPromise(systemContext(dir, "fix login"))).toBeUndefined()
      })
    }))

  test("surfaces compiler timeout errors", async () =>
    withTmp(async (dir) => {
      const cli = await fakeCli(dir, `await new Promise((resolve) => setTimeout(resolve, 200));`)
      await withEnv({ OPENCODE_LIVE_CONTEXT_CLI: cli, OPENCODE_LIVE_CONTEXT_TIMEOUT_MS: "10" }, async () => {
        await expect(Effect.runPromise(status(dir, true))).rejects.toThrow(/timed out|SIGTERM|ETIMEDOUT/i)
      })
    }))
})
