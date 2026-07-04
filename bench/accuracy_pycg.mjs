// Accuracy track — score the Live Context Compiler against the PyCG micro-benchmark,
// the standard labeled call-graph ground truth (github.com/vitsalis/PyCG).
//
// For each case: index its folder into an isolated graph DB, reconstruct the generated
// call/use graph as fully-qualified caller->callee edges, and compare to the checked-in
// callgraph.json. Reports micro-averaged precision / recall / F1 overall and per category.
//
// Usage:
//   node accuracy_pycg.mjs --snippets <PyCG>/micro-benchmark/snippets --cli <cli.js> [--no-lsp] [--out results.json]
//
// Honest caveats (see bench/README.md):
//  - Our graph records Python calls as REFERENCES (a superset of pure calls), so precision
//    here is a LOWER BOUND vs PyCG's pure-call ground truth.
//  - `external`/`dynamic` categories exercise stdlib/dynamic dispatch our static resolver
//    intentionally leaves unresolved; low recall there is expected, not a regression.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { openGraph, fqnResolver, resolvedCallEdges, prf } from "./lib/graph.mjs"

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith("--") ? v : true
}

const SNIPPETS = arg("snippets")
const CLI = arg("cli")
const NO_LSP = !!arg("no-lsp", false)
const OUT = arg("out", null)
if (!SNIPPETS || !CLI) {
  console.error("required: --snippets <dir> --cli <cli.js>")
  process.exit(2)
}

const NODE = process.execPath
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pycg-bench-"))

// Every dir containing callgraph.json is one case.
function findCases(root) {
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(p, "callgraph.json"))) out.push(p)
      else out.push(...findCases(p))
    }
  }
  return out
}

function groundTruthEdges(caseDir) {
  const gt = JSON.parse(fs.readFileSync(path.join(caseDir, "callgraph.json"), "utf8"))
  const set = new Set()
  for (const [caller, callees] of Object.entries(gt)) {
    for (const callee of callees) set.add(`${caller}\t${callee}`)
  }
  return set
}

function generatedEdges(caseDir, db) {
  const { fqn } = fqnResolver(db)
  const set = new Set()
  for (const e of resolvedCallEdges(db)) {
    const s = fqn(e.src), d = fqn(e.dst)
    if (s && d && s !== d) set.add(`${s}\t${d}`)
  }
  return set
}

const cases = findCases(SNIPPETS).sort()
const perCategory = new Map() // category -> {tp,fp,fn,cases,perfect}
let g = { tp: 0, fp: 0, fn: 0, cases: 0, perfect: 0, indexFail: 0 }
const caseRows = []

console.error(`Scoring ${cases.length} PyCG cases  (LSP ${NO_LSP ? "OFF" : "ON"})...`)

for (const caseDir of cases) {
  const rel = path.relative(SNIPPETS, caseDir).replaceAll("\\", "/")
  const category = rel.split("/")[0]
  const db = path.join(tmpRoot, rel.replaceAll("/", "_") + ".sqlite")
  const env = { ...process.env }
  if (NO_LSP) env.OPENCODE_LIVE_CONTEXT_LSP = "0"

  const r = spawnSync(NODE, [CLI, "index", "--root", caseDir, "--db", db], {
    encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024, env,
  })
  if (r.status !== 0 || !fs.existsSync(db)) {
    g.indexFail++
    caseRows.push({ case: rel, error: (r.stderr || "").split("\n").slice(-3).join(" ").slice(0, 200) })
    continue
  }

  const gt = groundTruthEdges(caseDir)
  let gen
  try {
    const h = openGraph(db)
    gen = generatedEdges(caseDir, h)
    h.close()
  } catch (e) {
    g.indexFail++
    caseRows.push({ case: rel, error: `read: ${e.message}` })
    continue
  }

  const m = prf(gen, gt)
  const cat = perCategory.get(category) ?? { tp: 0, fp: 0, fn: 0, cases: 0, perfect: 0 }
  cat.tp += m.tp; cat.fp += m.fp; cat.fn += m.fn; cat.cases++
  const perfect = m.fp === 0 && m.fn === 0
  if (perfect) cat.perfect++
  perCategory.set(category, cat)
  g.tp += m.tp; g.fp += m.fp; g.fn += m.fn; g.cases++
  if (perfect) g.perfect++
  caseRows.push({ case: rel, gt: gt.size, gen: gen.size, ...m, perfect })
}

fs.rmSync(tmpRoot, { recursive: true, force: true })

function rate(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : 1
  const r = tp + fn ? tp / (tp + fn) : 1
  const f1 = p + r ? (2 * p * r) / (p + r) : 0
  return { precision: +p.toFixed(4), recall: +r.toFixed(4), f1: +f1.toFixed(4) }
}

const overall = rate(g.tp, g.fp, g.fn)
const categories = {}
for (const [k, v] of [...perCategory].sort()) {
  categories[k] = { ...rate(v.tp, v.fp, v.fn), cases: v.cases, perfect: v.perfect }
}

const report = {
  benchmark: "PyCG micro-benchmark",
  lsp: !NO_LSP,
  cases: g.cases, indexFailures: g.indexFail, perfectCases: g.perfect,
  overall, categories, perCase: caseRows,
}

console.error("\n=== PyCG accuracy ===")
console.error(`cases scored: ${g.cases}  index failures: ${g.indexFail}  perfect: ${g.perfect}/${g.cases}`)
console.error(`OVERALL  precision ${overall.precision}  recall ${overall.recall}  F1 ${overall.f1}`)
console.error("\nby category:")
for (const [k, v] of Object.entries(categories)) {
  console.error(`  ${k.padEnd(14)} P ${v.precision.toFixed(3)}  R ${v.recall.toFixed(3)}  F1 ${v.f1.toFixed(3)}  (${v.perfect}/${v.cases} perfect)`)
}

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`\nwrote ${OUT}`) }
