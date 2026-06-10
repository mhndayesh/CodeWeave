import { GraphStore } from "./db.js";

export class Invalidator {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  onFileChanged(changedFile: string): string[] {
    const directlyAffected = this.store.getImportersOf(changedFile);
    for (const aff of directlyAffected) {
      this.store.markDirty(aff, `dependency changed: ${changedFile}`);
    }
    return directlyAffected;
  }

  onFileDeleted(deletedFile: string): string[] {
    const directlyAffected = this.store.getImportersOf(deletedFile);
    this.store.transaction(() => {
      this.store.clearFile(deletedFile);
    });
    for (const aff of directlyAffected) {
      this.store.markDirty(aff, `dependency deleted: ${deletedFile}`);
    }
    return directlyAffected;
  }

  onFileRenamed(
    oldPath: string,
    newPath: string,
  ): string[] {
    const oldImporters = this.store.getImportersOf(oldPath);
    const newImporters = this.store.getImportersOf(newPath);
    const allAffected = new Set([...oldImporters, ...newImporters]);
    for (const aff of allAffected) {
      this.store.markDirty(
        aff,
        `dependency renamed: ${oldPath} -> ${newPath}`,
      );
    }
    return [...allAffected];
  }

  propagateDirty(): string[] {
    const dirty = this.store.getDirtyFiles();
    const propagated = new Set(dirty);

    let changed = true;
    while (changed) {
      changed = false;
      for (const file of [...propagated]) {
        const importers = this.store.getImportersOf(file);
        for (const importer of importers) {
          if (!propagated.has(importer)) {
            propagated.add(importer);
            this.store.markDirty(
              importer,
              `transitive: ${file}`,
            );
            changed = true;
          }
        }
      }
    }

    return [...propagated];
  }

  getTransitiveDependents(filePath: string): string[] {
    const result = new Set<string>();
    const queue = [filePath];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);

      const importers = this.store.getImportersOf(current);
      for (const importer of importers) {
        if (!seen.has(importer)) {
          result.add(importer);
          queue.push(importer);
        }
      }
    }

    return [...result];
  }
}
