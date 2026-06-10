export const VERIFICATION = {
  UNRESOLVED: 0,
  ANNOTATION_ONLY: 1,
  PATTERN_MATCHED: 2,
  VERIFIED_STATIC: 3,
  VERIFIED_COMPILER: 4,
  VERIFIED_RUNTIME: 5,
} as const;

export type Verification = (typeof VERIFICATION)[keyof typeof VERIFICATION];

export type NodeKind =
  | "file" | "function" | "class" | "method" | "interface" | "type" | "enum"
  | "variable" | "property"
  | "route" | "db_table" | "db_column" | "event" | "config" | "package";

export type EdgeKind =
  | "CONTAINS" | "IMPORTS" | "EXPORTS"
  | "EXTENDS" | "IMPLEMENTS"
  | "REFERENCES" | "CALLS"
  | "EXPOSES_ROUTE" | "CONSUMES_ROUTE"
  | "EMITS_EVENT" | "CONSUMES_EVENT"
  | "READS_TABLE" | "WRITES_TABLE"
  | "CONSUMES_API" | "EXPOSES_API"
  | "DEPENDS_ON_PACKAGE"
  | "UNRESOLVED_CALL" | "UNRESOLVED_IMPORT"
  | "OBSERVED_CALL" | "COVERS_LINE";

export interface SymbolIdentity {
  stableId: string;
  versionHash: string;
  previousStableId?: string;
}

export interface CodeNode {
  identity: SymbolIdentity;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  language: string;
}

export interface CodeEdge {
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  verification: Verification;
  sourceMethod: string;
  metadata?: Record<string, unknown>;
}

export interface EdgeEvidence {
  id?: number;
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  verification: Verification;
  sourceMethod: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export type ContainerKind = "physical" | "feature" | "relation";
export type ContainerRole = "primary" | "related" | "utility";

export interface RelationContainer {
  id: string;
  name: string;
  kind: ContainerKind;
  entryNodeIds: string[];
  memberIds: string[];
  version: number;
  dirty: boolean;
}

export interface TraversalStep {
  edgeKinds: EdgeKind[];
  direction: "forward" | "reverse" | "both";
  maxEdgesPerNode: number;
  stopNodePatterns?: string[];
  stopAtContainerBoundary: boolean;
}

export interface TraversalPolicy {
  name: string;
  maxTokens: number;
  steps: TraversalStep[];
}

export interface ContextSlice {
  entryNodeIds: string[];
  containerId?: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  policies: TraversalPolicy[];
}
