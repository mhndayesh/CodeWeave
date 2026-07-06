import ts from "typescript";
import { VERIFICATION } from "../types.js";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

const FASTIFY_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "options", "head",
  "all",
]);

export class FastifyBridge implements ContractBridge {
  name = "fastify";

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
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const methodName = node.expression.name.text;
        if (FASTIFY_METHODS.has(methodName) && node.arguments.length > 0) {
          const firstArg = node.arguments[0];
          if (ts.isStringLiteralLike(firstArg)) {
            const path = firstArg.text;
            const handlerName =
              node.arguments.length > 1
                ? node.arguments[1].getText(source)
                : undefined;

            const opts = node.arguments.length > 1 ? node.arguments[1] : undefined;
            let schemaType: string | undefined;
            if (opts && ts.isObjectLiteralExpression(opts)) {
              for (const prop of opts.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "schema") {
                  schemaType = prop.initializer.getText(source);
                }
              }
            }

            const method = methodName === "all" ? "ALL" : methodName.toUpperCase();
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
              sourceMethod: "fastify-bridge",
              metadata: {
                method, path, handlerName,
                schemaType: schemaType,
              },
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
    return { routes, schemas: [], events: [], apis: [], tables: [] };
  }
}
