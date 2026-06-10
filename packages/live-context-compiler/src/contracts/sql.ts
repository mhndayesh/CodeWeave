import fs from "node:fs";
import { VERIFICATION } from "../types.js";
import path from "node:path";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, SqlTable } from "./types.js";
import type { SourceFile } from "typescript";

export class SqlBridge implements ContractBridge {
  name = "sql";

  handlesFile(filePath: string): boolean {
    const n = filePath.toLowerCase();
    return (
      n.endsWith(".sql") ||
      n.includes("/migrations/") ||
      n.includes("/migration/")
    );
  }

  private parseMigrations(text: string): SqlTable[] {
    const tables: SqlTable[] = [];
    const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?(\w+)`?\.)?`?(\w+)`?\s*\(([^;]+?)\)\s*;/gims;

    let match: RegExpExecArray | null;
    while ((match = createTableRegex.exec(text)) !== null) {
      const name = match[2] || match[1];
      const body = match[3];

      const columns: SqlTable["columns"] = [];
      const indexes: SqlTable["indexes"] = [];

      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("--") || trimmed.startsWith("/*")) continue;

        const idxMatch = trimmed.match(/^INDEX\s+(?:`?(\w+)`?)\s+(?:USING\s+\w+\s+)?\(([^)]+)\)/i);
        if (idxMatch) {
          indexes.push({
            name: idxMatch[1],
            columns: idxMatch[2].split(",").map((c) => c.trim().replace(/`/g, "")),
          });
          continue;
        }

        const colMatch = trimmed.match(
          /^`?(\w+)`?\s+(\w+(?:\s*\([^)]*\))?)\s*(.*)$/i,
        );
        if (colMatch && !trimmed.startsWith("PRIMARY") && !trimmed.startsWith("KEY") && !trimmed.startsWith("CONSTRAINT") && !trimmed.startsWith("INDEX") && !trimmed.startsWith("UNIQUE")) {
          const constraints: string[] = [];
          const rest = colMatch[3].toUpperCase();
          if (rest.includes("NOT NULL")) constraints.push("NOT NULL");
          if (rest.includes("AUTO_INCREMENT") || rest.includes("GENERATED")) constraints.push("AUTO_INCREMENT");
          if (rest.includes("DEFAULT")) {
            const defMatch = rest.match(/DEFAULT\s+(\S+)/);
            if (defMatch) constraints.push(`DEFAULT ${defMatch[1]}`);
          }
          if (rest.includes("REFERENCES")) {
            const refMatch = rest.match(/REFERENCES\s+`?(\w+)`?\s*\(`?(\w+)`?\)/);
            if (refMatch) constraints.push(`REFERENCES ${refMatch[1]}(${refMatch[2]})`);
          }
          columns.push({ name: colMatch[1], type: colMatch[2], constraints });
        }

        const pkMatch = trimmed.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        if (pkMatch) {
          indexes.push({
            name: "PRIMARY",
            columns: pkMatch[1].split(",").map((c) => c.trim().replace(/`/g, "")),
          });
        }
      }

      tables.push({ name, columns, indexes });
    }

    return tables;
  }

  extractAll(store: GraphStore, root: string): SqlTable[] {
    const allTables: SqlTable[] = [];

    const files = fg.sync(["**/*.sql", "**/migrations/**", "**/migration/**"], {
      cwd: root,
      ignore: ["**/node_modules/**"],
      absolute: true,
    });

    for (const file of files) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const tables = this.parseMigrations(text);
        if (tables.length === 0) continue;

        const rel = path.relative(root, file).replaceAll("\\", "/");
        const fileQName = `file:${rel}`;
        const fileNodeId = stableId(root, "ts", fileQName);

        store.upsertNode({
          identity: {
            stableId: fileNodeId,
            versionHash: versionHash(text),
          },
          kind: "file",
          name: rel,
          qualifiedName: fileQName,
          filePath: rel,
          startLine: 1,
          endLine: text.split("\n").length,
          language: "sql",
        });

        for (const table of tables) {
          const qName = `db_table:${table.name}`;
          const sid = stableId(root, "ts", qName);
          store.upsertNode({
            identity: { stableId: sid, versionHash: versionHash(table.name) },
            kind: "db_table",
            name: table.name,
            qualifiedName: qName,
            filePath: rel,
            startLine: 0,
            endLine: 0,
            language: "sql",
          });
          store.upsertEdge({
            sourceId: fileNodeId,
            targetId: sid,
            kind: "CONTAINS",
            verification: VERIFICATION.VERIFIED_STATIC,
            sourceMethod: "sql-bridge",
            metadata: { columns: table.columns.length, indexes: table.indexes.length },
          });

          for (const col of table.columns) {
            const colQName = `db_column:${table.name}.${col.name}`;
            const colId = stableId(root, "ts", colQName);
            store.upsertNode({
              identity: { stableId: colId, versionHash: versionHash(colQName) },
              kind: "db_column",
              name: col.name,
              qualifiedName: colQName,
              filePath: rel,
              startLine: 0,
              endLine: 0,
              language: "sql",
            });
            store.upsertEdge({
              sourceId: sid,
              targetId: colId,
              kind: "CONTAINS",
              verification: VERIFICATION.VERIFIED_STATIC,
              sourceMethod: "sql-bridge",
              metadata: { type: col.type, constraints: col.constraints },
            });
          }
        }

        allTables.push(...tables);
      } catch {
        // skip unparseable
      }
    }

    return allTables;
  }

  extract(): { routes: []; schemas: []; events: []; apis: []; tables: [] } {
    return { routes: [], schemas: [], events: [], apis: [], tables: [] };
  }
}
