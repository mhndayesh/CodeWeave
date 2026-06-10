import { GraphStore } from "../db.js";
import { ExpressBridge } from "./express.js";
import { FastifyBridge } from "./fastify.js";
import { NextBridge } from "./next.js";
import { OpenApiBridge } from "./openapi.js";
import { PrismaBridge } from "./prisma.js";
import { DrizzleBridge } from "./drizzle.js";
import { SqlBridge } from "./sql.js";
import { EventsBridge } from "./events.js";
import { GenericBridge } from "./generic.js";
import { GraphqlBridge } from "./graphql.js";
import { EnvBridge } from "./env.js";
import type { SourceFile } from "typescript";
import type { ContractBridge } from "./types.js";

const bridges: ContractBridge[] = [
  new ExpressBridge(),
  new FastifyBridge(),
  new NextBridge(),
  new DrizzleBridge(),
  new EventsBridge(),
  new GenericBridge(),
  new EnvBridge(),
];

const fullScanBridges = [
  new OpenApiBridge(),
  new PrismaBridge(),
  new SqlBridge(),
  new GraphqlBridge(),
];

export function runContractBridges(
  store: GraphStore,
  filePath: string,
  text: string,
  source: SourceFile,
  fileNodeId: string,
  root: string,
): void {
  for (const bridge of bridges) {
    if (bridge.handlesFile(filePath)) {
      bridge.extract(store, filePath, text, source, fileNodeId, root);
    }
  }
}

export function runContractFullScans(store: GraphStore, root: string): void {
  for (const bridge of fullScanBridges) {
    if (bridge instanceof OpenApiBridge) {
      bridge.extractAll(store, root);
    } else if (bridge instanceof PrismaBridge) {
      bridge.extractAll(store, root);
    } else if (bridge instanceof SqlBridge) {
      bridge.extractAll(store, root);
    } else if (bridge instanceof GraphqlBridge) {
      bridge.extractAll(store, root);
    }
  }
}
