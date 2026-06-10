import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fg from "fast-glob";
import { GraphStore } from "./src/db.js";
import { TsRepositoryIndexer } from "./src/indexer.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-debug-"));
const dbPath = path.join(tmpDir, "test.db");
const store = new GraphStore(dbPath);

fs.writeFileSync(path.join(tmpDir, "normal.ts"), "export const x = 1;\n");

const files = await fg(["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"], {
  cwd: tmpDir,
  ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**"],
  absolute: true,
});
console.log("fg files:", files);

const indexer = new TsRepositoryIndexer(store, tmpDir);
await indexer.indexAll();

const db = (store as any).db;
const all = db.prepare("SELECT name, kind FROM nodes").all() as any[];
console.log("Nodes:", JSON.stringify(all, null, 2));

store.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
