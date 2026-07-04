// End-to-end token comparison with the LIVE model (LM Studio). For each question, send the
// same query to qwen twice and record the model's REAL prompt tokens (usage.prompt_tokens):
//   WITH graph    = context = the compiler's slice for the symbol.
//   WITHOUT graph = context = the top-K files a grep surfaces (what a graph-less agent reads).
// This measures the context cost each strategy delivers to the real model + whether the model
// can actually answer from it. (A full agentic loop would amplify the no-graph cost further via
// iterative grep->read->grep turns; this is the single-shot lower bound.)
//
// Usage: node e2e_lmstudio.mjs --root <repo> --cli <cli.js> [--model qwen/qwen3.6-35b-a3b]
//        [--endpoint http://localhost:1234/v1] [--sliceMaxTokens 4000] [--readK 3] [--out r.json]
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true }
const ROOT = arg("root"), CLI = arg("cli")
const MODEL = arg("model", "qwen/qwen3.6-35b-a3b")
const ENDPOINT = arg("endpoint", "http://localhost:1234/v1")
const SLICE_MT = String(arg("sliceMaxTokens", 4000))
const READK = Number(arg("readK", 3))
const BASE_CHAR_CAP = 240000 // ~60k tokens ceiling so prompt eval stays bounded
const OUT = arg("out", null)
if (!ROOT || !CLI) { console.error("required: --root <repo> --cli <cli.js>"); process.exit(2) }
const NODE = process.execPath
const DB = path.join(os.tmpdir(), `tokens-bench-${path.basename(ROOT)}.sqlite`)
if (!fs.existsSync(DB)) { console.error("indexing (one-time)..."); spawnSync(NODE, [CLI, "index", "--root", ROOT, "--db", DB], { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 }) }

// realistic questions about SQLAlchemy + the symbol a grep-first agent would search on
const QUESTIONS = [
  { q: "What does create_engine do and what object does it return?", term: "create_engine" },
  { q: "How does sessionmaker configure and produce Session objects?", term: "sessionmaker" },
  { q: "What is relationship() used for and what does it return?", term: "relationship" },
  { q: "How does declarative_base build a base class for models?", term: "declarative_base" },
]

// read all source once for the baseline grep+read
const contents = new Map()
;(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === ".git" || e.name === "node_modules") continue
  const p = path.join(d, e.name)
  if (e.isDirectory()) walk(p); else if (/\.py$/.test(e.name)) { try { contents.set(p, fs.readFileSync(p, "utf8")) } catch {} }
} })(ROOT)

function graphContext(term) {
  const r = spawnSync(NODE, [CLI, "slice", "--root", ROOT, "--db", DB, "--query", term, "--max-tokens", SLICE_MT],
    { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  return r.stdout || ""
}
function baselineContext(term) {
  const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")
  const hits = []
  for (const [f, text] of contents) { const m = text.match(re); if (m) hits.push({ f, count: m.length, text }) }
  hits.sort((a, b) => b.count - a.count)
  let out = "", used = 0
  for (const h of hits.slice(0, READK)) {
    const header = `\n\n===== ${path.relative(ROOT, h.f).replaceAll("\\", "/")} =====\n`
    if (used + header.length + h.text.length > BASE_CHAR_CAP) break
    out += header + h.text; used += header.length + h.text.length
  }
  return { context: out, matchingFiles: hits.length }
}

const SYSTEM = "You are a code assistant. Answer the question using ONLY the provided context. Be concise (2-4 sentences). If the context is insufficient, say so."
async function ask(context, question) {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 700,
      messages: [{ role: "system", content: SYSTEM },
                 { role: "user", content: `${context}\n\n---\nQuestion: ${question}` }] }),
  })
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { promptTokens: j.usage?.prompt_tokens, completionTokens: j.usage?.completion_tokens,
    answer: j.choices?.[0]?.message?.content?.trim() }
}

const rows = []
let sg = 0, sb = 0
for (const { q, term } of QUESTIONS) {
  console.error(`\nQ: ${q}`)
  const gCtx = graphContext(term)
  const b = baselineContext(term)
  const g = await ask(gCtx, q)
  const n = await ask(b.context, q)
  sg += g.promptTokens || 0; sb += n.promptTokens || 0
  const reduction = n.promptTokens ? +(100 * (1 - g.promptTokens / n.promptTokens)).toFixed(1) : null
  console.error(`  WITH graph:    ${g.promptTokens} prompt tok  ->  ${(g.answer || "").slice(0, 90)}`)
  console.error(`  WITHOUT graph: ${n.promptTokens} prompt tok (${b.matchingFiles} files match, read ${READK})`)
  console.error(`  reduction: ${reduction}%`)
  rows.push({ question: q, term, matchingFiles: b.matchingFiles,
    graphPromptTokens: g.promptTokens, baselinePromptTokens: n.promptTokens, reductionPct: reduction,
    graphAnswer: g.answer, baselineAnswer: n.answer,
    graphCompletionTokens: g.completionTokens, baselineCompletionTokens: n.completionTokens })
}

const report = { model: MODEL, sliceMaxTokens: Number(SLICE_MT), readK: READK,
  totals: { graphPromptTokens: sg, baselinePromptTokens: sb,
    reductionPct: sb ? +(100 * (1 - sg / sb)).toFixed(1) : null,
    avgGraph: Math.round(sg / QUESTIONS.length), avgBaseline: Math.round(sb / QUESTIONS.length) },
  perQuestion: rows }
console.error("\n=== END-TO-END (real qwen prompt tokens) ===")
console.error(`graph total ${sg}  |  baseline total ${sb}  |  reduction ${report.totals.reductionPct}%`)
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`wrote ${OUT}`) }
