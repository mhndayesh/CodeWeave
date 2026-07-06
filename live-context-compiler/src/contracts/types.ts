import type { GraphStore } from "../db.js";
import type { SourceFile } from "typescript";

export interface RouteInfo {
  method: string;
  path: string;
  handlerName?: string;
  handlerFile?: string;
  middleware?: string[];
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  relation?: { model: string; field: string };
}

export interface SchemaModel {
  name: string;
  table?: string;
  fields: SchemaField[];
  indexes?: string[];
}

export interface ApiEndpoint {
  path: string;
  method: string;
  requestType?: string;
  responseType?: string;
  parameters?: string[];
}

export interface EventInfo {
  eventName: string;
  direction: "emits" | "consumes";
  payloadType?: string;
  handlerName?: string;
}

export interface SqlTable {
  name: string;
  columns: Array<{ name: string; type: string; constraints: string[] }>;
  indexes: Array<{ name: string; columns: string[] }>;
}

export interface ContractExtractResult {
  routes: RouteInfo[];
  schemas: SchemaModel[];
  events: EventInfo[];
  apis: ApiEndpoint[];
  tables: SqlTable[];
}

export interface ContractBridge {
  name: string;
  handlesFile(filePath: string): boolean;
  extract(
    store: GraphStore,
    filePath: string,
    text: string,
    source: SourceFile,
    fileNodeId: string,
    root: string,
  ): ContractExtractResult;
}
