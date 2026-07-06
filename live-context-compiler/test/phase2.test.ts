import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";
import { ContainerBuilder } from "../src/container-builder.js";
import { SliceCache } from "../src/slice-cache.js";
import { compileSlice, POLICIES } from "../src/traversal.js";
import { stableId } from "../src/hash.js";
import type { CodeNode, RelationContainer } from "../src/types.js";

const TEST_ROOT = path.resolve("test/tmp-phase2");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function createRepo(
  name: string,
  files: Record<string, string>,
): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function makeStore(root: string): GraphStore {
  const dbPath = path.join(root, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

beforeEach(() => clean());
afterEach(() => clean());

// ─── Container DB Operations ─────────────────────────────────

describe("Container DB operations", () => {
  it("upserts and retrieves a container", () => {
    const root = createRepo("db-c-01", {});
    const store = makeStore(root);
    const c: RelationContainer = {
      id: "c1",
      name: "test-container",
      kind: "physical",
      entryNodeIds: [],
      memberIds: ["n1", "n2"],
      version: 1,
      dirty: false,
    };
    store.upsertContainer(c);
    const retrieved = store.getContainer("c1")!;
    expect(retrieved.name).toBe("test-container");
    expect(retrieved.memberIds).toEqual(["n1", "n2"]);
    expect(retrieved.dirty).toBe(false);
    store.close();
  });

  it("lists all containers", () => {
    const root = createRepo("db-c-02", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "a", name: "A", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "b", name: "B", kind: "feature", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    const list = store.listContainers();
    expect(list.length).toBe(2);
    store.close();
  });

  it("adds and retrieves container members", () => {
    const root = createRepo("db-c-03", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "c1", name: "T", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerMember("c1", "node-1", "primary");
    store.addContainerMember("c1", "node-2", "related");
    store.addContainerMember("c1", "node-3", "utility");
    const members = store.getContainerMembers("c1");
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.nodeId === "node-1")?.role).toBe("primary");
    store.close();
  });

  it("removes container members", () => {
    const root = createRepo("db-c-04", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "c1", name: "T", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerMember("c1", "n1", "related");
    store.removeContainerMember("c1", "n1");
    expect(store.getContainerMembers("c1")).toHaveLength(0);
    store.close();
  });

  it("finds containers for a node", () => {
    const root = createRepo("db-c-05", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "node-x", versionHash: "v1" },
      kind: "function", name: "x", qualifiedName: "f:x",
      filePath: "x.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.upsertContainer({ id: "c1", name: "C", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerMember("c1", "node-x", "primary");
    const containers = store.getMemberContainers("node-x");
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe("c1");
    store.close();
  });
});

// ─── Container Dependency Tracking ───────────────────────────

describe("Container dependency tracking", () => {
  it("tracks dependencies between containers", () => {
    const root = createRepo("dep-01", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "web", name: "Web", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "api", name: "Api", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "db", name: "Db", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerDep("web", "api");
    store.addContainerDep("web", "db");
    const deps = store.getContainerDeps("web");
    expect(deps).toContain("api");
    expect(deps).toContain("db");
    store.close();
  });

  it("finds dependents of a container", () => {
    const root = createRepo("dep-02", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "shared", name: "Shared", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "web", name: "Web", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "admin", name: "Admin", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerDep("web", "shared");
    store.addContainerDep("admin", "shared");
    const dependents = store.getContainerDependents("shared");
    expect(dependents).toContain("web");
    expect(dependents).toContain("admin");
    store.close();
  });

  it("cascades dirty flag to dependents", () => {
    const root = createRepo("dep-03", {});
    const store = makeStore(root);
    store.upsertContainer({ id: "shared", name: "Shared", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.upsertContainer({ id: "web", name: "Web", kind: "physical", entryNodeIds: [], memberIds: [], version: 1, dirty: false });
    store.addContainerDep("web", "shared");
    store.markContainerDirty("shared", "test");
    const webContainer = store.getContainer("web")!;
    expect(webContainer.dirty).toBe(true);
    const sharedContainer = store.getContainer("shared")!;
    expect(sharedContainer.dirty).toBe(true);
    store.close();
  });

  it("propagateContainerDirty marks containers for a file", () => {
    const root = createRepo("dep-04", {});
    const store = makeStore(root);
    store.upsertNode({
      identity: { stableId: "file-src-main", versionHash: "v1" },
      kind: "file", name: "src/main.ts", qualifiedName: "file:src/main.ts",
      filePath: "src/main.ts", startLine: 1, endLine: 1, language: "ts",
    });
    store.upsertContainer({ id: "main-pkg", name: "Main", kind: "physical", entryNodeIds: [], memberIds: ["file-src-main"], version: 1, dirty: false });
    store.addContainerMember("main-pkg", "file-src-main", "primary");
    const affected = store.propagateContainerDirty("src/main.ts");
    expect(affected).toContain("main-pkg");
    const c = store.getContainer("main-pkg")!;
    expect(c.dirty).toBe(true);
    expect(c.version).toBeGreaterThanOrEqual(2);
    store.close();
  });
});

// ─── Container Builder ───────────────────────────────────────

describe("ContainerBuilder", () => {
  it("discovers service directory containers", async () => {
    const root = createRepo("cb-01", {
      "src/auth/login.ts": "export function login() {}",
      "src/auth/register.ts": "export function register() {}",
      "src/billing/charge.ts": "export function charge() {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    expect(containers.length).toBeGreaterThanOrEqual(2);
    const names = containers.map((c) => c.name);
    expect(names).toContain("auth");
    expect(names).toContain("billing");
    store.close();
  });

  it("assigns members and roles to containers", async () => {
    const root = createRepo("cb-02", {
      "src/api/routes.ts":
        "import { login } from '../auth/handler';\nexport function setup() { login(); }",
      "src/auth/handler.ts":
        "export function login() {}",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    builder.assignMembersAndRoles(containers);
    for (const c of containers) {
      const members = store.getContainerMembers(c.id);
      expect(members.length).toBeGreaterThanOrEqual(1);
    }
    store.close();
  });

  it("discovers tsconfig.json roots", async () => {
    const root = createRepo("cb-03", {
      "packages/core/tsconfig.json": "{}",
      "packages/core/index.ts": "export const x = 1;",
      "packages/web/tsconfig.json": "{}",
      "packages/web/app.ts": "export const y = 2;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    const paths = containers.map((c) => c.name);
    expect(paths).toContain("packages-core");
    expect(paths).toContain("packages-web");
    store.close();
  });

  it("discovers npm workspace packages", async () => {
    const root = createRepo("cb-04", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@my/core", main: "index.ts" }),
      "packages/core/index.ts": "export const x = 1;",
      "packages/web/package.json": JSON.stringify({ name: "@my/web", main: "app.ts" }),
      "packages/web/app.ts": "export const y = 2;",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    const names = containers.map((c) => c.name);
    expect(names).toContain("@my/core");
    expect(names).toContain("@my/web");
    store.close();
  });
});

// ─── Slice Cache ─────────────────────────────────────────────

describe("SliceCache", () => {
  it("computes deterministic cache keys", () => {
    const root = createRepo("sc-01", {});
    const store = makeStore(root);
    const cache = new SliceCache(store);
    const key1 = cache.cacheKey("c1", "impact", ["a", "b"]);
    const key2 = cache.cacheKey("c1", "impact", ["a", "b"]);
    const key3 = cache.cacheKey("c1", "impact", ["b", "a"]);
    const key4 = cache.cacheKey("c2", "impact", ["a", "b"]);
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
    expect(key1).not.toBe(key4);
    store.close();
  });

  it("stores and retrieves cached slices", async () => {
    const root = createRepo("sc-02", {
      "src/main.ts": "export function foo() { return 1; }",
    });
    const store = makeStore(root);
    const cache = new SliceCache(store);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    store.upsertContainer({
      id: "main-pkg",
      name: "Main",
      kind: "physical",
      entryNodeIds: [],
      memberIds: [],
      version: 1,
      dirty: false,
    });

    const entry = store.findNodes("foo", 5)[0];
    const slice = compileSlice(store, [entry.identity.stableId], POLICIES.minimal);
    cache.setCachedSlice("main-pkg", POLICIES.minimal, [entry.identity.stableId], slice);

    const cached = cache.getCachedSlice("main-pkg", POLICIES.minimal.name, [entry.identity.stableId]);
    expect(cached).toBeDefined();
    expect(cached!.nodes.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("invalidates cache when container is dirty", async () => {
    const root = createRepo("sc-03", {
      "src/main.ts": "export function foo() { return 1; }",
    });
    const store = makeStore(root);
    const cache = new SliceCache(store);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    store.upsertContainer({
      id: "main-pkg",
      name: "Main",
      kind: "physical",
      entryNodeIds: [],
      memberIds: [],
      version: 1,
      dirty: false,
    });

    const entry = store.findNodes("foo", 5)[0];
    const slice = compileSlice(store, [entry.identity.stableId], POLICIES.minimal);
    cache.setCachedSlice("main-pkg", POLICIES.minimal, [entry.identity.stableId], slice);

    store.markContainerDirty("main-pkg", "test");

    const cached = cache.getCachedSlice("main-pkg", POLICIES.minimal.name, [entry.identity.stableId]);
    expect(cached).toBeUndefined();
    store.close();
  });

  it("invalidates all cache entries", async () => {
    const root = createRepo("sc-04", {});
    const store = makeStore(root);
    const cache = new SliceCache(store);

    store.setCachedSlice("test-key", "c1", "minimal", ["a"], ["b"], ["e"], 1, 10);
    cache.invalidateAll();
    expect(store.getCachedSlice("test-key")).toBeUndefined();
    store.close();
  });

  it("rejects stale cache when version mismatch", async () => {
    const root = createRepo("sc-05", {
      "src/main.ts": "export function foo() { return 1; }",
    });
    const store = makeStore(root);
    const cache = new SliceCache(store);

    store.upsertContainer({
      id: "main-pkg", name: "Main", kind: "physical",
      entryNodeIds: [], memberIds: [], version: 1, dirty: false,
    });

    store.setCachedSlice("k", "main-pkg", "minimal", [], [], [], 1, 5);

    store.upsertContainer({
      id: "main-pkg", name: "Main", kind: "physical",
      entryNodeIds: [], memberIds: [], version: 2, dirty: false,
    });

    const cached = cache.getCachedSlice("main-pkg", "minimal", []);
    expect(cached).toBeUndefined();
    store.close();
  });
});

// ─── Phase 2 Integration ─────────────────────────────────────

describe("Phase 2 integration", () => {
  it("index → container build → slice → cache workflow", async () => {
    const root = createRepo("int-p2-01", {
      "src/auth/login.ts":
        "export function login(email: string) { return true; }",
      "src/billing/charge.ts":
        "export function chargeCard() { return true; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    builder.assignMembersAndRoles(containers);

    const authContainer = containers.find((c) => c.name === "auth")!;
    expect(authContainer).toBeDefined();
    expect(authContainer.kind).toBe("physical");

    const fileNodes = store.getFileNodesByPrefix("src/auth");
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);

    store.close();
  });

  it("dirty propagation from file through containers", async () => {
    const root = createRepo("int-p2-02", {
      "src/shared/util.ts": "export function util() { return 1; }",
      "src/app/handler.ts":
        "import { util } from '../shared/util';\nexport function handle() { return util(); }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    builder.assignMembersAndRoles(containers);

    expect(store.getStats().containers).toBeGreaterThanOrEqual(2);

    const affected = store.propagateContainerDirty("src/shared/util.ts");
    expect(affected.length).toBeGreaterThanOrEqual(1);

    store.close();
  });

  it("cache hit after first compilation", async () => {
    const root = createRepo("int-p2-03", {
      "src/main.ts": "export function run() { return 42; }",
    });
    const store = makeStore(root);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();

    const builder = new ContainerBuilder({ root, store });
    const containers = builder.buildAll();
    builder.assignMembersAndRoles(containers);

    const mainContainer = containers.find((c) => c.name === "src")!;

    const entry = store.findNodes("run", 5)[0];
    const slice = compileSlice(store, [entry.identity.stableId], POLICIES.minimal);

    const cache = new SliceCache(store);
    cache.setCachedSlice(mainContainer.id, POLICIES.minimal, [entry.identity.stableId], slice);

    const cached = cache.getCachedSlice(mainContainer.id, POLICIES.minimal.name, [entry.identity.stableId]);
    expect(cached).toBeDefined();
    expect(cached!.nodes.length).toBeGreaterThanOrEqual(1);

    store.close();
  });
});
