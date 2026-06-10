import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { CodeEdge, CodeNode, EdgeKind, Verification } from "../types.js";
import { VERIFICATION } from "../types.js";
import type { ExtractionResult, LanguageIndexer } from "./base.js";
import { makeNode, makeEdge, makeFileNode } from "./base.js";

export class PythonIndexer implements LanguageIndexer {
  language = "python";
  extensions = [".py"];

  extract(text: string, filePath: string, root: string): ExtractionResult {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNode = makeFileNode(filePath, text, root);
    nodes.push(fileNode);

    const lines = text.split("\n");

    const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
    const classRegex = /^class\s+(\w+)/gm;
    const importRegex = /^(?:from\s+(\S+)\s+)?import\s+(\S+(?:\s*,\s*\S+)*)/gm;

    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "function", name, filePath, lineNum, lineNum + 1, "python");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = classRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "class", name, filePath, lineNum, lineNum + 5, "python");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = importRegex.exec(text)) !== null) {
      const fromModule = match[1];
      const imports = match[2].split(",").map((s) => s.trim());

      if (fromModule) {
        for (const imp of imports) {
          const targetQName = `file:${fromModule.replaceAll(".", "/")}.py`;
          const targetId = stableId(root, "python", targetQName);
          nodes.push({
            identity: { stableId: targetId, versionHash: versionHash(targetQName) },
            kind: "file",
            name: targetQName,
            qualifiedName: targetQName,
            filePath: targetQName,
            startLine: 0,
            endLine: 0,
            language: "python",
          });
          edges.push(makeEdge(fileNode.identity.stableId, targetId, "IMPORTS", VERIFICATION.UNRESOLVED, "python-indexer"));

          const mod = fromModule.replaceAll(".", "/");
          edges.push(makeEdge(
            fileNode.identity.stableId,
            stableId(root, "python", `function:${mod}:${imp}`),
            "REFERENCES",
            VERIFICATION.UNRESOLVED,
            "python-indexer",
          ));
        }
      } else {
        for (const imp of imports) {
          const targetQName = `file:${imp.replaceAll(".", "/")}.py`;
          const targetId = stableId(root, "python", targetQName);
          nodes.push({
            identity: { stableId: targetId, versionHash: versionHash(targetQName) },
            kind: "file",
            name: targetQName,
            qualifiedName: targetQName,
            filePath: targetQName,
            startLine: 0,
            endLine: 0,
            language: "python",
          });
          edges.push(makeEdge(fileNode.identity.stableId, targetId, "IMPORTS", VERIFICATION.UNRESOLVED, "python-indexer"));
        }
      }
    }

    return { nodes, edges };
  }
}
