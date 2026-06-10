import { GraphStore } from "../db.js";
import { compileSlice, POLICIES } from "../traversal.js";
import { renderSlice } from "../render.js";
import { TokenBudget } from "../budget.js";

export interface McpRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class McpServer {
  private store: GraphStore;
  private root: string;

  constructor(dbPath: string, root: string) {
    this.store = new GraphStore(dbPath);
    this.root = root;
  }

  close(): void {
    this.store.close();
  }

  handleRequest(req: McpRequest): McpResponse {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "live-context-compiler",
              version: "2.0.0",
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            tools: [
              {
                name: "compile_context",
                description:
                  "Compile a context slice for a given query. Returns relevant code nodes and edges.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Search query to find entry nodes" },
                    policy: {
                      type: "string",
                      enum: ["minimal", "function_edit", "endpoint_edit", "impact"],
                      default: "impact",
                    },
                    maxTokens: { type: "number", default: 12000 },
                  },
                  required: ["query"],
                },
              },
              {
                name: "expand_slice",
                description: "Expand a specific node in a cached slice from Tier 2 to Tier 1.",
                inputSchema: {
                  type: "object",
                  properties: {
                    nodeId: { type: "string" },
                    containerId: { type: "string" },
                  },
                  required: ["nodeId"],
                },
              },
              {
                name: "explore",
                description: "Explore the graph around a node.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    direction: {
                      type: "string",
                      enum: ["outgoing", "incoming", "both"],
                      default: "both",
                    },
                    maxDepth: { type: "number", default: 2 },
                  },
                  required: ["query"],
                },
              },
              {
                name: "search",
                description: "Search for nodes in the graph.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    limit: { type: "number", default: 20 },
                  },
                  required: ["query"],
                },
              },
              {
                name: "stats",
                description: "Show graph statistics.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        };

      case "tools/call": {
        const name = req.params?.name as string;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

        switch (name) {
          case "compile_context":
            return this.handleCompileContext(req.id, args);
          case "expand_slice":
            return this.handleExpandSlice(req.id, args);
          case "explore":
            return this.handleExplore(req.id, args);
          case "search":
            return this.handleSearch(req.id, args);
          case "stats":
            return this.handleStats(req.id);
          default:
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: `Unknown tool: ${name}` },
            };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Unknown method: ${req.method}` },
        };
    }
  }

  private handleCompileContext(id: number, args: Record<string, unknown>): McpResponse {
    const query = args.query as string;
    if (!query) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "query is required" } };
    }

    const policyName = (args.policy as string) ?? "impact";
    const maxTokens = (args.maxTokens as number) ?? 12000;
    const policy = POLICIES[policyName as keyof typeof POLICIES];

    if (!policy) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown policy: ${policyName}` } };
    }

    const nodes = this.store.findNodes(query, 5);
    if (nodes.length === 0) {
      return {
        jsonrpc: "2.0", id,
        result: { content: "No nodes found matching query.", nodes: [], edges: [] },
      };
    }

    const policyWithTokens = { ...policy, maxTokens };
    const slice = compileSlice(this.store, [nodes[0].identity.stableId], policyWithTokens);
    const rendered = renderSlice(this.root, slice, { maxTokens: policyWithTokens.maxTokens });

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: rendered,
        nodes: slice.nodes.map((n) => ({
          stableId: n.identity.stableId,
          kind: n.kind,
          name: n.name,
          filePath: n.filePath,
        })),
        edges: slice.edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, kind: e.kind })),
        stats: { nodes: slice.nodes.length, edges: slice.edges.length, tokens: TokenBudget.estimateTokens(rendered) },
      },
    };
  }

  private handleExpandSlice(id: number, args: Record<string, unknown>): McpResponse {
    const nodeId = args.nodeId as string;
    if (!nodeId) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "nodeId is required" } };
    }

    const node = this.store.getNode(nodeId);
    if (!node) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Node not found: ${nodeId}` } };
    }

    const incoming = this.store.incoming(nodeId, [
      "CALLS", "REFERENCES", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "EXPOSES_ROUTE", "CONSUMES_ROUTE", "READS_TABLE", "WRITES_TABLE", "CONTAINS",
    ]);
    const outgoing = this.store.outgoing(nodeId, [
      "CALLS", "REFERENCES", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "EXPOSES_ROUTE", "CONSUMES_ROUTE", "READS_TABLE", "WRITES_TABLE", "CONTAINS",
    ]);

    const relatedIds = new Set<string>();
    for (const e of [...incoming, ...outgoing]) {
      relatedIds.add(e.sourceId);
      relatedIds.add(e.targetId);
    }
    relatedIds.delete(nodeId);
    const relatedNodes = this.store.getNodes([...relatedIds]);

    const lines = [
      `--- Expanded: ${node.name} (${node.kind}) ---`,
      `File: ${node.filePath}:${node.startLine}-${node.endLine}`,
      `Stable ID: ${nodeId}`,
      ``,
      `Incoming edges (${incoming.length}):`,
      ...incoming.map((e) => `  ${e.kind} ← ${this.store.getNode(e.sourceId)?.name ?? e.sourceId}`),
      ``,
      `Outgoing edges (${outgoing.length}):`,
      ...outgoing.map((e) => `  ${e.kind} → ${this.store.getNode(e.targetId)?.name ?? e.targetId}`),
      ``,
      `Related nodes (${relatedNodes.length}):`,
      ...relatedNodes.map((n) => `  ${n.kind.padEnd(12)} ${n.name.padEnd(30)} ${n.filePath}`),
    ];

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: lines.join("\n"),
        node: { stableId: node.identity.stableId, kind: node.kind, name: node.name, filePath: node.filePath },
        incoming: incoming.map((e) => ({ kind: e.kind, sourceName: this.store.getNode(e.sourceId)?.name })),
        outgoing: outgoing.map((e) => ({ kind: e.kind, targetName: this.store.getNode(e.targetId)?.name })),
      },
    };
  }

  private handleSearch(id: number, args: Record<string, unknown>): McpResponse {
    const query = args.query as string;
    if (!query) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "query is required" } };
    }

    const limit = (args.limit as number) ?? 20;
    const nodes = this.store.findNodes(query, limit);

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: nodes.length === 0
          ? "No nodes found."
          : nodes.map((n, i) => `${i + 1}. [${n.kind}] ${n.name} (${n.filePath}:${n.startLine})`).join("\n"),
        nodes: nodes.map((n) => ({
          stableId: n.identity.stableId, kind: n.kind, name: n.name, filePath: n.filePath,
        })),
      },
    };
  }

  private handleExplore(id: number, args: Record<string, unknown>): McpResponse {
    const query = args.query as string;
    if (!query) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "query is required" } };
    }

    const nodes = this.store.findNodes(query, 5);
    if (nodes.length === 0) {
      return { jsonrpc: "2.0", id, result: { content: "No nodes found." } };
    }

    const node = nodes[0];
    const sid = node.identity.stableId;
    const incoming = this.store.incoming(sid, [
      "CALLS", "REFERENCES", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "CONTAINS", "EXPOSES_ROUTE", "CONSUMES_ROUTE", "READS_TABLE", "WRITES_TABLE",
    ]);
    const outgoing = this.store.outgoing(sid, [
      "CALLS", "REFERENCES", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "CONTAINS", "EXPOSES_ROUTE", "CONSUMES_ROUTE", "READS_TABLE", "WRITES_TABLE",
    ]);

    const result: Array<{
      kind: string;
      direction: "incoming" | "outgoing";
      nodeName: string | undefined;
    }> = [];
    for (const e of incoming) {
      result.push({ kind: e.kind, direction: "incoming", nodeName: this.store.getNode(e.sourceId)?.name });
    }
    for (const e of outgoing) {
      result.push({ kind: e.kind, direction: "outgoing", nodeName: this.store.getNode(e.targetId)?.name });
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: `Node: ${node.name} (${node.kind})\nConnections: ${result.length}`,
        node: { stableId: sid, kind: node.kind, name: node.name, filePath: node.filePath },
        connections: result,
      },
    };
  }

  private handleStats(id: number): McpResponse {
    const stats = this.store.getStats();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          `Files: ${stats.files}`,
          `Nodes: ${stats.nodes}`,
          `Edges: ${stats.edges}`,
          `Dirty: ${stats.dirty}`,
          `Containers: ${stats.containers}`,
          `Cache entries: ${stats.cacheEntries}`,
          `FTS5: ${stats.hasFts ? "yes" : "no"}`,
        ].join("\n"),
        ...stats,
      },
    };
  }

  start(): void {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const req = JSON.parse(trimmed) as McpRequest;
          const response = this.handleRequest(req);
          process.stdout.write(JSON.stringify(response) + "\n");
        } catch {
          // ignore
        }
      }
    });
    process.stdin.on("end", () => this.close());
  }
}
