#!/usr/bin/env node
import path from "node:path";
import minimist from "minimist";
import { GraphStore } from "./db.js";
import { TsRepositoryIndexer } from "./indexer.js";
import { initTreeSitter } from "./languages/treesitter.js";
import { Invalidator } from "./invalidator.js";
import { ContainerBuilder } from "./container-builder.js";
import { SliceCache } from "./slice-cache.js";
import { compileSlice, POLICIES } from "./traversal.js";
import { renderSlice, type RenderMode } from "./render.js";
import { startWatcher } from "./watcher.js";
import { McpServer } from "./mcp/server.js";
import { TestTraceImporter } from "./runtime/test-trace.js";
import { OtelImporter } from "./runtime/otel.js";
import { CoverageImporter } from "./runtime/coverage.js";
import {
  SECURITY_EXCLUSIONS,
  SECRET_PATTERNS,
  getExclusion,
  guardPath,
  redactSecrets,
} from "./security.js";

const args = minimist(process.argv.slice(2));
const command = args._[0] ?? "help";
const root = path.resolve(args.root ?? process.cwd());
const dbPath = path.resolve(
  args.db ?? path.join(root, ".context-graph.sqlite"),
);

function ignorePatternsArg(): string[] {
  const raw = args["ignore-patterns"];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

if (command === "init") {
  const store = new GraphStore(dbPath);
  store.close();
  console.log(`Initialized graph store at ${dbPath}`);
  console.log(`Security: ${SECURITY_EXCLUSIONS.length} exclusions loaded`);
  console.log(`Security: ${SECRET_PATTERNS.length} secret patterns loaded`);
  console.log(`Path traversal guard: enabled`);
} else if (command === "index") {
  const store = new GraphStore(dbPath);
  const indexer = new TsRepositoryIndexer(store, root, ignorePatternsArg());
  await indexer.indexAll();
  console.log(`Indexed ${root}`);
  store.close();
} else if (command === "watch") {
  const store = new GraphStore(dbPath);
  const indexer = new TsRepositoryIndexer(store, root, ignorePatternsArg());
  const invalidator = new Invalidator(store);
  await indexer.indexAll();
  startWatcher(root, indexer, invalidator);
} else if (command === "query") {
  const store = new GraphStore(dbPath);
  const query = String(args.query ?? "");
  if (!query) {
    console.error("Use --query <symbol or path>");
    process.exit(1);
  }
  const matches = store.findNodes(query, Number(args.limit ?? 10));
  if (matches.length === 0) {
    console.log("No matching nodes found.");
    store.close();
    process.exit(0);
  }
  for (const node of matches) {
    console.log(
      `  ${node.identity.stableId.slice(0, 12)}  ${node.kind.padEnd(10)} ${node.qualifiedName}  (${node.filePath}:${node.startLine})`,
    );
  }
  store.close();
} else if (command === "slice") {
  const store = new GraphStore(dbPath);
  const query = String(args.query ?? "");
  if (!query) {
    console.error("Use --query <symbol or path>");
    process.exit(1);
  }
  const matches = store.findNodes(query, Number(args.limit ?? 5));
  if (matches.length === 0) {
    console.error(`No nodes found for: ${query}`);
    process.exit(1);
  }
  const policyName = String(args.policy ?? "impact");
  const policy = POLICIES[policyName];
  if (!policy) {
    console.error(
      `Unknown policy. Choose: ${Object.keys(POLICIES).join(", ")}`,
    );
    process.exit(1);
  }
  const maxTokens = Number(args["max-tokens"] ?? policy.maxTokens);
  const renderMode = args["render-mode"] as RenderMode | undefined;
  const slice = compileSlice(store, [matches[0].identity.stableId], {
    ...policy,
    maxTokens,
  });
  const rendered = renderSlice(root, slice, { maxTokens, renderMode });
  console.log(rendered);
  // Honest estimate from the ACTUAL rendered text (~3.2 chars/token), not the structural
  // node/edge count -- the latter under-counted rendered source and misled the budget.
  console.log(
    `\n// Estimated tokens: ~${Math.ceil(rendered.length / 3.2)} / ${maxTokens}`,
  );
  store.close();
} else if (command === "invalidate") {
  const store = new GraphStore(dbPath);
  const invalidator = new Invalidator(store);
  const file = String(args.file ?? "");
  if (file) {
    const absFile = path.resolve(root, file);
    const rel = path.relative(root, absFile).replaceAll("\\", "/");
    const affected = invalidator.onFileChanged(rel);
    const propagated = invalidator.propagateDirty();
    console.log(
      `${affected.length} direct dependents, ${propagated.length} total dirty files`,
    );
    for (const f of propagated) console.log(`  dirty: ${f}`);
  } else {
    const dirty = store.getDirtyFiles();
    if (dirty.length === 0) {
      console.log("No dirty files.");
    } else {
      console.log(`${dirty.length} dirty files:`);
      for (const f of dirty) console.log(`  ${f}`);
    }
  }
  store.close();
} else if (command === "reindex") {
  const store = new GraphStore(dbPath);
  const indexer = new TsRepositoryIndexer(store, root, ignorePatternsArg());
  const dirty = store.getDirtyFiles();
  if (dirty.length === 0) {
    console.log("No dirty files to re-index.");
    store.close();
    process.exit(0);
  }
  await initTreeSitter(new Set(dirty.map((f) => path.extname(f).toLowerCase())));
  for (const f of dirty) {
    const abs = path.join(root, f);
    indexer.indexFile(abs);
    console.log(`  re-indexed: ${f}`);
  }
  console.log(`Re-indexed ${dirty.length} files.`);
  store.close();
} else if (command === "container" || command === "containers") {
  const sub = args._[1] ?? "list";
  const store = new GraphStore(dbPath);

  if (sub === "build") {
    const indexer = new TsRepositoryIndexer(store, root, ignorePatternsArg());
    await indexer.indexAll();
    const ignorePatterns = args["ignore-patterns"]
      ? (Array.isArray(args["ignore-patterns"]) ? args["ignore-patterns"] : [args["ignore-patterns"]])
      : undefined;
    const builder = new ContainerBuilder({ root, store, ignorePatterns });
    const containers = builder.buildAll();
    builder.assignMembersAndRoles(containers);
    console.log(`Built ${containers.length} containers:`);
    for (const c of containers) {
      console.log(
        `  ${c.kind.padEnd(10)} ${c.name.padEnd(30)} ${c.memberIds.length} members v${c.version}${c.dirty ? " DIRTY" : ""}`,
      );
    }
  } else if (sub === "list") {
    const containers = store.listContainers();
    if (containers.length === 0) {
      console.log("No containers. Run `container build` first.");
    } else {
      console.log(`${containers.length} containers:`);
      for (const c of containers) {
        console.log(
          `  ${c.kind.padEnd(10)} ${c.name.padEnd(30)} ${c.memberIds.length} members v${c.version}${c.dirty ? " DIRTY" : ""}`,
        );
      }
    }
  } else if (sub === "status") {
    const containers = store.listContainers();
    const total = containers.length;
    const dirty = containers.filter((c) => c.dirty).length;
    const physical = containers.filter((c) => c.kind === "physical").length;
    console.log(`Containers: ${total} (${physical} physical, ${total - physical} other)`);
    console.log(`Dirty: ${dirty}`);
    console.log(`Members: ${containers.reduce((s, c) => s + c.memberIds.length, 0)}`);
  } else {
    console.log("Usage: container [build|list|status]");
  }
  store.close();
} else if (command === "cache") {
  const sub = args._[1] ?? "status";
  const store = new GraphStore(dbPath);
  const cache = new SliceCache(store);

  if (sub === "clear") {
    cache.invalidateAll();
    console.log("Slice cache cleared.");
  } else if (sub === "status") {
    const stats = store.getStats();
    console.log(`Cache entries: ${stats.cacheEntries}`);
  }
  store.close();
} else if (command === "import-test-trace") {
  const store = new GraphStore(dbPath);
  const importer = new TestTraceImporter(store, root);
  const file = args.file as string;
  if (file) {
    importer.importFromFile(file);
    console.log(`Imported test traces from ${file}`);
  } else {
    importer.findFromDirectory();
    console.log("Imported test traces from directory");
  }
  store.close();
} else if (command === "import-otel") {
  const store = new GraphStore(dbPath);
  const importer = new OtelImporter(store, root);
  const file = args.file as string;
  if (file) {
    importer.importFromFile(file);
    console.log(`Imported OTel traces from ${file}`);
  } else {
    importer.findFromDirectory();
    console.log("Imported OTel traces from directory");
  }
  store.close();
} else if (command === "import-coverage") {
  const store = new GraphStore(dbPath);
  const importer = new CoverageImporter(store, root);
  const file = args.file as string;
  if (file) {
    importer.importLcovFile(file);
    console.log(`Imported coverage from ${file}`);
  } else {
    importer.findFromDirectory();
    console.log("Imported coverage from directory");
  }
  store.close();
} else if (command === "security") {
  const sub = args._[1] ?? "status";
  if (sub === "status") {
    console.log(`Security exclusions: ${SECURITY_EXCLUSIONS.length}`);
    for (const ex of SECURITY_EXCLUSIONS) {
      console.log(`  ${ex.action.padEnd(8)} ${ex.reason.padEnd(12)} ${ex.pattern}`);
    }
    console.log(`\nSecret patterns: ${SECRET_PATTERNS.length}`);
    console.log(`Path guard: enabled`);
  } else if (sub === "check") {
    const file = args.file as string;
    if (!file) {
      console.log("Usage: security check --file <path>");
      process.exit(0);
    }
    const exclusion = getExclusion(file);
    console.log(`File: ${file}`);
    console.log(`Excluded: ${exclusion ? `yes (${exclusion.action} — ${exclusion.reason})` : "no"}`);
    if (exclusion) console.log(`Pattern: ${exclusion.pattern}`);
  } else if (sub === "redact") {
    const text = (args.text as string) ?? "";
    if (!text) {
      console.log("Usage: security redact --text <string>");
      process.exit(0);
    }
    console.log(redactSecrets(text));
  } else {
    console.log("Usage: security [status|check|redact]");
  }
} else if (command === "serve") {
  const server = new McpServer(dbPath, root);
  server.start();
} else if (command === "stats") {
  const store = new GraphStore(dbPath);
  const stats = store.getStats();
  console.log(`Files: ${stats.files}`);
  console.log(`Nodes: ${stats.nodes}`);
  console.log(`Edges: ${stats.edges}`);
  console.log(`Dirty: ${stats.dirty}`);
  console.log(`Containers: ${stats.containers}`);
  console.log(`Entry points: ${stats.entryPoints}`);
  console.log(`Cache entries: ${stats.cacheEntries}`);
  console.log(`FTS5: ${stats.hasFts ? "yes" : "no"}`);
  store.close();
} else {
  console.log(`
Usage:
  init                    Create graph store
  index                   Index all files
  watch                   Watch for changes
  query --query <s>       Search for nodes
  slice --query <s> [--policy impact] [--max-tokens 12000]  Generate context slice
  invalidate [--file <p>] Show or trigger invalidation
  reindex                 Re-index dirty files
  container build         Discover and build containers
  container list          List containers
  container status        Container summary
  cache clear             Clear slice cache
  import-test-trace       Import test trace JSON (--file <path>)
  import-otel             Import OTel traces JSON (--file <path>)
  import-coverage         Import lcov coverage (--file <path>)
  security [status|check|redact]  Inspect exclusions, path guard, secret redaction
  serve                   Start MCP server (stdio)
  stats                   Show stats

Options:
  --root <dir>      Repository root (default: cwd)
  --db <path>       Database path (default: .context-graph.sqlite)
  --limit <n>       Max results (default: 10)
  --query <s>       Search string
  --policy <name>   Traversal policy: minimal, function_edit, endpoint_edit, schema_edit, impact
  --max-tokens <n>  Token budget
  --render-mode <m>  Render allocation: balanced, source-first, edges-first
`);
}
