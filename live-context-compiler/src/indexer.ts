import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import fg from "fast-glob";
import { sha256, stableId, versionHash } from "./hash.js";
import { GraphStore } from "./db.js";
import { ModuleResolver } from "./resolver.js";
import { runContractBridges, runContractFullScans } from "./contracts/index.js";
import { getExclusion, redactSecrets } from "./security.js";
import { getIndexerForFile, indexFileWithLanguage, getRegisteredExtensions } from "./languages/index.js";
import { initTreeSitter } from "./languages/treesitter.js";
import { normalizeDoc, moduleDoc } from "./languages/docstring.js";
import { DOC_EXTENSIONS } from "./languages/doc.js";
import { resolvePythonLsp } from "./lsp/python.js";
import type { CodeEdge, CodeNode, EdgeKind, NodeKind } from "./types.js";
import { VERIFICATION } from "./types.js";

const SUPPORTED = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const LANGUAGE_GLOBS = getRegisteredExtensions().map((ext) => `**/*${ext}`);
const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  // Common heavy / generated dirs across ecosystems (esp. Python/Rust/Go)
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/site-packages/**",
  "**/target/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.svelte-kit/**",
  "**/*.min.js",
];
const TS_SOURCE_METHOD = "typescript-compiler";

// Filename stems that conventionally mark a program/module entry point. Kept deliberately
// tight — `index` is excluded because barrel `index.ts` files are everywhere and would
// dilute the signal to noise.
const ENTRY_BASENAMES = new Set(["main", "cli", "server", "app", "__main__"]);

// Flatten the string leaves of a package.json field (bin can be a string or a map,
// exports a deeply nested conditions tree).
function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

// Cross-file reference pass tuning. We only link a symbol whose name is defined
// exactly once in the repo (high precision), is reasonably distinctive, and is
// not a generic word — so heuristic edges stay useful rather than noisy.
const REF_CAP_PER_FILE = 60;
const REF_MIN_NAME_LENGTH = 4;
const REF_STOPWORDS = new Set([
  "main", "init", "setup", "index", "value", "result", "data", "name", "type",
  "kind", "node", "edge", "item", "list", "self", "none", "null", "true", "false",
  "config", "options", "context", "state", "error", "print", "input", "output",
  "start", "close", "open", "read", "write", "build", "parse", "render", "update",
  "create", "delete", "remove", "apply", "format", "handler", "builder", "test",
]);

// Registration-detection tuning. A decorator's root identifier (`@SOURCES.register` →
// `SOURCES`) is captured, and the declaration it sits above is linked to it.
const REGISTRATION_CAP_PER_FILE = 100;
const DECORATOR_RE = /^\s*@\s*([A-Za-z_]\w*)/;
const DECL_NAME_RE =
  /\b(?:def|class|function|func|fn|const|let|var|interface|enum|struct|trait|type|object|val|record|module)\s+([A-Za-z_]\w*)/;

// Best-effort, language-agnostic removal of comments and string literals so the
// cross-reference name scan only sees code. Strings are stripped before line comments
// so a `#`/`//` inside a literal can't swallow it; approximate by design — over-stripping
// only drops a heuristic (tier-2) edge, never a compiler-verified one.
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block comments */
    .replace(/"""[\s\S]*?"""/g, " ") // python triple-quoted
    .replace(/'''[\s\S]*?'''/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ") // template / backtick strings
    .replace(/"(?:\\.|[^"\\\n])*"/g, " ") // "double"
    .replace(/'(?:\\.|[^'\\\n])*'/g, " ") // 'single'
    .replace(/#.*$/gm, " ") // python/shell/ruby line comments
    .replace(/\/\/.*$/gm, " "); // c-style line comments
}

interface ProgramContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
}

export class TsRepositoryIndexer {
  private store: GraphStore;
  private resolver: ModuleResolver;
  private root: string;
  private ignore: string[];
  private programContext?: ProgramContext;

  constructor(store: GraphStore, root: string, ignorePatterns: string[] = []) {
    this.store = store;
    this.resolver = new ModuleResolver(root);
    this.root = root;
    this.ignore = [...IGNORE, ...ignorePatterns];
  }

