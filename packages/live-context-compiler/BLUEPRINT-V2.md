# BLUEPRINT V2 — Live Context Compiler

> **Core insight**: The graph is infrastructure, not the product. **Relation containers** are the product.
>
> Every request hits a **slice cache** first. Cache miss → compile container → cache it → serve it. No repeated graph traversal.

---

## Table of Contents

1. [Core Concept — Relation Containers](#1-core-concept--relation-containers)
2. [Data Model](#2-data-model)
3. [Verification Taxonomy](#3-verification-taxonomy)
4. [SQLite Schema](#4-sqlite-schema)
5. [Architecture](#5-architecture)
6. [Traversal & Slicing](#6-traversal--slicing)
7. [Rendering & Budget](#7-rendering--budget)
8. [Security](#8-security)
9. [Implementation Phases](#9-implementation-phases)
10. [Benchmarking](#10-benchmarking)
11. [Architecture Decision Records](#11-architecture-decision-records)
12. [Current Code Audit](#12-current-code-audit)
13. [CodeGraph Evaluation](#13-codegraph-evaluation)

---

## 1. Core Concept — Relation Containers

### The Problem

A flat graph with BFS traversal means every request re-discovers the same relationships. You save file-read tokens but still pay traversal cost repeatedly.

### The Solution

```
Large containers (service / bounded context)
        ↓
Smaller containers (feature / module)
        ↓
Relation containers (frontend ↔ API ↔ service ↔ DB)
        ↓
Load only the relevant containers from cache
```

A **relation container** is a pre-compiled, versioned, cacheable package of nodes + edges for a known task boundary.

### Container Types

```text
PHYSICAL_CONTAINER     — maps to a workspace package or service directory
FEATURE_CONTAINER      — cross-cutting feature (e.g., "checkout", "auth")
RELATION_CONTAINER     — contract path (e.g., "CheckoutPage → POST /checkout → processCheckout → orders")
SLICE_CACHE            — cached result of a specific traversal policy + entry point
```

### Container Lifecycle

```text
File edit
  → content hash changes
  → node versions updated
  → PHYSICAL_CONTAINER marked dirty
  → FEATURE_CONTAINERs covering dirty files marked dirty
  → RELATION_CONTAINERs traversing dirty containers marked dirty
  → SLICE_CACHE entries for dirty containers invalidated
  → next request rebuilds only the affected containers
```

### Container Discovery

| Method | How | Default |
|---|---|---|
| **Convention** | One container per npm workspace package, per service directory, per `tsconfig.json` root | Primary |
| **Auto (fallback)** | Spectral clustering on graph degree for files outside any package boundary | Fallback |
| **Manual** | `.context-graph.yml` annotations: `container: billing-service` | Override |

---

## 2. Data Model

### 2.1 Symbol Identity (not Node ID)

Current scaffold uses unstable positional IDs:

```ts
`${filePath}::${kind}::${name}::${start}`  // BREAKS ON ANY LINE CHANGE
```

V2 uses **identity + version** with lineage tracking:

```typescript
interface SymbolIdentity {
  stableId: string;              // repo + language + qualified-name
  versionHash: string;           // SHA-256(content) — changes when body changes
  filePath: string;
  previousStableId?: string;     // null on creation, set on rename/move
  previousVersionHash?: string;  // previous versionHash for diff
}

function stableId(
  repoRoot: string,
  language: string,
  qualifiedName: string
): string {
  return createHash("sha256")
    .update(repoRoot)
    .update("\0")
    .update(language)
    .update("\0")
    .update(qualifiedName)
    .digest("hex")
    .slice(0, 32);  // 128 bits — collision probability ~10^-24 at 1M nodes
}
```

For anonymous functions, use an enclosing-symbol path plus an AST structural fingerprint.

### 2.2 Node Types

```typescript
type NodeKind =
  // Structural
  | "file" | "module" | "namespace" | "package"

  // Declarations
  | "function" | "method" | "class" | "interface"
  | "type" | "enum" | "enum_member" | "property"
  | "field" | "variable" | "parameter" | "constructor"
  | "getter" | "setter"

  // Contract / Framework
  | "route" | "middleware" | "db_table" | "db_column"
  | "graphql_type" | "graphql_field" | "event"

  // Configuration
  | "config_key" | "env_var" | "secret"

  // Build / Deploy
  | "workspace" | "service" | "build_target"
  | "generated_artifact" | "external_dependency"

  // Dynamic / Unresolved
  | "dynamic_target" | "placeholder";
```

### 2.3 Edge Types — Start With 17

**Proven by syntax** (tree-sitter or regex):
```text
VERIFIED_STATIC: CONTAINS
VERIFIED_STATIC: IMPORTS
VERIFIED_STATIC: EXPORTS
VERIFIED_STATIC: EXTENDS
VERIFIED_STATIC: IMPLEMENTS
VERIFIED_STATIC: REFERENCES
VERIFIED_STATIC: CALLS            (cross-file via import resolution)
VERIFIED_STATIC: EXPOSES_ROUTE    (regex: app.get/post/...)
VERIFIED_STATIC: CONSUMES_ROUTE   (regex: fetch/axios)
VERIFIED_STATIC: EMITS_EVENT      (regex: emit/publish)
VERIFIED_STATIC: CONSUMES_EVENT   (regex: on/subscribe)
```

**Proven by TS Compiler API** (per-tsconfig `TypeChecker`):
```text
VERIFIED_STATIC: REFERENCES       (type-aware, cross-file)
VERIFIED_STATIC: CALLS            (type-aware, verified target)
```

**Proven by schema adapter** (Prisma, OpenAPI, GraphQL):
```text
VERIFIED_STATIC: READS_TABLE
VERIFIED_STATIC: WRITES_TABLE
VERIFIED_STATIC: CONSUMES_API
VERIFIED_STATIC: EXPOSES_API
```

**Proven by manifest** (package.json, workspace config):
```text
VERIFIED_STATIC: DEPENDS_ON_PACKAGE
```

**Unresolved** (tracked, never guessed):
```text
UNRESOLVED: UNRESOLVED_CALL
UNRESOLVED: UNRESOLVED_IMPORT
```

**Total: 15 VERIFIED_STATIC + 2 UNRESOLVED = 17 edges.**

Add an edge only when a benchmark proves its absence causes retrieval failures.

### 2.4 Verification Taxonomy (4-tier)

Not all "deterministic" claims are equal. Four distinct tiers:

```typescript
type VerificationTier =
  | "VERIFIED_STATIC"     // Proven by parser, compiler, schema adapter, or manifest
  | "VERIFIED_RUNTIME"    // Observed in trace, test coverage, or profiler evidence
  | "UNRESOLVED"          // Dynamic target, ambiguous import, framework convention not resolved
  | "ANNOTATION_ONLY";    // Heuristic match, embedding result, LLM-generated label (never in V1)
```

**Rules**:
- `VERIFIED_STATIC` and `VERIFIED_RUNTIME` live in the main edge table
- `UNRESOLVED` is tracked in a separate table, never assumed
- `ANNOTATION_ONLY` is excluded from V1 entirely
- Traversal policies filter by minimum verification tier

### 2.5 Edge Schema

```typescript
interface CodeEdge {
  id?: number;                   // auto-increment, for evidence linking
  sourceId: string;              // stableId
  targetId: string;              // stableId
  kind: string;                  // e.g., "CALLS"
  verificationTier: VerificationTier;
  sourceMethod: SourceMethod;    // how it was proven
}

type SourceMethod =
  | "tree-sitter"
  | "typescript-compiler"
  | "regex-contract"
  | "framework-adapter"
  | "schema-adapter"
  | "manifest"
  | "runtime-trace"
  | "test-trace"
  | "manual";
```

### 2.6 Edge Evidence (separate from edge)

Multiple observations of the same edge do not overwrite — they accumulate:

```typescript
interface EdgeEvidence {
  id: number;
  edgeId: number;                // FK to edges table
  sourceMethod: SourceMethod;
  sourceRef: string;             // file:line or trace-id
  environment?: string;          // "test" | "production" | "ci"
  commitHash?: string;
  observedAt: string;            // ISO timestamp
  metadata?: Record<string, unknown>;
}
```

This preserves the full provenance:

```text
checkoutService → StripeProvider
  Evidence 1: compiler-resolved (commit abc123)
  Evidence 2: observed in integration test (commit def456)
  Evidence 3: observed in production trace (trace-id xyz)
```

### 2.7 Containers Schema

```typescript
interface Container {
  id: string;
  kind: "physical" | "feature" | "relation";
  name: string;
  parentId?: string;
  graphVersion: number;          // incremented on any member change
  dirty: boolean;
  summary?: string;              // human-readable description
  createdAt: string;
  updatedAt: string;
}

interface ContainerMember {
  containerId: string;
  nodeId: string;                // stableId
  role: "entry" | "core" | "dependency" | "peripheral";
}

interface SliceCache {
  cacheKey: string;              // hash(policy + entryIds + graphVersion)
  policy: string;
  entryIdsJson: string;
  graphVersion: number;
  compiledSliceJson: string;     // serialized ContextSlice
  dirty: boolean;                // invalidated when member nodes change
  createdAt: string;
}
```

---

## 3. Verification Taxonomy — Detailed

### What Each Source Can Prove

| Source | Can Prove | Cannot Prove |
|---|---|---|
| **tree-sitter** | CONTAINS, IMPORTS (specifier), EXTENDS (keyword), IMPLEMENTS (keyword), CALLS (same-file), EXPORTS | Cross-file CALLS target, type resolution, overload dispatch |
| **TS Compiler API** (per-tsconfig) | All of the above + cross-file REFERENCES, CALLS to verified target, type-aware EXTENDS/IMPLEMENTS | Dynamic dispatch target, runtime behavior |
| **Schema adapter** (Prisma) | READS_TABLE, WRITES_TABLE, column mappings | Runtime query patterns, row-level access |
| **Schema adapter** (OpenAPI) | EXPOSES_API, CONSUMES_API, endpoint → handler linkage | Authentication behavior, error paths |
| **Manifest** (package.json) | DEPENDS_ON_PACKAGE, workspace boundaries | Actual usage of the dependency |
| **Regex** (contract patterns) | EXPOSES_ROUTE, CONSUMES_ROUTE, EMITS_EVENT | Handler linkage (handler function name is guessed) |
| **Runtime trace** (OTel) | OBSERVED_CALL, OBSERVED_LATENCY, data flow for instrumented spans | Causality for un-instrumented code |
| **Test trace** | OBSERVED_CALL (test-specific), coverage edges | Production behavior |

### The Chicken-and-Egg Problem (Fixed)

V1 proposed: tree-sitter → slice → TS Compiler API deepen on sliced files.

**This fails when the shallow graph misses the edge needed to retrieve the correct file.**

V2 fix — **two persistent levels**:

```
Level A: syntax graph (tree-sitter)
  — always runs, covers every file
  — proven edges only: CONTAINS, IMPORTS, EXPORTS, EXTENDS, IMPLEMENTS, same-file CALLS
  — also stores: all UNRESOLVED_CALL, UNRESOLVED_IMPORT

Level B: symbol resolution (TS Compiler API per tsconfig.json)
  — runs on every file in the tsconfig scope
  — adds: cross-file CALLS, type-aware REFERENCES, verified EXTENDS/IMPLEMENTS
  — one small Program per workspace package (50-200 files, ~50MB each)
```

Level B is not on-demand. It runs at index time, but in small units per `tsconfig.json`. A 100-package monorepo has 100 small Programs, not one massive one.

On-demand deepening is reserved only for expensive **data-flow analysis**, not basic cross-file correctness.

---

## 4. SQLite Schema

```sql
-- 4.1 Nodes
CREATE TABLE IF NOT EXISTS nodes (
  stable_id TEXT PRIMARY KEY,           -- SHA-256(repo + lang + qualified-name), 128 bits
  version_hash TEXT NOT NULL,           -- SHA-256(body) — changes on content change
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,
  language TEXT NOT NULL DEFAULT 'typescript',
  visibility TEXT DEFAULT 'public',
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_deprecated INTEGER DEFAULT 0,
  is_generated INTEGER DEFAULT 0,       -- skip from default slices
  doc_comment TEXT,
  indexed_at TEXT NOT NULL,
  previous_stable_id TEXT,
  previous_version_hash TEXT
);

-- 4.2 Edges
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES nodes(stable_id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES nodes(stable_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- CALLS, IMPORTS, etc.
  verification_tier TEXT NOT NULL DEFAULT 'VERIFIED_STATIC',
  UNIQUE(source_id, target_id, kind)    -- one edge record, multiple evidence rows
);

-- 4.3 Edge Evidence (provenance, not overwrite)
CREATE TABLE IF NOT EXISTS edge_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_id INTEGER NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  source_method TEXT NOT NULL,          -- tree-sitter, typescript-compiler, schema-adapter, etc.
  source_ref TEXT,                      -- file:line or trace-id
  environment TEXT,                     -- test, production, ci
  commit_hash TEXT,
  observed_at TEXT,
  metadata_json TEXT
);

-- 4.4 Unresolved (tracked separately, never mixed with verified)
CREATE TABLE IF NOT EXISTS unresolved_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES nodes(stable_id) ON DELETE CASCADE,
  expression TEXT NOT NULL,             -- original call expression or import specifier
  kind TEXT NOT NULL,                   -- UNRESOLVED_CALL or UNRESOLVED_IMPORT
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  candidates_json TEXT,                 -- possible matches (not proven)
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_edge_id INTEGER             -- null until confirmed, then links to edges.id
);

-- 4.5 Containers
CREATE TABLE IF NOT EXISTS containers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- physical, feature, relation
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES containers(id),
  graph_version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4.6 Container Members
CREATE TABLE IF NOT EXISTS container_members (
  container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(stable_id) ON DELETE CASCADE,
  role TEXT NOT NULL,                   -- entry, core, dependency, peripheral
  PRIMARY KEY(container_id, node_id)
);

-- 4.7 Slice Cache
CREATE TABLE IF NOT EXISTS slice_cache (
  cache_key TEXT PRIMARY KEY,           -- SHA-256(policy + entryIds + graphVersion)
  policy TEXT NOT NULL,
  entry_ids_json TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  compiled_slice_json TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 4.8 Import Index (for reverse invalidation)
CREATE TABLE IF NOT EXISTS imports_index (
  importer_path TEXT NOT NULL,
  imported_specifier TEXT NOT NULL,     -- raw "./auth"
  resolved_target TEXT NOT NULL,        -- resolved "src/auth.ts"
  PRIMARY KEY(importer_path, imported_specifier)
);

-- 4.9 Indexed Files
CREATE TABLE IF NOT EXISTS indexed_files (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

-- 4.10 Security Exclusions
CREATE TABLE IF NOT EXISTS security_exclusions (
  pattern TEXT PRIMARY KEY,             -- glob pattern
  reason TEXT NOT NULL,                 -- binary, generated, secret, vendor, etc.
  action TEXT NOT NULL                  -- skip, redact, truncate
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_file_idx ON nodes(file_path);
CREATE INDEX IF NOT EXISTS nodes_lang_idx ON nodes(language);
CREATE INDEX IF NOT EXISTS nodes_name_idx ON nodes(name);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS edges_tier_idx ON edges(verification_tier);
CREATE INDEX IF NOT EXISTS edges_evidence_edge_idx ON edge_evidence(edge_id);
CREATE INDEX IF NOT EXISTS containers_parent_idx ON containers(parent_id);
CREATE INDEX IF NOT EXISTS container_members_cid_idx ON container_members(container_id);
CREATE INDEX IF NOT EXISTS container_members_nid_idx ON container_members(node_id);
CREATE INDEX IF NOT EXISTS imports_target_idx ON imports_index(resolved_target);
CREATE INDEX IF NOT EXISTS slice_cache_dirty_idx ON slice_cache(dirty);

-- FTS5 for symbol search
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  stable_id UNINDEXED, name, signature, file_path,
  content='nodes', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, stable_id, name, signature, file_path)
  VALUES (new.rowid, new.stable_id, new.name, new.signature, new.file_path);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, stable_id, name, signature, file_path)
  VALUES ('delete', old.rowid, old.stable_id, old.name, old.signature, old.file_path);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, stable_id, name, signature, file_path)
  VALUES ('delete', old.rowid, old.stable_id, old.name, old.signature, old.file_path);
  INSERT INTO nodes_fts(rowid, stable_id, name, signature, file_path)
  VALUES (new.rowid, new.stable_id, new.name, new.signature, new.file_path);
END;

-- Pragmas
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;       -- 64MB
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

### Key Queries

```sql
-- Reverse invalidation: which files import the changed file?
SELECT importer_path FROM imports_index WHERE resolved_target = ?;

-- Find all containers affected by a changed file
SELECT DISTINCT c.* FROM containers c
JOIN container_members cm ON cm.container_id = c.id
JOIN nodes n ON n.stable_id = cm.node_id
WHERE n.file_path = ?;

-- Get slice from cache (fast path)
SELECT compiled_slice_json FROM slice_cache
WHERE cache_key = ? AND dirty = 0 AND graph_version = ?;

-- All evidence for an edge
SELECT * FROM edge_evidence WHERE edge_id = ? ORDER BY observed_at;

-- Unresolved edges that may now be resolvable
SELECT u.* FROM unresolved_edges u
WHERE u.last_seen_at < datetime('now', '-7 days');
```

---

## 5. Architecture

### 5.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CONTEXT COMPILER                              │
│                                                                         │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐   ┌───────────────┐  │
│  │ Indexer  │──▶│  Container   │──▶│  Slice     │──▶│  MCP Server   │  │
│  │ Engine   │   │  Builder     │   │  Compiler  │   │  (stdio)      │  │
│  └──────────┘   └──────────────┘   └────────────┘   └───────────────┘  │
│       │                │                │                               │
│       ▼                ▼                ▼                               │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │                  Graph Store (SQLite)                     │          │
│  │  nodes │ edges │ edge_evidence │ unresolved │ containers  │          │
│  │  container_members │ slice_cache │ imports_index │ fts    │          │
│  └──────────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
        │                      │
        ▼                      ▼
┌───────────────┐   ┌──────────────────┐
│  Repo on Disk │   │  AI Agent        │
│  (watched)    │   │  (Claude/Cursor) │
└───────────────┘   └──────────────────┘
```

### 5.2 Indexer Engine

```
Two persistent passes:

Level A (syntax — always):
  tree-sitter parser per file
  → nodes (functions, classes, imports, exports)
  → edges (CONTAINS, IMPORTS specifier, EXTENDS, IMPLEMENTS)
  → UNRESOLVED_CALL for cross-file or dynamic calls
  → UNRESOLVED_IMPORT for non-resolved module specifiers

Level B (resolution — per tsconfig.json):
  TypeScript Program + TypeChecker per tsconfig
  → resolves import specifiers to real file paths
  → resolves CALLS to verified cross-file targets
  → adds type-aware EXTENDS / IMPLEMENTS
  → populates imports_index for reverse invalidation

Contract adapters (per file):
  → OpenAPI → EXPOSES_API / CONSUMES_API
  → Prisma schema → READS_TABLE / WRITES_TABLE
  → package.json → DEPENDS_ON_PACKAGE

Schema adapters (framework-specific):
  → Express/Fastify routes → EXPOSES_ROUTE
  → fetch/axios → CONSUMES_ROUTE
  → EventEmitter → EMITS_EVENT / CONSUMES_EVENT
```

### 5.3 Incremental Update (Reverse Invalidation)

```text
File A edited
  → content hash changed
  → Level A: re-parse File A (tree-sitter), diff old vs new stableIds
  → Level B: re-resolve File A in its tsconfig scope

  → DELETE removed nodes (FK cascade removes their edges)
  → UPSERT new/modified nodes
  → UPSERT new/modified edges

  → LOOK UP imports_index WHERE resolved_target = File A
  → FOR EACH importer:
      → mark the importer's container as dirty
      → re-resolve the importer's UNRESOLVED_IMPORT / UNRESOLVED_CALL

  → File A's PHYSICAL_CONTAINER marked dirty
  → All FEATURE_CONTAINERs containing File A marked dirty
  → All RELATION_CONTAINERs traversing dirty containers marked dirty
  → All SLICE_CACHE entries referencing dirty containers marked dirty
```

### 5.4 Container Builder

```typescript
class ContainerBuilder {
  buildPhysicalContainers(): void {
    // One per workspace package, service directory, or tsconfig root
    for (const group of detectPackageBoundaries()) {
      const nodes = this.store.getNodesByFileGroup(group.files);
      this.store.upsertContainer({
        id: `physical:${group.name}`,
        kind: "physical",
        name: group.name,
        members: nodes.map(n => ({ nodeId: n.stableId, role: "core" })),
      });
    }
  }

  buildRelationContainers(): void {
    // Walk contract edges to build frontend→API→service→DB paths
    const routes = this.store.getEdgesByKind("EXPOSES_ROUTE");
    for (const route of routes) {
      const path = this.traceContractPath(route);
      this.store.upsertContainer({
        id: `relation:${path.join("→")}`,
        kind: "relation",
        name: path.join(" → "),
        members: path.map((n, i) => ({
          nodeId: n.stableId,
          role: i === 0 ? "entry" : i === path.length - 1 ? "core" : "dependency"
        })),
      });
    }
  }

  private traceContractPath(route: Edge): ContainerMember[] {
    // EXPOSES_ROUTE → handler → CALLS → service → READS_TABLE
    // Returns ordered list of nodes along the contract path
  }
}
```

---

## 6. Traversal & Slicing

### 6.1 Policy-Specific Traversal (not generic BFS)

```typescript
interface TraversalPolicy {
  name: string;
  verificationTier?: VerificationTier;  // minimum tier to include
  steps: TraversalStep[];               // ordered traversal steps, not flat BFS
  maxNodes: number;
  maxTokens: number;
}

interface TraversalStep {
  edgeKinds: string[];
  direction: "forward" | "backward" | "both";
  maxDepth: number;
  hubStopRules?: {                       // prevent explosion around hubs
    maxEdgesPerNode: number;              // e.g., 20 — don't follow all edges from logger
    stopNodePatterns: string[];           // e.g., ["log*", "config", "User", "*Controller"]
    stopAtContainerBoundary: boolean;     // don't traverse outside container
  };
  mandatoryRoles?: string[];             // "entry", "core" — always include
}

const POLICIES: Record<string, TraversalPolicy> = {
  function_edit: {
    name: "function_edit",
    verificationTier: "VERIFIED_STATIC",
    steps: [
      { edgeKinds: ["CONTAINS"], direction: "forward", maxDepth: 1 },
      { edgeKinds: ["CALLS"], direction: "both", maxDepth: 2,
        hubStopRules: { maxEdgesPerNode: 15, stopAtContainerBoundary: true }},
      { edgeKinds: ["REFERENCES"], direction: "forward", maxDepth: 1 },
      { edgeKinds: ["TESTS"], direction: "both", maxDepth: 1 },
    ],
    maxNodes: 80,
    maxTokens: 16000,
  },

  endpoint_edit: {
    name: "endpoint_edit",
    verificationTier: "VERIFIED_STATIC",
    steps: [
      { edgeKinds: ["EXPOSES_ROUTE", "CONSUMES_ROUTE"], direction: "forward", maxDepth: 1 },
      { edgeKinds: ["CONTAINS"], direction: "forward", maxDepth: 1 },
      { edgeKinds: ["CALLS"], direction: "forward", maxDepth: 3,
        hubStopRules: { maxEdgesPerNode: 20, stopAtContainerBoundary: true }},
      { edgeKinds: ["READS_TABLE", "WRITES_TABLE"], direction: "forward", maxDepth: 1 },
      { edgeKinds: ["TESTS"], direction: "both", maxDepth: 1 },
    ],
    maxNodes: 120,
    maxTokens: 24000,
  },

  schema_edit: {
    name: "schema_edit",
    verificationTier: "VERIFIED_STATIC",
    steps: [
      { edgeKinds: ["READS_TABLE", "WRITES_TABLE"], direction: "backward", maxDepth: 2 },
      { edgeKinds: ["CALLS"], direction: "backward", maxDepth: 1 },
      { edgeKinds: ["CONSUMES_API"], direction: "backward", maxDepth: 1 },
      { edgeKinds: ["TESTS"], direction: "both", maxDepth: 1 },
    ],
    maxNodes: 100,
    maxTokens: 20000,
  },

  impact: {
    name: "impact",
    verificationTier: "VERIFIED_STATIC",
    steps: [
      { edgeKinds: ["CALLS", "REFERENCES", "IMPORTS"], direction: "both", maxDepth: 4,
        hubStopRules: { maxEdgesPerNode: 30, stopNodePatterns: ["log*", "config"], stopAtContainerBoundary: true }},
      { edgeKinds: ["READS_TABLE", "WRITES_TABLE", "EXPOSES_ROUTE", "CONSUMES_ROUTE"], direction: "both", maxDepth: 2 },
      { edgeKinds: ["TESTS"], direction: "both", maxDepth: 2 },
    ],
    maxNodes: 200,
    maxTokens: 32000,
  },
};
```

### 6.2 Slice Compiler

```typescript
function compileSlice(
  store: GraphStore,
  entryNodeIds: string[],
  policy: TraversalPolicy
): ContextSlice {
  // 1. Check cache first
  const cacheKey = makeCacheKey(policy.name, entryNodeIds, store.getGraphVersion());
  const cached = store.getSliceCache(cacheKey);
  if (cached && !cached.dirty) {
    return JSON.parse(cached.compiledSliceJson);
  }

  // 2. Step-by-step traversal (not flat BFS)
  const seen = new Set<string>(entryNodeIds);
  const edges: CodeEdge[] = [];

  for (const step of policy.steps) {
    const queue = [...seen].map(id => ({ id, depth: 0 }));

    while (queue.length > 0 && seen.size < policy.maxNodes) {
      const current = queue.shift()!;
      if (current.depth >= step.maxDepth) continue;

      const nextEdges = step.direction === "forward"
        ? store.outgoing(current.id, step.edgeKinds)
        : step.direction === "backward"
          ? store.incoming(current.id, step.edgeKinds)
          : [...store.outgoing(current.id, step.edgeKinds),
             ...store.incoming(current.id, step.edgeKinds)];

      // Apply hub stop rules
      const limited = step.hubStopRules
        ? nextEdges.slice(0, step.hubStopRules.maxEdgesPerNode)
        : nextEdges;

      for (const edge of limited) {
        edges.push(edge);
        const nextId = edge.sourceId === current.id ? edge.targetId : edge.sourceId;

        if (!seen.has(nextId) && seen.size < policy.maxNodes) {
          // Check container boundary stop rule
          if (step.hubStopRules?.stopAtContainerBoundary) {
            const inBoundary = store.areInSameContainer(current.id, nextId);
            if (!inBoundary) continue;
          }
          seen.add(nextId);
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }
  }

  const uniqueEdges = deduplicateEdges(edges);

  // 3. Build result
  const slice = {
    policy: policy.name,
    entryNodeIds,
    nodes: store.getNodes([...seen]),
    edges: uniqueEdges,
    unresolved: store.getUnresolvedForNodes([...seen]),
    stats: { /* ... */ },
  };

  // 4. Cache it
  store.upsertSliceCache(cacheKey, policy.name, entryNodeIds, store.getGraphVersion(), slice);

  return slice;
}
```

### 6.3 Hub Node Protection

Highly-connected nodes (logger, User, config, BaseController) explode the BFS. V2 handles them with:

1. **`maxEdgesPerNode`** — per-step limit on how many edges to follow from a single node
2. **`stopNodePatterns`** — glob patterns for nodes to never traverse beyond (log*, config, *Client)
3. **`stopAtContainerBoundary`** — don't follow edges across container boundaries (noise reduction)
4. **Mandatory inclusion tiers** — Tier 0 nodes (entry, contract) are always included regardless of stop rules

---

## 7. Rendering & Budget

### 7.1 Deterministic Inclusion Tiers (not popularity scoring)

```
Tier 0 — ALWAYS INCLUDE (full body)
  target node(s)
  exact contract node (route, DB table)
  changed source lines
  entry node from query

Tier 1 — INCLUDE RAW BODY (full source)
  direct dependency path
  direct callers (1 hop backward)
  direct callees (1 hop forward)
  relevant tests

Tier 2 — SIGNATURE ONLY
  adjacent types
  peripheral implementations
  alternative dynamic candidates
  nodes at depth ≥ 3

Tier 3 — OMIT UNLESS EXPANDED
  generic hubs (logger, config, *Client)
  unrelated consumers
  distant shared utilities
```

### 7.2 Token Budget

```typescript
class TokenBudget {
  private budget: number;
  private used = 0;
  private safetyMargin: number;  // 0.25 = 25% safety margin

  constructor(maxTokens: number, safetyMargin = 0.25) {
    this.budget = Math.floor(maxTokens * (1 - safetyMargin));
  }

  tryAllocate(text: string): boolean {
    const tokens = this.countTokens(text);
    if (this.used + tokens > this.budget) return false;
    this.used += tokens;
    return true;
  }

  private countTokens(text: string): number {
    // Use model-specific tokenizer if available
    // Fallback: ~4 chars per token with 30% safety margin
    return Math.ceil(text.length / 4);
  }
}
```

### 7.3 Rendering Rules

```
For function_edit policy:
  Tier 0: full body of target function
  Tier 1: full body of direct callers and callees
  Tier 2: signature only for peripheral nodes
  Tier 3: omitted
  Diff: appended as annotation section, NOT replacing source

For endpoint_edit policy:
  Tier 0: full route handler, full API client call site
  Tier 1: full service function bodies
  Tier 2: signature only for DB queries, middleware
  Tier 3: omitted
  Diff: shown as annotation

For schema_edit policy:
  Tier 0: full table/column definition
  Tier 1: full reader/writer function bodies
  Tier 2: signature only for callers 2+ hops away
  Tier 3: omitted
```

### 7.4 Diff Rendering (appended, not replacing)

```diff
--- before
+++ after
@@ -12,5 +12,7 @@
   function calculateTotal(items: Item[]) {
     const subtotal = items.reduce((sum, item) => sum + item.price, 0);
-    const tax = subtotal * 0.08;
+    const taxRate = getTaxRate(items[0].region);
+    const tax = subtotal * taxRate;
     return subtotal + tax;
   }
```

The diff is an **annotation section** appended to the output. Full source of Tier 0-1 nodes is always rendered.

---

## 8. Security

### 8.1 Exclusion Rules

```typescript
const SECURITY_EXCLUSIONS = [
  { pattern: "**/node_modules/**", reason: "vendor", action: "skip" },
  { pattern: "**/.git/**", reason: "vendor", action: "skip" },
  { pattern: "**/dist/**", reason: "generated", action: "skip" },
  { pattern: "**/.env*", reason: "secret", action: "redact" },
  { pattern: "**/*.pem", reason: "secret", action: "skip" },
  { pattern: "**/*.key", reason: "secret", action: "skip" },
  { pattern: "**/*.min.js", reason: "generated", action: "skip" },
  { pattern: "**/*.bundle.js", reason: "generated", action: "skip" },
  { pattern: "**/*.min.css", reason: "generated", action: "skip" },
  { pattern: "**/coverage/**", reason: "generated", action: "skip" },
];
```

| Action | Behavior |
|---|---|
| `skip` | File is not indexed at all. Not in graph. |
| `redact` | File is indexed but values matching secret patterns are replaced with `[REDACTED]` in the source excerpt. |
| `truncate` | File is indexed but only first N bytes are stored (for large files >1MB). |

### 8.2 Path Traversal Guard

```typescript
function guardPath(userPath: string, repoRoot: string): string {
  const resolved = path.resolve(repoRoot, userPath);
  if (!resolved.startsWith(path.resolve(repoRoot))) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}
```

### 8.3 File Size Limit

```typescript
const MAX_FILE_SIZE = 1_000_000;  // 1MB

function safeReadFile(absPath: string): string | null {
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_FILE_SIZE) {
    console.warn(`Skipping oversized file: ${absPath} (${stat.size} bytes)`);
    return null;
  }
  // Also check magic bytes for binary
  const buffer = Buffer.alloc(512);
  const fd = fs.openSync(absPath, 'r');
  fs.readSync(fd, buffer, 0, 512, 0);
  fs.closeSync(fd);
  if (isBinary(buffer)) {
    console.warn(`Skipping binary file: ${absPath}`);
    return null;
  }
  return fs.readFileSync(absPath, "utf8");
}
```

### 8.4 Secret Redaction

```typescript
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|password|token|credential)s?\s*[:=]\s*['"][^'"]+['"]/gi,
  /(?:-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----)/g,
  /(?:ghp_|gho_|github_pat_)[a-zA-Z0-9]{36,}/g,
  /(?:sk-[a-zA-Z0-9]{20,})/g,  // OpenAI keys
];

function redactSecrets(text: string): string {
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match: string) => {
      const parts = match.split(/[:=]\s*/);
      return parts.length > 1 ? `${parts[0]}: [REDACTED]` : "[REDACTED]";
    });
  }
  return text;
}
```

---

## 9. Implementation Phases

### Phase 1 — Correctness Before Scale (TypeScript only)

**Goal**: Prove the loop works for ONE language before adding complexity.

| Task | Detail | Deliverable |
|---|---|---|
| 1.1 | Stable 128-bit symbol IDs with lineage | `SymbolIdentity`, `stableId()`, `versionHash` |
| 1.2 | Real cross-file module resolution (per tsconfig) | `resolver.ts` — resolves `./auth` → `src/auth.ts` |
| 1.3 | Level A: tree-sitter syntax pass for all TS/JS files | `tree-sitter-indexer.ts` — CONTAINS, IMPORTS, EXTENDS, IMPLEMENTS |
| 1.4 | Level B: TS Compiler API per tsconfig.json | `tsc-indexer.ts` — cross-file CALLS, type-aware REFERENCES |
| 1.5 | Replace `filePath::kind::name::start` IDs everywhere | Migrate `indexer.ts`, `db.ts`, `traversal.ts` |
| 1.6 | Reverse invalidation: `imports_index` + dirty propagation | `invalidator.ts` — edit file B, re-index file A's references |
| 1.7 | 17-edge set (no more) | `types.ts` — 15 VERIFIED_STATIC + 2 UNRESOLVED |
| 1.8 | Edge evidence table (provenance, not overwrite) | `edge_evidence` table, `store.addEvidence()` |
| 1.9 | Handle file deletion, rename, move, branch switch | `watcher.ts` + `invalidator.ts` |
| 1.10 | 50 mutation tests | `test/mutation/` — save, delete, rename, change function, change signature |

**Exit gate**: Zero stale edges after save, delete, rename, and branch switch. ≥95% recall on manually labeled 50-task gold set.

### Phase 2 — Relation Containers

| Task | Detail | Deliverable |
|---|---|---|
| 2.1 | Container discovery (convention + auto + manual) | `container-builder.ts` — workspace packages, service dirs |
| 2.2 | Physical container creation | `physical` containers mapping to packages |
| 2.3 | Feature container creation | Cross-cutting containers derived from runtime traces |
| 2.4 | Relation container creation | `relation` containers via contract-path tracing |
| 2.5 | Container membership + role assignment | `container_members` table, role heuristics |
| 2.6 | Dirty propagation across containers | `dirty` flag cascading: node → physical → feature → relation |
| 2.7 | Slice cache | `slice_cache` table, cache-key computation, invalidation |

**Exit gate**: Common tasks retrieve cached relation containers. Cache invalidates correctly after edits.

### Phase 3 — Contract Bridges

| Task | Detail | Deliverable |
|---|---|---|
| 3.1 | Express / Fastify / Next.js route extractor | `contracts/express.ts` — EXPOSES_ROUTE |
| 3.2 | fetch / axios / Apollo client extractor | `contracts/http-client.ts` — CONSUMES_ROUTE |
| 3.3 | OpenAPI schema adapter | `contracts/openapi.ts` — EXPOSES_API, CONSUMES_API |
| 3.4 | GraphQL schema adapter | `contracts/graphql.ts` — type/field/resolver edges |
| 3.5 | Prisma / Drizzle / TypeORM adapter | `contracts/orm.ts` — READS_TABLE, WRITES_TABLE |
| 3.6 | SQL migration parser | `contracts/migrations.ts` — schema evolution edges |
| 3.7 | Event / queue adapter | `contracts/events.ts` — EMITS_EVENT, CONSUMES_EVENT |
| 3.8 | Environment variable extractor | `contracts/config.ts` — USES_ENV |

**Exit gate**: Frontend → API → service → DB path traced correctly. ≥90% recall on cross-contract gold set.

### Phase 4 — Context Compiler

| Task | Detail | Deliverable |
|---|---|---|
| 4.1 | Policy-specific traversal engine (step-based, not BFS) | `traversal.ts` rewrite — ordered steps, hub stop rules |
| 4.2 | Tier-based rendering (Tier 0-3) | `render.ts` rewrite — full body / signature / omit |
| 4.3 | Exact token budgeting with safety margin | `budget.ts` — model-specific tokenizer or fallback |
| 4.4 | Diff-as-annotation section (not replacement) | `render-diff.ts` |
| 4.5 | Expand-slice tool (MCP) | `mcp/tools.ts` — promote Tier 2→Tier 1 on demand |

**Exit gate**: Task success within 5pp of baseline agent. ≥50% token reduction.

### Phase 5 — Runtime Evidence

| Task | Detail | Deliverable |
|---|---|---|
| 5.1 | Integration-test trace importer | `runtime/tests.ts` — OBSERVED_CALL edges |
| 5.2 | OpenTelemetry span importer | `runtime/otel.ts` — trace edges separate from static |
| 5.3 | Coverage importer | `runtime/coverage.ts` — COVERS_LINE edges |

**Exit gate**: Dynamic targets become traceable without erasing unresolved alternatives.

### Phase 6 — Multi-Language Expansion

| Task | Detail | Deliverable |
|---|---|---|
| 6.1 | Python indexer (tree-sitter) | `indexers/python.ts` |
| 6.2 | Rust indexer (tree-sitter) | `indexers/rust.ts` |
| 6.3 | Go indexer (tree-sitter) | `indexers/go.ts` |
| 6.4 | Java indexer (tree-sitter) | `indexers/java.ts` |

Each language gets its own indexer, but all share the same graph store, containers, traversal, and rendering.

---

## 10. Benchmarking

### 10.1 Three-Layer Benchmark

```
Layer 1: Unit fixtures
  → Extractor correctness
  → Each edge kind tested independently
  → Example: "import { login } from './auth'" → IMPORTS edge to resolved path

Layer 2: Mutation fixtures
  → Stale edge detection
  → Rename, delete, move, change signature, change body
  → Confirm old edges removed, new edges appear, unrelated unchanged

Layer 3: Real repositories + real patches
  → Historical commits as gold cases
  → Example: issue description → expected changed files from real patch
  → Run agent against pre-fix commit → execute project tests
```

### 10.2 Gold Case Format

```json
{
  "name": "add-rate-limiting-to-login",
  "repo": "express-starter",
  "entry_query": "POST /api/login",
  "policy": "endpoint_edit",
  "required_nodes": [
    "route:POST /api/login",
    "handler:loginHandler",
    "function:rateLimiter",
    "middleware:rateLimitMiddleware",
    "config:RATE_LIMIT_WINDOW"
  ],
  "forbidden_nodes": [
    "function:sendWelcomeEmail",
    "function:generateInvoice"
  ],
  "maximum_context_tokens": 24000
}
```

### 10.3 Metrics

| Metric | How | Phase |
|---|---|---|
| **Edge correctness** | Mutation tests: insert file, edit, delete, rename → check stale edges | Phase 1 pass |
| **Required-node recall** | % of required_nodes found in slice | Phase 1 track |
| **Forbidden-node precision** | % of forbidden_nodes absent from slice | Phase 1 track |
| **Index time (10k LOC)** | `performance.now()` around full index | Phase 1 track |
| **Index time (100k LOC)** | `performance.now()` around full index | Phase 4 target: <60s |
| **Slice cache hit rate** | % of requests served from cache without traversal | Phase 2 track |
| **Cache invalidation correctness** | After edit, stale cache entries are dirty | Phase 2 pass |
| **Incremental update latency** | Single file edit → all containers updated | Phase 1 track |
| **Token reduction vs baseline** | Compare slice size with/without budget engine | Phase 4 track |
| **Agent task success** | Agent A/B: graph-first vs grep-first, same task | Phase 4 track |
| **Test pass rate** | After agent edit, project tests still pass | Phase 4 pass |

---

## 11. Architecture Decision Records

### ADR-1: tree-sitter over TS Compiler API for Level A

**Decision**: Level A (syntax pass) uses tree-sitter. Level B (resolution pass) uses TS Compiler API per tsconfig.

**Reason**: tree-sitter is 10-50x faster, supports 40+ languages, error-tolerant, incremental. TypeScript Compiler API is correct but too expensive for every file. Per-tsconfig Programs are the middle ground: small enough to be fast, comprehensive enough to resolve cross-file calls.

**Consequence**: Level A cannot do type-aware resolution. Level B covers that per-tsconfig.

### ADR-2: SQLite over Graph Database

**Decision**: SQLite + recursive CTEs. No graph DB until benchmark proves otherwise.

**Reason**: SQLite handles million-node graphs efficiently with proper schema. No server process, no config, no backup ops. Add one only when traversal benchmarks show it's the bottleneck.

**Consequence**: Graph queries are CTEs instead of Cypher. Equivalent expressiveness for bounded traversals.

### ADR-3: 128-bit Content-Hash IDs over Positional IDs

**Decision**: `SHA-256(repo + language + qualified-name) → 128 bits` as `stableId`. Separate `versionHash` for content tracking.

**Reason**: Positional IDs break on any line edit. Simple content hash also changes on rename/move. Separating identity from version enables lineage tracking and preserves references across edits.

**Consequence**: Collision probability at 1M nodes is ~10^-24 (effectively zero). More complex ID generation but deterministic across machines.

### ADR-4: Relation Containers over Flat Graph Retrieval

**Decision**: The graph calculates containers. Containers are the retrieval unit. Cache before traversal.

**Reason**: Flat BFS on every request is wasteful. Common tasks repeatedly walk the same paths. Pre-compiled containers with versioning and dirty propagation eliminate redundant traversal.

**Consequence**: More schema complexity (5 additional tables). But cache hit rates of 80%+ on common tasks make it worthwhile.

### ADR-5: 4-Tier Verification over "All Deterministic"

**Decision**: VERIFIED_STATIC / VERIFIED_RUNTIME / UNRESOLVED / ANNOTATION_ONLY. ANNOTATION_ONLY excluded from V1.

**Reason**: tree-sitter cannot prove type-level relationships. "Deterministic" loses meaning if used for both "proven by compiler" and "guessed by regex." Separate tiers maintain honest provenance.

**Consequence**: More complex edge model. But prevents silent false edges (which are worse than unresolved edges).

### ADR-6: Step-Based Traversal over BFS

**Decision**: Traversal policies define ordered `TraversalStep[]` instead of a single edge-kind list + maxDepth.

**Reason**: BFS around a hub like `logger` or `User` pulls in half the repo. Step-based traversal with per-step `maxEdgesPerNode`, `stopNodePatterns`, and `stopAtContainerBoundary` prevents explosions.

**Consequence**: More verbose policy definitions. But each policy is a precise recipe for a specific task type.

### ADR-7: Tier-Based Rendering over Popularity Scoring

**Decision**: Deterministic inclusion tiers (0-3). Popularity-based relevance scoring is NOT used.

**Reason**: Highly connected nodes (logger, User, config) are often noise, not signal. A node should be included because it lies on a required path, not because it's popular.

**Consequence**: Simpler rendering logic. Agents get exactly the code they need, not the code that's most connected.

### ADR-8: Edge Evidence as Separate Table

**Decision**: `edges` has a uniqueness constraint (one record per source+target+kind). `edge_evidence` stores multiple provenance records per edge.

**Reason**: Multiple observations of the same edge (compiler + runtime + test) should accumulate, not overwrite. The PK overwrite in V1 would lose runtime confirmation data.

**Consequence**: Slightly more complex insert logic. But full provenance preservation.

### ADR-9: Reverse Invalidation Before Scale

**Decision**: `imports_index` table and dirty propagation are Phase 1, not Phase 6.

**Reason**: Without reverse invalidation, the graph silently becomes incorrect after file edits. Renaming a function in file B leaves stale edges in file A's importers. This is a correctness bug, not a performance optimization.

**Consequence**: More work in Phase 1. But the graph stays correct.

### ADR-10: Keep `node:sqlite` for Phase 1

**Decision**: Keep Node's built-in `node:sqlite` for Phase 1. Switch to `better-sqlite3` only if benchmarks show it's a bottleneck.

**Reason**: The database adapter is not the correctness bottleneck. Node 24 ships with `node:sqlite` working. Fixing the graph's correctness, stable IDs, and real resolution is P0. Changing DB drivers is not.

**Consequence**: If `node:sqlite` proves too slow at 100k nodes, switch to `better-sqlite3` in Phase 4.

---

## 12. Current Code Audit

### 12.1 File-by-File Assessment

| File | Lines | Verdict | V2 Fate |
|---|---|---|---|
| `src/types.ts` | 62 | 15 edges, no tier, no stable ID | Rewrite: 17 edges, 4 tiers, SymbolIdentity |
| `src/db.ts` | 157 | `node:sqlite`, no batch, `LIKE %`, dead code | Rewrite: new schema, FTS5, evidence table, containers |
| `src/hash.ts` | 2 | Simple SHA-256, fine | Keep |
| `src/indexer.ts` | 135 | Positional IDs, no cross-file, regex contracts | Replace: tree-sitter Level A + TS API Level B |
| `src/traversal.ts` | 54 | Flat BFS, `queue.shift()`, no direction use | Replace: step-based policies, hub stops, tiers |
| `src/render.ts` | 27 | Always full source, no budget, hardcoded ````ts```` | Replace: tier-based, budget, diff-as-annotation |
| `src/watcher.ts` | 16 | chokidar, no cooldown, no rename handling | Enhance: cooldown, rename detection, reverse invalidation |
| `src/cli.ts` | 39 | Clean CLI, minimal | Expand: container commands, cache commands |
| `src/benchmark.ts` | 46 | 1 gold case, no mutation tests | Rewrite: 3-layer benchmark, 50+ cases |
| `src/node-sqlite.d.ts` | 12 | Hand-written stub, possibly wrong | Keep for now (Phase 1), reassess in Phase 4 |
| `test/` | 0 | Empty | Needs 50+ mutation tests |
| `bench/gold.json` | 9 | 1 case | Needs 20+ cases from real repos |

### 12.2 Critical Bugs

1. **Node IDs unstable** — `filePath::kind::name::startLine` changes on any edit (`indexer.ts:16`).
2. **No cross-file resolution** — Calls only resolve in current file's `declared` map (`indexer.ts:94-96`).
3. **False CALLS edges** — `split(".").at(-1)` matches any same-named function in the file (`indexer.ts:95`). A wrong verified edge is worse than an unresolved one.
4. **Imports are placeholder strings** — `file::./auth` never resolves to `src/auth.ts` (`indexer.ts:80`). Graph is disconnected across files.
5. **`clearFile()` deletes everything** — No edge-granular diffing. A 2-line edit triggers full re-index (`db.ts:51`).
6. **No reverse invalidation** — Changing file B doesn't re-resolve file A's import of B.
7. **Edge PK overwrites evidence** — `PRIMARY KEY(source_id, target_id, kind)` means runtime observations overwrite compiler results (`db.ts:36`).
8. **No file rename/move handling** — watcher only handles add/change/unlink.

### 12.3 V2 Fix Mapping

| Bug | V2 Fix | Phase |
|---|---|---|
| 1. Unstable IDs | `SymbolIdentity: stableId + versionHash` | Phase 1 |
| 2. No cross-file resolution | Level B: TS Compiler API per tsconfig | Phase 1 |
| 3. False CALLS edges | Only create CALLS when target is verified | Phase 1 |
| 4. Placeholder imports | Real module resolution via TypeScript resolver | Phase 1 |
| 5. `clearFile()` deletes everything | Diff-stableIds: only DELETE removed nodes | Phase 1 |
| 6. No reverse invalidation | `imports_index` table + dirty propagation | Phase 1 |
| 7. Edge PK overwrites evidence | `edges` (unique) + `edge_evidence` (accumulate) | Phase 1 |
| 8. No rename handling | Detect rename via content hash match across paths | Phase 1 |

---

## 13. CodeGraph Evaluation

`@colbymchenry/codegraph` is the closest existing project. Current benchmarks (from their docs):

```
- 16% cheaper
- 47% fewer tokens
- 22% faster
- 58% fewer tool calls
```

Averages across 7 real open-source repos (VS Code, Django, Tokio, etc.).

### What CodeGraph does well

- tree-sitter parsing for 19+ languages
- SQLite + FTS5 storage
- MCP server with `codegraph_context` and `codegraph_explore` tools
- Caller/callee/impact queries
- File watcher with cooldown
- 45k+ GitHub stars, active maintenance

### What CodeGraph does NOT do (our differentiation)

| Capability | CodeGraph | V2 |
|---|---|---|
| Relation containers | No | Core retrieval unit |
| Versioned container cache | No | Slice cache with dirty propagation |
| Verification tiers | All edges treated equally | VERIFIED_STATIC / RUNTIME / UNRESOLVED |
| Reverse invalidation | File-level re-index only | Import-aware, container-aware |
| Edge provenance | Single PK overwrites evidence | `edge_evidence` accumulates |
| Contract artifact bridges | No | OpenAPI, Prisma, GraphQL adapters |
| Step-based traversal | BFS | Policy-specific steps with hub stops |
| Tier-based rendering | Relevance scoring | 4 deterministic tiers |
| Security layer | None | Exclusions, redaction, path guard |
| Correctness-first build order | Features added incrementally | Containers before contracts before languages |

### Recommendation

**Do not build on top of CodeGraph as a dependency.** The schema differences (no containers, no evidence table, no tiers) would require fighting upstream. Starting from our small scaffold and building containers + evidence + tiers from scratch gives full schema control.

**Do use CodeGraph as a reference** for:
- tree-sitter extraction patterns
- MCP server protocol implementation
- Benchmark methodology (7 repos, 4 runs per arm, medians)
- Framework adapter patterns (Express, React, etc.)

---

## Appendix: Corrected Dependencies

```
Phase 1 (correctness)
  types.ts               ← no deps
  hash.ts                ← no deps
  db.ts                  ← types.ts
  indexer-ast.ts         ← db.ts, types.ts (tree-sitter)
  indexer-tsc.ts         ← db.ts, types.ts (TS Compiler API, per tsconfig)
  resolver.ts            ← db.ts
  invalidator.ts         ← db.ts
  └─ 50 mutation tests

Phase 2 (containers)
  container-builder.ts   ← db.ts, types.ts
  └─ container + cache tests

Phase 3 (contracts)
  contracts/*.ts         ← db.ts, types.ts

Phase 4 (compiler)
  traversal.ts           ← db.ts, types.ts (step-based, hub stops)
  budget.ts              ← no deps
  render.ts              ← types.ts, budget.ts (tier-based)
  render-diff.ts         ← types.ts

Phase 5 (runtime)
  runtime/otel.ts        ← db.ts
  runtime/tests.ts       ← db.ts

Phase 6 (MCP)
  mcp/server.ts          ← traversal.ts, render.ts, container-builder.ts
  mcp/tools.ts           ← mcp/server.ts
  mcp/install.ts         ← no deps
```
