import ts from "typescript";
import { VERIFICATION } from "../types.js";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    ts.isIdentifier(node.name) &&
    node.name.text === "env"
  );
}

export class EnvBridge implements ContractBridge {
  name = "env";

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
    const visited = new Set<string>();

    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isProcessEnv(node.expression) &&
        ts.isIdentifier(node.name)
      ) {
        const envName = node.name.text;
        if (!visited.has(envName)) {
          visited.add(envName);
          this.recordEnvVar(store, envName, filePath, fileNodeId, root);
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (
        ts.isElementAccessExpression(node) &&
        isProcessEnv(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const envName = node.argumentExpression.text;
        if (!visited.has(envName)) {
          visited.add(envName);
          this.recordEnvVar(store, envName, filePath, fileNodeId, root);
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "env" || node.expression.text === "config") &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const envName = node.arguments[0].text;
        if (!visited.has(envName)) {
          visited.add(envName);
          this.recordEnvVar(store, envName, filePath, fileNodeId, root);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
    return { routes: [], schemas: [], events: [], apis: [], tables: [] };
  }

  private recordEnvVar(
    store: GraphStore,
    name: string,
    filePath: string,
    fileNodeId: string,
    root: string,
  ): void {
    const qName = `env_var:${name}`;
    const sid = stableId(root, "ts", qName);
    store.upsertNode({
      identity: { stableId: sid, versionHash: versionHash(name) },
      kind: "config",
      name,
      qualifiedName: qName,
      filePath,
      startLine: 0,
      endLine: 0,
      language: "ts",
    });
    store.upsertEdge({
      sourceId: fileNodeId,
      targetId: sid,
      kind: "REFERENCES",
      verification: VERIFICATION.VERIFIED_STATIC,
      sourceMethod: "env-bridge",
      metadata: { envVar: name },
    });
  }
}
