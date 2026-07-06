import path from "node:path";

export const SECURITY_EXCLUSIONS: SecurityExclusion[] = [
  { pattern: "**/node_modules/**", reason: "vendor", action: "skip" },
  { pattern: "**/.git/**", reason: "vendor", action: "skip" },
  { pattern: "**/dist/**", reason: "generated", action: "skip" },
  { pattern: "**/build/**", reason: "generated", action: "skip" },
  { pattern: "**/.env*", reason: "secret", action: "redact" },
  { pattern: "**/.npmrc", reason: "secret", action: "redact" },
  { pattern: "**/.pypirc", reason: "secret", action: "redact" },
  { pattern: "**/.netrc", reason: "secret", action: "redact" },
  { pattern: "**/.aws/**", reason: "secret", action: "skip" },
  { pattern: "**/.azure/**", reason: "secret", action: "skip" },
  { pattern: "**/.config/gcloud/**", reason: "secret", action: "skip" },
  { pattern: "**/.kube/**", reason: "secret", action: "skip" },
  { pattern: "**/.ssh/**", reason: "secret", action: "skip" },
  { pattern: "**/*.pem", reason: "secret", action: "skip" },
  { pattern: "**/*.key", reason: "secret", action: "skip" },
  { pattern: "**/id_rsa", reason: "secret", action: "skip" },
  { pattern: "**/id_ed25519", reason: "secret", action: "skip" },
  { pattern: "**/*.min.js", reason: "generated", action: "skip" },
  { pattern: "**/*.bundle.js", reason: "generated", action: "skip" },
  { pattern: "**/*.min.css", reason: "generated", action: "skip" },
  { pattern: "**/coverage/**", reason: "generated", action: "skip" },
  { pattern: "**/.test.sqlite", reason: "generated", action: "skip" },
  { pattern: "**/*.sqlite", reason: "generated", action: "skip" },
  { pattern: "**/*.sqlite-wal", reason: "generated", action: "skip" },
  { pattern: "**/.context-graph.sqlite*", reason: "generated", action: "skip" },
];

export const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|password|token|credential|authToken|accessToken|refreshToken)s?\s*[:=]\s*['"][^'"]+['"]/gi,
  /(?:api[_-]?key|apikey|secret|password|token|credential|authToken|accessToken|refreshToken)s?\s*[:=]\s*[^\s'"]+/gi,
  /(?:-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----)/g,
  /(?:ghp_|gho_|github_pat_)[a-zA-Z0-9]{36,}/g,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
  /(?:AKIA[A-Z0-9]{16})/g,
];

export type ExclusionAction = "skip" | "redact";

export interface SecurityExclusion {
  pattern: string;
  reason: string;
  action: ExclusionAction;
}

function matchGlob(filePath: string, pattern: string): boolean {
  const n = filePath.replaceAll("\\", "/");
  let p = pattern;
  let prefix = "^";
  if (p.startsWith("**/")) {
    prefix = "^(.*/)?";
    p = p.slice(3);
  }
  const segs = p.split("/");
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg === "**") {
      parts.push(".*");
    } else {
      let r = "";
      for (const ch of seg) {
        if (ch === "*") r += "[^/]*";
        else if (ch === "?") r += ".";
        else if (ch === ".") r += "\\.";
        else r += ch;
      }
      parts.push(r);
    }
  }
  return new RegExp(prefix + parts.join("/") + "$").test(n);
}

export function getExclusion(
  filePath: string,
  customExclusions: SecurityExclusion[] = [],
): SecurityExclusion | undefined {
  const all = [...SECURITY_EXCLUSIONS, ...customExclusions];
  for (const ex of all) {
    if (matchGlob(filePath, ex.pattern)) return ex;
  }
  return undefined;
}

export function guardPath(userPath: string, repoRoot: string): string {
  const resolved = path.resolve(repoRoot, userPath);
  const normalizedRoot = path.resolve(repoRoot);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match: string) => {
      const eqIdx = match.search(/[:=]\s*/);
      if (eqIdx !== -1) {
        return match.slice(0, eqIdx + 1) + " [REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}
