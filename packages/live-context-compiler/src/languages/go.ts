import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { CodeEdge, CodeNode, EdgeKind, Verification } from "../types.js";
import { VERIFICATION } from "../types.js";
import type { ExtractionResult, LanguageIndexer } from "./base.js";
import { makeNode, makeEdge, makeFileNode } from "./base.js";

export class GoIndexer implements LanguageIndexer {
  language = "go";
  extensions = [".go"];

  extract(text: string, filePath: string, root: string): ExtractionResult {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNode = makeFileNode(filePath, text, root);
    nodes.push(fileNode);

    const funcRegex = /^(?:func\s+)(?:\([^)]*\)\s+)?(\w+)\s*\(/gm;
    const typeRegex = /^type\s+(\w+)\s+(?:struct|interface)\s*/gm;
    const methodRegex = /^func\s+\([^)]+\)\s+(\w+)\s*\(/gm;

    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "function", name, filePath, lineNum, lineNum + 1, "go");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = methodRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "method", name, filePath, lineNum, lineNum + 1, "go");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = typeRegex.exec(text)) !== null) {
      const name = match[1];
      const isStruct = match[0].includes("struct") ? "class" : "interface";
      const lineNum = text.slice(0, match.index).split("\n").length;
      const kind = isStruct as "class" | "interface";
      const node = makeNode(root, kind, name, filePath, lineNum, lineNum + 5, "go");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    const importBlockRegex = /^import\s+\(([^)]*)\)/gm;
    while ((match = importBlockRegex.exec(text)) !== null) {
      const body = match[1];
      for (const line of body.split("\n")) {
        const trimmed = line.trim().replace(/^"|"$/g, "");
        if (!trimmed) continue;
        const parts = trimmed.split("/");
        const pkgName = parts[parts.length - 1].replace(/"/g, "");
        const targetQName = `file:${pkgName}`;
        const targetId = stableId(root, "go", targetQName);
        nodes.push({
          identity: { stableId: targetId, versionHash: versionHash(targetQName) },
          kind: "file",
          name: targetQName,
          qualifiedName: targetQName,
          filePath: targetQName,
          startLine: 0,
          endLine: 0,
          language: "go",
        });
        edges.push(makeEdge(fileNode.identity.stableId, targetId, "IMPORTS", VERIFICATION.UNRESOLVED, "go-indexer"));
      }
    }

    const importLineRegex = /^import\s+"([^"]+)"\s*$/gm;
    while ((match = importLineRegex.exec(text)) !== null) {
      const importPath = match[1];
      const parts = importPath.split("/");
      const pkgName = parts[parts.length - 1];
      const targetQName = `file:${pkgName}`;
      const targetId = stableId(root, "go", targetQName);
      nodes.push({
        identity: { stableId: targetId, versionHash: versionHash(targetQName) },
        kind: "file",
        name: targetQName,
        qualifiedName: targetQName,
        filePath: targetQName,
        startLine: 0,
        endLine: 0,
        language: "go",
      });
      edges.push(makeEdge(fileNode.identity.stableId, targetId, "IMPORTS", VERIFICATION.UNRESOLVED, "go-indexer"));
    }

    return { nodes, edges };
  }
}
