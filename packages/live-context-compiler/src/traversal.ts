import { GraphStore } from "./db.js";
import type {
  CodeEdge,
  CodeNode,
  ContextSlice,
  EdgeKind,
  TraversalPolicy,
  TraversalStep,
} from "./types.js";

export const POLICIES: Record<string, TraversalPolicy> = {
  schema_edit: {
    name: "schema_edit",
    maxTokens: 8000,
    steps: [
      {
        edgeKinds: ["CONTAINS"],
        direction: "reverse",
        maxEdgesPerNode: 1,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["READS_TABLE", "WRITES_TABLE"],
        direction: "forward",
        maxEdgesPerNode: 20,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["CALLS", "REFERENCES"],
        direction: "both",
        maxEdgesPerNode: 15,
        stopAtContainerBoundary: true,
      },
      {
        edgeKinds: ["CALLS", "REFERENCES"],
        direction: "reverse",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: true,
      },
    ],
  },
  function_edit: {
    name: "function_edit",
    maxTokens: 8000,
    steps: [
      {
        edgeKinds: ["CONTAINS"],
        direction: "reverse",
        maxEdgesPerNode: 1,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["CONTAINS", "CALLS", "REFERENCES"],
        direction: "forward",
        maxEdgesPerNode: 20,
        stopNodePatterns: ["^console$", "^logger$"],
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["IMPORTS", "EXPORTS"],
        direction: "both",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["CALLS", "REFERENCES"],
        direction: "reverse",
        maxEdgesPerNode: 15,
        stopNodePatterns: ["^test", "spec$"],
        stopAtContainerBoundary: false,
      },
    ],
  },
  endpoint_edit: {
    name: "endpoint_edit",
    maxTokens: 12000,
    steps: [
      {
        edgeKinds: ["CONTAINS"],
        direction: "reverse",
        maxEdgesPerNode: 1,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["EXPOSES_ROUTE", "CONSUMES_ROUTE"],
        direction: "both",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["CONTAINS", "CALLS", "REFERENCES"],
        direction: "forward",
        maxEdgesPerNode: 20,
        stopNodePatterns: ["^console$", "^logger$"],
        stopAtContainerBoundary: true,
      },
      {
        edgeKinds: ["READS_TABLE", "WRITES_TABLE"],
        direction: "forward",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: true,
      },
      {
        edgeKinds: ["IMPORTS", "EXPORTS"],
        direction: "both",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: true,
      },
    ],
  },
  impact: {
    name: "impact",
    maxTokens: 16000,
    steps: [
      {
        edgeKinds: ["CONTAINS"],
        direction: "reverse",
        maxEdgesPerNode: 1,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: [
          "CALLS",
          "REFERENCES",
          "IMPORTS",
          "EXPORTS",
        ],
        direction: "both",
        maxEdgesPerNode: 25,
        stopNodePatterns: ["^console$", "^logger$", "^_"],
        stopAtContainerBoundary: true,
      },
      {
        edgeKinds: [
          "EXPOSES_ROUTE",
          "CONSUMES_ROUTE",
          "READS_TABLE",
          "WRITES_TABLE",
        ],
        direction: "forward",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["EXTENDS", "IMPLEMENTS"],
        direction: "both",
        maxEdgesPerNode: 10,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["UNRESOLVED_CALL", "UNRESOLVED_IMPORT"],
        direction: "forward",
        maxEdgesPerNode: 5,
        stopAtContainerBoundary: true,
      },
    ],
  },
  minimal: {
    name: "minimal",
    maxTokens: 4000,
    steps: [
      {
        edgeKinds: ["CONTAINS"],
        direction: "reverse",
        maxEdgesPerNode: 1,
        stopAtContainerBoundary: false,
      },
      {
        edgeKinds: ["CONTAINS", "CALLS", "REFERENCES", "IMPORTS"],
        direction: "forward",
        maxEdgesPerNode: 10,
        stopNodePatterns: ["^console$", "^logger$", "^_"],
        stopAtContainerBoundary: true,
      },
    ],
  },
};

export function compileSlice(
  store: GraphStore,
  entryNodeIds: string[],
  policy: TraversalPolicy,
): ContextSlice {
  const seen = new Set<string>(entryNodeIds);
  const allEdges: CodeEdge[] = [];

  for (const step of policy.steps) {
    const stepResult = executeStep(store, seen, step);
    allEdges.push(...stepResult);
  }

  const edgeMap = new Map<string, CodeEdge>();
  for (const edge of allEdges) {
    const key = `${edge.sourceId}|${edge.targetId}|${edge.kind}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, edge);
    }
  }
  const uniqueEdges = [...edgeMap.values()];

  const nodes = store.getNodes([...seen]);

  return {
    entryNodeIds,
    nodes,
    edges: uniqueEdges,
    policies: [policy],
  };
}

function executeStep(
  store: GraphStore,
  seen: Set<string>,
  step: TraversalStep,
): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const queue = [...seen].map((id) => ({ id }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const stopPatterns = step.stopNodePatterns ?? [];
    const node = store.getNode(current.id);
    if (node && stopPatterns.some((p) => new RegExp(p).test(node.name))) {
      continue;
    }

    let candidates: CodeEdge[] = [];
    if (step.direction === "forward" || step.direction === "both") {
      candidates.push(...store.outgoing(current.id, step.edgeKinds));
    }
    if (step.direction === "reverse" || step.direction === "both") {
      candidates.push(...store.incoming(current.id, step.edgeKinds));
    }

    if (candidates.length > step.maxEdgesPerNode) {
      candidates = candidates.slice(0, step.maxEdgesPerNode);
    }

    for (const edge of candidates) {
      edges.push(edge);

      const neighborId =
        edge.sourceId === current.id ? edge.targetId : edge.sourceId;

      if (!seen.has(neighborId)) {
        seen.add(neighborId);
        queue.push({ id: neighborId });
      }
    }
  }

  return edges;
}

export function estimateTokenCount(slice: ContextSlice): number {
  let tokens = 0;
  for (const node of slice.nodes) {
    tokens += node.name.length * 0.25;
    tokens += (node.signature?.length ?? 0) * 0.25;
    tokens += 5;
  }
  for (const edge of slice.edges) {
    tokens += edge.sourceId.length * 0.25;
    tokens += edge.targetId.length * 0.25;
    tokens += edge.kind.length * 0.25;
    tokens += 2;
  }
  return Math.ceil(tokens);
}
