import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { CodeEdge, CodeNode, EdgeKind, Verification } from "../types.js";
import { VERIFICATION } from "../types.js";
import type { ExtractionResult, LanguageIndexer } from "./base.js";
import { makeNode, makeEdge, makeFileNode } from "./base.js";

export class RustIndexer implements LanguageIndexer {
  language = "rust";
  extensions = [".rs"];

  extract(text: string, filePath: string, root: string): ExtractionResult {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNode = makeFileNode(filePath, text, root);
    nodes.push(fileNode);

    // Allow leading indentation so methods inside `impl` blocks and items nested
    // in modules are captured too.
    const fnRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/gm;
    const structRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/gm;
    const enumRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/gm;
    const traitRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/gm;
    const useRegex = /^[ \t]*(?:pub\s+)?use\s+(.+);/gm;
    const implRegex = /^[ \t]*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/gm;

    let match: RegExpExecArray | null;

    while ((match = fnRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "function", name, filePath, lineNum, lineNum + 1, "rust");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = structRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "class", name, filePath, lineNum, lineNum + 3, "rust");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = enumRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "enum", name, filePath, lineNum, lineNum + 3, "rust");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = traitRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "interface", name, filePath, lineNum, lineNum + 3, "rust");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = implRegex.exec(text)) !== null) {
      const name = match[1];
      const lineNum = text.slice(0, match.index).split("\n").length;
      const node = makeNode(root, "method", `impl ${name}`, filePath, lineNum, lineNum + 3, "rust");
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    }

    while ((match = useRegex.exec(text)) !== null) {
      const usePath = match[1].split(" as ")[0].trim();
      const parts = usePath.split("::");
      const targetFile = `src/${parts.slice(0, -1).join("/")}.rs`;
      const targetQName = `file:${targetFile}`;
      const targetId = stableId(root, "rust", targetQName);
      nodes.push({
        identity: { stableId: targetId, versionHash: versionHash(targetQName) },
        kind: "file",
        name: targetQName,
        qualifiedName: targetQName,
        filePath: targetQName,
        startLine: 0,
        endLine: 0,
        language: "rust",
      });
      edges.push(makeEdge(fileNode.identity.stableId, targetId, "IMPORTS", VERIFICATION.UNRESOLVED, "rust-indexer"));
    }

    return { nodes, edges };
  }
}
