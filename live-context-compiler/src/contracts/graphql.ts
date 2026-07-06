import fs from "node:fs";
import { VERIFICATION } from "../types.js";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, SchemaModel, SchemaField } from "./types.js";
import type { SourceFile } from "typescript";

interface GraphqlType {
  name: string;
  kind: "type" | "input" | "interface" | "enum";
  fields: Array<{ name: string; type: string }>;
}

export class GraphqlBridge implements ContractBridge {
  name = "graphql";

  handlesFile(filePath: string): boolean {
    return (
      filePath.endsWith(".graphql") ||
      filePath.endsWith(".gql") ||
      filePath.endsWith(".graphqls")
    );
  }

  private parseSchema(text: string): GraphqlType[] {
    const types: GraphqlType[] = [];
    const typeRegex = /(type|input|interface)\s+(\w+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;

    let match: RegExpExecArray | null;
    while ((match = typeRegex.exec(text)) !== null) {
      const kind = match[1] as GraphqlType["kind"];
      const name = match[2];
      const body = match[3];
      const fields: Array<{ name: string; type: string }> = [];

      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
        const fieldMatch = trimmed.match(/^(\w+)\s*:\s*([!\w[\]|]+)/);
        if (fieldMatch) {
          fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
        }
      }

      types.push({ name, kind, fields });
    }

    while ((match = enumRegex.exec(text)) !== null) {
      const name = match[1];
      const body = match[2];
      const fields: Array<{ name: string; type: string }> = [];
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const val = trimmed.replace(/[@\w]+\s*$/, "").trim();
          if (val) fields.push({ name: val, type: "String" });
        }
      }
      types.push({ name, kind: "enum", fields });
    }

    return types;
  }

  extractAll(store: GraphStore, root: string): SchemaModel[] {
    const models: SchemaModel[] = [];

    const files = fg.sync(["**/*.graphql", "**/*.gql", "**/*.graphqls"], {
      cwd: root,
      ignore: ["**/node_modules/**"],
      absolute: true,
    });

    for (const file of files) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const parsed = this.parseSchema(text);
        if (parsed.length === 0) continue;

        const rel = path.relative(root, file).replaceAll("\\", "/");
        const fileQName = `file:${rel}`;
        const fileNodeId = stableId(root, "ts", fileQName);

        store.upsertNode({
          identity: { stableId: fileNodeId, versionHash: versionHash(text) },
          kind: "file",
          name: rel,
          qualifiedName: fileQName,
          filePath: rel,
          startLine: 1,
          endLine: text.split("\n").length,
          language: "graphql",
        });

        for (const t of parsed) {
          const qName = `graphql_type:${t.name}`;
          const sid = stableId(root, "ts", qName);
          store.upsertNode({
            identity: { stableId: sid, versionHash: versionHash(t.name) },
            kind: "interface",
            name: t.name,
            qualifiedName: qName,
            filePath: rel,
            startLine: 0,
            endLine: 0,
            language: "graphql",
          });
          store.upsertEdge({
            sourceId: fileNodeId,
            targetId: sid,
            kind: "CONTAINS",
            verification: VERIFICATION.VERIFIED_STATIC,
            sourceMethod: "graphql-bridge",
            metadata: { graphqlKind: t.kind, fields: t.fields.length },
          });

          for (const field of t.fields) {
            const fieldQName = `graphql_field:${t.name}.${field.name}`;
            const fieldId = stableId(root, "ts", fieldQName);
            store.upsertNode({
              identity: { stableId: fieldId, versionHash: versionHash(fieldQName) },
              kind: "property",
              name: field.name,
              qualifiedName: fieldQName,
              filePath: rel,
              startLine: 0,
              endLine: 0,
              language: "graphql",
            });
            store.upsertEdge({
              sourceId: sid,
              targetId: fieldId,
              kind: "CONTAINS",
              verification: VERIFICATION.VERIFIED_STATIC,
              sourceMethod: "graphql-bridge",
              metadata: { type: field.type },
            });

            const refMatch = field.type.replace(/[!\]\[]/g, "").trim();
            if (refMatch && refMatch !== "String" && refMatch !== "Int" && refMatch !== "Float" && refMatch !== "Boolean" && refMatch !== "ID") {
              const refQName = `graphql_type:${refMatch}`;
              const refId = stableId(root, "ts", refQName);
              store.upsertEdge({
                sourceId: fieldId,
                targetId: refId,
                kind: "REFERENCES",
                verification: VERIFICATION.VERIFIED_STATIC,
                sourceMethod: "graphql-bridge",
                metadata: { type: field.type },
              });
            }
          }

          models.push({
            name: t.name,
            fields: t.fields.map((f) => ({ name: f.name, type: f.type, required: !f.type.includes("?") })),
          });
        }
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
