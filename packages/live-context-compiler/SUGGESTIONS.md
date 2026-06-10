# Live Context Compiler — Scale & Cost Optimization Suggestions

## Table of Contents

1. [Read-to-Use Parts (Don't Build From Scratch)](#1-ready-to-use-parts-dont-build-from-scratch)
2. [Architecture Decisions With Tradeoffs](#2-architecture-decisions-with-tradeoffs)
3. [High-Impact Changes (Implementation Details)](#3-high-impact-changes-implementation-details)
4. [Medium-Impact Changes](#4-medium-impact-changes)
5. [Cost Reduction for LLM Usage](#5-cost-reduction-for-llm-usage)
6. [Recommended Priority Order](#6-recommended-priority-order)

---

## 1. Ready-to-Use Parts (Don't Build From Scratch)

### 1.1 tree-sitter — AST parsing for 40+ languages (THE replacement for TS Compiler API)

**What**: An incremental parser generator that builds CSTs (concrete syntax trees). Written in C, bindings for Node.js/Rust/Python. Powers GitHub's code navigation, Neovim, Zed, etc.

**Why switch from TypeScript Compiler API**:

| Factor | TypeScript Compiler API | tree-sitter |
|---|---|---|
| Speed | ~10-50x slower for pure structure | **10-50x faster** |
| Memory | High (loads full type graph) | **Low** (CST only) |
| Languages | TS/JS only | **40+ languages** |
| Error tolerance | Fails on syntax errors | **Recovers gracefully** |
| Incremental | Manual (no built-in) | **Built-in incremental** |
| Type info | Yes (full type resolution) | No (syntax only) |

**Tradeoff**: tree-sitter gives you structure, not types. For a context-slice compiler, structure is 90% of what you need (calls, imports, references, definitions). Types only matter for overload resolution and polymorphic dispatch — both edge cases for context slicing.

**npm packages**: `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`, `web-tree-sitter` (WASM)

**Implementation**:
```ts
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);
const tree = parser.parse(sourceCode);
// Walk tree.rootNode to extract functions, classes, calls, imports
// tree-sitter query language: (call_expression) @call
```

### 1.2 CodeGraph (@colbymchenry/codegraph) — Pre-built MCP code intelligence server

**What**: A complete open-source CLI + MCP server that already does exactly what this project aims to build. Uses tree-sitter + SQLite + FTS5. 45k+ GitHub stars, MIT license.

**Benchmarks** (from their docs, verified across 7 real repos):
- **35% cheaper** API costs
- **59% fewer tokens** consumed
- **49% faster** wall-clock time
- **70% fewer tool calls**

**Architecture**:
```
files → ExtractionOrchestrator (tree-sitter) → SQLite (nodes/edges/files with FTS5)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
              ↓
       MCP Server (codegraph_context, codegraph_explore tools)
```

**Recommendation**: **Evaluate using CodeGraph as a dependency** instead of building from scratch. It already supports:
- 19+ languages
- Caller/callee/impact analysis
- Diff impact analysis (git-aware)
- Framework pattern matching
- MCP protocol
- File watcher with cooldown

If you need something custom, the CodeGraph architecture is an excellent reference implementation. The author (Colby McHenry) is actively developing and responsive.

**npm**: `@colbymchenry/codegraph`

### 1.3 SCIP Protocol — Standardized code indexing format

**What**: Sourcegraph's language-agnostic protobuf format for code intelligence. Used by `rust-analyzer`, `scip-typescript`, `scip-python`, `scip-java`, and more.

**Why consider**: Adopting SCIP as your storage format means:
- Interoperability with Sourcegraph, Glean, Searchfox
- Language indexers already exist for 10+ languages
- Stable protobuf schema with Go/Rust/TS bindings

**Tradeoff**: SCIP is designed for "go to definition / find references" — not for context-slice compilation. You'd need an additional layer on top to build the task-specific slices.

**GitHub**: `github.com/scip-code/scip`

### 1.4 GitHub Stack-Graphs — File-incremental name resolution

**What**: An extension of scope graphs for name resolution at GitHub scale. Every file produces an isolated subgraph. Resolution is path-finding across files.

**Key insight** (from their paper): "For each source file, we create an isolated subgraph without any knowledge of, or visibility into, any other file in the program. This lets us eliminate the storage and compute costs of reanalyzing file versions that we have already seen."

**Rust crate**: `stack-graphs` (Rust only, no Node.js binding)

**Recommendation**: Study the paper for architecture ideas. Don't use directly (Rust-only, complex). The key idea — **file-incremental subgraphs** — should inform your data model.

**Paper**: arXiv:2211.01224

### 1.5 SQLite + FTS5 — Graph storage (already using, but optimize)

**What you have**: SQLite via `node:sqlite` (experimental, Node 22+).

**What to change**:

| From | To | Reason |
|---|---|---|
| `node:sqlite` (experimental) | `better-sqlite3` | Production-hardened, 5-10x faster, works on all Node versions |
| Single-row inserts | Multi-row `INSERT INTO ... VALUES (...), (...)` | ~10-50x write throughput |
| Individual transactions per node | One `BEGIN/COMMIT` per file | ~100x fewer transaction commits |
| `LIKE %query%` | FTS5 virtual table | Sub-ms lookup at any scale |
| Default page cache | `PRAGMA cache_size = -64000` (64MB) | Avoid page thrashing on large graphs |
| WAL mode (already set) | Keep WAL + add `PRAGMA synchronous = NORMAL` | Faster writes without durability loss |

**FTS5 implementation**:
```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id UNINDEXED, name, signature, file_path,
  content='nodes', content_rowid='rowid'
);

CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, signature, file_path)
  VALUES (new.rowid, new.name, new.signature, new.file_path);
END;

-- Query:
SELECT n.* FROM nodes n
JOIN nodes_fts ON n.rowid = nodes_fts.rowid
WHERE nodes_fts MATCH ? ORDER BY rank;
```

### 1.6 Node.js Worker Threads — CPU-bound parallelization

**Already built-in** (Node 12+), zero dependencies.

**Pattern for parallel indexing**:
```ts
// Main thread: partition files and dispatch
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

const workers = cpus().length - 1; // leave 1 for main thread
const batches = partitionFiles(allFiles, workers);
const results = await Promise.all(
  batches.map(batch => {
    return new Promise((resolve, reject) => {
      const worker = new Worker("./dist/index-worker.js");
      worker.postMessage({ files: batch, root });
      worker.on("message", resolve);
      worker.on("error", reject);
    });
  })
);
// Merge results into SQLite
```

---

## 2. Architecture Decisions With Tradeoffs

### 2.1 tree-sitter vs TypeScript Compiler API

| Criterion | tree-sitter | TS Compiler API |
|---|---|---|
| **Speed** | ~1000 files/sec per core | ~50 files/sec per core |
| **Type info** | None | Full |
| **Error tolerance** | Excellent | Poor |
| **Languages** | 40+ | TS/JS only |
| **Incremental** | Built-in | Manual |
| **NPM size** | ~5MB (WASM) | ~50MB+ |
| **Memory per 100k files** | ~200MB | ~4GB+ |
| **Cross-file resolution** | Manual (you build it) | Built-in via Program |

**Verdict**: **Start with tree-sitter**. Reserve TS Compiler API for a "precise mode" that runs only when you need type-resolution (e.g., for specific files in a slice). The 10-50x speed difference is decisive for large codebases.

### 2.2 Build vs Integrate CodeGraph

**Build from scratch**:
- + Full control over schema, edges, policies
- + Can optimize for your specific use case
- - Months of work
- - Need to maintain language parsers, MCP server, etc.

**Use CodeGraph as library**:
- + Immediate: tree-sitter parsing, SQLite+FTS5, MCP server, 19 languages
- + Active maintenance, 45k+ GitHub stars
- - Uses its own schema (may not match your TraversalPolicy model)
- - Dependency on external package

**Hybrid (recommended)**:
1. Use CodeGraph for the indexing layer (tree-sitter → SQLite)
2. Write your own traversal/context-builder on top of its SQLite schema
3. Extend with your specific ContextSlice/TraversalPolicy models
4. Contribute improvements back upstream

### 2.3 In-process SQLite vs Standalone graph DB

| Criterion | SQLite | PostgreSQL | Neo4j |
|---|---|---|---|
| Setup | Zero | Server process | Server process |
| Latency | ~microseconds | ~milliseconds | ~milliseconds |
| Throughput | ~100k writes/s | ~10k writes/s | ~5k writes/s |
| Graph queries | Manual (recursive CTEs) | Manual (recursive CTEs) | Native (Cypher) |
| Embeddable | Yes | No | No |
| Backup | Copy file | pg_dump | Export |

**Verdict**: SQLite is correct for this use case. The requirements plan says "Do not introduce Neo4j until SQLite/PostgreSQL traversal becomes a measured bottleneck" — this is the right call.

---

## 3. High-Impact Changes (Implementation Details)

### 3.1 Parallel Indexing with Worker Pool

**Problem**: `indexAll()` processes files sequentially. For 100k files at ~50ms each, that's 5000 seconds (1.4 hours).

**Solution**: Worker thread pool with file batching.

**Implementation sketch** (`src/indexer-pool.ts`):
```ts
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { GraphStore } from "./db.js";

const POOL_SIZE = Math.max(1, cpus().length - 1);

export async function indexParallel(root: string, store: GraphStore): Promise<void> {
  const files = await fg(["**/*.ts", "**/*.tsx"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**"],
    absolute: true
  });
  
  // Batch into chunks for each worker
  const chunkSize = Math.ceil(files.length / POOL_SIZE);
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    batches.push(files.slice(i, i + chunkSize));
  }

  // Spawn workers and collect results
  const results = await Promise.all(batches.map((batch, i) => {
    return new Promise<WorkerResult>((resolve, reject) => {
      const worker = new Worker(path.resolve("dist/index-worker.js"), {
        workerData: { batch, root }
      });
      worker.on("message", resolve);
      worker.on("error", reject);
      worker.on("exit", code => {
        if (code !== 0) reject(new Error(`Worker ${i} exited with code ${code}`));
      });
    });
  }));

  // Merge: batch insert all results
  store.batchInsert(results.flatMap(r => r.nodes), results.flatMap(r => r.edges));
}
```

### 3.2 Content-Hash Node IDs

**Problem**: Current IDs `filePath::kind::name::startLine` break on any line shift, preventing real incremental updates.

**Solution**: `contentHash(kind + name + filePath + context)` as the primary key.

```ts
function stableNodeId(kind: NodeKind, name: string, filePath: string, context: string): string {
  const hash = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(name)
    .update("\0")
    .update(filePath)
    .update("\0")
    .update(context.slice(0, 100)) // enough to disambiguate overloads
    .digest("hex")
    .slice(0, 16); // 64-bit collision resistance is enough
  return `${kind}:${hash}`;
}
```

**Benefits**:
- Stable across line edits, refactors, formatting changes
- Enables edge-granular diffing (compare old vs new node IDs)
- Predictable: same code → same IDs across machines

### 3.3 Edge-Granular Incremental Updates

**Problem**: `clearFile()` deletes ALL nodes from a file on every change. A 2-line edit triggers full re-index.

**Solution**: Compare old vs new node hashes per file, update only what changed.

```ts
indexFile(absPath: string): void {
  const rel = path.relative(this.root, absPath);
  const text = fs.readFileSync(absPath, "utf8");
  const digest = sha256(text);
  
  const oldHash = this.store.indexedHash(rel);
  if (oldHash === digest) return; // unchanged
  
  const oldNodeIds = this.store.getNodeIdsForFile(rel); // NEW query
  const newNodes = this.parseNodes(rel, text, digest);
  const newNodeIds = new Set(newNodes.map(n => n.id));
  
  // Delete removed nodes (and their edges cascade)
  for (const oldId of oldNodeIds) {
    if (!newNodeIds.has(oldId)) {
      this.store.deleteNode(oldId); // cascades to edges
    }
  }
  
  // Upsert new/modified nodes
  for (const node of newNodes) {
    this.store.upsertNode(node);
  }
  
  // Edge diffing happens via cascade + re-insert
  const newEdges = this.parseEdges(rel, source, digest);
  for (const edge of newEdges) {
    this.store.upsertEdge(edge);
  }
  
  this.store.markIndexed(rel, digest);
}
```

### 3.4 Context Budget Optimizer

**Problem**: Rendering full source for every node in a slice can exceed LLM context windows (especially for large slices).

**Solution**: Rank nodes by relevance, truncate low-value source excerpts.

```ts
interface BudgetConfig {
  maxTokens: number;          // 32k, 64k, 128k etc.
  nodePriority: NodeKind[];   // higher priority first
  maxLinesPeripheral: number; // how many lines for low-priority nodes
}

function renderSlice(root: string, slice: ContextSlice, budget: BudgetConfig): string {
  const sorted = prioritizeNodes(slice.nodes, slice.edges, budget.nodePriority);
  
  let totalTokens = 0;
  const rendered: string[] = [];
  
  for (const node of sorted) {
    const source = extractSource(root, node);
    const tokens = estimateTokens(source);
    
    if (totalTokens + tokens <= budget.maxTokens) {
      rendered.push(formatNode(node, source));
      totalTokens += tokens;
    } else {
      // Truncate: show only signature + first N lines
      const truncated = truncateSource(source, budget.maxLinesPeripheral, node.signature);
      rendered.push(formatNode(node, truncated));
      totalTokens += estimateTokens(truncated);
    }
  }
  
  return rendered.join("\n");
}
```

**Token savings**: ~30-70% depending on slice complexity.

### 3.5 Batch SQLite Writes

**Problem**: Each `upsertNode` + `upsertEdge` is a separate SQLite call.

**Solution**: Multi-row inserts within explicit transactions.

```ts
batchInsert(nodes: CodeNode[], edges: CodeEdge[]): void {
  this.db.exec("BEGIN");
  try {
    // Multi-row node insert
    if (nodes.length > 0) {
      const placeholders = nodes.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(",");
      const values = nodes.flatMap(n => [
        n.id, n.kind, n.name, n.filePath, n.startLine, n.endLine,
        n.signature ?? null, n.contentHash ?? null
      ]);
      this.db.prepare(`
        INSERT OR REPLACE INTO nodes 
        (id, kind, name, file_path, start_line, end_line, signature, content_hash)
        VALUES ${placeholders}
      `).run(...values);
    }
    
    // Similar for edges
    if (edges.length > 0) {
      // ...
    }
    
    this.db.exec("COMMIT");
  } catch (e) {
    this.db.exec("ROLLBACK");
    throw e;
  }
}
```

---

## 4. Medium-Impact Changes

### 4.1 Two-Pass Lazy Indexing

**Problem**: Full TS Compiler API parsing of 100k files is prohibitive.

**Solution**:
- **Pass 1** (always): tree-sitter parsing for structure (imports, exports, function/class definitions, call sites). ~1000 files/sec.
- **Pass 2** (on-demand): TypeScript Compiler API only for files that will be rendered in a context slice.

```ts
class TwoPassIndexer {
  async indexFast(root: string): Promise<void> {
    // tree-sitter: extract symbols + edges (no type info)
  }
  
  async deepenForSlice(slice: ContextSlice): Promise<void> {
    // TS Compiler API: only for files in the slice
    const files = [...new Set(slice.nodes.map(n => n.filePath))];
    const program = ts.createProgram(files, { /* options */ });
    // Enhance edges with type info
  }
}
```

### 4.2 Plugin Architecture for Language Support

**Problem**: Currently hardcoded to TypeScript.

**Solution**: `LanguageIndexer` interface.

```ts
interface LanguageIndexer {
  language: string;
  filePatterns: string[];
  parseFile(filePath: string, text: string): ParseResult;
}

interface ParseResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

class IndexerOrchestrator {
  private indexers: LanguageIndexer[] = [];
  
  register(indexer: LanguageIndexer): void {
    this.indexers.push(indexer);
  }
  
  indexFile(absPath: string): void {
    const ext = path.extname(absPath);
    const indexer = this.indexers.find(i => i.filePatterns.includes(ext));
    if (indexer) {
      const text = fs.readFileSync(absPath, "utf8");
      const result = indexer.parseFile(absPath, text);
      this.store.batchInsert(result.nodes, result.edges);
    }
  }
}
```

### 4.3 SQLite Connection Pooling (for concurrent reads)

**Problem**: The single `DatabaseSync` instance means concurrent slice compilation blocks on DB reads.

**Solution**: WAL mode already supports concurrent readers. Use a read pool.

```ts
class GraphStorePool {
  private writer: GraphStore;  // single writer
  private readers: GraphStore[]; // pool of readers
  private rrIndex = 0;
  
  constructor(dbPath: string, poolSize = 4) {
    this.writer = new GraphStore(dbPath);
    this.readers = Array.from({ length: poolSize }, () => {
      const store = new GraphStore(dbPath);
      store.db.exec("PRAGMA query_only = ON;");
      return store;
    });
  }
  
  query(callback: (store: GraphStore) => unknown): unknown {
    const reader = this.readers[this.rrIndex++ % this.readers.length];
    return callback(reader);
  }
  
  write(callback: (store: GraphStore) => unknown): unknown {
    return callback(this.writer);
  }
}
```

### 4.4 Fix: Namespace-based Contract Extraction

**Problem**: `extractContracts` combines Express routes, fetch calls, and event emits into one regex method. This is fragile and misses framework-specific patterns.

**Solution**: Registered extractors per framework.

```ts
interface ContractExtractor {
  extract(text: string, fileNodeId: string): { nodes: CodeNode[]; edges: CodeEdge[] };
}

class ExpressExtractor implements ContractExtractor {
  extract(text: string, fileNodeId: string) {
    // Pattern: router.get('/path', handler) or app.post('/path', handler)
    // Benefits: captures handler function name, path params, middleware chain
  }
}

class FastifyExtractor implements ContractExtractor {
  // Similar but handles Fastify's schema-based route declarations
}
```

### 4.5 FTS5-Based Symbol Search (replace LIKE)

```sql
-- Migration: add FTS5 table
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id UNINDEXED,
  name,
  signature,
  file_path,
  content=nodes,
  tokenize='unicode61 remove_diacritics 2'
);

-- Trigger: keep FTS in sync
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, signature, file_path)
  VALUES (new.rowid, new.id, new.name, new.signature, new.file_path);
END;

CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, signature, file_path)
  VALUES ('delete', old.rowid, old.id, old.name, old.signature, old.file_path);
END;

-- Query (instead of LIKE %query%):
store.findNodes(query: string): CodeNode[] {
  return this.db.prepare(`
    SELECT n.* FROM nodes n
    JOIN nodes_fts fts ON n.rowid = fts.rowid
    WHERE nodes_fts MATCH ?
    ORDER BY rank
    LIMIT 20
  `).all(query);
}
```

---

## 5. Cost Reduction for LLM Usage

### 5.1 Diff-Aware Context Rendering

When the slice includes modified files (the "edit" use case), render only the **diff hunks** + their surrounding context instead of the whole file.

```ts
function renderWithDiff(root: string, slice: ContextSlice, gitDiff: string): string {
  const changedLines = parseChangedLines(gitDiff);
  
  for (const node of slice.nodes) {
    if (changedLines.has(node.filePath)) {
      // Render only the diff context
      const diffHunks = getDiffHunks(changedLines.get(node.filePath));
      yield formatNodeWithDiff(node, diffHunks);
    } else {
      // Render full source
      yield formatNode(node, extractSource(root, node));
    }
  }
}
```

**Token savings on edit tasks**: 40-80%.

### 5.2 Signature-Only for Peripheral Nodes

For nodes at depth 3+ (or with low relevance scores), show only the signature line, not the full body.

```ts
function formatNode(node: CodeNode, source: string, isPeripheral: boolean): string {
  if (isPeripheral && node.signature) {
    return `### ${node.kind}: ${node.name}\n\`\`\`ts\n${node.signature}\n\`\`\``;
  }
  return `### ${node.kind}: ${node.name}\n\`\`\`ts\n${source}\n\`\`\``;
}
```

### 5.3 Relevance-Prioritized Slice Sorting

Not all nodes in a slice are equally important. Sort by:
1. **Depth** (closer to entry = more relevant)
2. **Edge kind** (CALLS > REFERENCES > CONTAINS)
3. **Degree** (highly connected nodes are more important)

```ts
function prioritizeNodes(nodes: CodeNode[], edges: CodeEdge[], entryIds: Set<string>): CodeNode[] {
  const relevance = new Map<string, number>();
  
  for (const node of nodes) {
    let score = 0;
    if (entryIds.has(node.id)) score += 100;
    const incomingEdges = edges.filter(e => e.targetId === node.id);
    const outgoingEdges = edges.filter(e => e.sourceId === node.id);
    score += incomingEdges.length * 2; // more callers = more relevant
    score += outgoingEdges.length;     // more callees = more context
    relevance.set(node.id, score);
  }
  
  return [...nodes].sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0));
}
```

### 5.4 Token Budget Enforcement

Add strict enforcement to prevent the rendered slice from exceeding the model's context window.

```ts
class TokenBudget {
  private budget: number;
  private used = 0;
  
  constructor(maxTokens: number) { this.budget = maxTokens; }
  
  tryAllocate(text: string): boolean {
    const tokens = estimateTokens(text);
    if (this.used + tokens > this.budget) return false;
    this.used += tokens;
    return true;
  }
}

// Estimate tokens as ~4 chars per token (general LLM heuristic)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

---

## 6. Recommended Priority Order

For the stated goal of "extremely large codebases, lower cost, improved performance":

### Immediate (this week)

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Replace `node:sqlite` with `better-sqlite3` | 1 hour | 5-10x faster DB |
| 2 | Batch SQLite writes per file (BEGIN/COMMIT) | 2 hours | 10-50x write throughput |
| 3 | Add FTS5 for symbol search | 4 hours | 100-1000x faster lookup |
| 4 | Fix: remove SQLite WAL/SHM from version control | 5 min | Clean repo |
| 5 | Content-hash node IDs | 4 hours | Enables all incremental work |

### Short-term (this sprint)

| # | Change | Effort | Impact |
|---|---|---|---|
| 6 | tree-sitter replaces TS Compiler API for indexing | 2-3 days | 10-50x faster parsing, multi-language |
| 7 | Context budget optimizer with relevance ranking | 2 days | 30-70% token reduction |
| 8 | Worker thread pool for parallel indexing | 2 days | ~6-7x speedup on 8-core |
| 9 | Diff-aware rendering for edit tasks | 1 day | 40-80% token savings on edits |

### Medium-term (next sprint)

| # | Change | Effort | Impact |
|---|---|---|---|
| 10 | Edge-granular incremental updates | 3 days | ~100x faster for small edits |
| 11 | Two-pass lazy indexing (tree-sitter first, TS API on-demand) | 3 days | Memory reduction for large repos |
| 12 | Plugin architecture: LanguageIndexer interface | 2 days | Python/Rust/Go support |

### Long-term (next month)

| # | Change | Effort | Impact |
|---|---|---|---|
| 13 | MCP server integration | 5 days | Usable by Claude/Cursor/Codex |
| 14 | Runtime-confirmed edges (OpenTelemetry integration) | 5 days | Dynamic dispatch tracing |
| 15 | SCIP protocol export | 3 days | Interoperability with other tools |

---

## Appendix: Architecture Decision Record

### ADR-1: tree-sitter over TS Compiler API

**Decision**: Use tree-sitter as the primary indexer. Reserve TS Compiler API for a "precise mode" that can deepen specific files on demand.

**Context**: The TypeScript Compiler API is correct but slow (~50 files/sec). tree-sitter parses ~1000 files/sec per core and supports 40+ languages. For a context-slice compiler that needs to index entire repos, tree-sitter's speed and multi-language support are decisive.

**Consequence**: We lose type-level information (generic resolution, overload picking). This is acceptable because:
- 90% of context slicing needs structure (calls, imports, definitions)
- Type resolution is only needed for polymorphic dispatch cases
- A "deepen" mode can selectively apply TS Compiler API when needed

### ADR-2: SQLite over Graph Database

**Decision**: Stay with SQLite + recursive CTEs for graph traversal.

**Context**: SQLite handles million-node graphs efficiently with proper schema design. Graph databases add operational complexity (server process, backup, configuration) that is not justified until SQLite is proven insufficient.

**Consequence**: Graph queries are expressed as recursive CTEs instead of Cypher/Gremlin. This is slightly more verbose but equally expressive for bounded traversals.

### ADR-3: Content Hash IDs over Positional IDs

**Decision**: Use `sha256(kind + name + context) → 64-bit` as the node primary key.

**Context**: Position-based IDs (`filePath::kind::name::startLine`) change whenever a file is edited, even if the symbol itself is unchanged. This breaks incremental indexing and causes unnecessary cache invalidations.

**Consequence**: Slightly more complex ID generation, but enables stable node identities across edits, true incremental updates, and deterministic deduplication.
