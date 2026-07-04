# CodeWeave Benchmark — accuracy · speed · tokens

A self-contained harness that measures the Live Context Compiler three ways:

1. **Accuracy** — precision / recall / F1 against **labeled ground truth** (the PyCG micro-benchmark).
2. **Speed** — cold index, warm re-index, incremental edit, and query latency on a **dense repo** (SQLAlchemy).
3. **Tokens** — how many tokens the model must ingest **with the graph** vs **without it** (grep + read whole files).

> **This harness does not run itself.** Launch it explicitly with `run.ps1`. It uses throwaway
> DBs in `%TEMP%` and never touches CodeWeave's own `.context-graph.sqlite`.

---

## Why these targets

| Need | Target | Why |
|---|---|---|
| Labeled accuracy | **PyCG micro-benchmark** (`vitsalis/PyCG`, 119 cases / 18 categories) | Hand-labeled call-graph ground truth from the ICSE'21 paper. It's a **different algorithm** than pyright/the TS compiler, so scoring against it is **not circular**. |
| Dense real repo | **SQLAlchemy** (669 `.py`, ~198k LOC in `lib/`) | Deeply interconnected, heavily typed → a fair, hard stress test for indexing speed and token savings. |

Both are cloned automatically (shallow) by `run.ps1`.

---

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File bench\run.ps1
```

Edit the `CONFIG` block at the top of `run.ps1` if your paths differ (Node, the compiler
`cli.js`, repo locations). Results are written to `bench\results\*.json` and printed to console.

Individual tracks:

```powershell
node bench\speed.mjs        --root <repo>  --cli <cli.js> --out speed.json
node bench\tokens.mjs       --root <repo>  --cli <cli.js> --topN 12 --readK 5 --out tokens.json
node bench\accuracy_pycg.mjs --snippets <PyCG>\micro-benchmark\snippets --cli <cli.js> --out acc.json
node bench\accuracy_pycg.mjs --snippets ... --cli ... --no-lsp   # tier-2 only, to isolate pyright's contribution
```

---

## What each metric means

### Accuracy (`accuracy_pycg.mjs`)
For each case: index the snippet folder, reconstruct the generated call/use graph as
fully-qualified `caller → callee` edges (module + CONTAINS scope path), and diff against the
checked-in `callgraph.json`.

- **precision** = matched / generated, **recall** = matched / ground-truth, **F1** = harmonic mean.
- Micro-averaged over all edges, plus per-category and a count of **perfect cases**.
- Runs twice: **LSP ON** (tier-4 pyright) and **LSP OFF** (tier-2 tree-sitter only) — the F1
  delta is pyright's contribution.
- Reference point: the PyCG paper itself reports ~99% precision / ~70% recall on this suite.

### Speed (`speed.mjs`)
- **coldIndexMs** — first full index (fresh DB).
- **warmReindexMs** — re-index with no changes (hash-skip path).
- **incrementalReindexMs** — touch one file, re-index, restore it (the everyday edit case).
- **graph** counts + **tier histogram** + **tier4Pct**.
- **sliceLatencyMs** — p50/p95/mean over N `slice` queries (random symbols from the graph).
- **filesPerSec / nodesPerSec** throughput.

### Tokens (`tokens.mjs`) — the headline comparison
For each query (default: the 12 most-referenced symbols in the graph):

- **graphTokens** — tokens in the compiler's `slice` output (the targeted context).
- **baselineReadK** — tokens a graph-less agent ingests: grep for the symbol, open the top-K
  files it surfaces, read them whole (`--readK`, default 5).
- **baselineAllMatches** — worst case: read *every* file that matches.
- **reductionVsReadKPct** — `1 − graph/baseline`. This is "how many tokens the graph saves."

Token counts use a `chars/N` estimate (default 4; set `BENCH_CHARS_PER_TOKEN`). Because we
report a **ratio** with the same estimator on both sides, the exact tokenizer barely matters.

---

## End-to-end token comparison (model-in-the-loop)

The `tokens.mjs` track measures the *static context size* each strategy delivers. To measure
the **actual prompt tokens the model consumes** answering the same question with vs without the
graph (what the user asked to "run against normal without graph"):

1. **With graph** — ask normally:
   ```powershell
   opencode run "In sqlalchemy, what does Session.execute call and how does it reach the engine?"
   ```
2. **Without graph** — disable the graph tools so the model must grep/read. Add to the repo's
   `.opencode/opencode.jsonc`:
   ```jsonc
   { "tools": { "context_compile": false, "context_expand": false, "context_status": false } }
   ```
   then run the same `opencode run "..."`.
3. **Read the token cost** of each run from either:
   - the opencode session record (`tokens.input` / `tokens.output`), or
   - LM Studio's server log line `prompt eval time = ... / N tokens` (the exact prompt size).

Run several questions both ways and compare `tokens.input`. Keep the model, question, and repo
identical between the two runs so the only variable is the graph.

---

## Optional: real-repo accuracy vs Jedi (`oracle_jedi.py` + `accuracy_oracle.mjs`)

PyCG gives labeled **precision**; this gives real-repo **recall** on SQLAlchemy using **Jedi**
(a different engine than pyright — non-circular). Enable it in `run.ps1` (`$RunOracle = $true`)
after `pip install jedi`.

It samples real call sites, resolves each callee's definition with Jedi, and checks whether the
compiler's graph has the matching `caller → def` edge (matched by file + line, `--tol` window).
On first run, if `unmappable def` is high, raise `--tol` — tree-sitter's def start line may sit
a constant offset from Jedi's.

---

## Honest caveats

- **Precision vs PyCG is a lower bound.** The compiler records Python calls as `REFERENCES`
  (a *use* graph — a superset of pure calls), so it emits some edges PyCG doesn't count as
  calls. Recall is unaffected; precision is understated. (TS/JS emit true `CALLS` edges.)
- **`external` / `dynamic` categories** exercise stdlib and dynamic dispatch that a static
  resolver intentionally leaves unresolved — low recall there is expected, not a regression.
- **Token counts are estimates** (`chars/N`), reported as ratios; wire a real tokenizer in
  `lib/graph.mjs → estimateTokens` if you need exact per-model counts.
- **The Jedi oracle needs first-run calibration** (`--tol`) and only measures recall.

---

## Files

| File | Role |
|---|---|
| `run.ps1` | Orchestrator — clones repos, runs every track, writes `results/`. **Launch this.** |
| `speed.mjs` | Indexing + query latency on the dense repo. |
| `tokens.mjs` | Graph vs no-graph token comparison. |
| `accuracy_pycg.mjs` | Labeled precision/recall/F1 vs PyCG. |
| `oracle_jedi.py` / `accuracy_oracle.mjs` | Optional real-repo recall vs an independent oracle. |
| `lib/graph.mjs` | Shared graph-DB reader, FQN reconstruction, token estimate, P/R/F1. |
