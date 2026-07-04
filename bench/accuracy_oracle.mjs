// Real-repo accuracy (OPTIONAL) — score the graph's call/use edges against the Jedi oracle
// (oracle_jedi.py output). Reports RECALL: of the true call->def edges Jedi resolved inside
// the repo, how many did the compiler's graph also capture? (Precision on a real repo needs
// exhaustive ground truth, which the PyCG track provides; here we measure real-repo recall.)
//
// Matching is by (file, line): a caller node whose span contains caller_line, and a def node
// in def_file within +/- LINE_TOL of def_line. LINE_TOL may need calibration on first run if
// tree-sitter's def start line differs from Jedi's by a constant offset.
//
// Usage:
//   node accuracy_oracle.mjs --db <graph.sqlite> --oracle oracle.json [--tol 2] [--out r.json]
import fs from "node:fs"
import { openGraph } from "./lib/graph.mjs"

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith("--") ? v : true
}

const DB = arg("db")
const ORACLE = arg("oracle")
const TOL = Number(arg("tol", 2))
const OUT = arg("out", null)
if (!DB || !ORACLE) { console.error("required: --db <graph.sqlite> --oracle <oracle.json>"); process.exit(2) }

const db = openGraph(DB)
const nodes = db.prepare("SELECT stable_id id, kind, name, file_path file, start_line s, end_line e FROM nodes").all()
const byFile = new Map()
for (const n of nodes) { if (!byFile.has(n.file)) byFile.set(n.file, []); byFile.get(n.file).push(n) }

// adjacency: source_id -> Set(target_id) over call/use edges
const adj = new Map()
for (const r of db.prepare("SELECT source_id s, target_id t FROM edges WHERE kind IN ('CALLS','REFERENCES')").all()) {
  if (!adj.has(r.s)) adj.set(r.s, new Set())
  adj.get(r.s).add(r.t)
}
db.close()

function enclosing(file, line) {
  const cands = (byFile.get(file) || []).filter(n => n.kind !== "file" && n.s <= line && line <= (n.e || n.s))
  cands.sort((a, b) => (a.e - a.s) - (b.e - b.s)) // smallest span wins
  return cands[0] || (byFile.get(file) || []).find(n => n.kind === "file")
}
function defNode(file, line) {
  const cands = (byFile.get(file) || []).filter(n => n.kind !== "file" && Math.abs(n.s - line) <= TOL)
  cands.sort((a, b) => Math.abs(a.s - line) - Math.abs(b.s - line))
  return cands[0]
}

const oracle = JSON.parse(fs.readFileSync(ORACLE, "utf8"))
let considered = 0, matched = 0, noCaller = 0, noDef = 0
const misses = []
for (const rec of oracle) {
  const caller = enclosing(rec.caller_file, rec.caller_line)
  const target = defNode(rec.def_file, rec.def_line)
  if (!caller) { noCaller++; continue }
  if (!target) { noDef++; continue }
  considered++
  if (adj.get(caller.id)?.has(target.id)) matched++
  else if (misses.length < 40) misses.push({ ...rec, caller: caller.name, target: target.name })
}

const recall = considered ? +(matched / considered).toFixed(4) : null
const report = {
  oracle: ORACLE, lineTol: TOL,
  oracleRecords: oracle.length, considered, matched,
  unmatchableCaller: noCaller, unmatchableDef: noDef,
  recall, sampleMisses: misses.slice(0, 20),
}
console.error("\n=== Real-repo accuracy vs Jedi (recall) ===")
console.error(`oracle records: ${oracle.length}   considered (both endpoints mapped): ${considered}`)
console.error(`matched edges: ${matched}   RECALL ${recall}`)
console.error(`(unmapped caller ${noCaller}, unmapped def ${noDef} — raise --tol if def mapping is low)`)
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`wrote ${OUT}`) }
