import fs from "node:fs";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import { VERIFICATION } from "../types.js";

export interface LcovRecord {
  file: string;
  lines: Array<{ number: number; hits: number }>;
  functions: Array<{ name: string; line: number; hits: number }>;
}

export class CoverageImporter {
  private store: GraphStore;
  private root: string;

  constructor(store: GraphStore, root: string) {
    this.store = store;
    this.root = root;
  }

  importLcovFile(lcovPath: string): void {
    const text = fs.readFileSync(lcovPath, "utf8");
    const records = this.parseLcov(text);
    this.import(records);
  }

  private parseLcov(text: string): LcovRecord[] {
    const records: LcovRecord[] = [];
    let current: LcovRecord | null = null;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("SF:")) {
        current = { file: trimmed.slice(3), lines: [], functions: [] };
      } else if (trimmed.startsWith("end_of_record")) {
        if (current) records.push(current);
        current = null;
      } else if (current) {
        const daMatch = trimmed.match(/^DA:(\d+),(\d+)/);
        if (daMatch) {
          current.lines.push({ number: parseInt(daMatch[1]), hits: parseInt(daMatch[2]) });
        }
        const fnMatch = trimmed.match(/^FN:(\d+),(\w+)/);
        if (fnMatch) {
          current.functions.push({ name: fnMatch[2], line: parseInt(fnMatch[1]), hits: 0 });
        }
        const fndaMatch = trimmed.match(/^FNDA:(\d+),(\w+)/);
        if (fndaMatch) {
          const fn = current.functions.find((f) => f.name === fndaMatch[2]);
          if (fn) fn.hits = parseInt(fndaMatch[1]);
        }
      }
    }

    return records;
  }

  import(records: LcovRecord[]): void {
    for (const record of records) {
      const fileQName = `file:${record.file}`;
      const fileNodeId = stableId(this.root, "ts", fileQName);

      for (const line of record.lines) {
        if (line.hits === 0) continue;

        const lineQName = `line:${record.file}:${line.number}`;
        const lineId = stableId(this.root, "ts", lineQName);

        this.store.upsertNode({
          identity: { stableId: lineId, versionHash: versionHash(String(line.number)) },
          kind: "property",
          name: `L${line.number}`,
          qualifiedName: lineQName,
          filePath: record.file,
          startLine: line.number,
          endLine: line.number,
          language: "ts",
        });

        this.store.upsertEdge({
          sourceId: fileNodeId,
          targetId: lineId,
          kind: "COVERS_LINE",
          verification: VERIFICATION.VERIFIED_RUNTIME,
          sourceMethod: "coverage-trace",
          metadata: { line: line.number, hits: line.hits },
        });
      }
    }
  }

  findFromDirectory(pattern = "**/coverage/lcov.info"): void {
    const files = fg.sync([pattern], {
      cwd: this.root,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    for (const file of files) {
      this.importLcovFile(file);
    }
  }
}
