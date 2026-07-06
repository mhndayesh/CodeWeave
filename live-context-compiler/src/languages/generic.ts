import type { CodeEdge, CodeNode } from "../types.js";
import { VERIFICATION } from "../types.js";
import type { ExtractionResult, LanguageIndexer } from "./base.js";
import { makeNode, makeEdge, makeFileNode } from "./base.js";
import { leadingCommentDoc, moduleDoc } from "./docstring.js";

// Heuristic, language-agnostic fallback for source files that have no dedicated
// indexer. Produces a file node plus coarse function/class nodes and unresolved
// import edges. Everything is tier "pattern matched" / "unresolved" so callers
// treat it as a hint, not ground truth.
const MAX_BYTES = 512 * 1024;

export class GenericIndexer implements LanguageIndexer {
  language = "generic";
  extensions = [
    ".java", ".kt", ".kts", ".scala", ".groovy",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh",
    ".cs", ".rb", ".php", ".swift", ".m", ".mm",
    ".lua", ".sh", ".bash", ".zsh", ".pl", ".pm", ".r",
    ".jl", ".dart", ".ex", ".exs", ".erl", ".clj", ".cljs",
    ".hs", ".ml", ".mli", ".vb", ".sql", ".proto",
    ".tf", ".vue", ".svelte",
  ];

  extract(text: string, filePath: string, root: string): ExtractionResult {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNode = makeFileNode(filePath, text, root, moduleDoc(text));
    nodes.push(fileNode);

    // Skip obviously non-source or minified content (no newlines / too big).
    if (text.length > MAX_BYTES || !text.includes("\n")) {
      return { nodes, edges };
    }

    const seen = new Set<string>();
    const add = (kind: CodeNode["kind"], name: string, index: number) => {
      if (!name || seen.has(kind + ":" + name)) return;
      seen.add(kind + ":" + name);
      const lineNum = text.slice(0, index).split("\n").length;
      const node = makeNode(root, kind, name, filePath, lineNum, lineNum + 1, "generic", undefined, leadingCommentDoc(text, lineNum));
      nodes.push(node);
      edges.push(makeEdge(fileNode.identity.stableId, node.identity.stableId, "CONTAINS"));
    };

    // Function-like declarations across many C-like and scripting languages.
    const funcRegex =
      /^[ \t]*(?:(?:export|public|private|protected|internal|static|final|abstract|async|override|virtual|inline|pub|fn|func|function|def|sub|void)\s+)+[\w:<>,\[\]\*&\s]*?(\w+)\s*\(/gm;
    // Also catch bare `name(...) {` style (e.g. C/C++/Java methods) on their own line.
    const braceFuncRegex = /^[ \t]*(?:[\w:<>,\[\]\*&]+\s+)+(\w+)\s*\([^;]*\)\s*\{/gm;
    const typeRegex =
      /^[ \t]*(?:export\s+|public\s+|private\s+|abstract\s+|final\s+|sealed\s+|data\s+|open\s+)*(?:class|struct|interface|enum|trait|type|module|namespace|record|protocol|object)\s+(\w+)/gm;
    const importRegex = /^[ \t]*(?:import|#include|require|use|using|from|open)\b[ \t]*["'<]?([\w./:\-]+)/gm;

    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(text)) !== null) add("class", m[1], m.index);
    while ((m = funcRegex.exec(text)) !== null) add("function", m[1], m.index);
    while ((m = braceFuncRegex.exec(text)) !== null) add("function", m[1], m.index);

    const importSeen = new Set<string>();
    while ((m = importRegex.exec(text)) !== null) {
      const spec = m[1];
      if (!spec || importSeen.has(spec)) continue;
      importSeen.add(spec);
      edges.push(
        makeEdge(
          fileNode.identity.stableId,
          `unresolved::${spec}`,
          "IMPORTS",
          VERIFICATION.UNRESOLVED,
          "generic-indexer",
          { specifier: spec },
        ),
      );
    }

    return { nodes, edges };
  }
}
