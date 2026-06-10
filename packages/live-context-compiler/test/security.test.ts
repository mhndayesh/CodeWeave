import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  getExclusion,
  guardPath,
  redactSecrets,
  SECURITY_EXCLUSIONS,
  SECRET_PATTERNS,
} from "../src/security.js";
import { GraphStore } from "../src/db.js";
import { TsRepositoryIndexer } from "../src/indexer.js";

describe("security", () => {
  describe("exclusions", () => {
    it("skips node_modules", () => {
      const ex = getExclusion("node_modules/foo/index.js");
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("skip");
    });
    it("skips .git", () => {
      const ex = getExclusion(".git/config");
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("skip");
    });
    it("skips dist", () => {
      const ex = getExclusion("dist/bundle.js");
      expect(ex).toBeTruthy();
    });
    it("skips .pem files", () => {
      const ex = getExclusion("keys/private.pem");
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("skip");
    });
    it("skips .key files", () => {
      const ex = getExclusion("keys/server.key");
      expect(ex).toBeTruthy();
    });
    it("skips .min.js", () => {
      const ex = getExclusion("lib/vendor.min.js");
      expect(ex).toBeTruthy();
    });
    it("redacts .env files", () => {
      const ex = getExclusion(".env.production");
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("redact");
    });
    it("redacts .env", () => {
      const ex = getExclusion(".env");
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("redact");
    });
    it("redacts package and shell credential files", () => {
      expect(getExclusion(".npmrc")?.action).toBe("redact");
      expect(getExclusion(".pypirc")?.action).toBe("redact");
      expect(getExclusion(".netrc")?.action).toBe("redact");
    });
    it("skips cloud, kube, and ssh credential directories", () => {
      expect(getExclusion(".aws/credentials")?.action).toBe("skip");
      expect(getExclusion(".azure/accessTokens.json")?.action).toBe("skip");
      expect(getExclusion(".config/gcloud/application_default_credentials.json")?.action).toBe("skip");
      expect(getExclusion(".kube/config")?.action).toBe("skip");
      expect(getExclusion(".ssh/id_ed25519")?.action).toBe("skip");
    });
    it("returns undefined for normal files", () => {
      const ex = getExclusion("src/index.ts");
      expect(ex).toBeUndefined();
    });
    it("respects custom exclusions", () => {
      const custom = [{ pattern: "**/internal/**", reason: "private", action: "skip" as const }];
      const ex = getExclusion("src/internal/secret.ts", custom);
      expect(ex).toBeTruthy();
      expect(ex!.action).toBe("skip");
    });
  });

  describe("path guard", () => {
    const root = "/tmp/test-repo";
    it("allows paths within root", () => {
      const result = guardPath("src/index.ts", root);
      expect(result).toBe("/tmp/test-repo/src/index.ts");
    });
    it("denies traversal with ..", () => {
      expect(() => guardPath("../etc/passwd", root)).toThrow(/Path traversal denied/);
    });
    it("denies absolute traversal", () => {
      expect(() => guardPath("/etc/passwd", root)).toThrow(/Path traversal denied/);
    });
    it("denies sibling paths that only share a prefix", () => {
      expect(() => guardPath("../test-repo-evil/file.ts", root)).toThrow(/Path traversal denied/);
    });
    it("allows nested paths", () => {
      const result = guardPath("packages/a/src/index.ts", root);
      expect(result).toBe("/tmp/test-repo/packages/a/src/index.ts");
    });
  });

  describe("secret redaction", () => {
    it("redacts api_key assignments", () => {
      const result = redactSecrets('const api_key = "sk-12345678901234567890";');
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("sk-12345678901234567890");
    });
    it("redacts AWS access keys", () => {
      const result = redactSecrets("const key = 'AKIA1234567890123456';");
      expect(result).toContain("[REDACTED]");
    });
    it("redacts private keys", () => {
      const text = "-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----";
      const result = redactSecrets(text);
      expect(result).toContain("[REDACTED]");
    });
    it("redacts GitHub tokens", () => {
      const text = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = redactSecrets(text);
      expect(result).toContain("[REDACTED]");
    });
    it("redacts unquoted token assignments", () => {
      const result = redactSecrets("accessToken=abc123456789 secret:shh");
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain("abc123456789");
      expect(result).not.toContain("shh");
    });
    it("preserves normal text", () => {
      const text = "const name = 'hello';";
      expect(redactSecrets(text)).toBe(text);
    });
    it("preserves strings that look like keys but aren't", () => {
      const text = 'const greeting = "hello world";';
      expect(redactSecrets(text)).toBe(text);
    });
  });

  describe("indexer integration", () => {
    let tmpDir: string;
    let dbPath: string;
    let store: GraphStore;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-test-"));
      dbPath = path.join(tmpDir, "test.db");
      store = new GraphStore(dbPath);

      fs.writeFileSync(path.join(tmpDir, "normal.ts"), 'export const x = 1;\n');
      fs.writeFileSync(path.join(tmpDir, ".env"), 'API_KEY=super-secret-12345\n');
      fs.writeFileSync(path.join(tmpDir, "secret.pem"), "-----BEGIN RSA PRIVATE KEY-----\n");
      fs.writeFileSync(path.join(tmpDir, "vendor.min.js"), "var a=1;var b=2;\n");
    });

    afterAll(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("indexes safe files and skips excluded", async () => {
      const indexer = new TsRepositoryIndexer(store, tmpDir);
      await indexer.indexAll();

      const normalFiles = store.findNodes("normal.ts", 10);
      expect(normalFiles.length).toBeGreaterThanOrEqual(1);

      // .env files aren't matched by fast-glob patterns (only *.ts/*.tsx/*.js/*.jsx)
      const envFiles = store.findNodes(".env", 10);
      expect(envFiles.length).toBe(0);
    });
  });
});
