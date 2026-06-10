import fs from "node:fs";
import { VERIFICATION } from "../types.js";
import path from "node:path";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, SchemaModel, SchemaField } from "./types.js";
import type { SourceFile } from "typescript";

export class PrismaBridge implements ContractBridge {
  name = "prisma";

  handlesFile(filePath: string): boolean {
    return filePath.endsWith(".prisma");
  }

  private parseSchema(text: string): SchemaModel[] {
    const models: SchemaModel[] = [];
    const modelRegex = /model\s+(\w+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;

    let match: RegExpExecArray | null;

    while ((match = modelRegex.exec(text)) !== null) {
      const name = match[1];
      const body = match[2];
      const fields: SchemaField[] = [];
      const indexes: string[] = [];

      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) {
          if (trimmed.startsWith("@@")) {
            indexes.push(trimmed);
          }
          continue;
        }

        const fieldMatch = trimmed.match(
          /^(\w+)\s+(\S+?)(\??)\s*(.*)$/,
        );
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2];
          const optional = fieldMatch[3] === "?";
          const rest = fieldMatch[4];

          let relation: { model: string; field: string } | undefined;
          const relMatch = rest.match(/@relation\(.*references:\s*\[?(\w+)\]?\)/);
          if (relMatch) {
            const modelMatch = fieldType.match(/(\w+)/);
            if (modelMatch) {
              relation = { model: modelMatch[1], field: relMatch[1] };
            }
          }

          fields.push({
            name: fieldName,
            type: fieldType,
            required: !optional,
            relation,
          });
        }
      }

      models.push({ name, table: name.toLowerCase(), fields, indexes });
    }

    return models;
  }

  extractAll(store: GraphStore, root: string): SchemaModel[] {
    const models: SchemaModel[] = [];

    const files = fg.sync(["**/schema.prisma"], {
      cwd: root,
      ignore: ["**/node_modules/**"],
      absolute: true,
    });

    for (const file of files) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const parsed = this.parseSchema(text);
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
          language: "prisma",
        });

        for (const model of parsed) {
          const qName = `db_table:${model.name}`;
          const sid = stableId(root, "ts", qName);
          store.upsertNode({
            identity: { stableId: sid, versionHash: versionHash(model.name) },
            kind: "db_table",
            name: model.name,
            qualifiedName: qName,
            filePath: rel,
            startLine: 0,
            endLine: 0,
            language: "prisma",
          });
          store.upsertEdge({
            sourceId: fileNodeId,
            targetId: sid,
            kind: "CONTAINS",
            verification: VERIFICATION.VERIFIED_STATIC,
            sourceMethod: "prisma-bridge",
            metadata: { fields: model.fields.length },
          });

          for (const field of model.fields) {
            const colQName = `db_column:${model.name}.${field.name}`;
            const colId = stableId(root, "ts", colQName);
            store.upsertNode({
              identity: { stableId: colId, versionHash: versionHash(colQName) },
              kind: "db_column",
              name: field.name,
              qualifiedName: colQName,
              filePath: rel,
              startLine: 0,
              endLine: 0,
              language: "prisma",
            });
            store.upsertEdge({
              sourceId: sid,
              targetId: colId,
              kind: "CONTAINS",
              verification: VERIFICATION.VERIFIED_STATIC,
              sourceMethod: "prisma-bridge",
              metadata: {
                type: field.type,
                required: field.required,
                relation: field.relation,
              },
            });

            if (field.relation) {
              const relTableQName = `db_table:${field.relation.model}`;
              const relTableId = stableId(root, "ts", relTableQName);
              store.upsertEdge({
                sourceId: colId,
                targetId: relTableId,
                kind: "REFERENCES",
                verification: VERIFICATION.VERIFIED_STATIC,
                sourceMethod: "prisma-bridge",
                metadata: { via: field.relation.field },
              });
            }
          }
        }

        models.push(...parsed);
      } catch {
        // skip unparseable
      }
    }

    return models;
  }

  extract(): { routes: []; schemas: []; events: []; apis: []; tables: [] } {
    return { routes: [], schemas: [], events: [], apis: [], tables: [] };
  }
}
