import fs from "node:fs";
import path from "node:path";

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export interface ResolvedModule {
  absolutePath: string;
  relativePath: string;
  packageName?: string;
}

export class ModuleResolver {
  private root: string;
  private cache = new Map<string, ResolvedModule | null>();

  constructor(root: string) {
    this.root = root;
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  resolve(
    importerPath: string,
    specifier: string,
  ): ResolvedModule | null {
    if (!specifier) return null;

    const cacheKey = `${importerPath}::${specifier}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this.resolveInternal(importerPath, specifier);
    this.cache.set(cacheKey, result);
    return result;
  }

  private resolveInternal(
    importerPath: string,
    specifier: string,
  ): ResolvedModule | null {
    const importerDir = path.dirname(importerPath);

    if (specifier.startsWith(".")) {
      return this.resolveRelative(importerDir, specifier);
    }

    if (specifier.startsWith("#")) {
      return null;
    }

    return this.resolveFromNodeModules(importerDir, specifier);
  }

  private resolveRelative(
    importerDir: string,
    specifier: string,
  ): ResolvedModule | null {
    const base = path.resolve(importerDir, specifier);
    const exact = this.tryExtensions(base);
    if (exact) return exact;

    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
        const indexPath = path.join(base, idx);
        if (fs.existsSync(indexPath)) {
          return this.makeResult(indexPath);
        }
      }
    }

    const baseName = path.basename(base);
    const baseDir = path.dirname(base);
    const dirIndex = path.join(base, baseName);
    if (fs.existsSync(dirIndex) && fs.statSync(dirIndex).isDirectory()) {
      for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
        const indexPath = path.join(dirIndex, idx);
        if (fs.existsSync(indexPath)) {
          return this.makeResult(indexPath);
        }
      }
    }

    return null;
  }

  private resolveFromNodeModules(
    importerDir: string,
    packageSpec: string,
  ): ResolvedModule | null {
    const parts = packageSpec.split("/");
    const scoped = packageSpec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const subPath = packageSpec.startsWith("@")
      ? parts.slice(2).join("/")
      : parts.slice(1).join("/");

    let dir = importerDir;
    while (true) {
      const nm = path.join(dir, "node_modules", scoped);
      if (fs.existsSync(nm)) {
        const pkgJsonPath = path.join(nm, "package.json");
        let entry = "";
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
            entry = pkg.import || pkg.module || pkg.main || "index.js";
          } catch {
            entry = "index.js";
          }
        } else {
          entry = "index.js";
        }
        const resolved = subPath
          ? path.join(nm, subPath)
          : path.resolve(nm, entry);
        const withExt = this.tryExtensions(resolved);
        if (withExt) {
          withExt.packageName = scoped;
          return withExt;
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
            const indexPath = path.join(resolved, idx);
            if (fs.existsSync(indexPath)) {
              const r = this.makeResult(indexPath);
              r.packageName = scoped;
              return r;
            }
          }
        }
        if (subPath) {
          const subWithExt = this.tryExtensions(path.join(nm, subPath));
          if (subWithExt) {
            subWithExt.packageName = scoped;
            return subWithExt;
          }
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return null;
  }

  private tryExtensions(basePath: string): ResolvedModule | null {
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return this.makeResult(basePath);
    }
    for (const ext of EXTENSIONS) {
      const withExt = basePath + ext;
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return this.makeResult(withExt);
      }
    }
    return null;
  }

  private makeResult(absPath: string): ResolvedModule {
    return {
      absolutePath: absPath,
      relativePath: path.relative(this.root, absPath).replaceAll("\\", "/"),
    };
  }
}
