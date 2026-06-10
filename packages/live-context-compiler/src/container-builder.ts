import fs from "node:fs";
import path from "node:path";
import { GraphStore } from "./db.js";
import { stableId } from "./hash.js";
import type { ContainerKind, RelationContainer } from "./types.js";

export interface ContainerDiscoveryConfig {
  root: string;
  store: GraphStore;
  ignorePatterns?: string[];
}

export interface DiscoveredContainer {
  id: string;
  name: string;
  kind: ContainerKind;
  filePatterns: string[];
  entryFiles?: string[];
}

export class ContainerBuilder {
  private config: ContainerDiscoveryConfig;

  constructor(config: ContainerDiscoveryConfig) {
    this.config = config;
  }

  buildAll(): RelationContainer[] {
    const discovered = this.discoverContainers();
    const containers: RelationContainer[] = [];

    for (const dc of discovered) {
      const container = this.buildContainer(dc);
      containers.push(container);
    }

    return containers;
  }

  private discoverContainers(): DiscoveredContainer[] {
    const result: DiscoveredContainer[] = [];
    const seenPaths = new Set<string>();

    const workspaceCandidates = this.findWorkspacePackages();
    for (const wc of workspaceCandidates) {
      const id = this.containerId("physical", wc.name);
      result.push({
        id,
        name: wc.name,
        kind: "physical",
        filePatterns: [`${wc.relativePath}/**/*.ts`, `${wc.relativePath}/**/*.tsx`],
        entryFiles: wc.entryFiles,
      });
      seenPaths.add(wc.relativePath);
    }

    const tsconfigCandidates = this.findTsconfigRoots();
    for (const tc of tsconfigCandidates) {
      if (seenPaths.has(tc.relativePath)) continue;
      const name = tc.relativePath.replace(/\//g, "-") || "root";
      const id = this.containerId("physical", name);
      result.push({
        id,
        name,
        kind: "physical",
        filePatterns: [`${tc.relativePath}/**/*.ts`, `${tc.relativePath}/**/*.tsx`],
      });
      seenPaths.add(tc.relativePath);
    }

    const serviceDirs = this.findServiceDirectories();
    for (const sd of serviceDirs) {
      if (seenPaths.has(sd.relativePath)) continue;
      const id = this.containerId("physical", sd.name);
      result.push({
        id,
        name: sd.name,
        kind: "physical",
        filePatterns: [`${sd.relativePath}/**/*.ts`, `${sd.relativePath}/**/*.tsx`],
      });
      seenPaths.add(sd.relativePath);
    }

    const remaining = this.findRemainingTopLevel();
    for (const r of remaining) {
      if (seenPaths.has(r.relativePath)) continue;
      const id = this.containerId("physical", r.name);
      result.push({
        id,
        name: r.name,
        kind: "physical",
        filePatterns: [`${r.relativePath}/**/*.ts`, `${r.relativePath}/**/*.tsx`],
      });
      seenPaths.add(r.relativePath);
    }

    this.buildAutoContainers(result, seenPaths);

    return result;
  }

  private findWorkspacePackages(): Array<{
    name: string;
    relativePath: string;
    entryFiles: string[];
  }> {
    const results: Array<{ name: string; relativePath: string; entryFiles: string[] }> = [];
    const rootPkg = path.join(this.config.root, "package.json");

    if (!fs.existsSync(rootPkg)) return results;

    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf8"));
      const workspaces: string[] = pkg.workspaces ?? [];

      for (const pattern of workspaces) {
        const globPattern = pattern.replace(/\*$/g, "");
        const abs = path.join(this.config.root, globPattern);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          let workspaceEntries: string[] = [];
          try { workspaceEntries = fs.readdirSync(abs); } catch { continue; }
          for (const entry of workspaceEntries) {
            const pkgPath = path.join(abs, entry, "package.json");
            if (fs.existsSync(pkgPath)) {
              try {
                const subPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                const rel = path.relative(this.config.root, path.join(abs, entry)).replaceAll("\\", "/");
                const entryFiles: string[] = [];
                if (subPkg.main) {
                  const mainPath = path.join(abs, entry, subPkg.main);
                  const relMain = path.relative(this.config.root, mainPath).replaceAll("\\", "/");
                  entryFiles.push(relMain);
                }
                results.push({ name: subPkg.name || entry, relativePath: rel, entryFiles });
              } catch {
                // skip invalid package.json
              }
            }
          }
        }
      }
    } catch {
      // skip invalid root package.json
    }

