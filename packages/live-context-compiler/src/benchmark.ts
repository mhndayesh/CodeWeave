import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GraphStore } from "./db.js";
import { TsRepositoryIndexer } from "./indexer.js";
import { compileSlice, POLICIES } from "./traversal.js";
import type { TraversalPolicy } from "./types.js";

interface GoldCase {
  name: string;
  query: string;
  policyName: string;
  expectedNodeNameFragments: string[];
  forbiddenNodeNameFragments?: string[];
}

const root = path.resolve(process.argv[2] ?? "test/fixture");
const dbPath = path.join(root, ".context-graph.sqlite");
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const store = new GraphStore(dbPath);
const indexer = new TsRepositoryIndexer(store, root);
const startIndex = performance.now();
await indexer.indexAll();
const indexMs = performance.now() - startIndex;

const gold = JSON.parse(
  fs.readFileSync(path.resolve("bench/gold.json"), "utf8"),
) as GoldCase[];

let passed = 0;
for (const test of gold) {
  const matches = store.findNodes(test.query, 5);
  if (!matches.length) {
    console.log(`FAIL ${test.name}: entry node not found`);
    continue;
  }
  const started = performance.now();
  const policy = POLICIES[test.policyName];
  if (!policy) {
    console.log(`FAIL ${test.name}: unknown policy "${test.policyName}"`);
    continue;
  }
  const slice = compileSlice(store, [matches[0].identity.stableId], policy);
  const queryMs = performance.now() - started;
  const names = slice.nodes.map((n) => n.qualifiedName);
  const missing = test.expectedNodeNameFragments.filter(
    (fragment) => !names.some((name) => name.includes(fragment)),
  );
  const forbidden = (test.forbiddenNodeNameFragments ?? []).filter(
    (fragment) => names.some((name) => name.includes(fragment)),
  );
  if (missing.length || forbidden.length) {
    console.log(
      `FAIL ${test.name}: missing=${missing.join(",")} forbidden=${forbidden.join(",")}`,
    );
  } else {
    passed++;
    console.log(
      `PASS ${test.name}: nodes=${slice.nodes.length} edges=${slice.edges.length} queryMs=${queryMs.toFixed(2)}`,
    );
  }
}
console.log(
  `\nIndex: ${indexMs.toFixed(2)}ms | Passed: ${passed}/${gold.length}`,
);
process.exit(passed === gold.length ? 0 : 1);
