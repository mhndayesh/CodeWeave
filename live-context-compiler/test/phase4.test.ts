import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TokenBudget } from "../src/budget.js";
import { renderDiffAnnotation, renderSliceWithDiff } from "../src/render-diff.js";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";
import { McpServer } from "../src/mcp/server.js";

const TEST_ROOT = path.resolve("test/tmp-phase4");

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

// ─── TokenBudget ─────────────────────────────────────────────

describe("TokenBudget", () => {
  it("respects max tokens with safety margin", () => {
    const budget = new TokenBudget(10000, 0.25);
    expect(budget["budget"]).toBe(7500);
  });

  it("allocates tokens correctly", () => {
    const budget = new TokenBudget(10000, 0);
    expect(budget.tryAllocate("hello world")).toBe(true);
    expect(budget.remaining()).toBe(9997);
  });

  it("rejects when budget exceeded", () => {
    const budget = new TokenBudget(10, 0);
    expect(budget.tryAllocate("a".repeat(40))).toBe(true);
    expect(budget.tryAllocate("b".repeat(1))).toBe(false);
  });

  it("estimateTokens returns ~chars/4", () => {
    expect(TokenBudget.estimateTokens("a".repeat(40))).toBe(10);
    expect(TokenBudget.estimateTokens("test")).toBe(1);
  });

  it("zero budget rejects all allocations", () => {
    const budget = new TokenBudget(0, 0);
    expect(budget.tryAllocate("a")).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("safety margin defaults to 0.25", () => {
    const budget = new TokenBudget(1000);
    expect(budget["budget"]).toBe(750);
  });
});

// ─── renderDiffAnnotation ────────────────────────────────────

describe("renderDiffAnnotation", () => {
  it("renders empty string for no diffs", () => {
    expect(renderDiffAnnotation([])).toBe("");
  });

  it("renders a single diff hunk", () => {
    const result = renderDiffAnnotation([
      {
        filePath: "src/main.ts",
        oldText: "function foo() { return 1; }",
        newText: "function foo() { return 2; }",
        startLine: 10,
        endLine: 12,
      },
    ]);
    expect(result).toContain("src/main.ts:10-12");
    expect(result).toContain("- function foo() { return 1; }");
    expect(result).toContain("+ function foo() { return 2; }");
  });

  it("renders multiple diffs", () => {
    const result = renderDiffAnnotation([
      {
        filePath: "a.ts", oldText: "a", newText: "b",
        startLine: 1, endLine: 1,
      },
      {
        filePath: "b.ts", oldText: "c", newText: "d",
        startLine: 5, endLine: 5,
      },
    ]);
    expect(result).toContain("a.ts:1-1");
    expect(result).toContain("b.ts:5-5");
  });

  it("respects token budget", () => {
    const budget = new TokenBudget(1, 0);
    const result = renderDiffAnnotation(
      [
        {
          filePath: "a.ts", oldText: "long text here",
          newText: "changed text here", startLine: 1, endLine: 2,
        },
        {
          filePath: "b.ts", oldText: "more", newText: "diff",
          startLine: 3, endLine: 3,
        },
      ],
      budget,
    );
    expect(result).toContain("omitted");
  });
});

// ─── renderSliceWithDiff ─────────────────────────────────────

describe("renderSliceWithDiff", () => {
  it("appends diff annotation to rendered slice", () => {
    const result = renderSliceWithDiff(
      "--- Context ---\nnode body here",
      [
        {
          filePath: "src/file.ts",
          oldText: "old version",
          newText: "new version",
          startLine: 5,
          endLine: 7,
        },
      ],
      50000,
    );
    expect(result).toContain("--- Context ---");
    expect(result).toContain("--- Changes ---");
    expect(result).toContain("src/file.ts:5-7");
    expect(result).toContain("- old version");
    expect(result).toContain("+ new version");
  });
});

// ─── MCP Server ──────────────────────────────────────────────

describe("MCP Server", () => {
  it("responds to initialize with capabilities", () => {
    const root = createRepo("mcp-01", {});
    const dbPath = path.join(root, ".test.sqlite");
    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(resp.id).toBe(1);
    expect(resp.result?.capabilities?.tools).toBeDefined();
    expect(resp.result?.serverInfo?.name).toBe("live-context-compiler");
    server.close();
  });

  it("responds to tools/list", () => {
    const root = createRepo("mcp-02", {});
    const dbPath = path.join(root, ".test.sqlite");
    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(resp.result?.tools?.length).toBeGreaterThanOrEqual(4);
    server.close();
  });

  it("context_compile returns content for a query", async () => {
    const root = createRepo("mcp-03", {
      "src/main.ts": "export function add(a: number, b: number) { return a + b; }",
    });
    const dbPath = path.join(root, ".test.sqlite");
    const store = new GraphStore(dbPath);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    store.close();

    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "context_compile", arguments: { query: "add", policy: "minimal", maxTokens: 5000 } },
    });
    expect(resp.result).toBeDefined();
    expect((resp.result?.nodes as Array<unknown>)?.length).toBeGreaterThanOrEqual(1);
    server.close();
  });

  it("context_search returns matching nodes", async () => {
    const root = createRepo("mcp-04", {
      "src/main.ts": "export function searchMe() { return 42; }",
    });
    const dbPath = path.join(root, ".test.sqlite");
    const store = new GraphStore(dbPath);
    const indexer = new TsRepositoryIndexer(store, root);
    await indexer.indexAll();
    store.close();

    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "context_search", arguments: { query: "searchMe" } },
    });
    expect((resp.result?.nodes as Array<unknown>)?.length).toBeGreaterThanOrEqual(1);
    server.close();
  });

  it("context_status returns graph statistics", () => {
    const root = createRepo("mcp-05", {});
    const dbPath = path.join(root, ".test.sqlite");
    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "context_status", arguments: {} },
    });
    expect(resp.result?.files).toBeDefined();
    expect(resp.result?.nodes).toBeDefined();
    expect(resp.result?.edges).toBeDefined();
    server.close();
  });

  it("returns error for unknown tool", () => {
    const root = createRepo("mcp-06", {});
    const dbPath = path.join(root, ".test.sqlite");
    const server = new McpServer(dbPath, root);
    const resp = server.handleRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32601);
    server.close();
  });
});
