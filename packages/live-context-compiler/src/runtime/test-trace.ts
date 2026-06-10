import fs from "node:fs";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import { VERIFICATION } from "../types.js";

export interface TestTraceEntry {
  testFile: string;
  testName: string;
  calls: Array<{ functionName: string; file: string; line: number }>;
}

export class TestTraceImporter {
  private store: GraphStore;
  private root: string;

  constructor(store: GraphStore, root: string) {
    this.store = store;
    this.root = root;
  }

  importFromFile(tracePath: string): void {
    const text = fs.readFileSync(tracePath, "utf8");
    const traces: TestTraceEntry[] = JSON.parse(text);
    this.import(traces);
  }

  import(traces: TestTraceEntry[]): void {
    for (const trace of traces) {
      const testFileNodeId = stableId(this.root, "ts", `file:${trace.testFile}`);
      const testNodeId = stableId(this.root, "ts", `test:${trace.testFile}:${trace.testName}`);

      this.store.upsertNode({
        identity: { stableId: testNodeId, versionHash: versionHash(trace.testName) },
        kind: "function",
        name: trace.testName,
        qualifiedName: `test:${trace.testFile}:${trace.testName}`,
        filePath: trace.testFile,
        startLine: 0,
        endLine: 0,
        language: "ts",
      });

      for (const call of trace.calls) {
        const targetQName = `function:${call.file}:${call.functionName}`;
        const targetId = stableId(this.root, "ts", targetQName);

        this.store.upsertNode({
          identity: { stableId: targetId, versionHash: versionHash(call.functionName) },
          kind: "function",
          name: call.functionName,
          qualifiedName: targetQName,
          filePath: call.file,
          startLine: call.line,
          endLine: call.line,
          language: "ts",
        });

        this.store.upsertEdge({
          sourceId: testNodeId,
          targetId,
          kind: "OBSERVED_CALL",
          verification: VERIFICATION.VERIFIED_RUNTIME,
          sourceMethod: "test-trace",
          metadata: {
            testFile: trace.testFile,
            testName: trace.testName,
            line: call.line,
          },
        });
      }
    }
  }

  findFromDirectory(pattern = "**/.test-traces/*.json"): void {
    const files = fg.sync([pattern], {
      cwd: this.root,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    for (const file of files) {
      this.importFromFile(file);
    }
  }
}
