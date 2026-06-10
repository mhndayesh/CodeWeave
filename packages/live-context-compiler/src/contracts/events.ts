import ts from "typescript";
import { VERIFICATION } from "../types.js";
import { GraphStore } from "../db.js";
import { stableId, versionHash } from "../hash.js";
import type { ContractBridge, EventInfo, RouteInfo } from "./types.js";
import type { SourceFile } from "typescript";

const EMIT_PATTERNS = [
  "emit", "publish", "send", "dispatch",
  "EventBus.emit", "EventBus.publish",
  "eventEmitter.emit", "eventEmitter.publish",
  "rabbit.publish", "kafka.send", "kafka.produce",
  "queue.send", "queue.publish",
  "pubsub.publish", "topic.publish",
];

const CONSUME_PATTERNS = [
  "on", "subscribe", "listen", "consume",
  "EventBus.on", "EventBus.subscribe",
  "eventEmitter.on", "eventEmitter.addListener",
  "rabbit.consume", "kafka.consume", "kafka.subscribe",
  "queue.consume", "queue.subscribe",
  "pubsub.subscribe", "topic.subscribe",
];

export class EventsBridge implements ContractBridge {
  name = "events";

  handlesFile(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx)$/.test(filePath);
  }

  extract(
    store: GraphStore,
    filePath: string,
    text: string,
    source: SourceFile,
    fileNodeId: string,
    root: string,
  ): { routes: RouteInfo[]; schemas: []; events: EventInfo[]; apis: []; tables: [] } {
    const events: EventInfo[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        let exprText: string;

        if (ts.isPropertyAccessExpression(node.expression)) {
          exprText = `${node.expression.expression.getText(source)}.${node.expression.name.text}`;
        } else if (ts.isIdentifier(node.expression)) {
          exprText = node.expression.text;
        } else {
          ts.forEachChild(node, visit);
          return;
        }

        if (node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
          const eventName = node.arguments[0].text;

          const isEmit = EMIT_PATTERNS.some((p) => {
            if (p.includes(".")) {
              return exprText === p ||
                exprText.endsWith("." + p.split(".").pop());
            }
            return exprText === p || exprText.endsWith("." + p);
          });

          if (isEmit) {
            events.push({
              eventName,
              direction: "emits",
              payloadType: node.arguments[1]
                ? node.arguments[1].getText(source)
                : undefined,
            });

            const qName = `event:${eventName}`;
            const sid = stableId(root, "ts", qName);
            store.upsertNode({
              identity: { stableId: sid, versionHash: versionHash(eventName) },
              kind: "event",
              name: eventName,
              qualifiedName: qName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: "ts",
            });
            store.upsertEdge({
              sourceId: fileNodeId,
              targetId: sid,
              kind: "EMITS_EVENT",
              verification: VERIFICATION.VERIFIED_STATIC,
              sourceMethod: "events-bridge",
              metadata: { event: eventName, pattern: exprText },
            });
          }

          const isConsume = CONSUME_PATTERNS.some((p) => {
            if (p.includes(".")) {
              return exprText === p ||
                exprText.endsWith("." + p.split(".").pop());
            }
            return exprText === p || exprText.endsWith("." + p);
          });

          if (isConsume) {
            events.push({
              eventName,
              direction: "consumes",
              handlerName: node.arguments[1]
                ? node.arguments[1].getText(source)
                : undefined,
            });

            const qName = `event:${eventName}`;
            const sid = stableId(root, "ts", qName);
            store.upsertNode({
              identity: { stableId: sid, versionHash: versionHash(eventName) },
              kind: "event",
              name: eventName,
              qualifiedName: qName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: "ts",
            });
            store.upsertEdge({
              sourceId: fileNodeId,
              targetId: sid,
              kind: "CONSUMES_EVENT",
              verification: VERIFICATION.VERIFIED_STATIC,
              sourceMethod: "events-bridge",
              metadata: { event: eventName, pattern: exprText },
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
    return { routes: [], schemas: [], events, apis: [], tables: [] };
  }
}
