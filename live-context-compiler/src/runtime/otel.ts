import fs from "node:fs";
import fg from "fast-glob";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import { VERIFICATION } from "../types.js";

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  attributes?: Record<string, string>;
  startTime: string;
  endTime: string;
  status?: { code: string; message?: string };
}

export interface OtelTrace {
  resourceSpans: Array<{
    resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans: Array<{
      scope?: { name: string };
      spans: OtelSpan[];
    }>;
  }>;
}

export class OtelImporter {
  private store: GraphStore;
  private root: string;

  constructor(store: GraphStore, root: string) {
    this.store = store;
    this.root = root;
  }

  importFromFile(filePath: string): void {
    const text = fs.readFileSync(filePath, "utf8");
    const trace: OtelTrace = JSON.parse(text);
    this.import(trace);
  }

  import(trace: OtelTrace): void {
    for (const rs of trace.resourceSpans) {
      const serviceName = rs.resource?.attributes?.find(
        (a) => a.key === "service.name",
      )?.value?.stringValue ?? "unknown";

      for (const ss of rs.scopeSpans) {
        const scopeName = ss.scope?.name ?? "unknown";

        for (const span of ss.spans) {
          const spanQName = `otel:${serviceName}:${span.name}:${span.traceId.slice(0, 8)}`;
          const spanId = stableId(this.root, "ts", spanQName);

          this.store.upsertNode({
            identity: { stableId: spanId, versionHash: versionHash(span.name) },
            kind: "function",
            name: span.name,
            qualifiedName: spanQName,
            filePath: `otel://${serviceName}`,
            startLine: 0,
            endLine: 0,
            language: "otel",
          });

          if (span.parentSpanId) {
            const parentQName = `otel:${serviceName}:parent:${span.parentSpanId}`;
            const parentId = stableId(this.root, "ts", parentQName);
            this.store.upsertEdge({
              sourceId: spanId,
              targetId: parentId,
              kind: "REFERENCES",
              verification: VERIFICATION.VERIFIED_RUNTIME,
              sourceMethod: "otel-trace",
              metadata: {
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                duration: span.endTime,
                service: serviceName,
                scope: scopeName,
              },
            });
          }

          const attrs = span.attributes ?? {};
          const codeFile = attrs["code.filepath"] ?? attrs["code.function"];
          if (codeFile) {
            const callTargetQName = `function:${codeFile}:${span.name}`;
            const callTargetId = stableId(this.root, "ts", callTargetQName);
            this.store.upsertEdge({
              sourceId: spanId,
              targetId: callTargetId,
              kind: "OBSERVED_CALL",
              verification: VERIFICATION.VERIFIED_RUNTIME,
              sourceMethod: "otel-trace",
              metadata: {
                traceId: span.traceId,
                spanId: span.spanId,
                service: serviceName,
                codeFile,
              },
            });
          }
        }
      }
    }
  }

  findFromDirectory(pattern = "**/.otel-traces/*.json"): void {
    const files = fg.sync([pattern], {
      cwd: this.root,
      absolute: true,
      ignore: ["**/node_modules/**"],
    });
    for (const file of files) {
      this.importFromFile(file);
    }
  }
}
