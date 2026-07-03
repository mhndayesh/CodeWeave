import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import type { CodeEdge, CodeNode, NodeKind } from "../types.js";
import type { ExtractionResult } from "./base.js";
import { makeNode, makeEdge, makeFileNode } from "./base.js";

// Extension -> grammar name (must match a tree-sitter-<name>.wasm we ship).
// JS/TS are intentionally excluded: they go through the real TypeScript compiler.
const EXT_GRAMMAR: Record<string, string> = {
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".dart": "dart",
  ".ex": "elixir", ".exs": "elixir",
  ".ml": "ocaml", ".mli": "ocaml",
  ".sol": "solidity",
  ".zig": "zig",
};

// Per-grammar node types we treat as definitions, plus which of those open a
// class/type scope (so nested functions become methods with a CONTAINS edge).
type LangSpec = { defs: Record<string, NodeKind>; containers: Set<string> };

const LANG_SPECS: Record<string, LangSpec> = {
  python: {
    defs: { function_definition: "function", class_definition: "class" },
    containers: new Set(["class_definition"]),
  },
  rust: {
    defs: {
      function_item: "function", struct_item: "class", enum_item: "enum",
      trait_item: "interface", type_item: "type", macro_definition: "function",
    },
    containers: new Set(["impl_item", "trait_item"]),
  },
  go: {
    defs: {
      function_declaration: "function", method_declaration: "method",
      type_spec: "class", type_declaration: "class",
    },
    containers: new Set(),
  },
  java: {
    defs: {
      class_declaration: "class", interface_declaration: "interface",
      enum_declaration: "enum", record_declaration: "class",
      method_declaration: "method", constructor_declaration: "method",
    },
    containers: new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]),
  },
  c_sharp: {
    defs: {
      class_declaration: "class", interface_declaration: "interface",
      struct_declaration: "class", enum_declaration: "enum",
      method_declaration: "method", constructor_declaration: "method",
    },
    containers: new Set(["class_declaration", "interface_declaration", "struct_declaration"]),
  },
  ruby: {
    defs: { method: "method", singleton_method: "method", class: "class", module: "class" },
    containers: new Set(["class", "module"]),
  },
  php: {
    defs: {
      function_definition: "function", method_declaration: "method",
      class_declaration: "class", interface_declaration: "interface", trait_declaration: "class",
      enum_declaration: "enum",
    },
    containers: new Set(["class_declaration", "interface_declaration", "trait_declaration"]),
  },
  c: {
    defs: { function_definition: "function", struct_specifier: "class", enum_specifier: "enum" },
    containers: new Set(),
  },
  cpp: {
    defs: {
      function_definition: "function", class_specifier: "class",
      struct_specifier: "class", enum_specifier: "enum",
    },
    containers: new Set(["class_specifier", "struct_specifier"]),
  },
  swift: {
    defs: { function_declaration: "function", class_declaration: "class", protocol_declaration: "interface" },
    containers: new Set(["class_declaration"]),
  },
  kotlin: {
    defs: { function_declaration: "function", class_declaration: "class", object_declaration: "class" },
    containers: new Set(["class_declaration", "object_declaration"]),
  },
  scala: {
    defs: {
      function_definition: "function", class_definition: "class",
      object_definition: "class", trait_definition: "interface",
    },
    containers: new Set(["class_definition", "object_definition", "trait_definition"]),
  },
  lua: {
    defs: { function_declaration: "function", function_definition: "function" },
    containers: new Set(),
  },
  dart: {
    defs: { class_definition: "class", method_signature: "method", function_signature: "function" },
    containers: new Set(["class_definition"]),
  },
  elixir: { defs: { call: "function" }, containers: new Set() },
  ocaml: { defs: { value_definition: "function", type_definition: "type" }, containers: new Set() },
  solidity: {
    defs: { function_definition: "function", contract_declaration: "class" },
    containers: new Set(["contract_declaration"]),
  },
  zig: { defs: { function_declaration: "function" }, containers: new Set() },
};

const NAME_NODE_TYPES = new Set([
  "identifier", "type_identifier", "field_identifier", "constant",
  "simple_identifier", "name", "word",
]);

