import fs from "node:fs";
import { VERIFICATION } from "../types.js";
import path from "node:path";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, ApiEndpoint, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

export class OpenApiBridge implements ContractBridge {
  name = "openapi";

  handlesFile(filePath: string): boolean {
    const n = filePath.toLowerCase();
    return (
      n.endsWith(".yaml") ||
      n.endsWith(".yml") ||
      n.endsWith(".json")
    );
  }

  private extractEndpointsFromSpec(spec: Record<string, unknown>): ApiEndpoint[] {
    const endpoints: ApiEndpoint[] = [];
    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
    if (!paths) return endpoints;

    for (const [pathStr, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== "object") continue;
      for (const [method, details] of Object.entries(methods)) {
        if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
          const d = details as Record<string, unknown>;
          endpoints.push({
            path: pathStr,
            method: method.toUpperCase(),
            requestType: (d.requestBody as Record<string, unknown>)?.content
              ? "application/json"
              : undefined,
            responseType: (d.responses as Record<string, unknown>)?.["200"]
              ? "application/json"
              : undefined,
            parameters: (d.parameters as Array<{ name: string }>)?.map(
              (p: { name: string }) => p.name,
            ),
          });
        }
      }
    }
    return endpoints;
  }

  extractAll(store: GraphStore, root: string): { routes: RouteInfo[]; apis: ApiEndpoint[] } {
    const routes: RouteInfo[] = [];
    const apis: ApiEndpoint[] = [];

    const files = fg.sync(["**/*.yaml", "**/*.yml", "**/*.json"], {
      cwd: root,
      ignore: ["**/node_modules/**"],
      absolute: true,
    });

    for (const file of files) {
      try {
        const text = fs.readFileSync(file, "utf8").trim();
        if (!text.startsWith("{") && !text.startsWith("openapi") && !text.startsWith("swagger")) continue;

        let spec: Record<string, unknown>;
        if (file.endsWith(".json")) {
          spec = JSON.parse(text);
        } else {
          continue;
        }

        const endpoints = this.extractEndpointsFromSpec(spec);
        apis.push(...endpoints);

        const rel = path.relative(root, file).replaceAll("\\", "/");
        const fileQName = `file:${rel}`;
        const fileNodeId = stableId(root, "ts", fileQName);

        const info = spec.info as Record<string, unknown> | undefined;
        const title = (info?.title as string) || rel;

        store.upsertNode({
          identity: {
            stableId: stableId(root, "ts", `openapi:${title}`),
            versionHash: versionHash(text),
          },
          kind: "config",
          name: title,
          qualifiedName: `openapi:${title}`,
          filePath: rel,
          startLine: 0,
          endLine: 0,
          language: "yaml",
        });

        for (const ep of endpoints) {
          const routeName = `${ep.method} ${ep.path}`;
          const qName = `route:${routeName}`;
          const sid = stableId(root, "ts", qName);
          store.upsertNode({
            identity: { stableId: sid, versionHash: versionHash(routeName) },
            kind: "route",
            name: routeName,
            qualifiedName: qName,
            filePath: rel,
            startLine: 0,
            endLine: 0,
            language: "yaml",
          });
          store.upsertEdge({
            sourceId: fileNodeId,
            targetId: sid,
            kind: "EXPOSES_API",
            verification: VERIFICATION.VERIFIED_STATIC,
            sourceMethod: "openapi-bridge",
            metadata: {
              method: ep.method,
              path: ep.path,
              requestType: ep.requestType,
              responseType: ep.responseType,
            },
          });

          routes.push({ method: ep.method, path: ep.path });
        }
      } catch {
        // skip unparseable
      }
    }

    return { routes, apis };
  }

  extract(): { routes: []; schemas: []; events: []; apis: []; tables: [] } {
    return { routes: [], schemas: [], events: [], apis: [], tables: [] };
  }
}
