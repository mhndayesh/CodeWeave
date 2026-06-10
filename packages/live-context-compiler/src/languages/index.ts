import { GraphStore } from "../db.js";
import type { LanguageIndexer } from "./base.js";
import { extractAndStore } from "./base.js";
import { PythonIndexer } from "./python.js";
import { RustIndexer } from "./rust.js";
import { GoIndexer } from "./go.js";

const indexers: LanguageIndexer[] = [
  new PythonIndexer(),
  new RustIndexer(),
  new GoIndexer(),
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
  const idx = getIndexerForFile(filePath);
  if (!idx) return false;

  const result = idx.extract(text, filePath, root);
  extractAndStore(store, result, filePath, root);
  return true;
}

export function getRegisteredLanguages(): string[] {
  return indexers.map((i) => `${i.language} (${i.extensions.join(", ")})`);
}
