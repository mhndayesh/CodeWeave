import fs from "node:fs";
import path from "node:path";
import { watch } from "chokidar";
import { TsRepositoryIndexer } from "./indexer.js";
import { Invalidator } from "./invalidator.js";

const DEBOUNCE_MS = 300;

function fileExist(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function startWatcher(
  root: string,
  indexer: TsRepositoryIndexer,
  invalidator: Invalidator,
): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function schedule(file: string, event: "add" | "change" | "unlink"): void {
    const existing = timers.get(file);
    if (existing) clearTimeout(existing);
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        const absPath = path.join(root, file);
        const rel = path.relative(root, absPath).replaceAll("\\", "/");

        if (event === "unlink" || !fileExist(absPath)) {
          const affected = invalidator.onFileDeleted(rel);
          if (affected.length > 0) {
            console.log(`  ${rel} deleted, ${affected.length} dependents marked dirty`);
          }
          return;
        }

        const affected = invalidator.onFileChanged(rel);
        indexer.indexFile(absPath);
        if (affected.length > 0) {
          console.log(`  ${rel} changed, ${affected.length} dependents marked dirty`);
        } else {
          console.log(`  ${rel} indexed`);
        }
      }, DEBOUNCE_MS),
    );
  }

  const watcher = watch(["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"], {
    cwd: root,
    ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**"],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });

  watcher.on("add", (file: string) => schedule(file, "add"));
  watcher.on("change", (file: string) => schedule(file, "change"));
  watcher.on("unlink", (file: string) => schedule(file, "unlink"));

  console.log(`Watching ${root}`);
}
