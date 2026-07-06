import { GraphStore } from "./db.js";
import type { CodeEdge, CodeNode, ContextSlice, TraversalPolicy } from "./types.js";

export interface CacheOptions {
  maxAgeMs?: number;
}

export class SliceCache {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  cacheKey(
    containerId: string,
    policyName: string,
    entryNodeIds: string[],
  ): string {
    const sorted = [...entryNodeIds].sort().join(",");
    return `${containerId}::${policyName}::${sorted}`;
  }

  getCachedSlice(
    containerId: string,
    policyName: string,
    entryNodeIds: string[],
  ): ContextSlice | undefined {
    const key = this.cacheKey(containerId, policyName, entryNodeIds);

    const cached = this.store.getCachedSlice(key);
    if (!cached) return undefined;

    const container = this.store.getContainer(containerId);
    if (!container) return undefined;

    if (container.dirty || cached.version < container.version) {
      this.store.invalidateSliceCache(containerId);
      return undefined;
    }

    const nodes = this.store.getNodes(cached.nodeIds);
    if (nodes.length !== cached.nodeIds.length) {
      this.store.invalidateSliceCache(containerId);
      return undefined;
    }

    return {
      entryNodeIds: cached.entryNodeIds,
      containerId,
      nodes,
      edges: [],
      policies: [],
    };
  }

  setCachedSlice(
    containerId: string,
    policy: TraversalPolicy,
    entryNodeIds: string[],
    slice: ContextSlice,
  ): void {
    const key = this.cacheKey(containerId, policy.name, entryNodeIds);
    const container = this.store.getContainer(containerId);
    if (!container) return;

    this.store.setCachedSlice(
      key,
      containerId,
      policy.name,
      entryNodeIds,
      slice.nodes.map((n) => n.identity.stableId),
      slice.edges.map((e) => `${e.sourceId}|${e.targetId}|${e.kind}`),
      container.version,
      slice.nodes.length + slice.edges.length,
    );
  }

  invalidateForContainer(containerId: string): void {
    this.store.invalidateSliceCache(containerId);
  }

  invalidateAll(): void {
    this.store.clearSliceCache();
  }
}
