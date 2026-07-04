// Speed track — measure indexing and query latency on a target repo (default: the dense
// SQLAlchemy checkout). All timings are wall-clock around the shipping compiler CLI.
//
// Usage:
//   node speed.mjs --root <repo> --cli <cli.js> [--queries 40] [--out results.json]
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { openGraph, counts, tierHistogram } from "./lib/graph.mjs"

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith("--") ? v : true
}

const ROOT = arg("root")
const CLI = arg("cli")
const NQ = Number(arg("queries", 40))
const OUT = arg("out", null)
if (!ROOT || !CLI) { console.error("required: --root <repo> --cli <cli.js>"); process.exit(2) }

const NODE = process.execPath
const DB = path.join(os.tmpdir(), `speed-bench-${path.basename(ROOT)}.sqlite`)
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(DB + ext, { force: true }) } catch {} }

function run(args) {
  const t = process.hrtime.bigint()
  const r = spawnSync(NODE, [CLI, ...args], { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  if (r.status !== 0) throw new Error(`cli ${args[0]} failed (${r.status}): ${(r.stderr || "").slice(-300)}`)
  return { ms, stdout: r.stdout }
}

const results = { repo: ROOT, timestampNote: "wall-clock ms" }

// 1. cold full index
console.error("cold index...")
results.coldIndexMs = Math.round(run(["index", "--root", ROOT, "--db", DB]).ms)

// 2. warm re-index (no changes)
console.error("warm re-index...")
results.warmReindexMs = Math.round(run(["index", "--root", ROOT, "--db", DB]).ms)

// 3. graph size + tiers
const db = openGraph(DB)
results.graph = counts(db)
results.tiers = tierHistogram(db)
const total = Object.values(results.tiers).reduce((a, b) => a + b, 0)
results.tier4Pct = total ? +(100 * (results.tiers[4] || 0) / total).toFixed(1) : 0
// sample callable names for query latency
const names = db.prepare(
  "SELECT DISTINCT name FROM nodes WHERE kind IN ('function','method','class') AND length(name) >= 4"
).all().map(r => r.name)
db.close()

// 4. incremental edit (touch one source file, re-index, restore)
const srcFiles = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(py|ts|js)$/.test(e.name)) srcFiles.push(p)
  }
})(ROOT)
if (srcFiles.length) {
  const victim = srcFiles[Math.floor(srcFiles.length / 2)]
  const original = fs.readFileSync(victim, "utf8")
  try {
    fs.writeFileSync(victim, original + "\n# bench-touch\n")
    console.error("incremental re-index (1 file changed)...")
    results.incrementalReindexMs = Math.round(run(["index", "--root", ROOT, "--db", DB]).ms)
    results.incrementalFile = path.relative(ROOT, victim).replaceAll("\\", "/")
  } finally {
    fs.writeFileSync(victim, original) // always restore
  }
}

// 5. query/slice latency
console.error(`slice latency over ${NQ} queries...`)
const picks = []
for (let i = 0; i < NQ && names.length; i++) picks.push(names[Math.floor(Math.random() * names.length)])
const lat = []
for (const q of picks) {
  try { lat.push(run(["slice", "--root", ROOT, "--db", DB, "--query", q, "--max-tokens", "4000"]).ms) } catch {}
}
lat.sort((a, b) => a - b)
const pct = (p) => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]) : null
results.sliceLatencyMs = { n: lat.length, p50: pct(0.5), p95: pct(0.95),
  mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null }

// derived throughput
results.filesPerSec = results.graph.files ? +(results.graph.files / (results.coldIndexMs / 1000)).toFixed(1) : null
results.nodesPerSec = results.graph.nodes ? Math.round(results.graph.nodes / (results.coldIndexMs / 1000)) : null

console.error("\n=== Speed ===")
console.error(`cold index      ${results.coldIndexMs} ms   (${results.filesPerSec} files/s, ${results.nodesPerSec} nodes/s)`)
console.error(`warm re-index   ${results.warmReindexMs} ms`)
console.error(`incremental     ${results.incrementalReindexMs ?? "n/a"} ms  (1 file)`)
console.error(`graph           ${results.graph.files} files / ${results.graph.nodes} nodes / ${results.graph.edges} edges  (tier-4 ${results.tier4Pct}%)`)
console.error(`slice latency   p50 ${results.sliceLatencyMs.p50} ms  p95 ${results.sliceLatencyMs.p95} ms  (n=${results.sliceLatencyMs.n})`)

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.error(`\nwrote ${OUT}`) }
