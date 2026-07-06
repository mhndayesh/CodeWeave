import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";
import { ModuleResolver } from "../src/resolver.js";
import { Invalidator } from "../src/invalidator.js";
import { compileSlice, estimateTokenCount, POLICIES } from "../src/traversal.js";
import { stableId, versionHash } from "../src/hash.js";
import { VERIFICATION } from "../src/types.js";
import type { CodeNode, CodeEdge } from "../src/types.js";

const TEST_ROOT = path.resolve("test/tmp");
const FIXTURE_ROOT = path.resolve("test/fixture");

function cleanTemp(): void {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function createRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function makeStore(rootOrPath: string, isDir = true): GraphStore {
  const dbPath = isDir
    ? path.join(rootOrPath, ".test.sqlite")
    : rootOrPath;
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

beforeEach(() => cleanTemp());
afterEach(() => cleanTemp());

// ─── ModuleResolver ──────────────────────────────────────────

describe("ModuleResolver", () => {
  it("resolves relative ./foo to foo.ts", () => {
    const root = createRepo("res-01", {
      "src/bar.ts": "",
      "src/foo.ts": "export const x = 1;",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(path.join(root, "src/bar.ts"), "./foo");
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("src/foo.ts");
  });

  it("resolves ../../lib/util to lib/util.ts", () => {
    const root = createRepo("res-02", {
      "src/sub/deep.ts": "",
      "lib/util.ts": "",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(
      path.join(root, "src/sub/deep.ts"),
      "../../lib/util",
    );
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("lib/util.ts");
  });

  it("resolves directory/index.ts via barrel import", () => {
    const root = createRepo("res-03", {
      "src/app.ts": "",
      "components/index.ts": "",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(
      path.join(root, "src/app.ts"),
      "../components",
    );
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("components/index.ts");
  });

  it("tries .ts, .tsx, .js, .jsx, .mjs, .cjs extensions", () => {
    const root = createRepo("res-04", {
      "src/app.tsx": "",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(path.join(root, "other.ts"), "./src/app");
    expect(result).not.toBeNull();
    expect(result!.relativePath).toBe("src/app.tsx");
  });

  it("returns null for unresolvable import", () => {
    const root = createRepo("res-05", { "a.ts": "" });
    const r = new ModuleResolver(root);
    const result = r.resolve(path.join(root, "a.ts"), "./nonexistent");
    expect(result).toBeNull();
  });

  it("resolves node_modules package to entry point", () => {
    const root = createRepo("res-06", {
      "src/index.ts": "",
      "node_modules/express/package.json": JSON.stringify({ main: "index.js" }),
      "node_modules/express/index.js": "module.exports = {};",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(path.join(root, "src/index.ts"), "express");
    expect(result).not.toBeNull();
    expect(result!.packageName).toBe("express");
    expect(result!.absolutePath).toContain("node_modules/express/index.js");
  });

  it("resolves scoped @package/name", () => {
    const root = createRepo("res-07", {
      "src/index.ts": "",
      "node_modules/@scope/foo/package.json": JSON.stringify({ main: "lib.js" }),
      "node_modules/@scope/foo/lib.js": "",
    });
    const r = new ModuleResolver(root);
    const result = r.resolve(path.join(root, "src/index.ts"), "@scope/foo");
    expect(result).not.toBeNull();
    expect(result!.packageName).toBe("@scope/foo");
  });

  it("invalidates cache on demand", () => {
    const root = createRepo("res-08", { "a.ts": "" });
    const r = new ModuleResolver(root);
    expect(r.resolve(path.join(root, "a.ts"), "./b")).toBeNull();
    fs.writeFileSync(path.join(root, "b.ts"), "", "utf8");
    r.invalidateCache();
    const result = r.resolve(path.join(root, "a.ts"), "./b");
    expect(result).not.toBeNull();
  });
});

// ─── GraphStore ─────────────────────────────────────────────

describe("GraphStore", () => {
  it("upserts and retrieves a node", () => {
    const root = createRepo("db-01", {});
    const store = makeStore(root);
    const node: CodeNode = {
      identity: { stableId: "abc", versionHash: "v1" },
      kind: "function",
      name: "hello",
      qualifiedName: "function:hello",
      filePath: "src/main.ts",
      startLine: 1,
      endLine: 5,
      language: "ts",
    };
    store.upsertNode(node);
    const retrieved = store.getNode("abc");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("hello");
    expect(retrieved!.kind).toBe("function");
    store.close();
  });

  it("updates node on upsert with same stableId", () => {
    const root = createRepo("db-02", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "x", versionHash: "v1" },
      kind: "function", name: "old", qualifiedName: "f:old",
      filePath: "a.ts", startLine: 1, endLine: 2, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "x", versionHash: "v2" },
      kind: "class", name: "new", qualifiedName: "c:new",
      filePath: "a.ts", startLine: 1, endLine: 2, language: "ts",
    });
    const node = store.getNode("x")!;
    expect(node.name).toBe("new");
    expect(node.identity.versionHash).toBe("v2");
    store.close();
  });

  it("preserves previousStableId across updates", () => {
    const root = createRepo("db-03", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "x", versionHash: "v1" },
      kind: "function", name: "a", qualifiedName: "f:a",
      filePath: "a.ts", startLine: 1, endLine: 2, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "y", versionHash: "v2", previousStableId: "x" },
      kind: "function", name: "a", qualifiedName: "f:a",
      filePath: "b.ts", startLine: 1, endLine: 2, language: "ts",
    });
    const node = store.getNode("y")!;
    expect(node.identity.previousStableId).toBe("x");
    store.close();
  });

  it("upserts edge with evidence", () => {
    const root = createRepo("db-04", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "a", versionHash: "v1" },
      kind: "function", name: "a", qualifiedName: "f:a",
      filePath: "a.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "b", versionHash: "v1" },
      kind: "function", name: "b", qualifiedName: "f:b",
      filePath: "a.ts", startLine: 2, endLine: 2, language: "ts",
    });
    store.upsertEdge({
      sourceId: "a", targetId: "b", kind: "CALLS",
      verification: VERIFICATION.VERIFIED_STATIC,
      sourceMethod: "typescript-compiler",
    });
    const edges = store.outgoing("a", ["CALLS"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("CALLS");
    expect(edges[0].verification).toBe(VERIFICATION.VERIFIED_STATIC);
    store.close();
  });

  it("accumulates multiple evidence records for same edge", () => {
    const root = createRepo("db-05", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "a", versionHash: "v1" },
      kind: "function", name: "a", qualifiedName: "f:a",
      filePath: "a.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "b", versionHash: "v1" },
      kind: "function", name: "b", qualifiedName: "f:b",
      filePath: "a.ts", startLine: 2, endLine: 2, language: "ts",
    });
    store.upsertEdge({
      sourceId: "a", targetId: "b", kind: "CALLS",
      verification: VERIFICATION.VERIFIED_STATIC,
      sourceMethod: "typescript-compiler",
    });
    store.upsertEdge({
      sourceId: "a", targetId: "b", kind: "CALLS",
      verification: VERIFICATION.VERIFIED_RUNTIME,
      sourceMethod: "opentelemetry",
    });
    const evidence = store.getEvidence("a", "b", "CALLS");
    expect(evidence).toHaveLength(2);
    expect(evidence[0].verification).toBe(VERIFICATION.VERIFIED_STATIC);
    expect(evidence[1].verification).toBe(VERIFICATION.VERIFIED_RUNTIME);
    store.close();
  });

  it("deletes all nodes/edges for a file via clearFile", () => {
    const root = createRepo("db-06", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "n1", versionHash: "v1" },
      kind: "function", name: "x", qualifiedName: "f:x",
      filePath: "src/a.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "n2", versionHash: "v1" },
      kind: "function", name: "y", qualifiedName: "f:y",
      filePath: "src/a.ts", startLine: 2, endLine: 2, language: "ts",
    });
    store.upsertEdge({
      sourceId: "n1", targetId: "n2", kind: "CALLS",
      verification: VERIFICATION.VERIFIED_STATIC,
      sourceMethod: "typescript-compiler",
    });
    store.markIndexed("src/a.ts", "hash1");
    store.clearFile("src/a.ts");
    expect(store.getNode("n1")).toBeUndefined();
    expect(store.getNode("n2")).toBeUndefined();
    expect(store.outgoing("n1", ["CALLS"])).toHaveLength(0);
    expect(store.indexedHash("src/a.ts")).toBeUndefined();
    store.close();
  });

  it("tracks import index for reverse invalidation", () => {
    const root = createRepo("db-07", {});
    const store = makeStore(root);
    store.addImportEdge("src/a.ts", "src/b.ts", "IMPORTS");
    store.addImportEdge("src/b.ts", "src/c.ts", "IMPORTS");
    store.addImportEdge("src/a.ts", "src/c.ts", "IMPORTS");
    const importersOfC = store.getImportersOf("src/c.ts");
    expect(importersOfC).toContain("src/a.ts");
    expect(importersOfC).toContain("src/b.ts");
    expect(store.getImportsOf("src/a.ts")).toContain("src/b.ts");
    expect(store.getImportsOf("src/b.ts")).toContain("src/c.ts");
    store.close();
  });

  it("tracks dirty files", () => {
    const root = createRepo("db-08", {});
    const store = makeStore(root);
    store.markDirty("a.ts", "changed");
    store.markDirty("b.ts", "deleted");
    const dirty = store.getDirtyFiles();
    expect(dirty).toContain("a.ts");
    expect(dirty).toContain("b.ts");
    store.clearDirty("a.ts");
    expect(store.getDirtyFiles()).not.toContain("a.ts");
    store.close();
  });

  it("handles findNodes via FTS5 or LIKE fallback", () => {
    const root = createRepo("db-09", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "sid1", versionHash: "v1" },
      kind: "function", name: "greetUser", qualifiedName: "function:greetUser",
      filePath: "src/greeting.ts", startLine: 1, endLine: 5, language: "ts",
    });
    store.upsertNode({
      identity: { stableId: "sid2", versionHash: "v1" },
      kind: "class", name: "UserManager", qualifiedName: "class:UserManager",
      filePath: "src/user.ts", startLine: 1, endLine: 10, language: "ts",
    });
    const results = store.findNodes("greet", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((n) => n.name === "greetUser")).toBe(true);
    const results2 = store.findNodes("User", 10);
    expect(results2.some((n) => n.name === "UserManager")).toBe(true);
    store.close();
  });

  it("getNodes with empty array returns empty", () => {
    const root = createRepo("db-10", {});
    const store = makeStore(root);
    expect(store.getNodes([])).toHaveLength(0);
    store.close();
  });

  it("transaction commits all changes", () => {
    const root = createRepo("db-11", {});
    const store = makeStore(root);
    store.transaction(() => {
      store.upsertNode({
        identity: { stableId: "t1", versionHash: "v1" },
        kind: "function", name: "txTest", qualifiedName: "f:txTest",
        filePath: "tx.ts", startLine: 1, endLine: 1, language: "ts",
      });
    });
    expect(store.getNode("t1")).toBeDefined();
    store.close();
  });

  it("deleteAll removes everything", () => {
    const root = createRepo("db-12", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "x", versionHash: "v1" },
      kind: "function", name: "x", qualifiedName: "f:x",
      filePath: "x.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.deleteAll();
    expect(store.getNode("x")).toBeUndefined();
    expect(store.getStats().nodes).toBe(0);
    expect(store.getStats().edges).toBe(0);
    store.close();
  });
});

