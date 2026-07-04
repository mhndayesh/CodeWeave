import fs from "node:fs";
import path from "node:path";
import type { CodeNode, ContextSlice } from "./types.js";
import { VERIFICATION } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────

export type RenderMode = "balanced" | "source-first" | "edges-first";

export interface RenderOptions {
  maxTokens: number;
  minContextLines: number;
  renderMode?: RenderMode;
}

// ─── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: RenderOptions = {
  maxTokens: 12000,
  minContextLines: 2,
};

// Real tokenizers count source at ~3 chars/token (denser than the old chars/4 assumption),
// and stable-id/edge lines are denser still. Costing content at chars/4 -- plus charging every
// edge a flat 3 tokens while it prints a ~200-char stable-id line -- made the render emit ~15x
// its nominal budget in real tokens. Cost by actual length instead, and cap edge-line width.
const CHARS_PER_TOKEN = 3.2;
const MAX_EDGE_CHARS = 200;
const tok = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// ─── Phase budget allocation per (policy, renderMode) ──────────────────

type Phase =
  | "entrySource"
  | "entryEdges"
  | "otherSource"
  | "otherEdges"
  | "routesUnresolved";

type Allocation = Record<Phase, number>; // fractions summing to 1.0

const POLICY_ALLOCATIONS: Record<string, Allocation> = {
  minimal: {
    entrySource: 0.40,
    entryEdges: 0.20,
    otherSource: 0.20,
    otherEdges: 0.15,
    routesUnresolved: 0.05,
  },
  function_edit: {
    entrySource: 0.30,
    entryEdges: 0.10,
    otherSource: 0.45,
    otherEdges: 0.10,
    routesUnresolved: 0.05,
  },
  endpoint_edit: {
    entrySource: 0.20,
    entryEdges: 0.20,
    otherSource: 0.20,
    otherEdges: 0.30,
    routesUnresolved: 0.10,
  },
  schema_edit: {
    entrySource: 0.15,
    entryEdges: 0.15,
    otherSource: 0.15,
    otherEdges: 0.45,
    routesUnresolved: 0.10,
  },
  impact: {
    entrySource: 0.15,
    entryEdges: 0.35,
    otherSource: 0.10,
    otherEdges: 0.35,
    routesUnresolved: 0.05,
  },
};

const MODE_OVERLAY: Record<RenderMode, Allocation> = {
  "balanced": {
    entrySource: 0.30,
    entryEdges: 0.20,
    otherSource: 0.30,
    otherEdges: 0.15,
    routesUnresolved: 0.05,
  },
  "source-first": {
    entrySource: 0.40,
    entryEdges: 0.10,
    otherSource: 0.35,
    otherEdges: 0.10,
    routesUnresolved: 0.05,
  },
  "edges-first": {
    entrySource: 0.15,
    entryEdges: 0.35,
    otherSource: 0.10,
    otherEdges: 0.35,
    routesUnresolved: 0.05,
  },
};

// ─── Advisory: project-level heuristic tweaks (±) ─────────────────────

export interface ProjectProfile {
  /** Average edges-per-node ratio */
  edgeDensity: number;
  /** Average file line count */
  avgFileLines: number;
  /** Number of containers discovered */
  containerCount: number;
}

function advisoryDelta(
  profile: ProjectProfile | undefined,
): Partial<Allocation> {
  if (!profile) return {};
  const delta: Partial<Allocation> = {};

  // Dense graphs tilt toward edges
  if (profile.edgeDensity > 20) {
    delta.entryEdges = (delta.entryEdges ?? 0) + 0.05;
    delta.otherEdges = (delta.otherEdges ?? 0) + 0.05;
    delta.entrySource = (delta.entrySource ?? 0) - 0.05;
    delta.otherSource = (delta.otherSource ?? 0) - 0.05;
  }

  // Large files tilt toward source (more value per node)
  if (profile.avgFileLines > 500) {
    delta.entrySource = (delta.entrySource ?? 0) + 0.05;
    delta.otherSource = (delta.otherSource ?? 0) + 0.05;
    delta.entryEdges = (delta.entryEdges ?? 0) - 0.05;
    delta.otherEdges = (delta.otherEdges ?? 0) - 0.05;
  }

  // Many containers tilt toward entry (focus on immediate context)
  if (profile.containerCount > 30) {
    delta.entrySource = (delta.entrySource ?? 0) + 0.05;
    delta.entryEdges = (delta.entryEdges ?? 0) + 0.05;
    delta.otherSource = (delta.otherSource ?? 0) - 0.05;
    delta.otherEdges = (delta.otherEdges ?? 0) - 0.05;
  }

  return delta;
}

