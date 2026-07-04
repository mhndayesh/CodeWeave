// Prefix-cache probe: does LM Studio reprocess the whole prompt every call, or reuse the KV
// cache for a shared prefix? Sends a big context, then re-sends it (identical, then extended),
// then sends a DIFFERENT context. If prefix caching works, the 2nd/3rd calls are much faster
// than the 1st and the 4th (fresh) — proving the big context is prefilled ONCE, then reused.
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true }
const ROOT = arg("root"), CLI = arg("cli")
const MODEL = arg("model", "qwen/qwen3.6-35b-a3b")
const ENDPOINT = arg("endpoint", "http://localhost:1234/v1")
const NODE = process.execPath
const DB = path.join(os.tmpdir(), `tokens-bench-${path.basename(ROOT)}.sqlite`)

function slice(term, mt) {
  return spawnSync(NODE, [CLI, "slice", "--root", ROOT, "--db", DB, "--query", term, "--max-tokens", String(mt)],
    { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).stdout || ""
}
async function call(messages, label) {
  const t = process.hrtime.bigint()
  const res = await fetch(`${ENDPOINT}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 4, messages }) })
  const j = await res.json()
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  const pt = j.usage?.prompt_tokens
  console.error(`  ${label.padEnd(34)} ${Math.round(ms).toString().padStart(7)} ms   prompt_tokens=${pt}`)
  return { ms, pt }
}

const ctxA = slice("relationship", 1000)   // ~moderate context
const ctxB = slice("create_engine", 1000)  // a DIFFERENT context (no shared prefix)
const SYS = "You answer in one word."
const mA = [{ role: "system", content: SYS }, { role: "user", content: ctxA + "\n\nReply: ok" }]
const mA2 = [...mA, { role: "assistant", content: "ok" }, { role: "user", content: "Reply again: ok" }]
const mB = [{ role: "system", content: SYS }, { role: "user", content: ctxB + "\n\nReply: ok" }]

console.error("Prefix-cache probe (each call max_tokens=4, so timing ~= prompt processing):\n")
const r1 = await call(mA, "1. context A (cold prefill)")
const r2 = await call(mA, "2. context A again (identical)")
const r3 = await call(mA2, "3. context A + appended turn")
const r4 = await call(mB, "4. context B (different -> cold)")

console.error("\nInterpretation:")
const cached = r2.ms < r1.ms * 0.4
console.error(`  call#2 / call#1 = ${(r2.ms / r1.ms).toFixed(2)}  -> ${cached ? "CACHE REUSED (identical prefix ~instant)" : "NO reuse (reprocessed)"}`)
console.error(`  call#3 / call#1 = ${(r3.ms / r1.ms).toFixed(2)}  -> appended-turn cost`)
console.error(`  call#4 ~ call#1 (${(r4.ms / r1.ms).toFixed(2)}x) confirms a fresh context pays full prefill again`)
