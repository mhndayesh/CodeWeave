import { stableId, versionHash } from "../hash.js";
import type { CodeEdge, CodeNode } from "../types.js";
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

    // Line-based scan so methods/nested classes attach to their enclosing class
    // (CONTAINS) rather than the file, tracked by indentation.
    const classRe = /^([ \t]*)class\s+(\w+)/;
    const defRe = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/;
    const stack: Array<{ indent: number; id: string }> = [];

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const classM = classRe.exec(line);
      if (classM) {
        const indent = classM[1].length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const container = stack.length ? stack[stack.length - 1].id : fileNode.identity.stableId;
        const node = makeNode(root, "class", classM[2], filePath, lineNum, lineNum + 1, "python");
        nodes.push(node);
        edges.push(makeEdge(container, node.identity.stableId, "CONTAINS"));
        stack.push({ indent, id: node.identity.stableId });
        continue;
      }

      const defM = defRe.exec(line);
      if (defM) {
        const indent = defM[1].length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const inClass = stack.length > 0;
        const container = inClass ? stack[stack.length - 1].id : fileNode.identity.stableId;
        const node = makeNode(root, inClass ? "method" : "function", defM[2], filePath, lineNum, lineNum + 1, "python");
        nodes.push(node);
        edges.push(makeEdge(container, node.identity.stableId, "CONTAINS"));
        continue;
      }
    }

    const importRegex = /^[ \t]*(?:from\s+(\S+)\s+)?import\s+(\S+(?:\s*,\s*\S+)*)/gm;
    let match: RegExpExecArray | null;
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
