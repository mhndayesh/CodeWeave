import ts from "typescript";
import { VERIFICATION } from "../types.js";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, SchemaModel, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

export class DrizzleBridge implements ContractBridge {
  name = "drizzle";

  handlesFile(filePath: string): boolean {
    return /\.(ts|tsx)$/.test(filePath);
  }

  extract(
    store: GraphStore,
    filePath: string,
    text: string,
    source: SourceFile,
    fileNodeId: string,
    root: string,
  ): { routes: RouteInfo[]; schemas: SchemaModel[]; events: []; apis: []; tables: [] } {
    const schemas: SchemaModel[] = [];

    const pgTableCalls: Array<{ tableName: string; fields: string }> = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "pgTable" ||
          node.expression.text === "mysqlTable" ||
          node.expression.text === "sqliteTable")
      ) {
        if (node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
          const tableName = node.arguments[0].text;
          pgTableCalls.push({
            tableName,
            fields: node.arguments.length > 1
              ? node.arguments[1].getText(source)
              : "",
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);

    for (const { tableName, fields } of pgTableCalls) {
      const qName = `db_table:${tableName}`;
      const sid = stableId(root, "ts", qName);
      store.upsertNode({
        identity: { stableId: sid, versionHash: versionHash(tableName) },
        kind: "db_table",
        name: tableName,
        qualifiedName: qName,
        filePath,
        startLine: 0,
        endLine: 0,
        language: "ts",
      });
      store.upsertEdge({
        sourceId: fileNodeId,
        targetId: sid,
        kind: "CONTAINS",
        verification: VERIFICATION.VERIFIED_STATIC,
        sourceMethod: "drizzle-bridge",
        metadata: { framework: "drizzle" },
      });

      schemas.push({ name: tableName, fields: [] });
    }

    const drizzleReadPattern =
      /\b(db|drizzle)\s*\(\)\s*\.\s*(select|findMany|findFirst|query)\s*\(\s*(\w+)/g;
    for (const match of text.matchAll(drizzleReadPattern)) {
      const table = match[3];
      const qName = `db_table:${table}`;
      const sid = stableId(root, "ts", qName);
      store.upsertNode({
        identity: { stableId: sid, versionHash: versionHash(table) },
        kind: "db_table",
        name: table,
        qualifiedName: qName,
        filePath,
        startLine: 0,
        endLine: 0,
        language: "ts",
      });
      store.upsertEdge({
        sourceId: fileNodeId,
        targetId: sid,
        kind: "READS_TABLE",
        verification: VERIFICATION.VERIFIED_STATIC,
        sourceMethod: "drizzle-bridge",
        metadata: { table, method: "select" },
      });
    }

    const drizzleWritePattern =
      /\b(db|drizzle)\s*\(\)\s*\.\s*(insert|update|delete)\s*\(\s*(\w+)/g;
    for (const match of text.matchAll(drizzleWritePattern)) {
      const table = match[3];
      const qName = `db_table:${table}`;
      const sid = stableId(root, "ts", qName);
      store.upsertNode({
        identity: { stableId: sid, versionHash: versionHash(table) },
        kind: "db_table",
        name: table,
        qualifiedName: qName,
        filePath,
        startLine: 0,
        endLine: 0,
        language: "ts",
      });
      store.upsertEdge({
        sourceId: fileNodeId,
        targetId: sid,
        kind: "WRITES_TABLE",
        verification: VERIFICATION.VERIFIED_STATIC,
        sourceMethod: "drizzle-bridge",
        metadata: { table, method: "write" },
      });
    }

    return { routes: [], schemas, events: [], apis: [], tables: [] };
  }
}