const languages = new Map<string, Language>();
let initialized = false;

function coreDir(): { core: string; grammars: string; devModules: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "grammars");
  const devModules = path.resolve(here, "..", "..", "node_modules");
  return { core: bundled, grammars: bundled, devModules };
}

function coreWasmPath(): string {
  const { core, devModules } = coreDir();
  const bundled = path.join(core, "tree-sitter.wasm");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(devModules, "web-tree-sitter", "tree-sitter.wasm");
}

function grammarWasmPath(name: string): string | undefined {
  const { grammars, devModules } = coreDir();
  const bundled = path.join(grammars, `tree-sitter-${name}.wasm`);
  if (fs.existsSync(bundled)) return bundled;
  const dev = path.join(devModules, "tree-sitter-wasms", "out", `tree-sitter-${name}.wasm`);
  if (fs.existsSync(dev)) return dev;
  return undefined;
}

export function grammarForExt(ext: string): string | undefined {
  const name = EXT_GRAMMAR[ext];
  if (!name || !LANG_SPECS[name]) return undefined;
  return name;
}

// Preload the core runtime and grammars for the given extensions. Safe to call
// repeatedly; failures are swallowed so the caller falls back to regex indexers.
export async function initTreeSitter(exts: Iterable<string>): Promise<void> {
  const wanted = new Set<string>();
  for (const ext of exts) {
    const g = grammarForExt(ext);
    if (g) wanted.add(g);
  }
  if (wanted.size === 0) return;
  try {
    if (!initialized) {
      const core = coreWasmPath();
      await Parser.init({ locateFile: () => core });
      initialized = true;
    }
    for (const name of wanted) {
      if (languages.has(name)) continue;
      const wasm = grammarWasmPath(name);
      if (!wasm) continue;
      try {
        languages.set(name, await Language.load(wasm));
      } catch {
        // grammar failed to load; that language falls back to regex
      }
    }
  } catch {
    // tree-sitter unavailable; everything falls back to regex
  }
}

export function treeSitterReady(ext: string): boolean {
  const name = grammarForExt(ext);
  return Boolean(name && languages.has(name));
}

function nameOf(node: any): string | undefined {
  const field = node.childForFieldName?.("name");
  if (field?.text) return field.text;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && NAME_NODE_TYPES.has(c.type) && c.text) return c.text;
  }
  // one level deeper (e.g. C declarators)
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    for (let j = 0; j < c.namedChildCount; j++) {
      const g = c.namedChild(j);
      if (g && NAME_NODE_TYPES.has(g.type) && g.text) return g.text;
    }
  }
  return undefined;
}

export function treeSitterExtract(text: string, filePath: string, root: string): ExtractionResult | null {
  const ext = path.extname(filePath).toLowerCase();
  const grammar = grammarForExt(ext);
  if (!grammar) return null;
  const lang = languages.get(grammar);
  const spec = LANG_SPECS[grammar];
  if (!lang || !spec) return null;

  let tree;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    tree = parser.parse(text);
  } catch {
    return null;
  }
  if (!tree) return null;

  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const fileNode = makeFileNode(filePath, text, root);
  nodes.push(fileNode);

  const visit = (node: any, containerId: string, inContainer: boolean): void => {
    let nextContainer = containerId;
    let nextIn = inContainer;
    const kind = spec.defs[node.type];
    if (kind) {
      const name = nameOf(node);
      if (name) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const finalKind: NodeKind = kind === "function" && inContainer ? "method" : kind;
        const codeNode = makeNode(root, finalKind, name, filePath, startLine, endLine, grammar);
        nodes.push(codeNode);
        edges.push(makeEdge(containerId, codeNode.identity.stableId, "CONTAINS"));
        if (spec.containers.has(node.type)) {
          nextContainer = codeNode.identity.stableId;
          nextIn = true;
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child, nextContainer, nextIn);
    }
  };

  visit(tree.rootNode, fileNode.identity.stableId, false);
  tree.delete?.();
  return { nodes, edges };
}
