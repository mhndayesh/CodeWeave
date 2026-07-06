import type { CodeNode } from "./types.js";
import { TokenBudget } from "./budget.js";

interface DiffAnnotation {
  filePath: string;
  oldText: string;
  newText: string;
  startLine: number;
  endLine: number;
}

export function renderDiffAnnotation(
  diffs: DiffAnnotation[],
  budget?: TokenBudget,
): string {
  if (diffs.length === 0) return "";

  const lines: string[] = ["", "--- Changes ---", ""];

  for (const d of diffs) {
    const hunk = [
      `@@ ${d.filePath}:${d.startLine}-${d.endLine} @@`,
      ...d.oldText.split("\n").map((l) => `- ${l}`),
      ...d.newText.split("\n").map((l) => `+ ${l}`),
    ].join("\n");

    if (budget) {
      if (!budget.tryAllocate(hunk)) {
        lines.push(`  ... ${diffs.length - diffs.indexOf(d)} more diffs omitted (budget)`);
        break;
      }
    }

    lines.push(hunk);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderSliceWithDiff(
  renderedSlice: string,
  diffs: DiffAnnotation[],
  maxTokens: number,
): string {
  const budget = new TokenBudget(maxTokens, 0.15);
  const sliceTokens = TokenBudget.estimateTokens(renderedSlice);
  budget.tryAllocate(renderedSlice);

  const diffStr = renderDiffAnnotation(diffs, budget);
  return renderedSlice + diffStr;
}
