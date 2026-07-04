// Shared helpers for reading a Live Context Compiler graph DB (.context-graph.sqlite)
// and reconstructing Python-style fully-qualified names, so the graph can be compared
// against external ground truth (e.g. PyCG). Uses Node's built-in sqlite (Node >= 22.5).
import { DatabaseSync } from "node:sqlite"

export function openGraph(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true })
}

// "main.py" -> "main"; "pkg/mod.py" -> "pkg.mod"; "pkg/__init__.py" -> "pkg"
export function moduleName(relFilePath) {
  let p = String(relFilePath).replaceAll("\\", "/")
  p = p.replace(/\.(pyi?|mjs|cjs|jsx?|tsx?)$/i, "")
  p = p.replace(/\/__init__$/i, "")
  return p.split("/").filter(Boolean).join(".")
}

// Build a fully-qualified-name resolver over the graph's nodes + CONTAINS hierarchy.
// FQN(file)      = module name
// FQN(symbol)    = module + "." + dotted scope path (class.method etc.), from CONTAINS chain
export function fqnResolver(db) {
  const nodes = new Map()
  for (const r of db.prepare("SELECT stable_id id, kind, name, file_path file, start_line line FROM nodes").all()) {
    nodes.set(r.id, r)
  }
  const parent = new Map() // child -> containing parent
  for (const r of db.prepare("SELECT source_id src, target_id dst FROM edges WHERE kind='CONTAINS'").all()) {
    if (!parent.has(r.dst)) parent.set(r.dst, r.src)
  }
  const cache = new Map()
  function fqn(id) {
    if (cache.has(id)) return cache.get(id)
    const n = nodes.get(id)
    if (!n) return null
    let out
    if (n.kind === "file") {
      out = moduleName(n.file)
    } else {
      const names = [n.name]
      let cur = parent.get(id)
      let guard = 0
      while (cur && guard++ < 200) {
        const pn = nodes.get(cur)
        if (!pn || pn.kind === "file") break
        names.unshift(pn.name)
        cur = parent.get(cur)
      }
      out = moduleName(n.file) + "." + names.join(".")
    }
    cache.set(id, out)
    return out
  }
  return { nodes, fqn }
}

// Resolved call/use edges whose target is a callable-ish node (function/method/class).
// NOTE: the compiler emits Python call relationships as REFERENCES (tier-2 tree-sitter +
// tier-4 pyright) and TS/JS calls as CALLS. We union both. This is a *reference* graph, a
// superset of a pure call graph, so precision vs a pure-call oracle (PyCG) is a LOWER BOUND.
export function resolvedCallEdges(db) {
  return db.prepare(`
    SELECT e.source_id src, e.target_id dst
    FROM edges e
    JOIN nodes tn ON tn.stable_id = e.target_id
    WHERE e.kind IN ('CALLS','REFERENCES')
      AND tn.kind IN ('function','method','class')
  `).all()
}

// Distinct canonical edges bucketed by their best (max) verification tier.
export function tierHistogram(db) {
  const rows = db.prepare(`
    SELECT tier, COUNT(*) n FROM (
      SELECT source_id, target_id, kind, MAX(verification) tier
      FROM edge_evidence GROUP BY source_id, target_id, kind
    ) GROUP BY tier ORDER BY tier
  `).all()
  const out = {}
  for (const r of rows) out[r.tier] = Number(r.n)
  return out
}

export function counts(db) {
  const files = db.prepare("SELECT COUNT(*) n FROM indexed_files").get()?.n
    ?? db.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get().n
  const nodes = db.prepare("SELECT COUNT(*) n FROM nodes").get().n
  const edges = db.prepare("SELECT COUNT(*) n FROM edges").get().n
  const unresolved = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind LIKE 'UNRESOLVED%'").get().n
  return { files, nodes, edges, unresolved }
}

// Token estimate. Default heuristic is chars/4 (close to cl100k for source). The exact
// tokenizer barely matters here because we report a RATIO (graph vs baseline) with the SAME
// estimator on both sides. Set BENCH_CHARS_PER_TOKEN to tune, or wire a real tokenizer.
export function estimateTokens(text, charsPerToken = Number(process.env.BENCH_CHARS_PER_TOKEN) || 4) {
  if (!text) return 0
  return Math.ceil(text.length / charsPerToken)
}

// Precision / recall / F1 over two sets of "caller\tcallee" edge strings.
export function prf(genSet, gtSet) {
  let tp = 0
  for (const e of genSet) if (gtSet.has(e)) tp++
  const fp = genSet.size - tp
  const fn = gtSet.size - tp
  const precision = genSet.size ? tp / genSet.size : (gtSet.size ? 0 : 1)
  const recall = gtSet.size ? tp / gtSet.size : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { tp, fp, fn, precision, recall, f1 }
}