  async indexAll(): Promise<void> {
    const files = this.listSourceFiles();
    // Only build the TS program and re-index when TS/JS content actually changed.
    // Building the program (type checker) over the whole repo is the dominant cost of
    // a warm re-index, so skipping it when nothing changed is what makes re-index cheap.
    const changedTs = files.filter((f) => this.contentChanged(f));
    if (changedTs.length > 0) {
      this.programContext = this.createProgram(files);
      for (const file of changedTs) {
        try {
          this.indexFileWithProgram(file, this.programContext);
        } catch (error) {
          this.warnFileSkipped(file, error);
        }
      }
    }
    const langFiles = this.listLanguageFiles();
    await initTreeSitter(new Set(langFiles.map((f) => path.extname(f).toLowerCase())));
    const changedLang: string[] = [];
    for (const file of langFiles) {
      try {
        if (this.indexLanguageFile(file)) changedLang.push(file);
      } catch (error) {
        this.warnFileSkipped(file, error);
      }
    }
    // Scope the cross-reference pass to changed files. Re-scanning unchanged files every
    // run re-inserted duplicate edge_evidence rows (their edges were never cleared) and
    // made a warm re-index re-read the whole repo. A changed file's stale edges are already
    // dropped by clearFile before it is re-indexed, so re-enriching only those is correct.
    if (changedLang.length > 0) {
      this.enrichReferences(changedLang);
    }
    if (changedTs.length > 0 || changedLang.length > 0) {
      this.enrichRegistrations([...changedTs, ...changedLang]);
    }
    await this.resolveSemantics(langFiles);
    if (changedTs.length > 0 || changedLang.length > 0) {
      runContractFullScans(this.store, this.root);
      this.detectEntryPoints(files, langFiles);
    }
  }