function computeAllocation(
  policyName: string,
  renderMode: RenderMode | undefined,
  profile: ProjectProfile | undefined,
): Allocation {
  // Start from policy base
  const base = POLICY_ALLOCATIONS[policyName] ?? POLICY_ALLOCATIONS.impact;
  // Apply renderMode overlay (takes precedence over policy)
  const mode = renderMode ? MODE_OVERLAY[renderMode] : base;
  // Apply advisory tweaks
  const delta = advisoryDelta(profile);
  const alloc = { ...mode };
  for (const [k, v] of Object.entries(delta)) {
    alloc[k as Phase] = Math.max(0.05, Math.min(0.6, (alloc[k as Phase] ?? 0) + v));
  }
  // Normalize to 1.0
  const total = Object.values(alloc).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(alloc)) {
    alloc[k as Phase] = alloc[k as Phase]! / total;
  }
  return alloc as Allocation;
}

// ─── Small-budget protection ───────────────────────────────────────────

function applySmallBudgetOverride(
  alloc: Allocation,
  maxTokens: number,
): Allocation {
  if (maxTokens >= 2000) return alloc;
  // Under 2000: tilt heavily toward entry node
  return {
    entrySource: Math.min(alloc.entrySource + 0.20, 0.50),
    entryEdges: Math.min(alloc.entryEdges + 0.10, 0.35),
    otherSource: Math.max(alloc.otherSource - 0.15, 0.05),
    otherEdges: Math.max(alloc.otherEdges - 0.10, 0.05),
    routesUnresolved: Math.max(alloc.routesUnresolved - 0.05, 0.01),
  };
}

// ─── Tier assignment ───────────────────────────────────────────────────

export type Tier = 0 | 1 | 2 | 3;

export interface TierAssignment {
  nodeId: string;
  tier: Tier;
}

export function assignTiers(
  slice: ContextSlice,
  entryNodeIds: string[],
): TierAssignment[] {
  const entrySet = new Set(entryNodeIds);
  const assignments: TierAssignment[] = [];

  for (const node of slice.nodes) {
    const sid = node.identity.stableId;
    let tier: Tier;

    if (entrySet.has(sid)) {
      tier = 0;
    } else if (
      node.kind === "file" &&
      slice.edges.some(
        (e) =>
          e.kind === "CONTAINS" &&
          (e.sourceId === sid || e.targetId === sid),
      )
    ) {
      tier = 1;
    } else if (node.kind === "function" || node.kind === "class") {
      tier = 1;
    } else {
      tier = 2;
    }

    if (tier <= 1 && node.signature && node.signature.length > 200) {
      tier = 2;
    }
    if (tier === 2 && node.kind === "file") {
      tier = 1;
    }

    assignments.push({ nodeId: sid, tier });
  }

  return assignments;
}

// ─── Main render entry point ──────────────────────────────────────────

