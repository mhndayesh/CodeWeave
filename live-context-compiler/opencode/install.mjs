#!/usr/bin/env node
// Install the Live Context Compiler into opencode as a standard tool + skill.
//
// It uses only opencode's documented extension points — a custom tool under
// ~/.config/opencode/tools and a skill under ~/.config/opencode/skills — plus a
// normal npm dependency for the compiler itself. Nothing here patches or forks
// opencode, so it keeps working across opencode updates.
//
// Usage:  node opencode/install.mjs        (global: ~/.config/opencode)
//         node opencode/install.mjs .      (project: ./.opencode)
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url)) // .../opencode
const pkgDir = resolve(here, "..") // the compiler package
const projectArg = process.argv[2]
const configDir = projectArg
  ? resolve(process.cwd(), projectArg, ".opencode")
  : join(homedir(), ".config", "opencode")

const run = (cmd, args, cwd) => {
  console.log(`> ${cmd} ${args.join(" ")}  (in ${cwd})`)
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
}

console.log(`Installing Live Context into opencode config: ${configDir}\n`)
mkdirSync(configDir, { recursive: true })
mkdirSync(join(configDir, "tools"), { recursive: true })
mkdirSync(join(configDir, "skills"), { recursive: true })

// 1. Build the compiler and pack it into a self-contained tarball.
run("npm", ["run", "build"], pkgDir)
run("npm", ["pack", "--pack-destination", configDir], pkgDir)
const tgz = readdirSync(configDir).find((f) => /^live-context-compiler-.*\.tgz$/.test(f))
if (!tgz) throw new Error("npm pack did not produce a tarball")

// 2. Install the compiler as a normal dependency of the opencode config.
run("npm", ["install", "./" + tgz], configDir)

// 3. Drop in the tool + skill (opencode's standard locations).
cpSync(join(here, "tools", "context.ts"), join(configDir, "tools", "context.ts"))
cpSync(join(here, "skills"), join(configDir, "skills"), { recursive: true })

console.log("\nDone. Restart opencode, then just ask about your code — or force it with")
console.log('  context({ query: "<symbol / path / question>" })')
