import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GraphStore } from "../db.js";
import { stableId } from "../hash.js";
import { VERIFICATION } from "../types.js";
import { LspClient } from "./client.js";

function findPyright(): string | undefined {
  const envp = process.env.OPENCODE_LIVE_CONTEXT_PYRIGHT;
  if (envp && fs.existsSync(envp)) return envp;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "pyright", "langserver.index.js"), // bundled next to cli.js
    path.resolve(here, "..", "pyright", "langserver.index.js"),
    path.resolve(here, "..", "..", "node_modules", "pyright", "langserver.index.js"), // dev
    path.resolve(here, "..", "..", "..", "node_modules", "pyright", "langserver.index.js"),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

type Sym = { name: string; sel: { line: number; character: number }; range: { start: number; end: number } };

function flattenSymbols(list: any[], out: Sym[]): void {
  for (const s of list ?? []) {
    const range = s.range ?? s.location?.range;
    const sel = s.selectionRange?.start ?? range?.start;
    if (range && sel) {
      out.push({ name: s.name, sel: { line: sel.line, character: sel.character }, range: { start: range.start.line, end: range.end.line } });
    }
    if (s.children) flattenSymbols(s.children, out);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Uses pyright to add compiler-grade (tier 4) reference edges for Python.
// Best-effort and time-bounded: on any failure or missing server it returns null
// and the heuristic graph stands on its own.
export async function resolvePythonLsp(
  store: GraphStore,
  root: string,
  files: string[],
  budgetMs: number,
): Promise<{ server: string; edges: number; symbols: number } | null> {
  const debug = process.env.OPENCODE_LIVE_CONTEXT_LSP_DEBUG === "1";
  const log = (...a: unknown[]) => { if (debug) console.error("[lsp]", ...a); };
  const pyFiles = files.filter((f) => f.toLowerCase().endsWith(".py"));
  if (pyFiles.length === 0) { log("no python files"); return null; }
  const server = findPyright();
  if (!server) { log("pyright not found"); return null; }
  log("pyright:", server, "| py files:", pyFiles.length);

  const deadline = Date.now() + budgetMs;
  const client = new LspClient(process.execPath, [server, "--stdio"], root);
  let edges = 0;
  let symbols = 0;
  try {
    const rootUri = pathToFileURL(root).href;
    const init = await client.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
        },
      },
    }, 20000);
    if (!init || init.error || !init.result) { log("initialize failed", init?.error); return null; }
    client.notify("initialized", {});
    log("initialized ok");

    // Build lookups from the already-indexed graph.
    const defs = store.definitionRanges();
    const lineToId = new Map<string, Map<number, string>>(); // relFile -> (startLine -> nodeId)
    const intervals = new Map<string, Array<{ start: number; end: number; id: string }>>();
    for (const d of defs) {
      if (!lineToId.has(d.filePath)) lineToId.set(d.filePath, new Map());
      lineToId.get(d.filePath)!.set(d.startLine, d.id);
      if (!intervals.has(d.filePath)) intervals.set(d.filePath, []);
      intervals.get(d.filePath)!.push({ start: d.startLine, end: d.endLine, id: d.id });
    }
    for (const arr of intervals.values()) arr.sort((a, b) => a.start - b.start || b.end - a.end);

    const relOf = (uri: string) => path.relative(root, fileURLToPath(uri)).replaceAll("\\", "/");
    const enclosing = (rel: string, line1: number): string | undefined => {
      const arr = intervals.get(rel);
      if (!arr) return undefined;
      let best: { start: number; end: number; id: string } | undefined;
      for (const iv of arr) {
        if (iv.start <= line1 && line1 <= iv.end) {
          if (!best || iv.start > best.start) best = iv;
        }
      }
      return best?.id;
    };
    const fileNodeId = (rel: string) => stableId(root, "generic", `file:${rel}`);

    // pyFiles are absolute; store keys are repo-relative with forward slashes.
    const opened = pyFiles.slice(0, 4000); // absolute paths
    for (const abs of opened) {
      if (!fs.existsSync(abs)) continue;
      client.notify("textDocument/didOpen", {
        textDocument: { uri: pathToFileURL(abs).href, languageId: "python", version: 1, text: fs.readFileSync(abs, "utf8") },
      });
    }
    await sleep(Math.min(8000, Math.max(3000, opened.length * 40)));

    for (const abs of opened) {
      if (Date.now() > deadline || !client.alive) break;
      const rel = path.relative(root, abs).replaceAll("\\", "/");
      const uri = pathToFileURL(abs).href;
      const docSyms = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, 8000);
      if (!docSyms?.result) continue;
      const flat: Sym[] = [];
      flattenSymbols(docSyms.result, flat);
      log(rel, "symbols:", flat.length, "| matched-to-nodes:", flat.filter((s) => lineToId.get(rel)?.get(s.range.start + 1)).length);
      for (const sym of flat) {
        if (Date.now() > deadline || !client.alive) break;
        const targetId = lineToId.get(rel)?.get(sym.range.start + 1);
        if (!targetId) continue;
        symbols++;
        const refs = await client.request("textDocument/references", {
          textDocument: { uri },
          position: { line: sym.sel.line, character: sym.sel.character },
          context: { includeDeclaration: false },
        }, 8000);
        for (const loc of refs?.result ?? []) {
          const refRel = relOf(loc.uri);
          const refLine1 = loc.range.start.line + 1;
          const sourceId = enclosing(refRel, refLine1) ?? fileNodeId(refRel);
          if (sourceId === targetId) continue;
          store.upsertEdge({
            sourceId,
            targetId,
            kind: "REFERENCES",
            verification: VERIFICATION.VERIFIED_COMPILER,
            sourceMethod: "pyright-lsp",
            metadata: { name: sym.name, via: "references" },
          });
          edges++;
        }
      }
    }
    log("done. symbols queried:", symbols, "edges added:", edges);
    return { server: "pyright", edges, symbols };
  } catch (e) {
    log("threw:", (e as Error)?.message);
    return edges > 0 ? { server: "pyright", edges, symbols } : null;
  } finally {
    await client.shutdown();
  }
}
