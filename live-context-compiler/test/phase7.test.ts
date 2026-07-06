import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { compileSlice } from "../src/traversal.js";
import { renderSlice } from "../src/render.js";
import { VERIFICATION } from "../src/types.js";
import type { CodeNode, ContextSlice, TraversalPolicy } from "../src/types.js";

const TEST_ROOT = path.resolve("test/tmp-phase7");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
beforeEach(() => clean());
afterEach(() => clean());

function makeStore(): GraphStore {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dbPath = path.join(TEST_ROOT, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

function node(id: string, name: string): CodeNode {
  return {
    identity: { stableId: id, versionHash: "v" },
    kind: "function",
    name,
    qualifiedName: name,
    filePath: "x.py",
    startLine: 1,
    endLine: 1,
    language: "python",
  };
}

// #1 — the traversal cap must keep the most-trustworthy edges, not whatever order the DB
// returned. A hot node with more neighbors than the cap should retain the compiler-verified
// edges and drop the pattern-matched ones.
describe("edge ranking — traversal truncation", () => {
  it("keeps highest-verification edges when a node exceeds maxEdgesPerNode", () => {
    const store = makeStore();
    const entry = node("E", "target");
    store.upsertNode(entry);
    // 5 precise (tier 4) and 5 heuristic (tier 2) callers of the same target.
    for (let i = 0; i < 5; i++) {
      const s = node(`P${i}`, `precise${i}`);
      store.upsertNode(s);
      store.upsertEdge({ sourceId: s.identity.stableId, targetId: "E", kind: "CALLS", verification: VERIFICATION.VERIFIED_COMPILER, sourceMethod: "compiler" });
    }
    for (let i = 0; i < 5; i++) {
      const s = node(`H${i}`, `heuristic${i}`);
      store.upsertNode(s);
      store.upsertEdge({ sourceId: s.identity.stableId, targetId: "E", kind: "CALLS", verification: VERIFICATION.PATTERN_MATCHED, sourceMethod: "cross-ref" });
    }

    const policy: TraversalPolicy = {
      name: "test",
      maxTokens: 9999,
      steps: [{ edgeKinds: ["CALLS"], direction: "reverse", maxEdgesPerNode: 5, stopAtContainerBoundary: false }],
    };
    const slice = compileSlice(store, ["E"], policy);
    const calls = slice.edges.filter((e) => e.kind === "CALLS");
    expect(calls.length).toBe(5);
    // Every retained edge must be the compiler-verified tier; the heuristic ones were dropped.
    expect(calls.every((e) => e.verification === VERIFICATION.VERIFIED_COMPILER)).toBe(true);
    store.close();
  });
});

// #1 — under a tight render budget, precise edges are rendered and heuristic ones truncated,
// rather than rendering whatever order the slice collected them in.
describe("edge ranking — render truncation", () => {
  it("spends a small edge budget on tier-4 edges before tier-2", () => {
    const entry = node("E", "target");
    const edges = [];
    for (let i = 0; i < 12; i++) {
      edges.push({ sourceId: "E", targetId: `H${i}`, kind: "REFERENCES" as const, verification: VERIFICATION.PATTERN_MATCHED, sourceMethod: "cross-ref" });
    }
    for (let i = 0; i < 12; i++) {
      edges.push({ sourceId: "E", targetId: `P${i}`, kind: "CALLS" as const, verification: VERIFICATION.VERIFIED_COMPILER, sourceMethod: "compiler" });
    }
    const slice: ContextSlice = {
      entryNodeIds: ["E"],
      nodes: [entry],
      edges,
      policies: [{ name: "impact", maxTokens: 200, steps: [] }],
    };
    const out = renderSlice(TEST_ROOT, slice, { maxTokens: 200 });
    const edgeLines = out.split("\n").filter((l) => l.includes("-->"));
    const tier4 = edgeLines.filter((l) => l.includes("[4]")).length;
    const tier2 = edgeLines.filter((l) => l.includes("[2]")).length;
    // The budget truncates before all 24 fit; what survives must be the precise edges.
    expect(edgeLines.length).toBeLessThan(24);
    expect(tier4).toBeGreaterThan(0);
    expect(tier2).toBe(0);
  });
});
