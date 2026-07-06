import path from "node:path";
import { VERIFICATION } from "../types.js";
import ts from "typescript";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

export class NextBridge implements ContractBridge {
  name = "next";

  handlesFile(filePath: string): boolean {
    const n = filePath.replaceAll("\\", "/");
    return (
      n.includes("/pages/") ||
      n.includes("/app/") ||
      /\.(ts|tsx)$/.test(n)
    );
  }

  private appRouterPath(filePath: string): string | null {
    const n = filePath.replaceAll("\\", "/");
    const appIdx = n.indexOf("/app/");
    if (appIdx === -1) return null;
    const afterApp = n.slice(appIdx + 5);
    const withoutExt = afterApp.replace(/\.(tsx|ts)$/, "");
    const parts = withoutExt.split("/");
    const segments = parts.map((p) => {
      if (p.startsWith("[") && p.endsWith("]")) return `:${p.slice(1, -1)}`;
      if (p.startsWith("[[") && p.endsWith("]]")) return `:${p.slice(2, -2)}?`;
      if (p.startsWith("...")) return `*${p.slice(3)}`;
      return p;
    });
    return "/" + segments.join("/");
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
    const relPath = path.relative(root, filePath).replaceAll("\\", "/");

    const appRoute = this.appRouterPath(relPath);

    if (appRoute) {
      const exportNames = ["GET", "POST", "PUT", "PATCH", "DELETE"];
      for (const method of exportNames) {
        let found = false;
        const visit = (node: ts.Node) => {
          if (
            ts.isExportAssignment(node) ||
            (ts.isFunctionDeclaration(node) &&
              node.name &&
              exportNames.includes(node.name.text)) ||
            (ts.isVariableStatement(node) &&
              ts.isIdentifier((node.declarationList.declarations[0]?.name) as ts.Node)
            )
          ) {
            const name = ts.isFunctionDeclaration(node) && node.name
              ? node.name.text
              : undefined;
            if (name === method) found = true;

            const handlerName =
              ts.isFunctionDeclaration(node) && node.name
                ? node.name.text
                : ts.isExportAssignment(node)
                  ? "default"
                  : undefined;

            if (handlerName && (name === method || method === "GET")) {
              routes.push({ method, path: appRoute, handlerName });
              const routeName = `${method} ${appRoute}`;
              const qName = `route:${routeName}`;
              const sid = stableId(root, "ts", routeName);
              store.upsertNode({
                identity: { stableId: sid, versionHash: versionHash(routeName) },
                kind: "route",
                name: routeName,
                qualifiedName: qName,
                filePath: relPath,
                startLine: 0,
                endLine: 0,
                language: "ts",
              });
              store.upsertEdge({
                sourceId: fileNodeId,
                targetId: sid,
                kind: "EXPOSES_ROUTE",
                verification: VERIFICATION.VERIFIED_STATIC,
                sourceMethod: "next-bridge",
                metadata: { method, path: appRoute, handlerName },
              });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        if (!found && method === "GET") {
          routes.push({ method: "GET", path: appRoute, handlerName: "default" });
        }
      }
    }

    return { routes, schemas: [], events: [], apis: [], tables: [] };
  }
}
