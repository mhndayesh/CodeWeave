// Hands-on relation dump: for chosen symbols, show what the graph says relates to them
// (referrers in / references+calls out), and self-check each edge by confirming the related
// symbol's name actually appears in the source span of the referencing node.
//
// Usage: node relations_dump.mjs --db <graph.sqlite> --root <repo> [--symbols "A,B,C"] [--limit 6]
import fs from "node:fs"
import path from "node:path"
import { openGraph } from "./lib/graph.mjs"

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true }
const DB = arg("db"), ROOT = arg("root"), SYMS = arg("symbols", null), LIMIT = Number(arg("limit", 6))
if (!DB || !ROOT) { console.error("required: --db <graph.sqlite> --root <repo>"); process.exit(2) }

const db = openGraph(DB)
const nodeById = new Map()
for (const n of db.prepare("SELECT stable_id id, kind, name, qualified_name qn, file_path file, start_line s, end_line e FROM nodes").all()) nodeById.set(n.id, n)

function findNode(sym) {
  const rows = db.prepare(`SELECT stable_id id FROM nodes WHERE name = ?
    ORDER BY CASE kind WHEN 'class' THEN 0 WHEN 'function' THEN 1 WHEN 'method' THEN 2 ELSE 3 END LIMIT 1`).get(sym)
  return rows ? nodeById.get(rows.id) : null
}
const outgoing = (id) => db.prepare("SELECT target_id t, kind FROM edges WHERE source_id=? AND kind IN ('CALLS','REFERENCES')").all(id)
const incoming = (id) => db.prepare("SELECT source_id s, kind FROM edges WHERE target_id=? AND kind IN ('CALLS','REFERENCES')").all(id)

const srcCache = new Map()
function nameInSpan(node, name) {
  if (!node || !node.file) return null
  const abs = path.join(ROOT, node.file)
  if (!srcCache.has(abs)) { try { srcCache.set(abs, fs.readFileSync(abs, "utf8").split("\n")) } catch { srcCache.set(abs, null) } }
  const lines = srcCache.get(abs); if (!lines) return null
  const span = lines.slice(Math.max(0, node.s - 1), node.e || node.s).join("\n")
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(span)
}

let symbols = SYMS ? String(SYMS).split(",").map(s => s.trim())
  : db.prepare(`SELECT n.name FROM edges e JOIN nodes n ON n.stable_id=e.target_id
      WHERE e.kind IN ('CALLS','REFERENCES') AND n.kind IN ('class','function','method') AND length(n.name)>=4
      GROUP BY n.name ORDER BY COUNT(*) DESC LIMIT ${LIMIT}`).all().map(r => r.name)

let checks = 0, ok = 0
for (const sym of symbols.slice(0, LIMIT)) {
  const node = findNode(sym)
  if (!node) { console.log(`\n### ${sym}  (not in graph)`); continue }
  console.log(`\n### ${sym}  [${node.kind}]  ${node.file}:${node.s}`)
  const inn = incoming(node.id).map(e => ({ n: nodeById.get(e.s), k: e.kind })).filter(x => x.n)
  const out = outgoing(node.id).map(e => ({ n: nodeById.get(e.t), k: e.kind })).filter(x => x.n)
  console.log(`  <- referenced by (${inn.length}):`)
  for (const x of inn.slice(0, 8)) {
    const chk = nameInSpan(x.n, sym); if (chk !== null) { checks++; if (chk) ok++ }
    console.log(`       ${x.k.padEnd(10)} ${x.n.name} (${x.n.file}:${x.n.s})  ${chk === null ? "" : chk ? "[ok]" : "[MISS]"}`)
  }
  console.log(`  -> references/calls out (${out.length}):`)
  for (const x of out.slice(0, 8)) {
    const chk = nameInSpan(node, x.n.name); if (chk !== null) { checks++; if (chk) ok++ }
    console.log(`       ${x.k.padEnd(10)} ${x.n.name} (${x.n.file}:${x.n.s})  ${chk === null ? "" : chk ? "[ok]" : "[MISS]"}`)
  }
}
db.close()
console.log(`\nself-check: ${ok}/${checks} edges have the related name present in the source span (${checks ? Math.round(100 * ok / checks) : 0}%)`)
