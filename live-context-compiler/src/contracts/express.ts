import ts from "typescript";
import { VERIFICATION } from "../types.js";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

export class ExpressBridge implements ContractBridge {
  name = "express";

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

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        this.handleCallExpression(node, store, filePath, source, fileNodeId, root, routes);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return { routes, schemas: [], events: [], apis: [], tables: [] };
  }

  private handleCallExpression(
    node: ts.CallExpression,
    store: GraphStore,
    filePath: string,
    source: SourceFile,
    fileNodeId: string,
    root: string,
    routes: RouteInfo[],
  ): void {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const isHttpMethod = HTTP_METHODS.has(methodName);
      const isRouterMethod =
        methodName === "route" || methodName === "all" || isHttpMethod;

      if (isRouterMethod && node.arguments.length > 0) {
        const firstArg = node.arguments[0];
        if (ts.isStringLiteralLike(firstArg)) {
          const path = firstArg.text;
          const handlerName =
            node.arguments.length > 1
              ? node.arguments[1].getText(source)
              : undefined;

          const method = isHttpMethod
            ? methodName.toUpperCase()
            : methodName === "all"
              ? "ALL"
              : "USE";

          const route: RouteInfo = { method, path, handlerName };
          routes.push(route);

          const routeName = `${method} ${path}`;
          const qName = `route:${routeName}`;
          const sid = stableId(root, "ts", qName);
          store.upsertNode({
            identity: { stableId: sid, versionHash: versionHash(routeName) },
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
            kind: "EXPOSES_ROUTE",
            verification: VERIFICATION.VERIFIED_STATIC,
            sourceMethod: "express-bridge",
            metadata: { method, path, handlerName },
          });
        }
        return;
      }
    }

    const isUseCall =
      (ts.isIdentifier(node.expression) && node.expression.text === "use") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "use");

    if (isUseCall && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (ts.isStringLiteralLike(firstArg)) {
        const path = firstArg.text;
        const routeName = `USE ${path}`;
        const qName = `route:${routeName}`;
        const sid = stableId(root, "ts", qName);
        store.upsertNode({
          identity: { stableId: sid, versionHash: versionHash(routeName) },
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
          kind: "EXPOSES_ROUTE",
          verification: VERIFICATION.VERIFIED_STATIC,
          sourceMethod: "express-bridge",
          metadata: { method: "USE", path },
        });
      }
    }
  }
}
