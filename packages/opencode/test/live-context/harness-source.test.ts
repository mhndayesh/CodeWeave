import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("OpenCode harness wires Live Context as built-in source", async () => {
  const root = path.resolve(import.meta.dir, "../..")
  const registry = await fs.readFile(path.join(root, "src/tool/registry.ts"), "utf8")
  const prompt = await fs.readFile(path.join(root, "src/session/prompt.ts"), "utf8")
  const tools = await fs.readFile(path.join(root, "src/session/tools.ts"), "utf8")

  expect(registry).toContain('from "./live-context"')
  expect(registry).toContain("tool.contextCompile")
  expect(registry).toContain("tool.contextExpand")
  expect(registry).toContain("tool.contextStatus")
  expect(prompt).toContain("LiveContext.systemContext")
  expect(tools).toContain("LiveContext.invalidateChanged")
})
