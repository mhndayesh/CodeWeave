import { createHash } from "node:crypto";

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export function stableId(
  repoPath: string,
  language: string,
  qualifiedName: string,
): string {
  return sha256(`${repoPath}::${language}::${qualifiedName}`);
}

export function versionHash(body: string): string {
  return sha256(body);
}