export function renderSlice(
  root: string,
  slice: ContextSlice,
  options: Partial<RenderOptions> = {},
  profile?: ProjectProfile,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  const entrySet = new Set(slice.entryNodeIds);
  const tiers = assignTiers(slice, slice.entryNodeIds);
  const tierMap = new Map(tiers.map((t) => [t.nodeId, t.tier]));

  const alloc = computeAllocation(
    slice.policies[0]?.name ?? "impact",
    opts.renderMode,
    profile,
  );
  const finalAlloc = applySmallBudgetOverride(alloc, opts.maxTokens);

  // Compute phase budget caps
  const headerCost = 50;
  const phaseCaps: Record<Phase, number> = {
    entrySource: Math.floor((opts.maxTokens - headerCost) * finalAlloc.entrySource),
    entryEdges: Math.floor((opts.maxTokens - headerCost) * finalAlloc.entryEdges),
    otherSource: Math.floor((opts.maxTokens - headerCost) * finalAlloc.otherSource),
    otherEdges: Math.floor((opts.maxTokens - headerCost) * finalAlloc.otherEdges),
    routesUnresolved: Math.floor((opts.maxTokens - headerCost) * finalAlloc.routesUnresolved),
  };

  let globalBudget = opts.maxTokens;

  // ── Helpers ──
  const emit = (text: string, cost = 0): boolean => {
    if (cost > 0) {
      if (cost > globalBudget) return false;
      globalBudget -= cost;
    }
    lines.push(text);
    return true;
  };

  // ── Header ──
  lines.push("// Context: Slice", "");
  lines.push(`// Entry: ${slice.entryNodeIds.join(", ")}`);
  if (slice.containerId) lines.push(`// Container: ${slice.containerId}`);
  lines.push(`// Nodes: ${slice.nodes.length} | Edges: ${slice.edges.length}`);
  lines.push("");
  globalBudget -= headerCost;

  // Pre-compute sorted nodes
  const sortedNodes = [...slice.nodes]
    .filter((n) => n.startLine > 0 && n.filePath)
    .sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine,
    );

  // Pre-classify edges
  const renderEdges = slice.edges.filter(
    (e) => e.verification !== VERIFICATION.ANNOTATION_ONLY,
  );
  const entryEdges = renderEdges.filter(
    (e) => entrySet.has(e.sourceId) || entrySet.has(e.targetId),
  );
  const otherEdges = renderEdges.filter(
    (e) => !(entrySet.has(e.sourceId) || entrySet.has(e.targetId)),
  );
  const routeEdges = slice.edges.filter(
    (e) => e.kind === "EXPOSES_ROUTE" || e.kind === "CONSUMES_ROUTE",
  );
  const unresolvedEdges = renderEdges.filter(
    (e) => e.verification === VERIFICATION.UNRESOLVED,
  );

  // ─── Phase 1: Entry node source ───────────────────────────────────
  {
    let phaseBudget = phaseCaps.entrySource;
    const entryNode = sortedNodes.find((n) => entrySet.has(n.identity.stableId));
    if (entryNode && phaseBudget > 0) {
      emit("// --- Entry Source ---", 5);
      phaseBudget -= 5;
      const excerpt = readExcerpt(entryNode, root, opts.minContextLines);
      const cost = Math.min(tok(excerpt.length), phaseBudget);
      if (cost > 10) {
        emit(
          `>>> ENTRY ${entryNode.kind}: ${entryNode.qualifiedName} (${entryNode.filePath}:${entryNode.startLine}-${entryNode.endLine})`,
        );
        emit("```");
        emit(excerpt.slice(0, Math.ceil(cost * CHARS_PER_TOKEN)));
        emit("```");
        globalBudget -= cost;
      }
    }
  }

  // ─── Phase 2: Entry edges ─────────────────────────────────────────
  {
    const phaseBudget = phaseCaps.entryEdges;
    let spent = 0;
    if (entryEdges.length > 0 && spent < phaseBudget) {
      if (emit("// --- Entry Edges ---", 5)) spent += 5;
      for (const edge of entryEdges) {
        if (spent >= phaseBudget) {
          emit(`// [entry edges truncated, ${entryEdges.length - entryEdges.indexOf(edge)} remaining]`);
          break;
        }
        const meta = edge.metadata ? ` ${JSON.stringify(edge.metadata)}` : "";
        let text = `// ${edge.sourceId} --[${edge.kind}]--> ${edge.targetId} [${edge.verification}]${meta}`;
        if (text.length > MAX_EDGE_CHARS) text = text.slice(0, MAX_EDGE_CHARS) + " ...";
        const cost = Math.max(3, tok(text.length));
        if (spent + cost <= phaseBudget) {
          emit(text);
          spent += cost;
          globalBudget -= cost;
        } else {
          emit(`// [entry edges truncated, ${entryEdges.length - entryEdges.indexOf(edge)} remaining]`);
          break;
        }
      }
    }
  }

  // ─── Phase 3: Other source nodes ──────────────────────────────────
  {
    let phaseBudget = phaseCaps.otherSource;
    if (emit("// --- Source ---", 5)) phaseBudget -= 5;
    for (const node of sortedNodes) {
      const sid = node.identity.stableId;
      const tier = tierMap.get(sid) ?? 2;
      if (entrySet.has(sid) || tier >= 3) continue;
      if (phaseBudget <= 0) {
        emit(`// [budget exhausted, skipping ${sortedNodes.length - sortedNodes.indexOf(node)} remaining nodes]`);
        break;
      }

      const excerpt = readExcerpt(node, root, tier <= 1 ? opts.minContextLines : 0);
      const excerptTokens = tok(excerpt.length);

      if (tier <= 1) {
        const cost = Math.min(excerptTokens, phaseBudget);
        if (cost < 10) continue;
        emit(`>>> ${node.kind}: ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
        emit("```");
        emit(excerpt.slice(0, Math.ceil(cost * CHARS_PER_TOKEN)));
        emit("```");
        phaseBudget -= cost;
        globalBudget -= cost;
      } else if (node.signature) {
        const sigTokens = tok(node.signature.length);
        if (sigTokens <= phaseBudget) {
          emit(`// SIG ${node.kind}: ${node.qualifiedName} (${node.filePath}:${node.startLine})`);
          emit(`// ${node.signature}`);
          phaseBudget -= sigTokens;
          globalBudget -= sigTokens;
        }
      }
    }
  }

  // ─── Phase 4: Other edges ─────────────────────────────────────────
  {
    const phaseBudget = phaseCaps.otherEdges;
    let spent = 0;
    if (otherEdges.length > 0 && spent < phaseBudget) {
      if (emit("// --- Other Edges ---", 5)) spent += 5;
      for (const edge of otherEdges) {
        if (spent >= phaseBudget) {
          emit(`// [other edges truncated, ${otherEdges.length - otherEdges.indexOf(edge)} remaining]`);
          break;
        }
        const meta = edge.metadata ? ` ${JSON.stringify(edge.metadata)}` : "";
        let text = `// ${edge.sourceId} --[${edge.kind}]--> ${edge.targetId} [${edge.verification}]${meta}`;
        if (text.length > MAX_EDGE_CHARS) text = text.slice(0, MAX_EDGE_CHARS) + " ...";
        const cost = Math.max(3, tok(text.length));
        if (spent + cost <= phaseBudget) {
          emit(text);
          spent += cost;
          globalBudget -= cost;
        } else {
          emit(`// [other edges truncated, ${otherEdges.length - otherEdges.indexOf(edge)} remaining]`);
          break;
        }
      }
    }
  }

  // ─── Phase 5: Routes + Unresolved ─────────────────────────────────
  {
    let phaseBudget = phaseCaps.routesUnresolved;
    if (routeEdges.length > 0 && emit("// --- Routes ---", 5)) {
      phaseBudget -= 5;
      for (const edge of routeEdges) {
        if (phaseBudget <= 0) break;
        const cost = 2;
        emit(`// ${edge.sourceId} --${edge.kind}--> ${edge.targetId}`);
        phaseBudget -= cost;
        globalBudget -= cost;
      }
    }
    if (unresolvedEdges.length > 0 && emit("// --- Unresolved ---", 5)) {
      phaseBudget -= 5;
      for (const edge of unresolvedEdges) {
        if (phaseBudget <= 0) break;
        const cost = 2;
        emit(`// ${edge.sourceId} -> ${edge.targetId}`);
        phaseBudget -= cost;
        globalBudget -= cost;
      }
    }
  }

  if (globalBudget < 0) {
    emit(`// [token budget exceeded by ${Math.abs(globalBudget)} tokens]`);
  }

  return lines.join("\n");
}

// ─── Helpers ───────────────────────────────────────────────────────────

function readExcerpt(node: CodeNode, root: string, contextLines: number): string {
  const abs = path.join(root, node.filePath);
  if (!fs.existsSync(abs)) return "";
  const sourceLines = fs.readFileSync(abs, "utf8").split("\n");
  const from = Math.max(0, node.startLine - 1 - contextLines);
  const to = Math.min(sourceLines.length, node.endLine + contextLines);
  return sourceLines.slice(from, to).join("\n");
}