    return results;
  }

  private findTsconfigRoots(): Array<{ name: string; relativePath: string }> {
    const results: Array<{ name: string; relativePath: string }> = [];
    this.collectTsconfigs(this.config.root, results, new Set());
    return results;
  }

  private shouldIgnore(name: string): boolean {
    if (!this.config.ignorePatterns) return false;
    for (const pattern of this.config.ignorePatterns) {
      const stripped = pattern.replace(/^\*\*\/|(?:\/\*\*)?$/g, "");
      if (name === stripped || name.endsWith("/" + stripped)) return true;
    }
    return false;
  }

  private collectTsconfigs(
    dir: string,
    results: Array<{ name: string; relativePath: string }>,
    seen: Set<string>,
  ): void {
    const tsconfigPath = path.join(dir, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      const rel = path.relative(this.config.root, dir).replaceAll("\\", "/");
      if (!seen.has(rel)) {
        seen.add(rel);
        results.push({ name: rel.replace(/\//g, "-") || "root", relativePath: rel || "." });
      }
    }

    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || this.shouldIgnore(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      if (sub.startsWith(this.config.root + "/node_modules")) continue;
      this.collectTsconfigs(sub, results, seen);
    }
  }

  private findServiceDirectories(): Array<{ name: string; relativePath: string }> {
    const indicators = ["src/", "services/", "packages/", "apps/"];
    const results: Array<{ name: string; relativePath: string }> = [];

    for (const indicator of indicators) {
      const abs = path.join(this.config.root, indicator);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || this.shouldIgnore(entry.name)) continue;
        const rel = path
          .relative(this.config.root, path.join(abs, entry.name))
          .replaceAll("\\", "/");
        results.push({ name: entry.name, relativePath: rel });
      }
    }

    return results;
  }

  private findRemainingTopLevel(): Array<{ name: string; relativePath: string }> {
    const results: Array<{ name: string; relativePath: string }> = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.config.root, { withFileTypes: true }); } catch { return results; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage" || this.shouldIgnore(entry.name)) continue;
      const rel = path.relative(this.config.root, path.join(this.config.root, entry.name)).replaceAll("\\", "/");
      results.push({ name: entry.name, relativePath: rel });
    }

    return results;
  }

  private buildAutoContainers(
    discovered: DiscoveredContainer[],
    seenPaths: Set<string>,
  ): void {
    const unassigned = this.findUnassignedFiles(seenPaths);
    if (unassigned.length === 0) return;

    const groups = this.groupByDirectory(unassigned);
    for (const [dir, files] of groups) {
      const name = dir.replace(/\//g, "-") || "root-files";
      const id = this.containerId("physical", name);
      discovered.push({
        id,
        name,
        kind: "physical",
        filePatterns: files.map((f) => f.replaceAll("\\", "/")),
      });
    }
  }

  private findUnassignedFiles(seenPaths: Set<string>): string[] {
    const allFiles: string[] = [];
    const rootDot = this.config.root;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(rootDot, { withFileTypes: true }); } catch { return allFiles; }

    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const rel = path.relative(rootDot, path.join(rootDot, entry.name)).replaceAll("\\", "/");
      let assigned = false;
      for (const sp of seenPaths) {
        if (rel.startsWith(sp + "/") || rel === sp) {
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        allFiles.push(rel);
      }
    }

    return allFiles;
  }

  private groupByDirectory(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const dir = path.dirname(f);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    return groups;
  }

  private buildContainer(dc: DiscoveredContainer): RelationContainer {
    const fileNodeIds = this.collectFileNodeIds(dc.filePatterns);
    const container: RelationContainer = {
      id: dc.id,
      name: dc.name,
      kind: dc.kind,
      entryNodeIds: [],
      memberIds: fileNodeIds,
      version: 1,
      dirty: false,
    };

    if (dc.entryFiles && dc.entryFiles.length > 0) {
      for (const ef of dc.entryFiles) {
        const id = stableId(this.config.root, "ts", `file:${ef}`);
        container.entryNodeIds.push(id);
      }
    }

    return container;
  }

  private collectFileNodeIds(patterns: string[]): string[] {
    const ids: string[] = [];
    const store = this.config.store;

    for (const pattern of patterns) {
      const globPath = pattern.replace(/\*\*\/\*\.tsx?$/g, "").replace(/\*\.tsx?$/g, "");
      const normalized = globPath.replace(/\/$/g, "");
      const fileNodes = store.getFileNodesByPrefix(normalized);
      for (const fn of fileNodes) {
        ids.push(fn.identity.stableId);
      }
    }

    return [...new Set(ids)];
  }

  private containerId(kind: string, name: string): string {
    return stableId(this.config.root, "container", `${kind}:${name}`);
  }

  assignMembersAndRoles(containers: RelationContainer[]): void {
    const store = this.config.store;

    for (const container of containers) {
      store.upsertContainer(container);

      for (const memberId of container.memberIds) {
        const isEntry = container.entryNodeIds.includes(memberId);
        const role = isEntry ? "primary" : "related";
        store.addContainerMember(container.id, memberId, role);
      }
    }

    for (const container of containers) {
      for (const depId of container.memberIds) {
        const depNode = store.getNode(depId);
        if (!depNode || depNode.kind !== "file") continue;
        const incoming = store.incoming(depId, ["IMPORTS"]);
        for (const edge of incoming) {
          const sourceContainer = this.findContainerForNode(containers, edge.sourceId);
          if (sourceContainer && sourceContainer.id !== container.id) {
            store.addContainerDep(container.id, sourceContainer.id);
          }
        }
      }
    }
  }

  private findContainerForNode(
    containers: RelationContainer[],
    nodeId: string,
  ): RelationContainer | undefined {
    return containers.find((c) => c.memberIds.includes(nodeId));
  }

  getContainersForFile(filePath: string): RelationContainer[] {
    const store = this.config.store;
    const fileNodes = store.findNodes(filePath, 10).filter(
      (n) => n.kind === "file" && n.filePath === filePath,
    );

    const result: RelationContainer[] = [];
    for (const fn of fileNodes) {
      const containers = store.getMemberContainers(fn.identity.stableId);
      result.push(...containers);
    }
    return result;
  }
}
