import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { CodeEdge, CodeNode, EdgeKind, Verification } from "../types.js";
import { VERIFICATION } from "../types.js";

export interface ExtractionResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export interface LanguageIndexer {
  language: string;
  extensions: string[];
  extract(text: string, filePath: string, root: string): ExtractionResult;
}

export function makeFileNode(filePath: string, text: string, root: string, doc?: string): CodeNode {
  return {
    identity: {
      stableId: stableId(root, "generic", `file:${filePath}`),
      versionHash: versionHash(text),
    },
    kind: "file",
    name: filePath,
    qualifiedName: `file:${filePath}`,
    filePath,
    startLine: 1,
    endLine: text.split("\n").length,
    doc,
    language: "generic",
  };
}

export function makeNode(
  root: string,
  kind: CodeNode["kind"],
  name: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,
  signature?: string,
  doc?: string,
): CodeNode {
  const qualifiedName = `${kind}:${filePath}:${name}`;
  return {
    identity: {
      stableId: stableId(root, language, qualifiedName),
      versionHash: versionHash(name),
    },
    kind,
    name,
    qualifiedName,
    filePath,
    startLine,
    endLine,
    signature,
    doc,
    language,
  };
}

export function makeEdge(
  sourceId: string,
  targetId: string,
  kind: EdgeKind,
  verification: Verification = VERIFICATION.PATTERN_MATCHED,
  sourceMethod = "language-indexer",
  metadata?: Record<string, unknown>,
): CodeEdge {
  return { sourceId, targetId, kind, verification, sourceMethod, metadata };
}

export function extractAndStore(
  store: GraphStore,
  result: ExtractionResult,
  filePath: string,
  root: string,
): void {
  for (const node of result.nodes) {
    store.upsertNode(node);
  }
  for (const edge of result.edges) {
    store.upsertEdge(edge);
  }
}