// ─── TsRepositoryIndexer ─────────────────────────────────────

describe("TsRepositoryIndexer", () => {
  it("extracts function declarations", async () => {
    const root = createRepo("idx-01", {
      "src/main.ts": "export function foo(a: number): string { return 'x'; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const nodes = store.findNodes("foo", 10);
    expect(nodes.some((n) => n.kind === "function" && n.name === "foo")).toBe(true);
    store.close();
  });

  it("extracts class declarations with superclass", async () => {
    const root = createRepo("idx-02", {
      "src/main.ts": "class Animal {}\nclass Dog extends Animal {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const nodes = store.findNodes("Dog", 10);
    expect(nodes.some((n) => n.kind === "class")).toBe(true);
    const dogNode = nodes.find((n) => n.name === "Dog")!;
    const dogOut = store.outgoing(dogNode.identity.stableId, ["EXTENDS"]);
    expect(dogOut).toHaveLength(1);
    expect(dogOut[0].kind).toBe("EXTENDS");
    store.close();
  });

  it("extracts implements relationships", async () => {
    const root = createRepo("idx-03", {
      "src/main.ts":
        "interface IWalker { walk(): void; }\nclass Robot implements IWalker { walk() {} }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const robot = store.findNodes("Robot", 10)[0];
    const robotOut = store.outgoing(robot.identity.stableId, ["IMPLEMENTS"]);
    expect(robotOut).toHaveLength(1);
    expect(robotOut[0].kind).toBe("IMPLEMENTS");
    store.close();
  });

  it("extracts interface declarations", async () => {
    const root = createRepo("idx-04", {
      "src/main.ts": "export interface User { id: string; name: string; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const nodes = store.findNodes("User", 10);
    expect(nodes.some((n) => n.kind === "interface")).toBe(true);
    store.close();
  });

  it("extracts type aliases", async () => {
    const root = createRepo("idx-05", {
      "src/main.ts":
        "export type Callback = (err: Error | null) => void;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const nodes = store.findNodes("Callback", 10);
    expect(nodes.some((n) => n.kind === "type" && n.name === "Callback")).toBe(true);
    store.close();
  });

  it("extracts enum declarations", async () => {
    const root = createRepo("idx-06", {
      "src/main.ts": "enum Color { Red, Green, Blue }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const nodes = store.findNodes("Color", 10);
    expect(nodes.some((n) => n.kind === "enum")).toBe(true);
    store.close();
  });

  it("resolves cross-file imports", async () => {
    const root = createRepo("idx-07", {
      "src/auth.ts":
        "export function login(email: string) { return true; }",
      "src/routes.ts":
        "import { login } from './auth';\nexport function handler() { login('test@test.com'); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const handler = store.findNodes("handler", 10)[0];
    const calls = store.outgoing(handler.identity.stableId, ["CALLS"]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].verification).toBe(VERIFICATION.VERIFIED_COMPILER);
    const callTarget = store.getNode(calls[0].targetId);
    expect(callTarget?.name).toBe("login");
    store.close();
  });

  it("tracks exports from files", async () => {
    const root = createRepo("idx-08", {
      "src/main.ts": "export function foo() {}; export class Bar {};",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/main.ts", 10)[0];
    const edges = store.outgoing(fileNode.identity.stableId, ["EXPORTS"]);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const exportedNames = edges.map((e) => store.getNode(e.targetId)?.name);
    expect(exportedNames).toContain("foo");
    expect(exportedNames).toContain("Bar");
    store.close();
  });

  it("detects route exposure (regex-contract)", async () => {
    const root = createRepo("idx-09", {
      "src/routes.ts":
        "const app = { get: () => {} };\napp.get('/api/health', () => 'ok');",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const routeNodes = store.findNodes("GET /api/health", 10);
    expect(routeNodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("detects fetch consumer (regex-contract)", async () => {
    const root = createRepo("idx-10", {
      "src/client.ts":
        "export async function load() { return fetch('/api/data'); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/client.ts", 10)[0];
    const consumers = store.outgoing(fileNode.identity.stableId, ["CONSUMES_ROUTE"]);
    expect(consumers.length).toBeGreaterThanOrEqual(1);
    expect(consumers[0].kind).toBe("CONSUMES_ROUTE");
    store.close();
  });

  it("detects event emission (regex-contract)", async () => {
    const root = createRepo("idx-11", {
      "src/events.ts":
        "function notify() { emit('user.login', { id: 1 }); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/events.ts", 10)[0];
    const emits = store.outgoing(fileNode.identity.stableId, ["EMITS_EVENT"]);
    expect(emits.length).toBeGreaterThanOrEqual(1);
    const eventNode = store.getNode(emits[0].targetId);
    expect(eventNode?.name).toBe("user.login");
    store.close();
  });

  it("detects db read/write patterns (regex-contract)", async () => {
    const root = createRepo("idx-12", {
      "src/data.ts":
        "const users = db.findMany('users', {});\nawait db.create('orders', {});",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/data.ts", 10)[0];
    const reads = store.outgoing(fileNode.identity.stableId, ["READS_TABLE"]);
    const writes = store.outgoing(fileNode.identity.stableId, ["WRITES_TABLE"]);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("creates CONTAINS edges from file to symbols", async () => {
    const root = createRepo("idx-13", {
      "src/main.ts": "export function a() {}\nexport function b() {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/main.ts", 10)[0];
    const contains = store.outgoing(fileNode.identity.stableId, ["CONTAINS"]);
    expect(contains.length).toBe(2);
    const names = contains.map((e) => store.getNode(e.targetId)?.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    store.close();
  });

  it("skips re-indexing unchanged files", async () => {
    const root = createRepo("idx-14", {
      "src/a.ts": "export const x = 1;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const hashBefore = store.indexedHash("src/a.ts");
    await indexer.indexAll();
    const hashAfter = store.indexedHash("src/a.ts");
    expect(hashBefore).toBe(hashAfter);
    store.close();
  });

  it("cleans up file on deletion", async () => {
    const root = createRepo("idx-15", {
      "src/a.ts": "export function foo() {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    expect(store.findNodes("foo", 10).length).toBeGreaterThanOrEqual(1);
    const absPath = path.join(root, "src/a.ts");
    fs.unlinkSync(absPath);
    indexer.indexFile(absPath);
    expect(store.findNodes("foo", 10).length).toBe(0);
    store.close();
  });

  it("handles files with no declarations gracefully", async () => {
    const root = createRepo("idx-16", {
      "src/empty.ts": "",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/empty.ts", 10)[0];
    expect(fileNode).toBeDefined();
    expect(fileNode.kind).toBe("file");
    store.close();
  });

  it("captures UNRESOLVED_CALL for unknown callees", async () => {
    const root = createRepo("idx-17", {
      "src/main.ts":
        "export function run() { unknownFunction(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const run = store.findNodes("run", 10)[0];
    const unresolved = store.outgoing(run.identity.stableId, ["UNRESOLVED_CALL"]);
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("stableId is deterministic for same symbol", () => {
    const id1 = stableId("/repo", "ts", "function:a.ts:foo");
    const id2 = stableId("/repo", "ts", "function:a.ts:foo");
    expect(id1).toBe(id2);
  });

  it("handles barrel re-exports via index files", async () => {
    const root = createRepo("idx-18", {
      "lib/foo.ts": "export function foo() {}",
      "lib/index.ts": "export { foo } from './foo';",
      "src/main.ts":
        "import { foo } from '../lib'; foo();",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const main = store.findNodes("src/main.ts", 10)[0];
    const imports = store.outgoing(main.identity.stableId, ["IMPORTS"]);
    expect(imports.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── Invalidator ────────────────────────────────────────────

describe("Invalidator", () => {
  it("marks direct importers when file changes", () => {
    const root = createRepo("inv-01", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "b.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const affected = inv.onFileChanged("b.ts");
    expect(affected).toContain("a.ts");
    expect(store.getDirtyFiles()).toContain("a.ts");
    store.close();
  });

  it("marks transitive dependents via propagateDirty", () => {
    const root = createRepo("inv-02", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "b.ts", "IMPORTS");
    store.addImportEdge("b.ts", "c.ts", "IMPORTS");
    const inv = new Invalidator(store);
    inv.onFileChanged("c.ts");
    const propagated = inv.propagateDirty();
    expect(propagated).toContain("a.ts");
    expect(propagated).toContain("b.ts");
    store.close();
  });

  it("cleans up and marks dependents on file deletion", () => {
    const root = createRepo("inv-03", {});
    const store = makeStore(root);
    store.addImportEdge("src/a.ts", "src/b.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const affected = inv.onFileDeleted("src/b.ts");
    expect(affected).toContain("src/a.ts");
    expect(store.getDirtyFiles()).toContain("src/a.ts");
    store.close();
  });

  it("tracks transitive dependents via getTransitiveDependents", () => {
    const root = createRepo("inv-04", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "b.ts", "IMPORTS");
    store.addImportEdge("b.ts", "c.ts", "IMPORTS");
    store.addImportEdge("c.ts", "d.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const deps = inv.getTransitiveDependents("d.ts");
    expect(deps).toContain("a.ts");
    expect(deps).toContain("b.ts");
    expect(deps).toContain("c.ts");
    expect(deps).toHaveLength(3);
    store.close();
  });

  it("does not include self in transitive dependents", () => {
    const root = createRepo("inv-05", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "a.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const deps = inv.getTransitiveDependents("a.ts");
    expect(deps).not.toContain("a.ts");
    store.close();
  });

  it("handles diamond dependency correctly", () => {
    const root = createRepo("inv-06", {});
    const store = makeStore(root);
    store.addImportEdge("top.ts", "left.ts", "IMPORTS");
    store.addImportEdge("top.ts", "right.ts", "IMPORTS");
    store.addImportEdge("left.ts", "bottom.ts", "IMPORTS");
    store.addImportEdge("right.ts", "bottom.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const deps = inv.getTransitiveDependents("bottom.ts");
    expect(deps).toContain("top.ts");
    expect(deps).toContain("left.ts");
    expect(deps).toContain("right.ts");
    expect(deps).toHaveLength(3);
    store.close();
  });

  it("propagateDirty finds all affected in chain", () => {
    const root = createRepo("inv-07", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "b.ts", "IMPORTS");
    store.addImportEdge("b.ts", "c.ts", "IMPORTS");
    store.addImportEdge("c.ts", "d.ts", "IMPORTS");
    const inv = new Invalidator(store);
    inv.onFileChanged("d.ts");
    const propagated = inv.propagateDirty();
    expect(propagated).toContain("a.ts");
    expect(propagated).toContain("b.ts");
    expect(propagated).toContain("c.ts");
    store.close();
  });

  it("clearing dirty files removes them", () => {
    const root = createRepo("inv-08", {});
    const store = makeStore(root);
    store.markDirty("x.ts", "test");
    expect(store.getDirtyFiles()).toContain("x.ts");
    store.clearDirty("x.ts");
    expect(store.getDirtyFiles()).not.toContain("x.ts");
    store.close();
  });

  it("clearAllDirty removes all dirty files", () => {
    const root = createRepo("inv-09", {});
    const store = makeStore(root);
    store.markDirty("a.ts", "test");
    store.markDirty("b.ts", "test");
    store.clearAllDirty();
    expect(store.getDirtyFiles()).toHaveLength(0);
    store.close();
  });

  it("renaming triggers invalidation for old and new importers", () => {
    const root = createRepo("inv-10", {});
    const store = makeStore(root);
    store.addImportEdge("a.ts", "old.ts", "IMPORTS");
    store.addImportEdge("b.ts", "new.ts", "IMPORTS");
    const inv = new Invalidator(store);
    const affected = inv.onFileRenamed("old.ts", "new.ts");
    expect(affected).toContain("a.ts");
    expect(affected).toContain("b.ts");
    store.close();
  });
});

// ─── Traversal ──────────────────────────────────────────────

describe("Traversal", () => {
  it("function_edit policy returns entry and related nodes", async () => {
    const root = createRepo("tr-01", {
      "src/main.ts":
        "export function helper() { return 1; }\nexport function run() { return helper(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const run = store.findNodes("run", 5)[0];
    const slice = compileSlice(store, [run.identity.stableId], POLICIES.function_edit);
    expect(slice.nodes.length).toBeGreaterThanOrEqual(2);
    expect(slice.nodes.some((n) => n.name === "helper")).toBe(true);
    store.close();
  });

  it("endpoint_edit policy includes contract edges", async () => {
    const root = createRepo("tr-02", {
      "src/routes.ts":
        "const app = { get: () => {} };\napp.get('/health', () => 'ok');",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const fileNode = store.findNodes("src/routes.ts", 5)[0];
    const slice = compileSlice(store, [fileNode.identity.stableId], POLICIES.endpoint_edit);
    const routeEdges = slice.edges.filter(
      (e) => e.kind === "EXPOSES_ROUTE" || e.kind === "CONSUMES_ROUTE",
    );
    expect(routeEdges.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("registers schema_edit with table-focused traversal steps", () => {
    expect(POLICIES.schema_edit.maxTokens).toBe(8000);
    expect(POLICIES.schema_edit.steps).toHaveLength(4);
    expect(POLICIES.schema_edit.steps[1].edgeKinds).toEqual([
      "READS_TABLE",
      "WRITES_TABLE",
    ]);
    expect(POLICIES.schema_edit.steps[2].edgeKinds).toEqual([
      "CALLS",
      "REFERENCES",
    ]);
  });

  it("multiple policies produce different slice sizes", async () => {
    const root = createRepo("tr-03", {
      "src/a.ts":
        "export function x() { return 1; }\nexport function y() { return x(); }\nexport function z() { return y(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const a = store.findNodes("src/a.ts", 5)[0];
    const minimal = compileSlice(store, [a.identity.stableId], POLICIES.minimal);
    const impact = compileSlice(store, [a.identity.stableId], POLICIES.impact);
    expect(impact.nodes.length).toBeGreaterThanOrEqual(minimal.nodes.length);
    store.close();
  });

  it("estimateTokenCount returns reasonable estimate", async () => {
    const root = createRepo("tr-04", {
      "src/main.ts":
        "export function a() {}\nexport function b() {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const main = store.findNodes("src/main.ts", 5)[0];
    const slice = compileSlice(store, [main.identity.stableId], POLICIES.minimal);
    const tokens = estimateTokenCount(slice);
    expect(tokens).toBeGreaterThan(0);
    store.close();
  });
});

// ─── Integration ────────────────────────────────────────────

describe("Integration", () => {
  it("full index + slice workflow on fixture repo", async () => {
    // Create a clean copy of the fixture to avoid cross-test contamination
    const root = createRepo("int-01", {
      "src/auth.ts":
        fs.readFileSync(path.join(FIXTURE_ROOT, "src", "auth.ts"), "utf8"),
      "src/routes.ts":
        fs.readFileSync(path.join(FIXTURE_ROOT, "src", "routes.ts"), "utf8"),
      "src/client.ts":
        fs.readFileSync(path.join(FIXTURE_ROOT, "src", "client.ts"), "utf8"),
      "src/billing.ts":
        fs.readFileSync(path.join(FIXTURE_ROOT, "src", "billing.ts"), "utf8"),
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const login = store.findNodes("login", 5)[0];
    expect(login).toBeDefined();
    const slice = compileSlice(store, [login.identity.stableId], POLICIES.impact);
    expect(slice.nodes.length).toBeGreaterThanOrEqual(3);
    const chargeCard = slice.nodes.find((n) => n.name === "chargeCard");
    expect(chargeCard).toBeUndefined();
    store.close();
  });

  it("module resolution handles nested directories", async () => {
    const root = createRepo("int-02", {
      "src/lib/util/helper.ts":
        "export function help() { return 1; }",
      "src/app/index.ts":
        "import { help } from '../lib/util/helper';\nexport function run() { return help(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const run = store.findNodes("run", 5)[0];
    const calls = store.outgoing(run.identity.stableId, ["CALLS"]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const target = store.getNode(calls[0].targetId);
    expect(target?.name).toBe("help");
    store.close();
  });

  it("removes edges to deleted files after reindex", async () => {
    const root = createRepo("int-03", {
      "src/a.ts": "export function a() {}",
      "src/b.ts":
        "import { a } from './a';\nexport function b() { return a(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const bFunc = store.findNodes("b", 5).find(n => n.kind === "function")!;
    expect(
      store.outgoing(bFunc.identity.stableId, ["CALLS"]).length,
    ).toBeGreaterThanOrEqual(1);
    fs.unlinkSync(path.join(root, "src/a.ts"));
    const absA = path.join(root, "src/a.ts");
    indexer.invalidateAll();
    indexer.indexFile(absA);
    const bFile = store.findNodes("src/b.ts", 5)[0];
    const slice = compileSlice(store, [bFile.identity.stableId], POLICIES.minimal);
    const aInSlice = slice.nodes.some((n) => n.name === "a");
    expect(aInSlice).toBe(false);
    store.close();
  });

  it("getStats returns correct counts after indexing", async () => {
    const root = createRepo("int-04", {
      "src/a.ts": "export function foo() { return 1; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const stats = store.getStats();
    expect(stats.files).toBe(1);
    expect(stats.nodes).toBeGreaterThanOrEqual(2);
    expect(stats.edges).toBeGreaterThanOrEqual(2);
    store.close();
  });
});

// ─── Edge Cases ─────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles empty file", async () => {
    const root = createRepo("edge-01", { "src/empty.ts": "" });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const stats = store.getStats();
    expect(stats.files).toBe(1);
    store.close();
  });

  it("handles file with only comments", async () => {
    const root = createRepo("edge-02", {
      "src/comments.ts":
        "// this is a comment\n/* block comment */\n/// <reference path='x' />",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const stats = store.getStats();
    expect(stats.files).toBe(1);
    store.close();
  });

  it("handles JSX/TSX files", async () => {
    const root = createRepo("edge-03", {
      "src/component.tsx":
        "export function Greet({name}:{name:string}) { return <div>Hello {name}</div>; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const greet = store.findNodes("Greet", 5);
    expect(greet.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("handles deeply nested directory structure", async () => {
    const root = createRepo("edge-04", {
      "a/b/c/d/e/deep.ts": "export const x = 1;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const deep = store.findNodes("deep.ts", 5);
    expect(deep.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("multiple files with no circular dependencies", async () => {
    const root = createRepo("edge-05", {
      "a.ts": "import {b} from './b';\nexport const x = b;",
      "b.ts": "import {c} from './c';\nexport const b = c + 1;",
      "c.ts": "export const c = 1;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const stats = store.getStats();
    expect(stats.files).toBe(3);
    expect(stats.nodes).toBeGreaterThanOrEqual(6);
    store.close();
  });

  it("exports default function", async () => {
    const root = createRepo("edge-06", {
      "src/main.ts":
        "export default function greet() { return 42; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const stats = store.getStats();
    expect(stats.nodes).toBeGreaterThanOrEqual(2);
    const fileNode = store.findNodes("src/main.ts", 5)[0];
    const fileOut = store.outgoing(fileNode.identity.stableId, ["EXPORTS"]);
    expect(fileOut.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("versionHash changes when body changes", () => {
    const h1 = versionHash("function foo() { return 1; }");
    const h2 = versionHash("function foo() { return 2; }");
    expect(h1).not.toBe(h2);
  });

  it("different symbols get different stableIds", () => {
    const id1 = stableId("/repo", "ts", "function:main.ts:foo");
    const id2 = stableId("/repo", "ts", "function:main.ts:bar");
    expect(id1).not.toBe(id2);
  });
});
