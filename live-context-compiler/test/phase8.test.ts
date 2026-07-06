import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";
import { PythonIndexer } from "../src/languages/python.js";
import { parseDocFile } from "../src/languages/doc.js";
import { renderSlice } from "../src/render.js";
import { compileSlice, POLICIES } from "../src/traversal.js";

const TEST_ROOT = path.resolve("test/tmp-phase8");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
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

function makeStore(root: string): GraphStore {
  const dbPath = path.join(root, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

beforeEach(() => clean());
afterEach(() => clean());

// ─── #6 Docstrings ────────────────────────────────────────────

describe("docstring capture", () => {
  it("captures a TS JSDoc summary onto the symbol node", async () => {
    const root = createRepo("doc-ts", {
      "src/auth.ts": `/** Authenticates a user against the credential store. */
export function login(email: string) { return email; }
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();

    const login = store.findNodes("login").find((n) => n.name === "login");
    expect(login).toBeDefined();
    expect(login!.doc).toContain("Authenticates a user");
    store.close();
  });

  it("drops license/tooling boilerplate instead of storing it as doc", async () => {
    const root = createRepo("doc-noise", {
      "src/x.ts": `// eslint-disable-next-line
export function noop() {}
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    const noop = store.findNodes("noop").find((n) => n.name === "noop");
    expect(noop!.doc).toBeUndefined();
    store.close();
  });

  it("captures a Python docstring and module docstring", () => {
    const indexer = new PythonIndexer();
    const fn = indexer.extract(
      `def login(email):\n    """Log a user in and return a session."""\n    pass\n`,
      "src/a.py",
      "/repo",
    );
    expect(fn.nodes.find((n) => n.name === "login")!.doc).toContain("Log a user in");

    const mod = indexer.extract(
      `"""Auth module: login, logout, validation."""\n\ndef login():\n    pass\n`,
      "src/b.py",
      "/repo",
    );
    expect(mod.nodes.find((n) => n.kind === "file")!.doc).toContain("Auth module");
  });

  it("makes docstring prose searchable via FTS", async () => {
    const root = createRepo("doc-fts", {
      "src/pay.ts": `/** Reconciles pending settlements with the ledger. */
export function sweep() {}
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    // "Reconciles" appears only in the docstring, never in a symbol name.
    const hits = store.findNodes("Reconciles");
    expect(hits.some((h) => h.name === "sweep")).toBe(true);
    store.close();
  });

  it("renders a doc summary line for the entry node", async () => {
    const root = createRepo("doc-render", {
      "src/pay.ts": `/** Charges the customer and records the transaction. */
export function charge() {}
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    const charge = store.findNodes("charge").find((n) => n.name === "charge")!;
    const slice = compileSlice(store, [charge.identity.stableId], POLICIES.minimal);
    const out = renderSlice(root, slice, { maxTokens: 6000 });
    expect(out).toContain("Charges the customer");
    store.close();
  });
});

// ─── #1 Doc files ─────────────────────────────────────────────

describe("doc-file indexing", () => {
  it("parses a markdown title, intro, and headings", () => {
    const { summary, headings } = parseDocFile(
      `# System Architecture\n\nThe scheduler dispatches jobs to workers.\n\n## Components\n\n## Data Flow\n`,
    );
    expect(summary).toContain("System Architecture");
    expect(summary).toContain("scheduler dispatches jobs");
    expect(headings).toContain("Components");
    expect(headings).toContain("Data Flow");
  });

  it("indexes a doc file as a searchable node without emitting reference edges", async () => {
    const root = createRepo("docfile", {
      "docs/guide.md": `# Billing Guide\n\nThe invoicer charges customers monthly.\n`,
      "src/index.ts": `export function invoicer() {}`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();

    const doc = store.getFileNodesByPrefix("docs/guide.md")[0];
    expect(doc).toBeDefined();
    expect(doc.doc).toContain("Billing Guide");

    // A distinctive prose word finds the doc.
    expect(store.findNodes("invoicer").some((n) => n.filePath === "docs/guide.md")).toBe(true);

    // Prose is a mention, not a reference: the doc file emits no outgoing edges.
    expect(store.outgoing(doc.identity.stableId, ["REFERENCES"]).length).toBe(0);
    store.close();
  });

  it("attaches the nearest project doc to a rendered slice", async () => {
    const root = createRepo("nearest-doc", {
      "README.md": `# Payments Service\n\nHandles charging customers and issuing refunds.\n`,
      "src/charge.ts": `export function charge(amount: number) { return amount; }`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    const charge = store.findNodes("charge").find((n) => n.name === "charge")!;
    const slice = compileSlice(store, [charge.identity.stableId], POLICIES.impact);
    const out = renderSlice(root, slice, { maxTokens: 8000 });
    expect(out).toContain("Nearest doc: README.md");
    expect(out).toContain("Payments Service");
    store.close();
  });
});

// ─── #3 Dynamic imports ───────────────────────────────────────

describe("dynamic import edges", () => {
  it("records import() and require() as IMPORTS edges", async () => {
    const root = createRepo("dyn-import", {
      "src/loader.ts": `export async function load() { return import("./plugin"); }`,
      "src/req.ts": `export function need() { return require("./plugin"); }`,
      "src/plugin.ts": `export const plugin = 42;`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();

    const pluginFile = store.getFileNodesByPrefix("src/plugin.ts")[0];
    const loaderFile = store.getFileNodesByPrefix("src/loader.ts")[0];
    const reqFile = store.getFileNodesByPrefix("src/req.ts")[0];

    const loaderImports = store.outgoing(loaderFile.identity.stableId, ["IMPORTS"]);
    expect(loaderImports.some((e) => e.targetId === pluginFile.identity.stableId)).toBe(true);

    const reqImports = store.outgoing(reqFile.identity.stableId, ["IMPORTS"]);
    expect(reqImports.some((e) => e.targetId === pluginFile.identity.stableId)).toBe(true);
    store.close();
  });
});

// ─── #4 Entry points ──────────────────────────────────────────

describe("entry-point detection", () => {
  it("marks package.json targets, __main__, and conventional names", async () => {
    const root = createRepo("entry", {
      "package.json": JSON.stringify({ name: "app", bin: { app: "dist/cli.js" }, main: "dist/index.js" }),
      "src/cli.ts": `export function run() {}`,
      "app.py": `if __name__ == "__main__":\n    print("go")\n`,
      "src/util.ts": `export function helper() {}`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();

    const entries = store.entryPointFiles();
    expect(entries.has("src/cli.ts")).toBe(true); // bin dist/cli.js → src/cli.ts, and convention
    expect(entries.has("app.py")).toBe(true); // __main__ guard + convention
    expect(entries.has("src/util.ts")).toBe(false);
    expect(store.getStats().entryPoints).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("breaks a search tie toward the entry-point file", async () => {
    const root = createRepo("entry-rank", {
      "src/cli.ts": `export function handleRequest() {}`,
      "src/service.ts": `export function handleRequest() {}`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    // Both define handleRequest with an identical exact-name match; cli.ts is an entry
    // point (conventional name), so it must come first.
    const top = store.findNodes("handleRequest").filter((n) => n.name === "handleRequest")[0];
    expect(top.filePath).toBe("src/cli.ts");
    store.close();
  });
});

// ─── #7 Registry / decorator detection ────────────────────────

describe("registry decorator detection", () => {
  it("links a decorated handler to its registry", async () => {
    const root = createRepo("registry", {
      "src/registry.ts": `export const ScraperRegistry = { register(x: unknown) { return x; } };`,
      "src/haraj.ts": `import { ScraperRegistry } from "./registry";

@ScraperRegistry.register
export class HarajScraper {}
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();

    const haraj = store.findNodes("HarajScraper").find((n) => n.name === "HarajScraper")!;
    const registry = store.findNodes("ScraperRegistry").find((n) => n.name === "ScraperRegistry")!;

    const edges = store.outgoing(haraj.identity.stableId, ["REFERENCES"]);
    expect(edges.some((e) => e.targetId === registry.identity.stableId)).toBe(true);
    expect(store.hasEvidenceFrom("registry")).toBe(true);
    store.close();
  });

  it("emits nothing for a decorator that does not resolve to a known symbol", async () => {
    const root = createRepo("registry-neg", {
      "src/svc.ts": `@Injectable()
export class UserService {}
`,
    });
    const store = makeStore(root);
    await new TsRepositoryIndexer(store, root).indexAll();
    expect(store.hasEvidenceFrom("registry")).toBe(false);
    store.close();
  });
});