  // Discover natural starting points so search can bias its seed toward them. Recomputed
  // whenever anything changed (cheap: a package.json glob plus a name check per file, and
  // a content read only for Python files to spot a `__main__` guard). The set is a search
  // tiebreaker only — never a hard filter — so over- or under-marking can't hide code.
  private detectEntryPoints(tsFiles: string[], langFiles: string[]): void {
    this.store.clearEntryPoints();

    for (const pkgAbs of fg.sync("**/package.json", { cwd: this.root, ignore: this.ignore, absolute: true })) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(fs.readFileSync(pkgAbs, "utf8"));
      } catch {
        continue;
      }
      const dir = path.dirname(pkgAbs);
      const fields: Array<[unknown, string]> = [
        [json.bin, "bin"],
        [json.main, "package-main"],
        [json.module, "package-main"],
        [json.exports, "package-main"],
      ];
      for (const [val, kind] of fields) {
        for (const target of collectStrings(val)) {
          const rel = this.resolveEntryTarget(dir, target);
          if (rel) this.store.markEntryPoint(rel, kind);
        }
      }
    }

    for (const abs of [...tsFiles, ...langFiles]) {
      const rel = path.relative(this.root, abs).replaceAll("\\", "/");
      const stem = path.basename(rel).replace(/\.[^.]+$/, "").toLowerCase();
      if (ENTRY_BASENAMES.has(stem)) {
        this.store.markEntryPoint(rel, "convention");
        continue;
      }
      if (rel.toLowerCase().endsWith(".py")) {
        try {
          if (/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(fs.readFileSync(abs, "utf8"))) {
            this.store.markEntryPoint(rel, "main-guard");
          }
        } catch {
          // unreadable; skip
        }
      }
    }
  }

  // Map a package.json entry target to an indexed *source* file. `main`/`bin` usually point
  // at built output (dist/*.js), so we also try the obvious source location (src/*.ts) and
  // only mark a target that actually exists — a dangling build path marks nothing.
  private resolveEntryTarget(dir: string, target: string): string | undefined {
    if (!target) return undefined;
    const base = target.replace(/^\.\//, "");
    const candidates = new Set<string>([base, base.replace(/(^|\/)(dist|build|out|lib)\//, "$1src/")]);
    for (const c of [...candidates]) {
      for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
        candidates.add(c.replace(/\.(js|cjs|mjs)$/, ext));
      }
    }
    for (const c of candidates) {
      const abs = path.join(dir, c);
      if (this.isInsideRoot(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return path.relative(this.root, abs).replaceAll("\\", "/");
      }
    }
    return undefined;
  }

  // A file needs (re)indexing when it has never been indexed, or its current content
  // hash differs from the stored one. Files with no prior hash short-circuit without a
  // read so a cold index doesn't pay a redundant read here.
  private contentChanged(absPath: string): boolean {
    const rel = path.relative(this.root, absPath).replaceAll("\\", "/");
    const prior = this.store.indexedHash(rel);
    if (prior === undefined) return true;
    try {
      const exclusion = getExclusion(rel);
      if (exclusion?.action === "skip") return false;
      const raw = fs.readFileSync(absPath, "utf8");
      const text = exclusion?.action === "redact" ? redactSecrets(raw) : raw;
      return sha256(text) !== prior;
    } catch {
      return true;
    }
  }

  // One file failing (a TS compiler assertion, a malformed source, etc.) must never abort the
  // whole index. Its transaction is already rolled back by GraphStore.transaction; we just log a
  // single short line to stderr — never the full stack, which can be hundreds of KB of minified code.
  private warnFileSkipped(absPath: string, error: unknown): void {
    const rel = path.relative(this.root, absPath).replaceAll("\\", "/");
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
    process.stderr.write(`[live-context] skipped ${rel}: ${reason}\n`);
  }

  // Optional compiler-grade resolution pass (LSP). Best-effort, time-bounded,
  // and disabled by OPENCODE_LIVE_CONTEXT_LSP=0. Never throws.
  private async resolveSemantics(langFiles: string[]): Promise<void> {
    if (process.env.OPENCODE_LIVE_CONTEXT_LSP === "0") return;
    const pyAbs = langFiles.filter((f) => f.toLowerCase().endsWith(".py"));
    if (pyAbs.length === 0) return;

    // Resume on files pyright hasn't resolved yet, prioritizing the ones whose symbols are
    // most referenced (most likely to appear in a slice). A flat one-shot budget left large
    // repos at ~0% compiler coverage; spreading the budget across runs lets it reach 100%.
    const resolved = this.store.lspResolvedFiles();
    const rel = (abs: string) => path.relative(this.root, abs).replaceAll("\\", "/");
    const pending = pyAbs.filter((abs) => !resolved.has(rel(abs)));
    if (pending.length === 0) return; // fully resolved already

    const hotRank = new Map(this.store.filesByReferenceHotness().map((f, i) => [f, i]));
    pending.sort((a, b) => (hotRank.get(rel(a)) ?? Infinity) - (hotRank.get(rel(b)) ?? Infinity));

    const budget = numberEnv("OPENCODE_LIVE_CONTEXT_LSP_BUDGET_MS", 20000);
    try {
      const result = await resolvePythonLsp(this.store, this.root, pyAbs, budget, {
        queryFiles: pending,
      });
      for (const f of result?.resolvedRel ?? []) this.store.markLspResolved(f);
    } catch {
      // semantic resolution is additive; ignore failures
    }
  }

  // Second pass over non-TS files: emit REFERENCES edges from a file to any
  // symbol whose name it mentions, when that name has a single, distinctive
  // definition in the repo. Gives a cross-file usage graph for languages that
  // have no compiler-grade resolver.
  private enrichReferences(langFiles: string[]): void {
    if (langFiles.length === 0) return;
    const defs = this.store.symbolDefinitions();
    if (defs.length === 0) return;

    const byName = new Map<string, { id: string; filePath: string }>();
    const ambiguous = new Set<string>();
    for (const d of defs) {
      const name = d.name;
      if (name.length < REF_MIN_NAME_LENGTH || REF_STOPWORDS.has(name.toLowerCase())) continue;
      if (ambiguous.has(name)) continue;
      if (byName.has(name)) {
        byName.delete(name);
        ambiguous.add(name);
        continue;
      }
      byName.set(name, { id: d.id, filePath: d.filePath });
    }
    if (byName.size === 0) return;

    const identRe = /[A-Za-z_][A-Za-z0-9_]*/g;
    for (const abs of langFiles) {
      if (!fs.existsSync(abs)) continue;
      // Documentation is prose: every symbol name in it is a mention, not a reference.
      // Scanning it would re-introduce exactly the false edges the comment-stripping above
      // is meant to prevent, so doc files contribute nodes but never cross-ref edges.
      if (DOC_EXTENSIONS.has(path.extname(abs).toLowerCase())) continue;
      const rel = path.relative(this.root, abs).replaceAll("\\", "/");
      const fileId = stableId(this.root, "generic", `file:${rel}`);
      // Scan code only: a name that appears solely in a comment or string literal is
      // a mention, not a reference. Stripping them removes the bulk of the false-positive
      // file-level edges the heuristic used to emit (docstrings, error messages, examples).
      const text = stripCommentsAndStrings(fs.readFileSync(abs, "utf8"));
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      identRe.lastIndex = 0;
      while ((m = identRe.exec(text)) !== null) {
        const def = byName.get(m[0]);
        if (!def || def.filePath === rel || seen.has(def.id)) continue;
        seen.add(def.id);
        this.store.upsertEdge({
          sourceId: fileId,
          targetId: def.id,
          kind: "REFERENCES",
          verification: VERIFICATION.PATTERN_MATCHED,
          sourceMethod: "cross-ref",
          metadata: { name: m[0] },
        });
        if (seen.size >= REF_CAP_PER_FILE) break;
      }
    }
  }

  // Decorator-based registration links a handler to the registry that dispatches to it at
  // runtime — `@SOURCES.register` above `def haraj(...)`. Nothing statically *calls* haraj,
  // so plain call resolution never connects the registry to its handlers; this recovers
  // that edge. For a decorator whose root identifier resolves to a known symbol (the
  // registry), emit a REFERENCES edge from the decorated definition to that registry.
  //
  // The edge is sourced from the in-file handler definition, so clearFile drops it on
  // re-index (incrementally correct). Both ends must resolve to a single, distinctive
  // definition, so framework decorators imported from libraries (`@Injectable`) and
  // ambiguous names (`@app.route`) emit nothing — precise over noisy.
  private enrichRegistrations(files: string[]): void {
    if (files.length === 0) return;
    const defs = this.store.registrySymbols();
    if (defs.length === 0) return;

    const byName = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const d of defs) {
      const name = d.name;
      if (name.length < REF_MIN_NAME_LENGTH || REF_STOPWORDS.has(name.toLowerCase())) continue;
      if (ambiguous.has(name)) continue;
      if (byName.has(name)) {
        byName.delete(name);
        ambiguous.add(name);
        continue;
      }
      byName.set(name, d.id);
    }
    if (byName.size === 0) return;

    for (const abs of files) {
      if (!fs.existsSync(abs)) continue;
      const rel = path.relative(this.root, abs).replaceAll("\\", "/");
      if (getExclusion(rel)?.action === "skip") continue;
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      let emitted = 0;
      for (let i = 0; i < lines.length && emitted < REGISTRATION_CAP_PER_FILE; i++) {
        const dm = DECORATOR_RE.exec(lines[i]);
        if (!dm) continue;
        const registryId = byName.get(dm[1]);
        if (!registryId) continue;
        // Advance past stacked decorators / blank / comment lines to the declaration.
        let j = i + 1;
        while (
          j < lines.length &&
          (lines[j].trim() === "" || DECORATOR_RE.test(lines[j]) || /^\s*(#|\/\/)/.test(lines[j]))
        ) {
          j++;
        }
        const nm = j < lines.length ? DECL_NAME_RE.exec(lines[j]) : null;
        const handlerId = nm ? byName.get(nm[1]) : undefined;
        if (!handlerId || handlerId === registryId) continue;
        this.store.upsertEdge({
          sourceId: handlerId,
          targetId: registryId,
          kind: "REFERENCES",
          verification: VERIFICATION.PATTERN_MATCHED,
          sourceMethod: "registry",
          metadata: { via: "decorator", registry: dm[1] },
        });
        emitted++;
      }
    }
  }

  invalidateAll(): void {
    this.resolver.invalidateCache();
    this.programContext = undefined;
  }

  indexFile(absPath: string): void {
    // Non-TS/JS files handled by a dedicated or generic language indexer.
    if (getIndexerForFile(absPath)) {
      this.indexLanguageFile(absPath);
      return;
    }

    if (!fs.existsSync(absPath)) {
      const rel = path.relative(this.root, absPath).replaceAll("\\", "/");
      this.store.clearFile(rel, true);
      return;
    }

    const files = this.listSourceFiles();
    if (!files.includes(absPath)) files.push(absPath);
    this.programContext = this.createProgram(files);
    this.indexFileWithProgram(absPath, this.programContext);
  }

  private listLanguageFiles(): string[] {
    if (LANGUAGE_GLOBS.length === 0) return [];
    return fg.sync(LANGUAGE_GLOBS, {
      cwd: this.root,
      ignore: this.ignore,
      absolute: true,
    }).filter((file) => {
      const rel = path.relative(this.root, file).replaceAll("\\", "/");
      return getExclusion(rel)?.action !== "skip";
    });
  }

  // Returns true when it actually (re)indexed the file, false when it was skipped
  // (missing, excluded, or unchanged) — the caller uses this to scope the cross-reference
  // and contract passes to only what changed.
  private indexLanguageFile(absPath: string): boolean {
    const rel = path.relative(this.root, absPath).replaceAll("\\", "/");

    if (!fs.existsSync(absPath)) {
      this.store.clearFile(rel, true);
      return false;
    }

    const exclusion = getExclusion(rel);
    if (exclusion?.action === "skip") return false;

    const rawText = fs.readFileSync(absPath, "utf8");
    const text = exclusion?.action === "redact" ? redactSecrets(rawText) : rawText;
    const digest = sha256(text);
    if (this.store.indexedHash(rel) === digest) return false;

    this.store.transaction(() => {
      this.store.clearFile(rel);
      indexFileWithLanguage(this.store, rel, text, this.root);
      this.store.markIndexed(rel, digest);
    });
    return true;
  }

  private listSourceFiles(): string[] {
    return fg.sync(SUPPORTED, {
      cwd: this.root,
      ignore: this.ignore,
      absolute: true,
    }).filter((file) => {
      const rel = path.relative(this.root, file).replaceAll("\\", "/");
      return getExclusion(rel)?.action !== "skip";
    });
  }

  private createProgram(files: string[]): ProgramContext {
    const parsed = this.loadTsConfig(files);
    const host = ts.createCompilerHost(parsed.options, true);
    const program = ts.createProgram(parsed.fileNames, parsed.options, host);
    return {
      program,
      checker: program.getTypeChecker(),
      options: parsed.options,
      host,
    };
  }

  private loadTsConfig(files: string[]): ts.ParsedCommandLine {
    const configPath = ts.findConfigFile(this.root, ts.sys.fileExists);
    if (configPath && this.isInsideRoot(configPath)) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          path.dirname(configPath),
          this.defaultCompilerOptions(),
          configPath,
        );
        const fileSet = new Set([...parsed.fileNames, ...files]);
        return { ...parsed, fileNames: [...fileSet] };
      }
    }

    return {
      options: this.defaultCompilerOptions(),
      fileNames: files,
      errors: [],
      wildcardDirectories: {},
      compileOnSave: false,
    };
  }

  private defaultCompilerOptions(): ts.CompilerOptions {
    return {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: this.root,
      rootDir: this.root,
      noEmit: true,
    };
  }

  private indexFileWithProgram(absPath: string, context: ProgramContext): void {
    const rel = path.relative(this.root, absPath).replaceAll("\\", "/");
    const exclusion = getExclusion(rel);
    if (exclusion?.action === "skip") return;

    const rawText = fs.readFileSync(absPath, "utf8");
    const text = exclusion?.action === "redact" ? redactSecrets(rawText) : rawText;
    const digest = sha256(text);
    if (this.store.indexedHash(rel) === digest) return;

    const source = context.program.getSourceFile(absPath) ?? this.createDetachedSource(absPath, text);

    this.store.transaction(() => {
      this.store.clearFile(rel);
      this.resolver.invalidateCache();
      this.processFile(rel, absPath, text, digest, source, context);
    });
  }

  private createDetachedSource(absPath: string, text: string): ts.SourceFile {
    const scriptKind = absPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKind);
  }

  private processFile(
    rel: string,
    absPath: string,
    text: string,
    contentHash: string,
    source: ts.SourceFile,
    context: ProgramContext,
  ): void {
    const fileNode = this.createFileNode(rel, text, source);
    this.store.upsertNode(fileNode);

    this.extractDeclarations(source, source, fileNode.identity.stableId, rel, contentHash, context);
    this.extractContractPatterns(rel, text, fileNode.identity.stableId);

    this.store.markIndexed(rel, contentHash);
  }

  private createFileNode(rel: string, text: string, source: ts.SourceFile): CodeNode {
    const qualifiedName = `file:${rel}`;
    const sid = stableId(this.root, "ts", qualifiedName);
    return {
      identity: { stableId: sid, versionHash: versionHash(text) },
      kind: "file",
      name: rel,
      qualifiedName,
      filePath: rel,
      startLine: 1,
      endLine: ts.getLineAndCharacterOfPosition(source, source.end).line + 1,
      doc: moduleDoc(text),
      language: "ts",
    };
  }

  private extractDeclarations(
    node: ts.Node,
    source: ts.SourceFile,
    ownerStableId: string,
    rel: string,
    contentHash: string,
    context: ProgramContext,
  ): void {
    let childOwner = ownerStableId;

    if (ts.isImportDeclaration(node)) {
      this.resolveImportDeclaration(node, source, rel, ownerStableId, context);
    }

    if (ts.isExportDeclaration(node)) {
      this.resolveExportDeclaration(node, source, rel, ownerStableId, context);
    }

    if (ts.isExportAssignment(node)) {
      const target = this.targetNodeFromExpression(node.expression, context);
      if (target) {
        this.store.upsertNode(target);
        this.upsertCompilerEdge(ownerStableId, target.identity.stableId, "EXPORTS", {
          exportedName: "default",
        });
      }
    }

    const kind = this.declarationKind(node);
    if (kind) {
      const codeNode = this.makeDeclNode(node, source, kind, rel, contentHash);
      if (codeNode) {
        this.store.upsertNode(codeNode);
        this.upsertCompilerEdge(ownerStableId, codeNode.identity.stableId, "CONTAINS");
        childOwner = codeNode.identity.stableId;

        if (this.isExportedDeclaration(node)) {
          this.upsertCompilerEdge(ownerStableId, codeNode.identity.stableId, "EXPORTS", {
            exportedName: codeNode.name,
          });
        }

        this.resolveHeritage(node, source, codeNode.identity.stableId, context);
      }
    }

    if (ts.isCallExpression(node)) {
      // Dynamic `import("...")` / `require("...")` are IMPORTS edges, not calls. Without
      // this they resolved to nothing and were dropped as UNRESOLVED_CALL, so lazily-loaded
      // modules (route lazy-loading, plugin loaders, code-split chunks) went missing from
      // the import graph entirely.
      if (!this.resolveDynamicImport(node, source, rel, context)) {
        this.resolveCallExpression(node, source, childOwner, rel, context);
      }
    }

    ts.forEachChild(node, (child) =>
      this.extractDeclarations(child, source, childOwner, rel, contentHash, context),
    );
  }

  private declarationKind(node: ts.Node): NodeKind | undefined {
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isMethodDeclaration(node)) return "method";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isVariableDeclaration(node) && this.isExportedVariable(node)) return "variable";
    return undefined;
  }

  private makeDeclNode(
    node: ts.Node,
    source: ts.SourceFile,
    kind: NodeKind,
    rel: string,
    _contentHash: string,
  ): CodeNode | null {
    const name = declarationName(node);
    if (!name) return null;

    const qualifiedName = `${kind}:${rel}:${name}`;
    const text = node.getText(source);
    const sid = stableId(this.root, "ts", qualifiedName);
    const start = ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1;
    const end = ts.getLineAndCharacterOfPosition(source, node.end).line + 1;

    return {
      identity: { stableId: sid, versionHash: versionHash(text) },
      kind,
      name,
      qualifiedName,
      filePath: rel,
      startLine: start,
      endLine: end,
      signature: signature(node, source),
      doc: leadingDoc(node, source),
      language: "ts",
    };
  }

  private resolveImportDeclaration(
    node: ts.ImportDeclaration,
    source: ts.SourceFile,
    rel: string,
    fileNodeId: string,
    context: ProgramContext,
  ): void {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    this.addModuleImportEdge(source, rel, fileNodeId, specifier, context);

    const clause = node.importClause;
    if (!clause) return;

    if (clause.name) {
      this.addReferenceForName(fileNodeId, clause.name, context, {
        localName: clause.name.text,
        exportedName: "default",
        specifier,
      });
    }

    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        this.addReferenceForName(fileNodeId, el.name, context, {
          localName: el.name.text,
          exportedName: el.propertyName?.text ?? el.name.text,
          specifier,
        });
      }
    }

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      this.addReferenceForName(fileNodeId, clause.namedBindings.name, context, {
        localName: clause.namedBindings.name.text,
        exportedName: "*",
        specifier,
      });
    }
  }

  private resolveExportDeclaration(
    node: ts.ExportDeclaration,
    source: ts.SourceFile,
    rel: string,
    fileNodeId: string,
    context: ProgramContext,
  ): void {
    let specifier: string | undefined;
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
      this.addModuleImportEdge(source, rel, fileNodeId, specifier, context);
    }

    const clause = node.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return;

    for (const el of clause.elements) {
      const symbol = context.checker.getSymbolAtLocation(el.name);
      const target = this.targetNodeFromSymbol(symbol, context);
      if (target) {
        this.store.upsertNode(target);
        this.upsertCompilerEdge(fileNodeId, target.identity.stableId, "EXPORTS", {
          exportedName: el.name.text,
          localName: el.propertyName?.text ?? el.name.text,
          specifier,
        });
      }
    }
  }

  private addModuleImportEdge(
    source: ts.SourceFile,
    rel: string,
    fileNodeId: string,
    specifier: string,
    context: ProgramContext,
  ): void {
    const resolved = this.resolveModuleFile(source, rel, specifier, context);
    if (!resolved) {
      this.store.upsertEdge({
        sourceId: fileNodeId,
        targetId: `unresolved::${specifier}`,
        kind: "UNRESOLVED_IMPORT",
        verification: VERIFICATION.UNRESOLVED,
        sourceMethod: TS_SOURCE_METHOD,
        metadata: { specifier },
      });
      return;
    }

    const target = this.createImportTargetNode(resolved.relativePath, resolved.packageName);
    this.store.upsertNode(target);
    this.upsertCompilerEdge(fileNodeId, target.identity.stableId, "IMPORTS", {
      specifier,
      packageName: resolved.packageName,
    });

    if (!resolved.packageName) {
      this.store.addImportEdge(rel, resolved.relativePath, "IMPORTS");
    }
  }

  private resolveModuleFile(
    source: ts.SourceFile,
    rel: string,
    specifier: string,
    context: ProgramContext,
  ): { relativePath: string; packageName?: string } | null {
    const resolved = ts.resolveModuleName(
      specifier,
      source.fileName,
      context.options,
      context.host,
    ).resolvedModule;

    if (resolved?.resolvedFileName && this.isInsideRoot(resolved.resolvedFileName)) {
      return {
        relativePath: path.relative(this.root, resolved.resolvedFileName).replaceAll("\\", "/"),
      };
    }

    const fallback = this.resolver.resolve(path.join(this.root, rel), specifier);
    if (!fallback) return null;
    return {
      relativePath: fallback.relativePath,
      packageName: fallback.packageName,
    };
  }

  private createImportTargetNode(relativePath: string, packageName?: string): CodeNode {
    if (packageName) {
      const qualifiedName = `package:${packageName}`;
      return {
        identity: {
          stableId: stableId(this.root, "ts", qualifiedName),
          versionHash: versionHash(packageName),
        },
        kind: "package",
        name: packageName,
        qualifiedName,
        filePath: relativePath,
        startLine: 0,
        endLine: 0,
        language: "ts",
      };
    }

    const qualifiedName = `file:${relativePath}`;
    return {
      identity: {
        stableId: stableId(this.root, "ts", qualifiedName),
        versionHash: versionHash(relativePath),
      },
      kind: "file",
      name: relativePath,
      qualifiedName,
      filePath: relativePath,
      startLine: 0,
      endLine: 0,
      language: "ts",
    };
  }

  private addReferenceForName(
    sourceId: string,
    name: ts.Identifier,
    context: ProgramContext,
    metadata: Record<string, unknown>,
  ): void {
    const target = this.targetNodeFromSymbol(context.checker.getSymbolAtLocation(name), context);
    if (!target) return;
    this.store.upsertNode(target);
    this.upsertCompilerEdge(sourceId, target.identity.stableId, "REFERENCES", metadata);
  }

  private resolveHeritage(
    node: ts.Node,
    source: ts.SourceFile,
    sourceId: string,
    context: ProgramContext,
  ): void {
    if (
      !ts.isClassDeclaration(node) &&
      !ts.isInterfaceDeclaration(node)
    ) {
      return;
    }
    if (!node.heritageClauses) return;

    for (const clause of node.heritageClauses) {
      for (const heritageType of clause.types) {
        const target = this.targetNodeFromExpression(heritageType.expression, context);
        if (!target) continue;
        this.store.upsertNode(target);
        const kind: EdgeKind =
          clause.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS";
        this.upsertCompilerEdge(sourceId, target.identity.stableId, kind, {
          expression: heritageType.expression.getText(source),
        });
      }
    }
  }

  // Recognize a dynamic `import("...")` or `require("...")` with a static string
  // specifier and record it as a module IMPORTS edge (from the file node, matching how
  // static imports are stored). Returns true when it handled the call so the generic
  // call resolver skips it. A non-literal `import(expr)` is still swallowed (returns true)
  // to avoid emitting a useless UNRESOLVED_CALL for it.
  private resolveDynamicImport(
    node: ts.CallExpression,
    source: ts.SourceFile,
    rel: string,
    context: ProgramContext,
  ): boolean {
    const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (!isImportCall && !isRequire) return false;

    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg)) return isImportCall;

    const fileId = stableId(this.root, "ts", `file:${rel}`);
    this.addModuleImportEdge(source, rel, fileId, arg.text, context);
    return true;
  }

  private resolveCallExpression(
    node: ts.CallExpression,
    source: ts.SourceFile,
    ownerId: string,
    rel: string,
    context: ProgramContext,
  ): void {
    // TypeScript's checker can throw an internal assertion (e.g. "Debug Failure. No error for
    // last overload signature") on certain overloaded calls. A single bad call must not abort
    // indexing the whole repo — fall back to an UNRESOLVED_CALL edge instead.
    let signature: ts.Signature | undefined;
    try {
      signature = context.checker.getResolvedSignature(node);
    } catch {
      signature = undefined;
    }
    const declaration = signature?.declaration;
    const target = declaration ? this.targetNodeFromDeclaration(declaration, context) : null;

    if (target) {
      this.store.upsertNode(target);
      this.upsertCompilerEdge(ownerId, target.identity.stableId, "CALLS", {
        expression: node.expression.getText(source),
      });
      return;
    }

    const expression = node.expression.getText(source);
    this.store.upsertEdge({
      sourceId: ownerId,
      targetId: `unresolved::${rel}::${expression}`,
      kind: "UNRESOLVED_CALL",
      verification: VERIFICATION.UNRESOLVED,
      sourceMethod: TS_SOURCE_METHOD,
      metadata: { expression },
    });
  }

  private targetNodeFromExpression(
    expression: ts.Expression,
    context: ProgramContext,
  ): CodeNode | null {
    return this.targetNodeFromSymbol(context.checker.getSymbolAtLocation(expression), context);
  }

  private targetNodeFromSymbol(
    symbol: ts.Symbol | undefined,
    context: ProgramContext,
  ): CodeNode | null {
    if (!symbol) return null;
    const resolved = this.resolveAlias(symbol, context);
    const declarations = resolved.getDeclarations() ?? symbol.getDeclarations() ?? [];
    for (const declaration of declarations) {
      const target = this.targetNodeFromDeclaration(declaration, context);
      if (target) return target;
    }
    return null;
  }

  private resolveAlias(symbol: ts.Symbol, context: ProgramContext): ts.Symbol {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      return context.checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  private targetNodeFromDeclaration(
    declaration: ts.Declaration,
    _context: ProgramContext,
  ): CodeNode | null {
    const source = declaration.getSourceFile();
    if (!this.isInsideRoot(source.fileName) || source.isDeclarationFile) return null;

    const rel = path.relative(this.root, source.fileName).replaceAll("\\", "/");
    if (getExclusion(rel)?.action === "skip") return null;

    const kind = this.declarationKind(declaration);
    if (!kind) return null;

    return this.makeDeclNode(declaration, source, kind, rel, source.text);
  }

  private isInsideRoot(fileName: string): boolean {
    const relative = path.relative(this.root, fileName);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private isExportedDeclaration(node: ts.Node): boolean {
    if (hasModifier(node, ts.ModifierFlags.Export)) return true;
    if (ts.isVariableDeclaration(node)) return this.isExportedVariable(node);
    return false;
  }

  private isExportedVariable(node: ts.VariableDeclaration): boolean {
    const statement = node.parent?.parent;
    return Boolean(statement && ts.isVariableStatement(statement) && hasModifier(statement, ts.ModifierFlags.Export));
  }

  private upsertCompilerEdge(
    sourceId: string,
    targetId: string,
    kind: EdgeKind,
    metadata?: Record<string, unknown>,
  ): void {
    const edge: CodeEdge = {
      sourceId,
      targetId,
      kind,
      verification: VERIFICATION.VERIFIED_COMPILER,
      sourceMethod: TS_SOURCE_METHOD,
      metadata,
    };
    this.store.upsertEdge(edge);
  }

  private extractContractPatterns(
    rel: string,
    text: string,
    fileNodeId: string,
  ): void {
    const source = ts.createSourceFile(
      path.join(this.root, rel),
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    runContractBridges(this.store, rel, text, source, fileNodeId, this.root);
  }
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function declarationName(node: ts.Node): string | undefined {
  const maybe = node as ts.NamedDeclaration;
  if (!maybe.name) return undefined;
  if (ts.isIdentifier(maybe.name) || ts.isStringLiteral(maybe.name)) {
    return maybe.name.text;
  }
  return maybe.name.getText();
}

function signature(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).split("{")[0].trim().slice(0, 500);
}

// The JSDoc / leading comment immediately above a declaration, cleaned to a one-line
// summary. Uses the comment ranges at the node's full start, which include the block
// that precedes the `export`/modifier keywords, so `/** ... */ export function f` works.
function leadingDoc(node: ts.Node, source: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  const last = ranges[ranges.length - 1];
  return normalizeDoc(source.text.slice(last.pos, last.end));
}

function hasModifier(
  node: ts.Node,
  flag: ts.ModifierFlags,
): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & flag) !== 0;
}
