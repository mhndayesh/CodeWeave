import { GraphStore } from "../db.js";
import type { LanguageIndexer } from "./base.js";
import { extractAndStore } from "./base.js";
import { PythonIndexer } from "./python.js";
import { RustIndexer } from "./rust.js";
import { GoIndexer } from "./go.js";
import { GenericIndexer } from "./generic.js";
import { treeSitterExtract } from "./treesitter.js";

// Dedicated language indexers first; the generic fallback matches last so a
// specific indexer always wins for its extensions.
const indexers: LanguageIndexer[] = [
  new PythonIndexer(),
  new RustIndexer(),
  new GoIndexer(),
  new GenericIndexer(),
];

const extMap = new Map<string, LanguageIndexer>();
for (const idx of indexers) {
  for (const ext of idx.extensions) {
    extMap.set(ext, idx);
  }
}

export function getIndexerForFile(filePath: string): LanguageIndexer | undefined {
  for (const idx of indexers) {
    if (idx.extensions.some((ext) => filePath.endsWith(ext))) {
      return idx;
    }
  }
  return undefined;
}

export function indexFileWithLanguage(
  store: GraphStore,
  filePath: string,
  text: string,
  root: string,
): boolean {
  // Prefer a real tree-sitter parse (accurate symbols, nesting, line spans);
  // fall back to the regex indexers when no grammar is loaded for this file.
  const parsed = treeSitterExtract(text, filePath, root);
  if (parsed) {
    extractAndStore(store, parsed, filePath, root);
    return true;
  }

  const idx = getIndexerForFile(filePath);
  if (!idx) return false;

  const result = idx.extract(text, filePath, root);
  extractAndStore(store, result, filePath, root);
  return true;
}

export function getRegisteredLanguages(): string[] {
  return indexers.map((i) => `${i.language} (${i.extensions.join(", ")})`);
}

export function getRegisteredExtensions(): string[] {
  const exts = new Set<string>();
  for (const idx of indexers) {
    for (const ext of idx.extensions) exts.add(ext);
  }
  return [...exts];
}
