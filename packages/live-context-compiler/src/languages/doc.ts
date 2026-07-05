import type { CodeNode, CodeEdge } from "../types.js";
import type { ExtractionResult, LanguageIndexer } from "./base.js";
import { makeFileNode } from "./base.js";

// Documentation files carry the *design intent* the code never states — architecture
// notes, "where to find X", the why behind a module. The code graph indexes them as
// file nodes so a phrase query ("how auth works") can surface the doc that explains it,
// and so the renderer can attach the nearest project doc to a slice. Doc prose is not
// scanned for symbol references: a name mentioned in prose is a mention, not a call.

const MAX_BYTES = 1024 * 1024;

export const DOC_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".rst", ".adoc", ".asciidoc",
]);

// Filenames that describe a directory/package, most-specific intent first. Used when
// attaching the "nearest doc" to a rendered slice.
export const DOC_FILENAMES = [
  "AGENTS.md", "CLAUDE.md", "CONTEXT.md", "ARCHITECTURE.md",
  "README.md", "readme.md", "README.mdx", "index.md", "README.rst",
];

export class DocIndexer implements LanguageIndexer {
  language = "doc";
  extensions = [...DOC_EXTENSIONS];

  extract(text: string, filePath: string, root: string): ExtractionResult {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNode = makeFileNode(filePath, text, root);
    if (text.length <= MAX_BYTES) {
      const { summary, headings } = parseDocFile(text);
      if (summary) fileNode.doc = summary;
      // Heading trail lands in `signature`, which is FTS-indexed, so a query matches a
      // section title even when the word never appears in code.
      if (headings) fileNode.signature = headings;
    }
    nodes.push(fileNode);
    return { nodes, edges };
  }
}

/**
 * Pull a short summary (title — first paragraph) and a heading trail out of a markdown
 * / reStructuredText / AsciiDoc file. Best-effort and format-tolerant.
 */
export function parseDocFile(text: string): { summary?: string; headings?: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings: string[] = [];
  let title: string | undefined;
  let intro: string | undefined;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // ATX heading: #, ##, … / AsciiDoc: =, ==, …
    const atx = /^(#{1,6}|={1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      const h = atx[2].trim();
      headings.push(h);
      if (atx[1].length === 1 && !title) title = h;
      continue;
    }

    // Setext (markdown) / underline (rst): a text line followed by a rule of =, -, ~, ^.
    const next = lines[i + 1];
    if (
      line.trim() &&
      next &&
      /^[=\-~^"'#*]{3,}\s*$/.test(next) &&
      !/^[=\-~^"'#*]/.test(line.trim())
    ) {
      const h = line.trim();
      headings.push(h);
      if (!title) title = h;
      i++; // consume the underline
      continue;
    }

    // First prose paragraph — skip badges, HTML, images, blockquotes, lists, link refs.
    if (!intro && line.trim() && !/^\s*(<|!\[|\[!|\[[^\]]*\]:|[>|*+\-]|\d+\.|---|===|\.\.)/.test(line)) {
      const para: string[] = [];
      for (let j = i; j < lines.length && lines[j].trim() && !/^\s*(#{1,6}|={1,6})\s/.test(lines[j]); j++) {
        para.push(lines[j].trim());
      }
      intro = cleanInline(para.join(" "));
    }
  }

  const summary = buildSummary(title, intro);
  const dedup = [...new Set(headings.map((h) => cleanInline(h)).filter(Boolean))];
  const headingTrail = dedup.length ? dedup.join(" · ").slice(0, 500) : undefined;
  return { summary, headings: headingTrail };
}

function buildSummary(title?: string, intro?: string): string | undefined {
  const t = title ? cleanInline(title) : undefined;
  let s: string | undefined;
  if (t && intro) s = `${t} — ${intro}`;
  else s = t ?? intro;
  if (!s) return undefined;
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 300) s = s.slice(0, 300).replace(/\s+\S*$/, "").trim() + "…";
  return s || undefined;
}

// Strip the common inline markup so the stored summary reads as plain prose.
function cleanInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) / ![alt](src) -> text
    .replace(/[`*_~]+/g, "") // emphasis / code ticks
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
