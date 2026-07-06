import { DatabaseSync } from "node:sqlite";
import type {
  CodeEdge,
  CodeNode,
  EdgeEvidence,
  EdgeKind,
  NodeKind,
  RelationContainer,
  Verification,
} from "./types.js";

export class GraphStore {
  private db: DatabaseSync;
  private hasFts = false;
  private entryCache?: Set<string>;

  constructor(dbPath = ".context-graph.sqlite") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        stable_id TEXT PRIMARY KEY,
        version_hash TEXT NOT NULL,
        previous_stable_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        doc TEXT,
        language TEXT NOT NULL DEFAULT 'ts'
      );
      CREATE INDEX IF NOT EXISTS nodes_file_idx ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes(kind);
      CREATE INDEX IF NOT EXISTS nodes_name_idx ON nodes(name);
      CREATE INDEX IF NOT EXISTS nodes_qname_idx ON nodes(qualified_name);

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, kind)
      );
      CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id);
      CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id);
      CREATE INDEX IF NOT EXISTS edges_kind_idx ON edges(kind);

      CREATE TABLE IF NOT EXISTS edge_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verification INTEGER NOT NULL,
        source_method TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (source_id, target_id, kind) REFERENCES edges(source_id, target_id, kind)
      );
      CREATE INDEX IF NOT EXISTS evidence_edge_idx ON edge_evidence(source_id, target_id, kind);

      CREATE TABLE IF NOT EXISTS imports_index (
        importer_file TEXT NOT NULL,
        imported_file TEXT NOT NULL,
        edge_kind TEXT NOT NULL,
        PRIMARY KEY (importer_file, imported_file, edge_kind)
      );
      CREATE INDEX IF NOT EXISTS imports_imported_idx ON imports_index(imported_file);

      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lsp_resolved_files (
        file_path TEXT PRIMARY KEY,
        resolved_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS entry_points (
        file_path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS containers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        entry_node_ids TEXT NOT NULL DEFAULT '[]',
        member_ids TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS dirty_files (
        file_path TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS container_members (
        container_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'related',
        PRIMARY KEY (container_id, node_id),
        FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS cm_node_idx ON container_members(node_id);
      CREATE INDEX IF NOT EXISTS cm_container_idx ON container_members(container_id);

      CREATE TABLE IF NOT EXISTS slice_cache (
        cache_key TEXT PRIMARY KEY,
        container_id TEXT NOT NULL,
        policy_name TEXT NOT NULL,
        entry_node_ids TEXT NOT NULL,
        node_ids TEXT NOT NULL,
        edge_ids TEXT NOT NULL,
        version INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS sc_container_idx ON slice_cache(container_id);
      CREATE INDEX IF NOT EXISTS sc_policy_idx ON slice_cache(policy_name);

      CREATE TABLE IF NOT EXISTS container_deps (
        dependent_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        PRIMARY KEY (dependent_id, dependency_id),
        FOREIGN KEY (dependent_id) REFERENCES containers(id) ON DELETE CASCADE,
        FOREIGN KEY (dependency_id) REFERENCES containers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS cd_dep_idx ON container_deps(dependency_id);
    `);

    // `doc` was added after the initial release. Older databases have a nodes table
    // without it; add it in place so a warm re-index fills docstrings instead of forcing
    // a full rebuild. Errors ("duplicate column") mean it already exists — ignore them.
    if (!this.hasColumn("nodes", "doc")) {
      try {
        this.db.exec("ALTER TABLE nodes ADD COLUMN doc TEXT;");
      } catch {
        // column already present, or table just created with it — nothing to do
      }
    }

    this.migrateFts();
  }

  // Create (or migrate) the FTS5 index. `doc` joined the indexed columns after the
  // initial release; an external-content fts5 table's schema is fixed at creation, so a
  // legacy index missing `doc` is dropped and rebuilt from the (already-populated) nodes
  // table. The graph store is rebuildable, but rebuilding just the FTS avoids a full re-index.
  private migrateFts(): void {
    try {
      const ftsExists = this.tableExists("nodes_fts");
      const ftsStale = ftsExists && !this.ftsHasDoc();
      if (ftsStale) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS nodes_ai;
          DROP TRIGGER IF EXISTS nodes_ad;
          DROP TRIGGER IF EXISTS nodes_au;
          DROP TABLE IF EXISTS nodes_fts;
        `);
      }

      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
          stable_id UNINDEXED,
          kind UNINDEXED,
          name,
          qualified_name,
          file_path UNINDEXED,
          signature,
          doc,
          content='nodes',
          content_rowid='rowid'
        )`,
      );
      this.hasFts = true;
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, stable_id, kind, name, qualified_name, file_path, signature, doc)
          VALUES (new.rowid, new.stable_id, new.kind, new.name, new.qualified_name, new.file_path, new.signature, new.doc);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, stable_id, kind, name, qualified_name, file_path, signature, doc)
          VALUES ('delete', old.rowid, old.stable_id, old.kind, old.name, old.qualified_name, old.file_path, old.signature, old.doc);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, stable_id, kind, name, qualified_name, file_path, signature, doc)
          VALUES ('delete', old.rowid, old.stable_id, old.kind, old.name, old.qualified_name, old.file_path, old.signature, old.doc);
          INSERT INTO nodes_fts(rowid, stable_id, kind, name, qualified_name, file_path, signature, doc)
          VALUES (new.rowid, new.stable_id, new.kind, new.name, new.qualified_name, new.file_path, new.signature, new.doc);
        END;
      `);
      if (ftsStale) {
        // Repopulate the freshly recreated index from existing rows.
        this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');");
      }
    } catch {
      this.hasFts = false;
    }
  }

  private hasColumn(table: string, column: string): boolean {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === column);
    } catch {
      return false;
    }
  }

  private tableExists(name: string): boolean {
    try {
      const row = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
        .get(name);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private ftsHasDoc(): boolean {
    // fts5 virtual tables report their columns through table_info; a legacy index
    // predates the `doc` column.
    return this.hasColumn("nodes_fts", "doc");
  }

  hasFts5(): boolean {
    return this.hasFts;
  }

  // --- Node operations ---

  upsertNode(node: CodeNode): void {
    this.db
      .prepare(
        `INSERT INTO nodes(stable_id, version_hash, previous_stable_id, kind, name, qualified_name, file_path, start_line, end_line, signature, doc, language)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stable_id) DO UPDATE SET
         version_hash=excluded.version_hash,
         previous_stable_id=COALESCE(excluded.previous_stable_id, nodes.previous_stable_id),
         kind=excluded.kind,
         name=excluded.name,
         qualified_name=excluded.qualified_name,
         file_path=excluded.file_path,
         start_line=excluded.start_line,
         end_line=excluded.end_line,
         signature=excluded.signature,
         doc=excluded.doc`,
      )
      .run(
        node.identity.stableId,
        node.identity.versionHash,
        node.identity.previousStableId ?? null,
        node.kind,
        node.name,
        node.qualifiedName,
        node.filePath,
        node.startLine,
        node.endLine,
        node.signature ?? null,
        node.doc ?? null,
        node.language,
      );
  }

  deleteNode(stableId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE stable_id = ?").run(stableId);
  }

  getNode(stableId: string): CodeNode | undefined {
    const row = this.db
      .prepare(
        `SELECT stable_id, version_hash, previous_stable_id, kind, name, qualified_name,
              file_path, start_line, end_line, signature, doc, language
       FROM nodes WHERE stable_id = ?`,
      )
      .get(stableId) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  getNodes(stableIds: string[]): CodeNode[] {
    if (stableIds.length === 0) return [];
    const placeholders = stableIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT stable_id, version_hash, previous_stable_id, kind, name, qualified_name,
              file_path, start_line, end_line, signature, doc, language
       FROM nodes WHERE stable_id IN (${placeholders})`,
      )
      .all(...stableIds) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  // Declared symbols (not files/packages), used to build a cross-file reference graph.
  symbolDefinitions(): Array<{ id: string; name: string; kind: string; filePath: string }> {
    const rows = this.db
      .prepare(
        `SELECT stable_id, name, kind, file_path FROM nodes
         WHERE kind IN ('function','class','method','interface','enum','type')`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.stable_id as string,
      name: r.name as string,
      kind: r.kind as string,
      filePath: r.file_path as string,
    }));
  }

  // Like symbolDefinitions but also includes `variable` — registries are usually declared
  // as an exported const (`const SOURCES = new Registry()`), so registration linking needs
  // to resolve variable names too.
  registrySymbols(): Array<{ id: string; name: string; kind: string; filePath: string }> {
    const rows = this.db
      .prepare(
        `SELECT stable_id, name, kind, file_path FROM nodes
         WHERE kind IN ('function','class','method','interface','enum','type','variable')`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.stable_id as string,
      name: r.name as string,
      kind: r.kind as string,
      filePath: r.file_path as string,
    }));
  }

  hasEvidenceFrom(method: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM edge_evidence WHERE source_method = ? LIMIT 1").get(method);
    return Boolean(row);
  }

  // Symbol definitions with line ranges, for mapping LSP locations back to nodes.
  definitionRanges(): Array<{ id: string; filePath: string; name: string; kind: string; startLine: number; endLine: number }> {
    const rows = this.db
      .prepare(
        `SELECT stable_id, file_path, name, kind, start_line, end_line FROM nodes
         WHERE kind IN ('function','class','method','interface','enum','type')`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.stable_id as string,
      filePath: r.file_path as string,
      name: r.name as string,
      kind: r.kind as string,
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
    }));
  }

  // --- Edge operations ---

  upsertEdge(edge: CodeEdge): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO edges(source_id, target_id, kind)
       VALUES(?, ?, ?)`,
      )
      .run(edge.sourceId, edge.targetId, edge.kind);

    this.db
      .prepare(
        `INSERT INTO edge_evidence(source_id, target_id, kind, verification, source_method, metadata_json)
       VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edge.sourceId,
        edge.targetId,
        edge.kind,
        edge.verification,
        edge.sourceMethod,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
      );
  }

  getEvidence(
    sourceId: string,
    targetId: string,
    kind: EdgeKind,
  ): EdgeEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_id, target_id, kind, verification, source_method, metadata_json, created_at
       FROM edge_evidence WHERE source_id = ? AND target_id = ? AND kind = ?
       ORDER BY created_at`,
      )
      .all(sourceId, targetId, kind) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      sourceId: r.source_id as string,
      targetId: r.target_id as string,
      kind: r.kind as EdgeKind,
      verification: Number(r.verification) as Verification,
      sourceMethod: r.source_method as string,
      metadata: r.metadata_json
        ? (JSON.parse(r.metadata_json as string) as Record<string, unknown>)
        : undefined,
      createdAt: r.created_at as string,
    }));
  }

  // --- Import index (reverse invalidation) ---

  addImportEdge(
    importerFile: string,
    importedFile: string,
    edgeKind: EdgeKind,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO imports_index(importer_file, imported_file, edge_kind)
       VALUES(?, ?, ?)`,
      )
      .run(importerFile, importedFile, edgeKind);
  }

  removeImportEdgesForFile(filePath: string): void {
    this.db
      .prepare(
        `DELETE FROM imports_index WHERE importer_file = ? OR imported_file = ?`,
      )
      .run(filePath, filePath);
  }

  getImportersOf(filePath: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT importer_file FROM imports_index WHERE imported_file = ?`,
      )
      .all(filePath) as { importer_file: string }[];
    return rows.map((r) => r.importer_file);
  }

  getImportsOf(filePath: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT imported_file FROM imports_index WHERE importer_file = ?`,
      )
      .all(filePath) as { imported_file: string }[];
    return rows.map((r) => r.imported_file);
  }

  // --- Dirty file tracking ---

  markDirty(filePath: string, reason: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dirty_files(file_path, reason, created_at)
       VALUES(?, ?, datetime('now'))`,
      )
      .run(filePath, reason);
  }

  getDirtyFiles(): string[] {
    const rows = this.db
      .prepare(`SELECT file_path FROM dirty_files ORDER BY created_at`)
      .all() as { file_path: string }[];
    return rows.map((r) => r.file_path);
  }

  clearDirty(filePath: string): void {
    this.db.prepare("DELETE FROM dirty_files WHERE file_path = ?").run(filePath);
  }

  clearAllDirty(): void {
    this.db.exec("DELETE FROM dirty_files");
  }

  // --- Indexed files ---

  markIndexed(filePath: string, contentHash: string): void {
    this.db
      .prepare(
        `INSERT INTO indexed_files(file_path, content_hash, indexed_at)
       VALUES(?, ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         content_hash=excluded.content_hash,
         indexed_at=excluded.indexed_at`,
      )
      .run(filePath, contentHash);
  }

  indexedHash(filePath: string): string | undefined {
    const row = this.db
      .prepare("SELECT content_hash FROM indexed_files WHERE file_path = ?")
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  // --- Semantic (LSP) resolution tracking ---
  // Records which files pyright has already resolved so the (time-bounded) semantic pass
  // resumes on the still-unresolved files each run, accruing coverage to 100% over several
  // indexes instead of being permanently capped by one 20s budget.

  markLspResolved(filePath: string): void {
    this.db
      .prepare(
        `INSERT INTO lsp_resolved_files(file_path, resolved_at)
       VALUES(?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET resolved_at=excluded.resolved_at`,
      )
      .run(filePath);
  }

  lspResolvedFiles(): Set<string> {
    const rows = this.db
      .prepare("SELECT file_path FROM lsp_resolved_files")
      .all() as { file_path: string }[];
    return new Set(rows.map((r) => r.file_path));
  }

  // Files ranked by how referenced their symbols are in the (heuristic) graph so far —
  // the most-referenced symbols are the ones most likely to land in a slice, so the
  // budgeted semantic pass spends its time replacing their fuzzy edges with precise ones first.
  filesByReferenceHotness(): string[] {
    const rows = this.db
      .prepare(
        `SELECT n.file_path AS file_path, COUNT(*) AS c
         FROM edges e JOIN nodes n ON n.stable_id = e.target_id
         WHERE e.kind IN ('REFERENCES','CALLS')
         GROUP BY n.file_path
         ORDER BY c DESC`,
      )
      .all() as { file_path: string; c: number }[];
    return rows.map((r) => r.file_path);
  }

  // --- File-level operations ---

  clearFile(filePath: string, removeIncoming = false): void {
    const ids = this.db
      .prepare("SELECT stable_id FROM nodes WHERE file_path = ?")
      .all(filePath) as { stable_id: string }[];
    for (const { stable_id } of ids) {
      if (removeIncoming) {
        this.db.prepare("DELETE FROM edge_evidence WHERE source_id = ? OR target_id = ?").run(stable_id, stable_id);
        this.db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(stable_id, stable_id);
      } else {
        this.db.prepare("DELETE FROM edge_evidence WHERE source_id = ?").run(stable_id);
        this.db.prepare("DELETE FROM edges WHERE source_id = ?").run(stable_id);
      }
    }
    for (const { stable_id } of ids) {
      this.db.prepare("DELETE FROM nodes WHERE stable_id = ?").run(stable_id);
    }
    this.db
      .prepare("DELETE FROM indexed_files WHERE file_path = ?")
      .run(filePath);
    // Drop the semantic-resolution marker too, so an edited file is re-resolved by
    // pyright on the next index instead of keeping stale compiler edges.
    this.db
      .prepare("DELETE FROM lsp_resolved_files WHERE file_path = ?")
      .run(filePath);
    this.removeImportEdgesForFile(filePath);
    this.clearDirty(filePath);
  }

  // --- Entry points ---

  // Files that are natural starting points (package.json bin/main, __main__, conventional
  // names). Used to break search ties toward where a reader would actually start, so a
  // query like "cli" surfaces the CLI entry file over an incidental substring match.
  markEntryPoint(filePath: string, kind: string): void {
    this.db
      .prepare(
        `INSERT INTO entry_points(file_path, kind) VALUES(?, ?)
         ON CONFLICT(file_path) DO UPDATE SET kind=excluded.kind`,
      )
      .run(filePath, kind);
    this.entryCache = undefined;
  }

  clearEntryPoints(): void {
    this.db.exec("DELETE FROM entry_points");
    this.entryCache = undefined;
  }

  entryPointFiles(): Set<string> {
    if (!this.entryCache) {
      const rows = this.db.prepare("SELECT file_path FROM entry_points").all() as Array<{ file_path: string }>;
      this.entryCache = new Set(rows.map((r) => r.file_path));
    }
    return this.entryCache;
  }

  entryPointCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM entry_points").get() as { c: number };
    return row.c;
  }

  // --- Query / search ---

  getFileNodesByPrefix(filePrefix: string): CodeNode[] {
    const rows = this.db
      .prepare(
        `SELECT stable_id, version_hash, previous_stable_id, kind, name, qualified_name,
              file_path, start_line, end_line, signature, doc, language
       FROM nodes WHERE kind = 'file' AND file_path LIKE ?`,
      )
      .all(`${filePrefix}%`) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  findNodes(query: string, limit = 20): CodeNode[] {
    if (this.hasFts) {
      try {
        const sanitized = query.replace(/['"]/g, "").trim();
        if (!sanitized) return [];
        const ftsQuery = sanitized
          .split(/\s+/)
          .map((w) => `"${w}"`)
          .join(" OR ");
        // ORDER BY rank (bm25) so the strongest textual match leads; over-fetch so the
        // symbol-relevance re-rank below has candidates to promote past a raw bm25 tie.
        const rows = this.db
          .prepare(
            `SELECT n.stable_id, n.version_hash, n.previous_stable_id, n.kind, n.name, n.qualified_name,
                    n.file_path, n.start_line, n.end_line, n.signature, n.doc, n.language
             FROM nodes n
             JOIN nodes_fts fts ON n.stable_id = fts.stable_id
             WHERE nodes_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(ftsQuery, Math.max(limit * 4, 20)) as Record<string, unknown>[];
        if (rows.length > 0) {
          return this.rankMatches(rows.map((r) => this.rowToNode(r)), query).slice(0, limit);
        }
      } catch {
        // FTS5 query failed, fall through to LIKE
      }
    }

    const rows = this.db
      .prepare(
        `SELECT stable_id, version_hash, previous_stable_id, kind, name, qualified_name,
              file_path, start_line, end_line, signature, doc, language
       FROM nodes
       WHERE name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ?
       LIMIT ?`,
      )
      .all(
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        Math.max(limit * 4, 20),
      ) as Record<string, unknown>[];
    return this.rankMatches(rows.map((r) => this.rowToNode(r)), query).slice(0, limit);
  }

  // A search hit becomes the slice's entry seed, so the *first* result must be the
  // best one. bm25 alone treats a name match and a signature-substring match alike;
  // promote exact-name, then prefix, then substring matches ahead of incidental ones,
  // preferring declared symbols over files, and keep the existing order within a tier.
  private rankMatches(nodes: CodeNode[], query: string): CodeNode[] {
    const q = query.trim().toLowerCase();
    const entrySet = this.entryPointFiles();
    const kindRank = (n: CodeNode) => (n.kind === "file" ? 1 : 0);
    const nameRank = (n: CodeNode): number => {
      const name = n.name.toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      if (name.includes(q)) return 2;
      if (n.qualifiedName.toLowerCase().includes(q)) return 3;
      return 4;
    };
    // Entry-point membership is only a tiebreaker: an exact-name match in an ordinary
    // file still beats a substring match in an entry file. It just decides between
    // otherwise-equal candidates in favor of where a reader would start.
    const entryRank = (n: CodeNode) => (entrySet.has(n.filePath) ? 0 : 1);
    return nodes
      .map((n, i) => ({ n, i, score: nameRank(n) * 4 + kindRank(n) * 2 + entryRank(n) }))
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .map((x) => x.n);
  }

  // --- Traversal ---

  outgoing(sourceId: string, kinds: EdgeKind[]): CodeEdge[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT e.source_id, e.target_id, e.kind,
              (SELECT ev.verification FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as verification,
              (SELECT ev.source_method FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as source_method,
              (SELECT ev.metadata_json FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as metadata_json
       FROM edges e
       WHERE e.source_id = ? AND e.kind IN (${placeholders})`,
      )
      .all(sourceId, ...kinds) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEdge(r));
  }

  incoming(targetId: string, kinds: EdgeKind[]): CodeEdge[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT e.source_id, e.target_id, e.kind,
              (SELECT ev.verification FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as verification,
              (SELECT ev.source_method FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as source_method,
              (SELECT ev.metadata_json FROM edge_evidence ev
               WHERE ev.source_id = e.source_id AND ev.target_id = e.target_id AND ev.kind = e.kind
               ORDER BY ev.created_at DESC LIMIT 1) as metadata_json
       FROM edges e
       WHERE e.target_id = ? AND e.kind IN (${placeholders})`,
      )
      .all(targetId, ...kinds) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEdge(r));
  }

  // --- Container operations (Phase 2 ready) ---

  upsertContainer(container: RelationContainer): void {
    this.db
      .prepare(
        `INSERT INTO containers(id, name, kind, entry_node_ids, member_ids, version, dirty)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         kind=excluded.kind,
         entry_node_ids=excluded.entry_node_ids,
         member_ids=excluded.member_ids,
         version=excluded.version,
         dirty=excluded.dirty`,
      )
      .run(
        container.id,
        container.name,
        container.kind,
        JSON.stringify(container.entryNodeIds),
        JSON.stringify(container.memberIds),
        container.version,
        container.dirty ? 1 : 0,
      );
  }

  listContainers(): RelationContainer[] {
    const rows = this.db
      .prepare("SELECT * FROM containers ORDER BY kind, name")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as RelationContainer["kind"],
      entryNodeIds: JSON.parse(r.entry_node_ids as string),
      memberIds: JSON.parse(r.member_ids as string),
      version: r.version as number,
      dirty: (r.dirty as number) === 1,
    }));
  }

  getContainer(id: string): RelationContainer | undefined {
    const row = this.db
      .prepare("SELECT * FROM containers WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as RelationContainer["kind"],
      entryNodeIds: JSON.parse(row.entry_node_ids as string),
      memberIds: JSON.parse(row.member_ids as string),
      version: row.version as number,
      dirty: (row.dirty as number) === 1,
    };
  }

  // --- Container members ---

  addContainerMember(containerId: string, nodeId: string, role: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO container_members(container_id, node_id, role)
       VALUES(?, ?, ?)`,
      )
      .run(containerId, nodeId, role);
  }

  removeContainerMember(containerId: string, nodeId: string): void {
    this.db
      .prepare(
        "DELETE FROM container_members WHERE container_id = ? AND node_id = ?",
      )
      .run(containerId, nodeId);
  }

  getContainerMembers(containerId: string): Array<{ nodeId: string; role: string }> {
    const rows = this.db
      .prepare(
        "SELECT node_id, role FROM container_members WHERE container_id = ?",
      )
      .all(containerId) as { node_id: string; role: string }[];
    return rows.map((r) => ({ nodeId: r.node_id, role: r.role }));
  }

  getMemberContainers(nodeId: string): RelationContainer[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM containers c
       JOIN container_members cm ON c.id = cm.container_id
       WHERE cm.node_id = ?`,
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as RelationContainer["kind"],
      entryNodeIds: JSON.parse(r.entry_node_ids as string),
      memberIds: JSON.parse(r.member_ids as string),
      version: r.version as number,
      dirty: (r.dirty as number) === 1,
    }));
  }

  // --- Container dependency tracking ---

  addContainerDep(dependentId: string, dependencyId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO container_deps(dependent_id, dependency_id)
       VALUES(?, ?)`,
      )
      .run(dependentId, dependencyId);
  }

  getContainerDeps(containerId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT dependency_id FROM container_deps WHERE dependent_id = ?",
      )
      .all(containerId) as { dependency_id: string }[];
    return rows.map((r) => r.dependency_id);
  }

  getContainerDependents(containerId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT dependent_id FROM container_deps WHERE dependency_id = ?",
      )
      .all(containerId) as { dependent_id: string }[];
    return rows.map((r) => r.dependent_id);
  }

  // --- Dirty cascade across containers ---

  markContainerDirty(containerId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE containers SET dirty = 1, version = version + 1 WHERE id = ?`,
      )
      .run(containerId);
    const dependents = this.getContainerDependents(containerId);
    for (const depId of dependents) {
      this.db
        .prepare(
          `UPDATE containers SET dirty = 1, version = version + 1 WHERE id = ?`,
        )
        .run(depId);
    }
  }

  propagateContainerDirty(filePath: string): string[] {
    const affectedContainers = new Set<string>();

    const nodeRows = this.db
      .prepare("SELECT stable_id FROM nodes WHERE file_path = ?")
      .all(filePath) as { stable_id: string }[];

    for (const { stable_id } of nodeRows) {
      const containers = this.getMemberContainers(stable_id);
      for (const c of containers) {
        if (!c.dirty) {
          this.markContainerDirty(c.id, `file changed: ${filePath}`);
        }
        affectedContainers.add(c.id);
      }
    }

    return [...affectedContainers];
  }

  // --- Slice cache ---

  getCachedSlice(cacheKey: string): {
    containerId: string;
    policyName: string;
    entryNodeIds: string[];
    nodeIds: string[];
    edgeIds: string[];
    version: number;
    tokenCount: number;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT container_id, policy_name, entry_node_ids, node_ids, edge_ids,
              version, token_count
       FROM slice_cache WHERE cache_key = ?`,
      )
      .get(cacheKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      containerId: row.container_id as string,
      policyName: row.policy_name as string,
      entryNodeIds: JSON.parse(row.entry_node_ids as string),
      nodeIds: JSON.parse(row.node_ids as string),
      edgeIds: JSON.parse(row.edge_ids as string),
      version: row.version as number,
      tokenCount: row.token_count as number,
    };
  }

  setCachedSlice(
    cacheKey: string,
    containerId: string,
    policyName: string,
    entryNodeIds: string[],
    nodeIds: string[],
    edgeIds: string[],
    version: number,
    tokenCount: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO slice_cache
       (cache_key, container_id, policy_name, entry_node_ids, node_ids, edge_ids, version, token_count, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        cacheKey,
        containerId,
        policyName,
        JSON.stringify(entryNodeIds),
        JSON.stringify(nodeIds),
        JSON.stringify(edgeIds),
        version,
        tokenCount,
      );
  }

  invalidateSliceCache(containerId: string): void {
    this.db
      .prepare("DELETE FROM slice_cache WHERE container_id = ?")
      .run(containerId);
  }

  clearSliceCache(): void {
    this.db.exec("DELETE FROM slice_cache");
  }

  // --- Stats ---

  getStats(): { files: number; nodes: number; edges: number; dirty: number; containers: number; entryPoints: number; cacheEntries: number; hasFts: boolean } {
    const fileCount = (this.db.prepare("SELECT COUNT(*) as c FROM indexed_files").get() as { c: number }).c;
    const nodeCount = (this.db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
    const edgeCount = (this.db.prepare("SELECT COUNT(*) as c FROM edges").get() as { c: number }).c;
    const dirtyCount = (this.db.prepare("SELECT COUNT(*) as c FROM dirty_files").get() as { c: number }).c;
    const containerCount = (this.db.prepare("SELECT COUNT(*) as c FROM containers").get() as { c: number }).c;
    const cacheCount = (this.db.prepare("SELECT COUNT(*) as c FROM slice_cache").get() as { c: number }).c;
    return { files: fileCount, nodes: nodeCount, edges: edgeCount, dirty: dirtyCount, containers: containerCount, entryPoints: this.entryPointCount(), cacheEntries: cacheCount, hasFts: this.hasFts };
  }

  // --- Batch operations for performance ---

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteAll(): void {
    this.db.exec("DELETE FROM slice_cache");
    this.db.exec("DELETE FROM container_deps");
    this.db.exec("DELETE FROM container_members");
    this.db.exec("DELETE FROM containers");
    this.db.exec("DELETE FROM edge_evidence");
    this.db.exec("DELETE FROM edges");
    this.db.exec("DELETE FROM nodes");
    this.db.exec("DELETE FROM indexed_files");
    this.db.exec("DELETE FROM lsp_resolved_files");
    this.db.exec("DELETE FROM imports_index");
    this.db.exec("DELETE FROM dirty_files");
    if (this.hasFts) {
      this.db.exec("DELETE FROM nodes_fts");
    }
  }

  // --- Row mapping ---

  private rowToNode(row: Record<string, unknown>): CodeNode {
    return {
      identity: {
        stableId: row.stable_id as string,
        versionHash: row.version_hash as string,
        previousStableId: (row.previous_stable_id as string) || undefined,
      },
      kind: row.kind as NodeKind,
      name: row.name as string,
      qualifiedName: row.qualified_name as string,
      filePath: row.file_path as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      signature: (row.signature as string) || undefined,
      doc: (row.doc as string) || undefined,
      language: row.language as string,
    };
  }

  private rowToEdge(row: Record<string, unknown>): CodeEdge {
    return {
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as EdgeKind,
      verification: Number(row.verification) as Verification,
      sourceMethod: row.source_method as string,
      metadata: row.metadata_json
        ? (JSON.parse(row.metadata_json as string) as Record<string, unknown>)
        : undefined,
    };
  }
}
