// Relation-graph accuracy: score the compiler's REFERENCES/CALLS edges against the Jedi
// find-references oracle (oracle_jedi_refs.py). This judges the graph as a *reference* graph
// on its own terms - the fair counterpart to the PyCG pure-call test.
//
// For each sampled symbol S, compare the set of "referrer symbols" (functions/classes/modules
// that use S): ours (incoming CALLS/REFERENCES edges to S) vs Jedi's. Matched by (file, name)
// so granularity differences don't cause spurious misses.
//
// Usage: node accuracy_relations.mjs --db <graph.sqlite> --oracle refs.json [--tol 2] [--out r.json]
import fs from "node:fs"
import { openGraph } from "./lib/graph.mjs"

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true }
const DB = arg("db"), ORACLE = arg("oracle"), TOL = Number(arg("tol", 2)), OUT = arg("out", null)
if (!DB || !ORACLE) { console.error("required: --db <graph.sqlite> --oracle <refs.json>"); process.exit(2) }

const db = openGraph(DB)
const nodes = db.prepare("SELECT stable_id id, kind, name, file_path file, start_line s, end_line e FROM nodes").all()
const byFile = new Map()
for (const n of nodes) { if (!byFile.has(n.file)) byFile.set(n.file, []); byFile.get(n.file).push(n) }
const nodeById = new Map(nodes.map(n => [n.id, n]))
// incoming CALLS/REFERENCES: target -> Set(sourceId)
const incoming = new Map()
for (const r of db.prepare("SELECT source_id s, target_id t FROM edges WHERE kind IN ('CALLS','REFERENCES')").all()) {
  if (!incoming.has(r.t)) incoming.set(r.t, new Set())
  incoming.get(r.t).add(r.s)
}
db.close()

const key = (file, name) => `${file}::${name}`
function referrerKey(node) { return key(node.file, node.kind === "file" ? "<module>" : node.name) }
function defNode(file, line, name) {
  const c = (byFile.get(file) || []).filter(n => n.kind !== "file" && Math.abs(n.s - line) <= TOL)
  c.sort((a, b) => (a.name === name ? 0 : 1) - (b.name === name ? 0 : 1) || Math.abs(a.s - line) - Math.abs(b.s - line))
  return c[0]
}

const oracle = JSON.parse(fs.readFileSync(ORACLE, "utf8")).filter(s => s.referrers.length > 0)
// Two granularities: symbol-level (file, enclosing-name) and file-level (which files relate).
const G = { sym: { tp: 0, fp: 0, fn: 0 }, file: { tp: 0, fp: 0, fn: 0 } }
let mapped = 0, unmapped = 0
const rows = []
for (const sym of oracle) {
  const target = defNode(sym.def_file, sym.def_line, sym.name)
  if (!target) { unmapped++; continue }
  mapped++
  const ourNodes = [...(incoming.get(target.id) || [])].map(id => nodeById.get(id)).filter(Boolean)
  const ourSym = new Set(ourNodes.map(referrerKey))
  const jediSym = new Set(sym.referrers.map(r => key(r.file, r.name)))
  const ourFile = new Set(ourNodes.map(n => n.file))
  const jediFile = new Set(sym.referrers.map(r => r.file))
  const score = (ours, jedi, bucket) => {
    let tp = 0; for (const k of ours) if (jedi.has(k)) tp++
    G[bucket].tp += tp; G[bucket].fp += ours.size - tp; G[bucket].fn += jedi.size - tp; return tp
  }
  const tps = score(ourSym, jediSym, "sym")
  score(ourFile, jediFile, "file")
  rows.push({ symbol: sym.name, def: `${sym.def_file}:${sym.def_line}`, ours: ourSym.size, jedi: jediSym.size, tp: tps })
}
const prf = (b) => {
  const p = b.tp + b.fp ? b.tp / (b.tp + b.fp) : 1, r = b.tp + b.fn ? b.tp / (b.tp + b.fn) : 1
  return { precision: +p.toFixed(4), recall: +r.toFixed(4), f1: +(p + r ? 2 * p * r / (p + r) : 0).toFixed(4) }
}
const report = {
  oracle: ORACLE, lineTol: TOL, symbolsScored: mapped, symbolsUnmappable: unmapped,
  symbolLevel: { ...prf(G.sym), ...G.sym },
  fileLevel: { ...prf(G.file), ...G.file },
  perSymbol: rows.sort((a, b) => b.jedi - a.jedi),
}
console.error("\n=== RELATION-graph accuracy vs Jedi find-references ===")
console.error(`symbols scored: ${mapped} (unmappable ${unmapped})`)
const s = report.symbolLevel, fl = report.fileLevel
console.error(`SYMBOL granularity (referrer = enclosing function): P ${s.precision}  R ${s.recall}  F1 ${s.f1}  (tp ${s.tp}/fp ${s.fp}/fn ${s.fn})`)
console.error(`FILE granularity   (which files reference it):      P ${fl.precision}  R ${fl.recall}  F1 ${fl.f1}  (tp ${fl.tp}/fp ${fl.fp}/fn ${fl.fn})`)
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`wrote ${OUT}`) }
