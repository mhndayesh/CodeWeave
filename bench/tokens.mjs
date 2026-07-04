// Token track — the core value proposition. For a set of realistic "understand X" queries,
// compare how many tokens the model must ingest:
//
//   WITH graph      = tokens in the compiler's context_compile/slice output (targeted).
//   WITHOUT graph   = tokens a graph-less agent ingests: grep for the symbol, then read the
//                     whole files it surfaces (the usual grep -> open-file loop).
//
// Reports per-query and aggregate token counts + reduction %. This is the *static* context
// cost the two strategies deliver to the model; for the full model-in-the-loop number
// (actual prompt tokens), see bench/README.md -> "End-to-end token comparison".
//
// Usage:
//   node tokens.mjs --root <repo> --cli <cli.js> [--queries "a,b,c"] [--topN 12] [--readK 5] [--maxTokens 6000] [--out r.json]
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { openGraph, estimateTokens } from "./lib/graph.mjs"

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith("--") ? v : true
}

const ROOT = arg("root")
const CLI = arg("cli")
const QARG = arg("queries", null)
const TOPN = Number(arg("topN", 12))
const READK = Number(arg("readK", 5)) // how many files a no-graph agent realistically opens
const MAXTOK = String(arg("maxTokens", 6000))
const OUT = arg("out", null)
if (!ROOT || !CLI) { console.error("required: --root <repo> --cli <cli.js>"); process.exit(2) }

const NODE = process.execPath
const DB = path.join(os.tmpdir(), `tokens-bench-${path.basename(ROOT)}.sqlite`)

function runCli(args, maxBuf = 64 * 1024 * 1024) {
  const r = spawnSync(NODE, [CLI, ...args], { encoding: "utf8", timeout: 600000, maxBuffer: maxBuf })
  if (r.status !== 0) throw new Error(`cli ${args[0]} failed: ${(r.stderr || "").slice(-300)}`)
  return r.stdout
}

// ensure the graph exists
if (!fs.existsSync(DB)) { console.error("indexing (one-time)..."); runCli(["index", "--root", ROOT, "--db", DB]) }

// read all source files once (for the baseline grep+read)
const contents = new Map()
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "dist") continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(py|ts|tsx|js|jsx)$/.test(e.name)) { try { contents.set(p, fs.readFileSync(p, "utf8")) } catch {} }
  }
})(ROOT)

// choose queries: explicit, or the most-referenced symbols in the graph (realistic "ask about X")
let queries
const db = openGraph(DB)
if (QARG && typeof QARG === "string") {
  queries = QARG.split(",").map(s => s.trim()).filter(Boolean)
} else {
  queries = db.prepare(`
    SELECT n.name, COUNT(*) deg
    FROM edges e JOIN nodes n ON n.stable_id = e.target_id
    WHERE e.kind IN ('CALLS','REFERENCES') AND n.kind IN ('function','method','class') AND length(n.name) >= 4
    GROUP BY n.name ORDER BY deg DESC LIMIT ${TOPN}
  `).all().map(r => r.name)
}
db.close()

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
function baselineForTerm(term) {
  const re = new RegExp(`\\b${escapeRe(term)}\\b`, "g")
  const hits = []
  for (const [f, text] of contents) {
    const m = text.match(re)
    if (m) hits.push({ file: path.relative(ROOT, f).replaceAll("\\", "/"), count: m.length, tokens: estimateTokens(text) })
  }
  hits.sort((a, b) => b.count - a.count)
  const topK = hits.slice(0, READK)
  return {
    matchingFiles: hits.length,
    readKTokens: topK.reduce((a, h) => a + h.tokens, 0), // realistic: open top-K files
    allMatchTokens: hits.reduce((a, h) => a + h.tokens, 0), // worst case: read every match
  }
}

const rows = []
let sumGraph = 0, sumBaseK = 0, sumBaseAll = 0
console.error(`comparing ${queries.length} queries  (graph slice vs grep+read top-${READK})...`)
for (const q of queries) {
  const term = q.includes(".") ? q.split(".").pop() : q
  let graphTokens = 0
  try { graphTokens = estimateTokens(runCli(["slice", "--root", ROOT, "--db", DB, "--query", q, "--max-tokens", MAXTOK])) } catch {}
  const b = baselineForTerm(term)
  const reductionK = b.readKTokens ? +(100 * (1 - graphTokens / b.readKTokens)).toFixed(1) : null
  rows.push({ query: q, graphTokens, baselineReadK: b.readKTokens, baselineAllMatches: b.allMatchTokens,
    matchingFiles: b.matchingFiles, reductionVsReadKPct: reductionK })
  sumGraph += graphTokens; sumBaseK += b.readKTokens; sumBaseAll += b.allMatchTokens
}

const report = {
  repo: ROOT, readK: READK, maxTokens: Number(MAXTOK), estimator: `chars/${process.env.BENCH_CHARS_PER_TOKEN || 4}`,
  totals: {
    graphTokens: sumGraph,
    baselineReadKTokens: sumBaseK,
    baselineAllMatchTokens: sumBaseAll,
    reductionVsReadKPct: sumBaseK ? +(100 * (1 - sumGraph / sumBaseK)).toFixed(1) : null,
    reductionVsAllMatchesPct: sumBaseAll ? +(100 * (1 - sumGraph / sumBaseAll)).toFixed(1) : null,
    avgGraphTokensPerQuery: Math.round(sumGraph / (queries.length || 1)),
    avgBaselineReadKPerQuery: Math.round(sumBaseK / (queries.length || 1)),
  },
  perQuery: rows,
}

console.error("\n=== Tokens: graph vs no-graph ===")
console.error(`queries: ${queries.length}   estimator: ${report.estimator}`)
console.error(`graph total        ${sumGraph} tok   (avg ${report.totals.avgGraphTokensPerQuery}/query)`)
console.error(`baseline (read ${READK}) ${sumBaseK} tok   (avg ${report.totals.avgBaselineReadKPerQuery}/query)`)
console.error(`baseline (all hits) ${sumBaseAll} tok`)
console.error(`REDUCTION vs read-${READK}: ${report.totals.reductionVsReadKPct}%   vs all-matches: ${report.totals.reductionVsAllMatchesPct}%`)

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`\nwrote ${OUT}`) }
