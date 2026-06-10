# BLUEPRINT V1 — Live Context Compiler

> **Goal**: A live repository intelligence service that compiles task-specific context slices for LLMs from deterministic code relationships. Reduce token usage, tool calls, and latency vs blind grep/read exploration.
>
> **Target**: Extremely large codebases (100k+ files, 1M+ LOC). Multi-language. Sub-second slice retrieval.

---

## Table of Contents

1. [Project Architecture](#1-project-architecture)
2. [Data Model — Extended](#2-data-model--extended)
3. [Parsing & Indexing Pipeline](#3-parsing--indexing-pipeline)
4. [Graph Storage Schema](#4-graph-storage-schema)
5. [Traversal & Context Compilation](#5-traversal--context-compilation)
6. [Rendering & Token Budget](#6-rendering--token-budget)
7. [Ready-to-Use Parts](#7-ready-to-use-parts)
8. [Implementation Phases](#8-implementation-phases)
9. [Benchmarking Strategy](#9-benchmarking-strategy)
10. [Architecture Decision Records](#10-architecture-decision-records)
11. [Current Code Audit](#11-current-code-audit)

---

## 1. Project Architecture

### High-Level Pipeline

```
                                    ┌──────────────────────────┐
                                    │   File Watcher (chokidar) │
                                    │   incremental on save     │
                                    └─────┬────────────────────┘
                                          │ changed files
                                          ▼
┌─────────────┐  files  ┌──────────────────────────────────────┐
│ Repo on disk ├────────►│  Indexer Orchestrator               │
└─────────────┘         │  ┌─────────┐ ┌────────┐ ┌────────┐  │
                         │  │ TS/JS   │ │ Python │ │ Rust   │  │
                         │  │indexer  │ │indexer │ │indexer │  │
                         │  └────┬────┘ └───┬────┘ └───┬────┘  │
                         │       │           │           │      │
                         │  ┌────▼───────────▼───────────▼──┐   │
                         │  │  Deterministic Graph Builder  │   │
                         │  │  (dedup, merge, resolve)      │   │
                         │  └───────────────┬──────────────┘   │
                         └──────────────────┼──────────────────┘
                                            │ nodes + edges
                                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     Graph Store (SQLite + FTS5)               │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────────────┐  │
│  │ nodes   │  │ edges   │  │ files   │  │ nodes_fts (FTS)│  │
│  └─────────┘  └─────────┘  └─────────┘  └────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ query
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Context Compiler                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Traversal    │  │ Budget       │  │ Slice Renderer    │  │
│  │ Engine (BFS) │  │ Optimizer    │  │ (markdown/JSON)   │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ context slice
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  MCP Server  ◄─────►  AI Agent (Claude/Cursor/Codex)       │
│  (Model Context Protocol)                                     │
│  Tools: find_symbols, get_callers, slice_for_edit, etc.     │
└──────────────────────────────────────────────────────────────┘
```

### Layer Diagram

```
                    ┌─────────────────────────────────┐
  Layer 6: Agent    │  MCP Server / Tools             │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 5: Slice    │  Context Compiler + Renderer    │
                    │  (budget enforcement, diff mode) │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 4: Traversal│  Policy Engine (BFS, depth-ltd) │
                    │  + Semantic Dependency Slicer    │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 3: Storage  │  Graph Store (SQLite + FTS5)    │
                    │  + Connection Pool              │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 2: Graph    │  Deterministic Graph Builder    │
                    │  (dedup, cross-file resolution)  │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 1: Parse    │  Language-specific Indexers     │
                    │  (tree-sitter, TS API, plugin)   │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
  Layer 0: Observe  │  File Watcher + Git Hooks       │
                    │  + OTel Runtime Importer         │
                    └─────────────────────────────────┘
```

---

## 2. Data Model — Extended

### 2.1 Node Kinds (25+ types across 6 families)

```typescript
// ─── Structural ───────────────────────────────────────────
type StructuralNodeKind =
  | "file"
  | "module"
  | "namespace"
  | "package";

// ─── Declarations ────────────────────────────────────────
type DeclarationNodeKind =
  | "function"       // top-level function
  | "method"         // class/object method
  | "class"
  | "interface"
  | "type"           // type alias
  | "enum"
  | "enum_member"
  | "property"       // class/interface property
  | "field"          // struct/record field
  | "variable"       // const/let/var
  | "parameter"
  | "constructor"
  | "getter"
  | "setter"
  | "operator";

// ─── Contract / Framework ────────────────────────────────
type ContractNodeKind =
  | "route"          // API endpoint
  | "middleware"
  | "db_table"
  | "db_column"
  | "graphql_type"
  | "graphql_field"
  | "event";

// ─── Configuration ───────────────────────────────────────
type ConfigNodeKind =
  | "config_key"
  | "env_var"
  | "feature_flag"
  | "secret";

// ─── External / Dynamic ──────────────────────────────────
type ExternalNodeKind =
  | "external_function"
  | "external_module"
  | "dynamic_target"  // runtime-resolved target
  | "placeholder";    // unresolved, pending confirmation

// ─── Documentation ───────────────────────────────────────
type DocNodeKind =
  | "doc_comment"
  | "specification"
  | "example"
  | "rationale";
```

### 2.2 Edge Kinds — 7-Layer Hierarchy (100+ types)

```typescript
// ─── Layer 0: Structural (containment) ───────────────────
// Edges: file → function, class → method, module → export
"CONTAINS" | "DECLARES" | "DEFINES" | "BELONGS_TO" |
"NESTED_IN" | "MEMBER_OF" | "EXPORTS" | "EXPORTS_DEFAULT";

// ─── Layer 1: Module/Import (file graph) ─────────────────
// Edges: file → file, module → module
"IMPORTS" | "IMPORTS_TYPE" | "IMPORTS_DEFAULT" |
"IMPORTS_NAMESPACE" | "DYNAMIC_IMPORTS" | "RE_EXPORTS" |
"REQUIRES" | "LAZY_LOADS" | "BUNDLED_WITH";

// ─── Layer 2: Invocation (call graph) ────────────────────
// Edges: function → function, method → method
"CALLS" | "CALLS_ASYNC" | "CALLS_INDIRECT" |
"CALLS_VIRTUAL" | "INSTANTIATES" | "INVOKES" |
"CALLS_CONSTRUCTOR" | "CALLS_STATIC" | "CALLS_OPERATOR" |
"RETURNS" | "YIELDS" | "AWAITS" | "FORWARDS_TO" |
"DISPATCHES_TO" | "DEFERS";

// ─── Layer 3: Type System (inheritance, generics) ────────
// Edges: class → class, type → type
"EXTENDS" | "IMPLEMENTS" | "TYPE_ALIAS" | "TYPE_PARAMETER" |
"TYPE_ARGUMENT" | "TYPE_CONSTRAINT" | "SATISFIES" |
"MIXIN_USES" | "TRAIT_IMPLEMENTS" | "PROTOCOL_CONFORMS" |
"INFERRED_AS" | "SATISFIES_CONSTRAINT";

// ─── Layer 4: Data Flow (def-use chains) ─────────────────
// Edges: variable → use, producer → consumer
"READS" | "WRITES" | "MUTATES" | "PRODUCES" | "CONSUMES" |
"DEF_USE" | "FLOWS_TO" | "ALIASES" | "SHARES_STORAGE" |
"CAPTURES_BY_REF" | "CAPTURES_BY_VAL" | "ASSIGNS_TO" |
"DECLARES_VARIABLE" | "DECLARES_FIELD" | "PASSES_TO" |
"RETURNS_FROM";

// ─── Layer 5: Contract/Framework (routes, db, events) ────
// Edges: handler ↔ route, client → API, entity → table
"EXPOSES_ROUTE" | "CONSUMES_ROUTE" | "EXPOSES_API" |
"CONSUMES_API" | "IMPLEMENTS_CONTRACT" | "PROVIDES" |
"DEPENDS_ON_SERVICE" | "HANDLES_RPC" | "DEFINES_SCHEMA" |
"USES_SCHEMA" | "ANNOTATED_WITH" | "CONFIGURES" |
"READS_TABLE" | "WRITES_TABLE" | "SCHEMA_MAPS_TO" |
"QUERIES" | "MIGRATES" | "JOINS_TABLE" | "TRANSACTION_SCOPE" |
"EMITS" | "CONSUMES_EVENT" | "LISTENS" | "PUBLISHES" |
"SUBSCRIBES" | "HANDLES" | "DISPATCHES" | "OBSERVES" |
"NOTIFIES" | "ON_EVENT";

// ─── Layer 6: Cross-Cutting (test, doc, config, build) ───
// Edges: test → tested, code → doc, app → config
"TESTS" | "MOCKS" | "STUBS" | "FIXTURE_USES" |
"SETUP" | "TEARDOWN" | "COVERS_LINE" | "ASSERTS" |
"DOCUMENTS" | "REFERENCES_DOC" | "ANNOTATED_BY" |
"DEPRECATED_BY" | "LINKS_TO" | "DERIVED_FROM" |
"READS_CONFIG" | "WRITES_CONFIG" | "USES_ENV" | "DEFINES_ENV" |
"READS_SECRET" | "TOGGLE_FEATURE" | "DEPENDS_ON_PACKAGE" |
"BUILDS_FROM" | "DEPLOYS_TO" | "RUNS_ON";

// ─── Layer 7: Runtime / Observed ─────────────────────────
// Edges: confirmed-at-runtime relationships
"OBSERVED_CALL" | "OBSERVED_DATAFLOW" | "OBSERVED_LATENCY" |
"OBSERVED_ERROR" | "TRACE_SPAN_PARENT" | "TRACE_SPAN_CHILD" |
"REQUEST_FLOWS_THROUGH" | "UNRESOLVED_DYNAMIC" |
"UNRESOLVED_TYPE" | "UNRESOLVED_MODULE";
```

### 2.3 Edge Schema

```typescript
type EdgeFamily =
  | "STRUCTURAL"    // Layer 0
  | "IMPORT"        // Layer 1
  | "INVOCATION"    // Layer 2
  | "TYPE"          // Layer 3
  | "DATA_FLOW"     // Layer 4
  | "CONTRACT"      // Layer 5
  | "CROSS_CUTTING" // Layer 6
  | "RUNTIME";      // Layer 7

type EdgeConfidence =
  | 1.0   // Confirmed by compiler/parser (deterministic)
  | 0.9   // Confirmed by tree-sitter + import resolution
  | 0.7   // Heuristic: same-directory name match
  | 0.5   // Heuristic: global name match
  | 0.3   // Regex-based (e.g., route pattern)
  | 0.0;  // Unresolved / placeholder

type EdgeSource =
  | "tree-sitter"
  | "typescript-compiler"
  | "regex-contract"
  | "framework-adapter"
  | "runtime-trace"
  | "test-trace"
  | "manual";

interface CodeEdge {
  sourceId: string;
  targetId: string;
  family: EdgeFamily;         // for broad policy matching
  kind: EdgeKind;             // specific relationship
  confidence: EdgeConfidence; // how sure are we?
  sourceMethod: EdgeSource;   // how was it derived
  metadata?: Record<string, unknown>;
}
```

### 2.4 Node Schema (Stable Content-Hash IDs)

```typescript
interface CodeNode {
  id: string;         // contentHash(kind + name + file + signature)
  kind: NodeKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;  // truncated signature (first ~200 chars)
  bodyHash?: string;   // hash of full body text
  contentHash?: string; // hash of the source file
  docComment?: string;  // extracted JSDoc/docstring
  visibility?: "public" | "private" | "protected" | "internal";
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  isDeprecated?: boolean;
  language: string;     // "typescript" | "python" | "rust" | ...
}

function stableNodeId(kind: NodeKind, name: string, filePath: string, signature: string): string {
  const hash = createHash("sha256")
    .update(kind).update("\0")
    .update(name).update("\0")
    .update(filePath).update("\0")
    .update(signature.slice(0, 200))
    .digest("hex").slice(0, 16);
  return `${kind.slice(0, 4)}:${hash}`;
}
// Examples:
//   "func:a1b2c3d4e5f6g7h8"
//   "class:i9j0k1l2m3n4o5p6"
//   "route:q7r8s9t0u1v2w3x4"
```

### 2.5 Traversal Policy

```typescript
interface TraversalPolicy {
  name: string;
  families: EdgeFamily[];    // which layers to traverse
  edgeKinds: EdgeKind[];     // specific edge types (overrides families)
  maxDepth: number;          // max BFS depth
  maxNodes: number;          // max nodes in result
  maxTokens: number;         // max token budget for rendering
  includeReverseEdges: boolean;
  minConfidence: number;     // minimum confidence to include edge
  direction: "forward" | "backward" | "both";
}

const POLICIES: Record<string, TraversalPolicy> = {
  function_edit: {
    name: "function_edit",
    families: ["STRUCTURAL", "IMPORT", "INVOCATION", "DATA_FLOW"],
    maxDepth: 2,
    maxNodes: 80,
    maxTokens: 16000,
    includeReverseEdges: true,
    minConfidence: 0.5,
    direction: "both",
  },
  endpoint_edit: {
    name: "endpoint_edit",
    families: ["STRUCTURAL", "IMPORT", "INVOCATION", "CONTRACT", "DATA_FLOW"],
    maxDepth: 3,
    maxNodes: 120,
    maxTokens: 24000,
    includeReverseEdges: true,
    minConfidence: 0.3,
    direction: "both",
  },
  impact: {
    name: "impact",
    families: ["STRUCTURAL", "IMPORT", "INVOCATION", "TYPE", "DATA_FLOW", "CONTRACT", "CROSS_CUTTING"],
    maxDepth: 4,
    maxNodes: 200,
    maxTokens: 32000,
    includeReverseEdges: true,
    minConfidence: 0.0,
    direction: "both",
  },
  schema_edit: {
    name: "schema_edit",
    families: ["STRUCTURAL", "IMPORT", "TYPE", "DATA_FLOW", "CONTRACT"],
    edgeKinds: ["SCHEMA_MAPS_TO", "READS_TABLE", "WRITES_TABLE", "QUERIES", "MIGRATES"],
    maxDepth: 2,
    maxNodes: 100,
    maxTokens: 20000,
    includeReverseEdges: true,
    minConfidence: 0.5,
    direction: "backward",
  },
};
```

### 2.6 Context Slice

```typescript
interface ContextSlice {
  policy: string;
  entryNodeIds: string[];
  entryQuery: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  unresolved: CodeEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    totalFiles: number;
    estimatedTokens: number;
    retrievalMs: number;
    depthReached: number;
  };
}
```

---

## 3. Parsing & Indexing Pipeline

### 3.1 Language-Plugin Architecture

```typescript
interface LanguageIndexer {
  language: string;
  filePatterns: string[];
  supportedNodeKinds: NodeKind[];
  supportedEdgeKinds: EdgeKind[];
  
  // Parse a single file, return extracted nodes and edges
  parseFile(filePath: string, text: string, digest: string): ParseResult;
  
  // Optional: deeper analysis of a set of files (for type-aware passes)
  deepen?(files: string[], slice: ContextSlice): Promise<ParseResult>;
}

interface ParseResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
  unresolved: Array<{ expression: string; file: string; line: number }>;
  language: string;
}
```

### 3.2 Indexer Orchestrator

```typescript
class IndexerOrchestrator {
  private store: GraphStore;
  private indexers: Map<string, LanguageIndexer>;
  private workerPool: WorkerPool;
  
  registerIndexer(indexer: LanguageIndexer): void;
  
  async indexAll(root: string): Promise<IndexStats>;
  // Parallel: splits files by language, dispatches to worker pool
  
  async indexFiles(files: string[]): Promise<void>;
  // For incremental: only changed files
  
  async deepenSlice(slice: ContextSlice): Promise<void>;
  // Optionally run type-aware pass for slice-relevant files only
}
```

### 3.3 Parallel Worker Pool

```typescript
// src/indexer-pool.ts
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import path from "node:path";

const POOL_SIZE = Math.max(1, cpus().length - 1);

class WorkerPool {
  private workers: Worker[] = [];
  private queue: Array<{ job: IndexJob; resolve: Function; reject: Function }> = [];
  private activeCount = 0;
  
  async indexParallel(root: string, allFiles: string[]): Promise<MergeResult> {
    const batches = this.partitionFiles(allFiles, POOL_SIZE);
    const results = await Promise.all(
      batches.map(batch => this.dispatch({ files: batch, root }))
    );
    return this.merge(results);
  }
  
  private partitionFiles(files: string[], n: number): string[][] {
    const batches: string[][] = [];
    const chunkSize = Math.ceil(files.length / n);
    for (let i = 0; i < files.length; i += chunkSize) {
      batches.push(files.slice(i, i + chunkSize));
    }
    return batches;
  }
}
```

### 3.4 Two-Pass Strategy for Extreme Scale

```
Pass 1 (always):  tree-sitter structural parse
  - Extracts: functions, classes, imports, exports, call sites
  - Speed: ~1000 files/sec per core
  - No type information
  - 100k files in ~15 seconds (8 cores)

Pass 2 (on-demand, only for slice): TypeScript Compiler API deepen
  - Only runs on files that appear in the context slice
  - Resolves types, generics, overloads, polymorphic dispatch
  - ~50 files/sec per core, but runs only on ~5-20 files
  - Adds: TYPE_ARGUMENT, INFERRED_AS, CALLS_VIRTUAL edges
```

### 3.5 Incremental Updates (Edge-Granular)

```typescript
indexFile(absPath: string): void {
  const rel = path.relative(this.root, absPath);
  const text = fs.readFileSync(absPath, "utf8");
  const digest = sha256(text);
  
  // 1. Quick skip if unchanged
  const oldHash = this.store.indexedHash(rel);
  if (oldHash === digest) return;
  
  // 2. Get old node IDs for this file
  const oldNodeIds = this.store.getNodeIdsForFile(rel);
  
  // 3. Parse new content
  const result = this.parseFile(rel, text, digest);
  const newNodeIds = new Set(result.nodes.map(n => n.id));
  
  // 4. Delete removed nodes (edges cascade via FK)
  for (const oldId of oldNodeIds) {
    if (!newNodeIds.has(oldId)) {
      this.store.deleteNode(oldId);
    }
  }
  
  // 5. Batch insert new/modified nodes + edges
  this.store.batchInsert(result.nodes, result.edges);
  
  // 6. Mark indexed
  this.store.markIndexed(rel, digest);
}
```

---

## 4. Graph Storage Schema

### 4.1 SQLite Schema

```sql
-- Core node table
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,                    -- content-hash based (stable)
  kind TEXT NOT NULL,                     -- function, class, method, etc.
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,                         -- truncated signature
  body_hash TEXT,                         -- hash of body content
  content_hash TEXT,                      -- hash of source file
  language TEXT NOT NULL DEFAULT 'typescript',
  visibility TEXT DEFAULT 'public',
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_deprecated INTEGER DEFAULT 0,
  doc_comment TEXT,
  indexed_at TEXT NOT NULL
);

-- Core edge table
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- specific: CALLS, READS, etc.
  family TEXT NOT NULL,                   -- broad: INVOCATION, DATA_FLOW, etc.
  confidence REAL NOT NULL DEFAULT 1.0,
  source_method TEXT NOT NULL,            -- tree-sitter, compiler, runtime, etc.
  metadata_json TEXT,
  
  PRIMARY KEY(source_id, target_id, kind),
  FOREIGN KEY(source_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Indexed file tracking
CREATE TABLE IF NOT EXISTS indexed_files (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_file_idx ON nodes(file_path);
CREATE INDEX IF NOT EXISTS nodes_lang_idx ON nodes(language);
CREATE INDEX IF NOT EXISTS nodes_name_idx ON nodes(name);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS edges_family_idx ON edges(family);
CREATE INDEX IF NOT EXISTS edges_confidence_idx ON edges(confidence);

-- FTS5 for symbol search (sub-ms lookup)
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  signature,
  file_path,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Keep FTS in sync with triggers
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, signature, file_path)
  VALUES (new.rowid, new.id, new.name, new.signature, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, signature, file_path)
  VALUES ('delete', old.rowid, old.id, old.name, old.signature, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, signature, file_path)
  VALUES ('delete', old.rowid, old.id, old.name, old.signature, old.file_path);
  INSERT INTO nodes_fts(rowid, id, name, signature, file_path)
  VALUES (new.rowid, new.id, new.name, new.signature, new.file_path);
END;
```

### 4.2 Key Queries

```sql
-- Fast symbol search (FTS5, sub-ms)
SELECT n.* FROM nodes n
JOIN nodes_fts fts ON n.rowid = fts.rowid
WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 20;

-- Callers of a function (reverse lookup)
SELECT n.* FROM nodes n
JOIN edges e ON n.id = e.source_id
WHERE e.target_id = ? AND e.kind = 'CALLS';

-- Callees of a function (forward lookup)
SELECT n.* FROM nodes n
JOIN edges e ON n.id = e.target_id
WHERE e.source_id = ? AND e.kind = 'CALLS';

-- Transitive impact chain (recursive CTE, bounded)
WITH RECURSIVE impact(id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT e.target_id, i.depth + 1
  FROM impact i
  JOIN edges e ON e.source_id = i.id
  WHERE i.depth < 4 AND e.kind IN ('CALLS', 'REA DS', 'WRITES')
)
SELECT DISTINCT n.* FROM nodes n JOIN impact i ON n.id = i.id;

-- Files affected by a change (incoming edges to changed file's symbols)
SELECT DISTINCT e.source_id, n.file_path
FROM edges e
JOIN nodes n ON n.id = e.source_id
WHERE e.target_id IN (
  SELECT id FROM nodes WHERE file_path = ?
) AND e.kind IN ('CALLS', 'IMPLEMENTS', 'EXTENDS', 'REFERENCES');

-- Graph stats
SELECT family, kind, COUNT(*) as cnt FROM edges GROUP BY family, kind ORDER BY cnt DESC;
SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind ORDER BY cnt DESC;

-- Find orphan nodes (no edges)
SELECT n.* FROM nodes n
LEFT JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
WHERE e.source_id IS NULL AND n.kind != 'file';
```

### 4.3 Configuration

```sql
PRAGMA journal_mode = WAL;              -- WAL mode for concurrent read/write
PRAGMA foreign_keys = ON;               -- Referential integrity
PRAGMA cache_size = -64000;             -- 64MB page cache for large graphs
PRAGMA synchronous = NORMAL;            -- Faster writes, safe with WAL
PRAGMA mmap_size = 268435456;           -- 256MB memory-mapped I/O
PRAGMA temp_store = MEMORY;             -- Temp tables in memory
PRAGMA busy_timeout = 5000;             -- Wait 5s on lock instead of failing
```

---

## 5. Traversal & Context Compilation

### 5.1 BFS Traversal Engine

```typescript
function compileSlice(
  store: GraphStore,
  entryNodeIds: string[],
  policy: TraversalPolicy
): ContextSlice {
  const seen = new Set(entryNodeIds);
  const queue: Array<{ id: string; depth: number }> = 
    entryNodeIds.map(id => ({ id, depth: 0 }));
  const edges: CodeEdge[] = [];
  const started = performance.now();

  while (queue.length > 0 && seen.size < policy.maxNodes) {
    const current = queue.shift()!;
    if (current.depth >= policy.maxDepth) continue;

    // Fetch edges matching the policy's families and kinds
    const nextEdges = [
      ...store.outgoingByFamily(current.id, policy.families, policy.minConfidence),
      ...(policy.includeReverseEdges 
        ? store.incomingByFamily(current.id, policy.families, policy.minConfidence) 
        : [])
    ];

    for (const edge of nextEdges) {
      edges.push(edge);
      const nextId = edge.sourceId === current.id ? edge.targetId : edge.sourceId;
      if (!seen.has(nextId) && seen.size < policy.maxNodes) {
        seen.add(nextId);
        if (current.depth + 1 < policy.maxDepth) {
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }
  }

  // Deduplicate edges (same source+target+kind)
  const edgeMap = new Map<string, CodeEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceId}|${edge.targetId}|${edge.kind}`;
    // Prefer higher confidence
    if (!edgeMap.has(key) || edge.confidence > edgeMap.get(key)!.confidence) {
      edgeMap.set(key, edge);
    }
  }
  const uniqueEdges = [...edgeMap.values()];

  return {
    policy: policy.name,
    entryNodeIds,
    entryQuery: "",
    nodes: store.getNodes([...seen]),
    edges: uniqueEdges,
    unresolved: uniqueEdges.filter(e => e.kind === "UNRESOLVED_DYNAMIC"),
    stats: {
      totalNodes: seen.size,
      totalEdges: uniqueEdges.length,
      totalFiles: new Set(store.getNodes([...seen]).map(n => n.filePath)).size,
      estimatedTokens: 0, // set by renderer
      retrievalMs: performance.now() - started,
      depthReached: Math.max(...queue.map(q => q.depth), 0),
    },
  };
}
```

### 5.2 Forward/Backward Slicing

```typescript
// Forward slice: what does this change affect?
function forwardSlice(store: GraphStore, entryNodeId: string, depth: number): ContextSlice {
  return compileSlice(store, [entryNodeId], {
    name: "forward_impact",
    families: ["INVOCATION", "DATA_FLOW", "CONTRACT", "CROSS_CUTTING"],
    maxDepth: depth,
    maxNodes: 200,
    maxTokens: 32000,
    includeReverseEdges: false,  // Only forward
    minConfidence: 0.3,
    direction: "forward",
  });
}

// Backward slice: what does this depend on?
function backwardSlice(store: GraphStore, entryNodeId: string, depth: number): ContextSlice {
  return compileSlice(store, [entryNodeId], {
    name: "backward_deps",
    families: ["STRUCTURAL", "IMPORT", "INVOCATION", "TYPE", "DATA_FLOW"],
    maxDepth: depth,
    maxNodes: 200,
    maxTokens: 32000,
    includeReverseEdges: true,   // Follow incoming edges = find dependencies
    minConfidence: 0.5,
    direction: "backward",
  });
}
```

### 5.3 Value Slice (Data-Flow Based)

```typescript
// Trace where a value comes from (all paths: reads, writes, calls)
function valueSlice(store: GraphStore, valueNodeId: string): ContextSlice {
  // Walk backward through DEF_USE, FLOWS_TO, READS, CALLS edges
  // to find all definitions that reach this value
  const policy: TraversalPolicy = {
    name: "value_trace",
    edgeKinds: ["DEF_USE", "FLOWS_TO", "READS", "CALLS", "RETURNS_FROM", "PASSES_TO"],
    maxDepth: 5,
    maxNodes: 100,
    maxTokens: 16000,
    includeReverseEdges: true,
    minConfidence: 0.5,
    direction: "backward",
  };
  return compileSlice(store, [valueNodeId], policy);
}
```

---

## 6. Rendering & Token Budget

### 6.1 Relevance Scoring

```typescript
function scoreNode(
  node: CodeNode,
  edges: CodeEdge[],
  entryIds: Set<string>,
  config: { entryBonus: number; inboundWeight: number; outboundWeight: number }
): number {
  let score = 0;
  if (entryIds.has(node.id)) score += config.entryBonus;
  
  const incomingEdges = edges.filter(e => e.targetId === node.id);
  const outgoingEdges = edges.filter(e => e.sourceId === node.id);
  
  // More connections = more relevant (hub nodes)
  score += incomingEdges.length * config.inboundWeight;
  score += outgoingEdges.length * config.outboundWeight;
  
  // Prioritize certain node kinds
  const kindBonus: Partial<Record<NodeKind, number>> = {
    function: 10, class: 10, interface: 8,
    route: 15, db_table: 12, event: 8,
    variable: 3, parameter: 1,
  };
  score += kindBonus[node.kind] ?? 0;
  
  return score;
}

function prioritizeNodes(nodes: CodeNode[], edges: CodeEdge[], entryIds: Set<string>): CodeNode[] {
  const scores = new Map<string, number>();
  for (const node of nodes) {
    scores.set(node.id, scoreNode(node, edges, entryIds, {
      entryBonus: 100,
      inboundWeight: 2,
      outboundWeight: 1,
    }));
  }
  return [...nodes].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
}
```

### 6.2 Token Budget Enforcer

```typescript
class TokenBudget {
  private budget: number;
  private used = 0;
  
  constructor(maxTokens: number) { this.budget = maxTokens; }
  
  tryAllocate(text: string): boolean {
    const tokens = this.estimateTokens(text);
    if (this.used + tokens > this.budget) return false;
    this.used += tokens;
    return true;
  }
  
  remaining(): number { return this.budget - this.used; }
  
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for code
    return Math.ceil(text.length / 4);
  }
}
```

### 6.3 Multi-Level Rendering

```typescript
function renderSlice(
  root: string,
  slice: ContextSlice,
  options: {
    maxTokens: number;
    diff?: string;                    // git diff for diff-aware mode
    peripheralLines?: number;         // max lines for peripheral nodes
    format: "markdown" | "json";     // output format
  }
): string {
  const sorted = prioritizeNodes(slice.nodes, slice.edges, new Set(slice.entryNodeIds));
  const budget = new TokenBudget(options.maxTokens);
  const output: string[] = [];
  
  // Header (always included)
  const header = formatHeader(slice);
  budget.tryAllocate(header);
  output.push(header);
  
  // Changed lines map (for diff-aware mode)
  const changedFiles = options.diff ? parseChangedLines(options.diff) : null;
  
  for (const node of sorted) {
    if (budget.remaining() <= 0) break;
    
    const isPeripheral = !slice.entryNodeIds.includes(node.id);
    const isChanged = changedFiles?.has(node.filePath);
    
    let rendered: string;
    if (isChanged && changedFiles) {
      // Diff-aware: only render the changed hunks + context
      rendered = renderNodeWithDiff(node, root, changedFiles.get(node.filePath)!);
    } else if (isPeripheral && node.signature) {
      // Signature-only for peripheral nodes
      rendered = renderNodeSignature(node);
    } else {
      // Full source for entry/important nodes
      rendered = renderNodeFull(node, root, options.peripheralLines);
    }
    
    // Try to fit within budget
    if (budget.tryAllocate(rendered)) {
      output.push(rendered);
    } else {
      // Truncated fallback
      const truncated = renderNodeSignature(node);
      if (budget.tryAllocate(truncated)) {
        output.push(truncated + "  // (truncated)");
      }
    }
  }
  
  // Format unresolved edges
  if (slice.unresolved.length > 0) {
    output.push("\n## Unresolved Dynamic Edges");
    for (const edge of slice.unresolved) {
      output.push(`- \`${edge.sourceId}\` → \`${edge.targetId}\``);
    }
  }
  
  return output.join("\n");
}
```

### 6.4 Diff-Aware Rendering

```typescript
interface ChangedLines {
  added: Set<number>;
  removed: Set<number>;
  modified: Set<number>;
  context: Set<number>;  // surrounding untouched lines
}

function renderNodeWithDiff(
  node: CodeNode,
  root: string,
  lines: ChangedLines
): string {
  const filePath = path.join(root, node.filePath);
  if (!fs.existsSync(filePath)) return "";
  
  const sourceLines = fs.readFileSync(filePath, "utf8").split("\n");
  const relevant = sourceLines.slice(
    Math.max(0, node.startLine - 3),
    Math.min(sourceLines.length, node.endLine + 2)
  );
  
  // Only include lines that are part of the diff hunks
  const filtered = relevant.filter((_, i) => {
    const lineNum = node.startLine - 1 + i;
    return lines.context.has(lineNum) || 
           lines.added.has(lineNum) || 
           lines.modified.has(lineNum);
  });
  
  return `### ${node.kind}: ${node.name} (${node.filePath}:${node.startLine}-${node.endLine}) [diff]\n\`\`\`ts\n${filtered.join("\n")}\n\`\`\``;
}
```

**Token savings**: Signature-only mode saves ~60-80% for peripheral nodes. Diff-aware mode saves ~40-80% on edit tasks. Combined: **50-70% average reduction**.

---

## 7. Ready-to-Use Parts

### 7.1 tree-sitter (AST Parser)

| Factor | tree-sitter | TypeScript Compiler API |
|---|---|---|
| Speed | ~1000 files/sec/core | ~50 files/sec/core |
| Memory | ~200MB per 100k files | ~4GB+ per 100k files |
| Languages | 40+ | TS/JS only |
| Error tolerance | Excellent (recovers) | Poor (fails on errors) |
| Incremental | Built-in | Manual |
| Type info | None | Full |

**npm**: `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`, `web-tree-sitter`

**Decision**: Primary indexer = tree-sitter. Reserve TS Compiler API for on-demand "deepen" pass.

### 7.2 CodeGraph (Pre-built MCP Server)

- **What**: `@colbymchenry/codegraph` — 45k★, MIT, tree-sitter + SQLite + FTS5 + MCP
- **Benchmarks**: 35% cheaper, 59% fewer tokens, 49% faster, 70% fewer tool calls
- **Supports**: 19+ languages, caller/callee/impact, diff impact, MCP protocol, file watcher
- **Recommendation**: Evaluate as dependency. If schema doesn't match, use as architecture reference.

### 7.3 SCIP Protocol (Standardized Index Format)

- **What**: Sourcegraph's Protobuf-based code intelligence format
- **Indexers**: `scip-typescript`, `scip-python`, `scip-java`, `rust-analyzer`, etc.
- **Use case**: Export to SCIP for cross-tool compatibility (Sourcegraph, Glean, Searchfox)
- **Not for**: Context-slice compilation (SCIP is for definitions/references, not slices)

### 7.4 GitHub Stack-Graphs (File-Incremental Resolution)

- **Paper**: arXiv:2211.01224
- **Key idea**: Each file produces an isolated subgraph. Resolution = path-finding across subgraphs.
- **Use case**: Study the architecture. File-incremental subgraphs inform our data model.
- **Not for**: Direct use (Rust-only, complex, no Node.js binding)

### 7.5 SQLite + FTS5

- **Production choice**: `better-sqlite3` over experimental `node:sqlite`
- **Batch strategy**: Multi-row inserts within `BEGIN/COMMIT` per file (10-50x faster)
- **Search**: FTS5 virtual table over `LIKE %q%` (100-1000x faster)

### 7.6 Node.js Worker Threads

- **Built-in**: Node 12+, zero dependencies
- **Pattern**: Worker pool for parallel indexing across CPU cores
- **Speedup**: ~6-7x on 8-core machine

---

## 8. Implementation Phases

### Phase 0 — Current Baseline (today)

**Files**: 
- `src/types.ts` — node/edge types (15 edge kinds)
- `src/db.ts` — GraphStore with `node:sqlite` (experimental)
- `src/indexer.ts` — TS Compiler API, local-only call resolution, regex contracts
- `src/traversal.ts` — BFS traversal with 3 policies
- `src/render.ts` — naive full-source renderer
- `src/cli.ts` — index/watch/slice commands
- `src/benchmark.ts` — gold-set benchmark (1 case)
- `src/hash.ts` — sha256 helper
- `src/watcher.ts` — chokidar file watcher
- `test/fixture/src/` — 4 test files (auth.ts, routes.ts, client.ts, billing.ts)

**Metrics** (on fixture):
- Index: ~119ms
- Query: ~0.33ms
- Gold cases: 1/1 passed

**Issues**:
- Sequential indexing (single-threaded)
- `node:sqlite` is experimental (Node 22+ only)
- Per-node SQLite writes (no batching)
- `LIKE %q%` search (no FTS5)
- Position-based node IDs (break on line change)
- `clearFile` deletes everything on any change
- Fragile regex contract extraction
- SQLite WAL/SHM files committed
- Zero unit tests (vitest in deps but empty)
- Node IDs unstable across edits

### Phase 1 — Foundation (Week 1)

| # | Task | Files | Effort |
|---|---|---|---|
| 1.1 | Replace `node:sqlite` with `better-sqlite3` | `src/db.ts`, `package.json`, `src/node-sqlite.d.ts` | 1h |
| 1.2 | Batch SQLite writes (BEGIN/COMMIT per file) | `src/db.ts` | 2h |
| 1.3 | Add FTS5 for symbol search | `src/db.ts` (migration + queries) | 4h |
| 1.4 | Content-hash node IDs | `src/types.ts`, `src/indexer.ts` | 4h |
| 1.5 | Remove WAL/SHM from .gitignore | `.gitignore` | 5min |
| 1.6 | Expand gold benchmark to 10+ cases | `bench/gold.json` | 2h |

**Exit gate**: Index 10k LOC repo in under 5s. FTS5 findNodes < 1ms.

### Phase 2 — tree-sitter Migration (Week 1-2)

| # | Task | Files | Effort |
|---|---|---|---|
| 2.1 | Install tree-sitter + TypeScript grammar | `package.json` | 30min |
| 2.2 | Rewrite `TsRepositoryIndexer` using tree-sitter | `src/indexer.ts` | 2d |
| 2.3 | Plugin architecture: `LanguageIndexer` interface | `src/indexer.ts` (new) | 1d |
| 2.4 | Keep TS Compiler API as optional "deepen" pass | `src/deepen.ts` (new) | 1d |
| 2.5 | Cross-file import resolution (resolve real paths) | `src/resolver.ts` (new) | 2d |

**Exit gate**: 10x faster indexing on test repo. At least 90% symbol recall vs TS Compiler API baseline.

### Phase 3 — Relationship Model Expansion (Week 2-3)

| # | Task | Files | Effort |
|---|---|---|---|
| 3.1 | Extend `EdgeKind` to 7-layer hierarchy (~100 types) | `src/types.ts` | 4h |
| 3.2 | Add `EdgeFamily`, `EdgeConfidence`, `EdgeSource` | `src/types.ts` | 2h |
| 3.3 | Add type-system edges (EXTENDS, IMPLEMENTS, TYPE_ALIAS) | `src/indexer.ts` | 1d |
| 3.4 | Add data-flow edges (DEF_USE, READS, WRITES, FLOWS_TO) | `src/dataflow.ts` (new) | 2d |
| 3.5 | Framework contract extractors (Express, Fastify, React) | `src/contracts/` (new dir) | 2d |
| 3.6 | DB schema extractors (Prisma, Drizzle, raw SQL) | `src/contracts/db.ts` (new) | 1d |
| 3.7 | Event/messaging extractors (EventEmitter, pub/sub) | `src/contracts/events.ts` (new) | 1d |

**Exit gate**: Trace a full frontend→API→service→DB path in test repo.

### Phase 4 — Parallel Indexing (Week 3)

| # | Task | Files | Effort |
|---|---|---|---|
| 4.1 | Worker thread pool | `src/indexer-pool.ts` (new) | 2d |
| 4.2 | Partition files by language for parallel dispatch | `src/indexer-pool.ts` | 1d |
| 4.3 | Merge results from workers | `src/db.ts` (batchInsert) | 1d |
| 4.4 | SQLite read-pool for concurrent slice queries | `src/db.ts` (pool) | 1d |

**Exit gate**: Index 100k file repo in < 60s on 8-core machine.

### Phase 5 — Context Budget Optimizer (Week 3-4)

| # | Task | Files | Effort |
|---|---|---|---|
| 5.1 | Relevance scoring engine | `src/score.ts` (new) | 1d |
| 5.2 | Token budget enforcement | `src/render.ts` (rewrite) | 1d |
| 5.3 | Signature-only rendering for peripheral nodes | `src/render.ts` | 1d |
| 5.4 | Diff-aware context rendering | `src/render-diff.ts` (new) | 1d |
| 5.5 | JSON output format for programmatic consumption | `src/render.ts` | 4h |

**Exit gate**: 50% token reduction vs Phase 0 baseline on same gold tasks. Task success within 5pp of baseline.

### Phase 6 — Incremental & Live (Week 4-5)

| # | Task | Files | Effort |
|---|---|---|---|
| 6.1 | Edge-granular incremental updates | `src/indexer.ts` | 2d |
| 6.2 | Dirty propagation (changed→symbols→edges→cached slices) | `src/invalidator.ts` (new) | 2d |
| 6.3 | File watcher improvements (debounce, cooldown) | `src/watcher.ts` | 1d |
| 6.4 | Git-aware: reindex only changed files on branch switch | `src/git-hook.ts` (new) | 1d |

**Exit gate**: p95 incremental update < 2s on target repo. Zero stale edges in mutation tests.

### Phase 7 — Runtime Confirmation (Week 5-6)

| # | Task | Files | Effort |
|---|---|---|---|
| 7.1 | OpenTelemetry trace importer | `src/runtime/otel.ts` (new) | 2d |
| 7.2 | Test trace importer (Vitest/Jest integration) | `src/runtime/tests.ts` (new) | 1d |
| 7.3 | Store observed edges separately | `src/db.ts` (schema) | 1d |
| 7.4 | Report unresolved→confirmed transitions | `src/render.ts` | 1d |

**Exit gate**: Dynamic dispatch cases become traceable without deleting unresolved alternatives.

### Phase 8 — MCP Agent Interface (Week 6-7)

| # | Task | Files | Effort |
|---|---|---|---|
| 8.1 | MCP server with stdio transport | `src/mcp/server.ts` (new) | 2d |
| 8.2 | `find_symbols` tool | `src/mcp/tools.ts` (new) | 4h |
| 8.3 | `get_callers` / `get_callees` tools | `src/mcp/tools.ts` | 4h |
| 8.4 | `slice_for_function_edit` / `slice_for_endpoint_edit` tools | `src/mcp/tools.ts` | 1d |
| 8.5 | `get_contract_path` / `trace_value` tools | `src/mcp/tools.ts` | 1d |
| 8.6 | `expand_slice` / `report_unresolved` tools | `src/mcp/tools.ts` | 1d |
| 8.7 | Auto-config support for Claude/Cursor/Codex | `src/mcp/install.ts` (new) | 1d |

**Exit gate**: Agent uses graph tools first, reads raw code only after slice compilation. 50%+ reduction in tool calls vs baseline.

---

## 9. Benchmarking Strategy

### 9.1 Gold Dataset Format

```json
{
  "task": "Add an admin action to disable a user account",
  "repo": "test/fixture",
  "entry_candidates": ["disableUser", "PATCH /admin/users/:id/status"],
  "required_nodes": [
    "AdminUserPage",
    "PATCH /admin/users/:id/status",
    "disableUser",
    "users.status",
    "adminAuthorizationMiddleware"
  ],
  "forbidden_nodes": ["invoiceGenerator", "chargeCard"],
  "maximum_context_tokens": 20000,
  "minimum_confidence": 0.5,
  "policy": "endpoint_edit"
}
```

### 9.2 Metrics

| Metric | Target | How to measure |
|---|---|---|
| Required-node recall | ≥ 90% | % of required_nodes found in slice |
| Unrelated-node precision | ≤ 10% forbidden | % of forbidden_nodes in slice |
| Index time (10k LOC) | < 5s | `performance.now()` around indexAll |
| Index time (100k LOC) | < 60s | `performance.now()` around indexAll (parallel) |
| p50 slice retrieval | < 50ms | `performance.now()` around compileSlice |
| p95 slice retrieval | < 200ms | `performance.now()` around compileSlice (100 runs) |
| Incremental update (single file) | < 500ms | Change 1 function, measure reindex |
| Token reduction vs baseline | ≥ 50% | Compare slice size with/without budget optimizer |
| Database size (100k LOC) | < 200MB | `fs.statSync(dbPath).size` |
| Memory usage (100k LOC) | < 500MB | `process.memoryUsage().heapUsed` |

### 9.3 Scale Test Fixtures

```typescript
// Generate synthetic repos for benchmarking
interface ScaleFixture {
  name: string;
  loc: number;       // 10_000 | 100_000 | 1_000_000
  fileCount: number;
  languages: string[];
  edgeDensity: number;  // avg edges per node (0.5 = sparse, 3 = dense)
  crossFileCalls: boolean;
  generics: boolean;
  frameworkPatterns: boolean;
}
```

### 9.4 Agent A/B Test

```
Task: "Add rate limiting to the login endpoint"

Baseline arm (no graph):
  - Agent uses grep/glob/Read to explore
  - Files read: ~47
  - Tool calls: ~83
  - Tokens consumed: ~184k
  - Time: ~127s
  - Task success: 80%

Graph-first arm:
  - Agent queries graph: 2 calls
  - Slice compiled: 12 files, ~18k tokens
  - Tool calls: ~12
  - Tokens consumed: ~42k
  - Time: ~34s
  - Task success: 85%

Goal: 50%+ token reduction, 50%+ fewer tool calls, task success within 5pp of baseline
```

---

## 10. Architecture Decision Records

### ADR-1: tree-sitter over TypeScript Compiler API

- **Decision**: Primary indexer = tree-sitter. Reserve TS Compiler API for optional "deepen" pass.
- **Reason**: tree-sitter is 10-50x faster, supports 40+ languages, error-tolerant, incremental. Type info is not needed for 90% of context-slice use cases.
- **Consequence**: Lose generic resolution, overload picking. Acceptable because "deepen" pass handles those edge cases.

### ADR-2: SQLite over Graph Database

- **Decision**: SQLite + recursive CTEs. No Neo4j/PostgreSQL until benchmark proves it's a bottleneck.
- **Reason**: SQLite handles million-node graphs efficiently with proper schema. Adding a graph DB adds server process, config, backup complexity.
- **Consequence**: Graph queries are CTEs instead of Cypher. Verbose but equally expressive for bounded traversals.

### ADR-3: Content-Hash over Positional IDs

- **Decision**: `sha256(kind + name + file + signature) → 64-bit` as node primary key.
- **Reason**: Position IDs (`file::kind::name::startLine`) break on any line change. Hash-based IDs are stable across edits, enable true incremental updates.
- **Consequence**: Slightly more complex ID generation. 64-bit collision risk is negligible (< 2^-32 for 1M nodes).

### ADR-4: 7-Layer Edge Hierarchy over Flat Edge List

- **Decision**: Edges have `family` (broad) + `kind` (specific) + `confidence` (0.0-1.0).
- **Reason**: Flat lists are unqueryable at scale. Hierarchy lets policies say "give me all invocation edges" without listing 15 specific kinds. Confidence lets policies trade recall for precision.
- **Consequence**: More complex schema. But enables progressive detail: start with families, add specific kinds later.

### ADR-5: Plugin Language Indexers over Monolithic Parser

- **Decision**: Each language gets its own `LanguageIndexer` implementation.
- **Reason**: Different languages need different parsers (tree-sitter for most, but TypeScript benefits from its Compiler API for deepen mode). Monolithic parser doesn't scale across 40+ languages.
- **Consequence**: Need to write/maintain per-language indexers. But each indexer is ~200-500 lines and follows a standard interface.

### ADR-6: Worker Threads over Child Processes or Cluster

- **Decision**: Use `node:worker_threads` for parallel indexing.
- **Reason**: Workers share process memory (for SQLite), have lightweight communication (message passing), and are built-in. Child processes are heavier (separate V8 instances). Cluster is for web servers, not batch indexing.
- **Consequence**: Workers can't use `node:sqlite` (each worker needs its own connection). Mitigation: workers extract nodes/edges, main thread handles all DB writes.

### ADR-7: In-Process Context Compiler over Sidecar Service

- **Decision**: The context compiler runs as a library (in-process) not as a separate service.
- **Reason**: Sub-ms query latency requires in-process access to SQLite. A sidecar adds network latency that defeats the purpose.
- **Consequence**: The MCP server is the only external-facing process. It embeds the library.

---

## 11. Current Code Audit

### 11.1 File-by-File Assessment

| File | Lines | Quality | Issues |
|---|---|---|---|
| `src/types.ts` | 62 | OK | Only 15 edge kinds, no family/confidence/plugin support |
| `src/db.ts` | 157 | Needs work | `node:sqlite` (experimental), no batch writes, `LIKE %` search, `deleteFileIfMissing` is dead code wrapper |
| `src/hash.ts` | 2 | OK | Simple sha256 helper, fine |
| `src/indexer.ts` | 135 | Needs rewrite | Sequential, local-only call resolution, fragile regex contracts, TS-only, position-based IDs, `clearFile` deletes everything |
| `src/traversal.ts` | 54 | OK pattern | BFS is correct, but needs family/confidence filtering, token budgets |
| `src/render.ts` | 27 | Needs rewrite | No token budget, no diff mode, always full source, hardcoded ````ts```` |
| `src/watcher.ts` | 16 | OK | chokidar setup is fine, add debounce/cooldown |
| `src/cli.ts` | 39 | OK | Clean CLI, extend for new commands |
| `src/benchmark.ts` | 46 | Needs expansion | Only 1 gold case, no memory/CI integration |
| `src/node-sqlite.d.ts` | 12 | DELETE | Wrong API surface, will be replaced by better-sqlite3 types |
| `test/` | Empty | Missing | 0 test files despite vitest in devDeps |
| `bench/gold.json` | 9 | Needs expansion | Only 1 case, need 20+ |

### 11.2 Critical Bugs

1. **`node-sqlite.d.ts` is hand-written and likely wrong** — won't match actual Node 22 runtime API. Blocks any production use.
2. **Node IDs tied to line numbers** (`src/indexer.ts:16-18`) — breaks on any edit. Makes incremental indexing impossible.
3. **`clearFile` deletes everything per file** (`src/db.ts:51-63`) — wasteful for incremental. A 2-line edit triggers full re-index.
4. **No cross-file resolution** (`src/indexer.ts:94-104`) — only looks up callees in current file's `declared` map. All cross-file calls become UNRESOLVED_DYNAMIC.
5. **Import paths are placeholders** (`src/indexer.ts:80`) — `file::./auth` doesn't resolve to `file::src/auth.ts`. The graph never connects across files.
6. **Single SQLite connection** — no pooling, concurrent reads block on writes.

### 11.3 Recommended Immediate Fixes (by severity)

| Priority | Fix | File | Impact |
|---|---|---|---|
| P0 | Replace `node:sqlite` with `better-sqlite3` | `db.ts`, `package.json` | Unblocks everything |
| P0 | Fix node IDs to be content-hash based | `indexer.ts`, `types.ts` | Enables incremental |
| P1 | Batch SQLite writes per file | `db.ts` | 10-50x write speed |
| P1 | Add FTS5 for symbol search | `db.ts` | 100-1000x faster lookup |
| P1 | Expand gold benchmark (at least 10 cases) | `bench/gold.json` | Measurable progress |
| P2 | Write at least 1 unit test | `test/` | CI gate |
| P2 | Cross-file import resolution | `indexer.ts` | Fixes broken graph |
| P2 | Remove WAL/SHM from version control | `.gitignore` | Clean repo |

---

## Appendix A: Directory Structure (Target)

```
live-context-compiler/
├── src/
│   ├── types.ts              # All types: NodeKind, EdgeKind, CodeNode, CodeEdge, etc.
│   ├── db.ts                 # GraphStore: SQLite + FTS5 + batch + pool
│   ├── hash.ts               # Hashing utilities
│   ├── indexer.ts            # IndexerOrchestrator + LanguageIndexer interface
│   ├── indexer-pool.ts       # Worker thread pool for parallel indexing
│   ├── deepen.ts             # TypeScript Compiler API "deepen" pass
│   ├── resolver.ts           # Cross-file module resolution
│   ├── dataflow.ts           # Def-use chain extraction
│   ├── contracts/
│   │   ├── express.ts        # Express route extractor
│   │   ├── fastify.ts        # Fastify route extractor
│   │   ├── react.ts          # React/Next.js client extractor
│   │   ├── db.ts             # Prisma/Drizzle/TypeORM extractor
│   │   ├── events.ts         # Event emitter/subscriber extractor
│   │   └── config.ts         # Env var / config key extractor
│   ├── traversal.ts          # BFS traversal engine
│   ├── score.ts              # Node relevance scoring
│   ├── render.ts             # Context slice renderer (markdown)
│   ├── render-diff.ts        # Diff-aware renderer
│   ├── runtime/
│   │   ├── otel.ts           # OpenTelemetry trace importer
│   │   └── tests.ts          # Test trace importer
│   ├── mcp/
│   │   ├── server.ts         # MCP server (stdio)
│   │   ├── tools.ts          # MCP tool implementations
│   │   └── install.ts        # Auto-config for agents
│   ├── cli.ts               # CLI entry point
│   ├── benchmark.ts         # Gold-dataset benchmark runner
│   ├── watcher.ts           # Chokidar file watcher
│   └── invalidator.ts       # Dirty propagation / cache invalidation
├── test/
│   ├── fixture/             # Test repos
│   ├── unit/                # Unit tests per module
│   ├── mutation/            # Mutation tests
│   └── evaluation/          # Agent A/B evaluation runner
├── bench/
│   ├── gold.json            # Gold dataset (20+ cases)
│   └── fixtures/            # Synthetic scale fixtures
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── SUGGESTIONS.md
├── BLUEPRINT-V1.md          # This file
└── REQUIREMENTS_PLAN.md
```

---

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **Context Slice** | A bounded set of code nodes + edges relevant to a specific task |
| **Deterministic Graph** | Relationships proven by parsers/compilers, not LLM guesswork |
| **Edge Family** | Broad category of relationship (INVOCATION, DATA_FLOW, etc.) |
| **Edge Kind** | Specific relationship type (CALLS, CALLS_ASYNC, etc.) |
| **Node ID** | Stable content-hash-based identifier for a code symbol |
| **Traversal Policy** | Rules for building a context slice (depth, families, budget) |
| **Discovery Tax** | The cost (tokens, latency) of finding relevant code via grep/glob/Read |
| **Diff-Aware** | Rendering only changed lines + context instead of full source |
| **Deepen Pass** | Optional type-aware analysis of a subset of files |
| **FTS5** | Full-Text Search v5 (SQLite extension for fast text search) |
| **MCP** | Model Context Protocol (standard for AI agent tool exposure) |
