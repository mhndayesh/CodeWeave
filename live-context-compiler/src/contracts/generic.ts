import { GraphStore } from "../db.js";
import { VERIFICATION } from "../types.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

export class GenericBridge implements ContractBridge {
  name = "generic";

  handlesFile(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx)$/.test(filePath);
  }

  extract(
    store: GraphStore,
    filePath: string,
    text: string,
    source: SourceFile,
    fileNodeId: string,
    root: string,
  ): { routes: RouteInfo[]; schemas: []; events: []; apis: []; tables: [] } {
    const routes: RouteInfo[] = [];

    const fetchPattern = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of text.matchAll(fetchPattern)) {
      const url = match[1];
      const routeName = `UNKNOWN ${url}`;
      const qName = `route:${routeName}`;
      const sid = stableId(root, "ts", qName);
      store.upsertNode({
        identity: { stableId: sid, versionHash: versionHash(url) },
        kind: "route",
        name: routeName,
        qualifiedName: qName,
        filePath,
        startLine: 0,
        endLine: 0,
        language: "ts",
      });
      store.upsertEdge({
        sourceId: fileNodeId,
        targetId: sid,
        kind: "CONSUMES_ROUTE",
        verification: VERIFICATION.VERIFIED_STATIC,
        sourceMethod: "generic-bridge",
        metadata: { url },
      });
    }

    const dbReadPattern =
      /\b(db|prisma|knex|drizzle)\s*\.\s*(find|findMany|findUnique|findFirst|get|select|query)\s*\(/g;
    for (const match of text.matchAll(dbReadPattern)) {
      const table = match[3] || "unknown";
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
        sourceMethod: "generic-bridge",
        metadata: { table },
      });
    }

    const dbWritePattern =
      /\b(db|prisma|knex|drizzle)\s*\.\s*(create|update|upsert|delete|insert)\s*\(/g;
    for (const match of text.matchAll(dbWritePattern)) {
      const table = match[3] || "unknown";
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
        sourceMethod: "generic-bridge",
        metadata: { table },
      });
    }

    return { routes, schemas: [], events: [], apis: [], tables: [] };
  }
}
