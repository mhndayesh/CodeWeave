import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/db.js";
import { TestTraceImporter } from "../src/runtime/test-trace.js";
import { OtelImporter } from "../src/runtime/otel.js";
import { CoverageImporter } from "../src/runtime/coverage.js";
import { VERIFICATION } from "../src/types.js";

const TEST_ROOT = path.resolve("test/tmp-phase5");

function clean(): void {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function createRepo(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStore(root: string): GraphStore {
  const dbPath = path.join(root, ".test.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return new GraphStore(dbPath);
}

beforeEach(() => clean());
afterEach(() => clean());

// ─── Test Trace Importer ─────────────────────────────────────

describe("TestTraceImporter", () => {
  it("imports test traces from JSON and creates OBSERVED_CALL edges", () => {
    const root = createRepo("tt-01");
    const store = makeStore(root);
    const importer = new TestTraceImporter(store, root);

    importer.import([
      {
        testFile: "tests/auth.test.ts",
        testName: "should login successfully",
        calls: [
          { functionName: "login", file: "src/auth/login.ts", line: 10 },
          { functionName: "validateToken", file: "src/auth/token.ts", line: 5 },
        ],
      },
      {
        testFile: "tests/orders.test.ts",
        testName: "should create order",
        calls: [
          { functionName: "createOrder", file: "src/orders/service.ts", line: 20 },
        ],
      },
    ]);

    const allEdges = store.getStats().edges;
    expect(allEdges).toBe(3);

    const edgeKinds = new Set<string>();
    for (const row of store["db"].prepare("SELECT DISTINCT kind FROM edges").all() as { kind: string }[]) {
      edgeKinds.add(row.kind);
    }
    expect(edgeKinds.has("OBSERVED_CALL")).toBe(true);

    const loginNode = store.findNodes("login", 5);
    expect(loginNode.length).toBeGreaterThanOrEqual(1);

    store.close();
  });

  it("reads test traces from a JSON file", () => {
    const root = createRepo("tt-02");
    const traceFile = path.join(root, "traces.json");
    fs.writeFileSync(
      traceFile,
      JSON.stringify([
        {
          testFile: "tests/main.test.ts",
          testName: "test main",
          calls: [{ functionName: "main", file: "src/main.ts", line: 1 }],
        },
      ]),
    );
    const store = makeStore(root);
    const importer = new TestTraceImporter(store, root);
    importer.importFromFile(traceFile);
    expect(store.getStats().edges).toBe(1);
    store.close();
  });
});

// ─── OTel Importer ───────────────────────────────────────────

describe("OtelImporter", () => {
  it("imports OTel trace JSON and creates OBSERVED_CALL edges", () => {
    const root = createRepo("otel-01");
    const store = makeStore(root);
    const importer = new OtelImporter(store, root);

    importer.import({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "auth-service" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "express-handler" },
              spans: [
                {
                  traceId: "abc123",
                  spanId: "span1",
                  name: "POST /login",
                  kind: "SERVER",
                  startTime: "2024-01-01T00:00:00Z",
                  endTime: "2024-01-01T00:00:01Z",
                  attributes: {
                    "code.function": "loginHandler",
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(store.getStats().edges).toBeGreaterThanOrEqual(1);
    const edgeKinds = new Set<string>();
    for (const row of store["db"].prepare("SELECT DISTINCT kind FROM edges").all() as { kind: string }[]) {
      edgeKinds.add(row.kind);
    }
    expect(edgeKinds.has("OBSERVED_CALL")).toBe(true);

    store.close();
  });

  it("imports from file", () => {
    const root = createRepo("otel-02");
    const otelFile = path.join(root, "trace.json");
    fs.writeFileSync(
      otelFile,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "t1",
                    spanId: "s1",
                    name: "handler",
                    kind: "SERVER",
                    startTime: "2024-01-01T00:00:00Z",
                    endTime: "2024-01-01T00:00:01Z",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const store = makeStore(root);
    const importer = new OtelImporter(store, root);
    importer.importFromFile(otelFile);
    expect(store.getStats().nodes).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

// ─── Coverage Importer ───────────────────────────────────────

describe("CoverageImporter", () => {
  it("parses lcov format and creates COVERS_LINE edges", () => {
    const root = createRepo("cov-01");
    const store = makeStore(root);
    const importer = new CoverageImporter(store, root);

    const lcov = [
      "SF:src/main.ts",
      "FN:10,main",
      "FNDA:3,main",
      "DA:10,3",
      "DA:11,3",
      "DA:15,0",
      "end_of_record",
      "SF:src/auth.ts",
      "FN:5,login",
      "FNDA:1,login",
      "DA:5,1",
      "end_of_record",
    ].join("\n");

    const lcovFile = path.join(root, "lcov.info");
    fs.writeFileSync(lcovFile, lcov);
    importer.importLcovFile(lcovFile);

    expect(store.getStats().edges).toBeGreaterThanOrEqual(1);

    const edgeKinds = new Set<string>();
    for (const row of store["db"].prepare("SELECT DISTINCT kind FROM edges").all() as { kind: string }[]) {
      edgeKinds.add(row.kind);
    }
    expect(edgeKinds.has("COVERS_LINE")).toBe(true);

    store.close();
  });

  it("skips uncovered lines (0 hits)", () => {
    const root = createRepo("cov-02");
    const store = makeStore(root);
    const importer = new CoverageImporter(store, root);

    importer.import([
      {
        file: "src/main.ts",
        lines: [
          { number: 1, hits: 0 },
          { number: 2, hits: 0 },
        ],
        functions: [],
      },
    ]);

    expect(store.getStats().edges).toBe(0);
    store.close();
  });

  it("handles empty lcov gracefully", () => {
    const root = createRepo("cov-03");
    const store = makeStore(root);
    const importer = new CoverageImporter(store, root);
    importer.importLcovFile(
      (() => {
        const f = path.join(root, "empty.info");
        fs.writeFileSync(f, "");
        return f;
      })(),
    );
    expect(store.getStats().nodes).toBe(0);
    store.close();
  });
});

// ─── VERIFIED_RUNTIME edge verification ──────────────────────

describe("VERIFIED_RUNTIME edges", () => {
  it("test trace edges have VERIFIED_RUNTIME verification", () => {
    const root = createRepo("vr-01");
    const store = makeStore(root);
    const importer = new TestTraceImporter(store, root);

    importer.import([
      {
        testFile: "test.ts",
        testName: "test",
        calls: [{ functionName: "fn", file: "src/fn.ts", line: 1 }],
      },
    ]);

    const rows = store["db"].prepare(
      "SELECT DISTINCT verification FROM edge_evidence",
    ).all() as { verification: number }[];
    expect(rows.some((r) => r.verification === VERIFICATION.VERIFIED_RUNTIME)).toBe(true);

    store.close();
  });

  it("otel trace edges have VERIFIED_RUNTIME verification", () => {
    const root = createRepo("vr-02");
    const store = makeStore(root);
    const importer = new OtelImporter(store, root);

    importer.import({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1", spanId: "s1", name: "handler",
                  kind: "SERVER", startTime: "", endTime: "",
                  attributes: { "code.function": "handler" },
                },
              ],
            },
          ],
        },
      ],
    });

    const rows = store["db"].prepare(
      "SELECT DISTINCT verification FROM edge_evidence",
    ).all() as { verification: number }[];
    expect(rows.some((r) => r.verification === VERIFICATION.VERIFIED_RUNTIME)).toBe(true);

    store.close();
  });

  it("coverage edges have VERIFIED_RUNTIME verification", () => {
    const root = createRepo("vr-03");
    const store = makeStore(root);
    const importer = new CoverageImporter(store, root);

    importer.import([
      {
        file: "src/main.ts",
        lines: [{ number: 1, hits: 5 }],
        functions: [],
      },
    ]);

    const rows = store["db"].prepare(
      "SELECT DISTINCT verification FROM edge_evidence",
    ).all() as { verification: number }[];
    expect(rows.some((r) => r.verification === VERIFICATION.VERIFIED_RUNTIME)).toBe(true);

    store.close();
  });
});
