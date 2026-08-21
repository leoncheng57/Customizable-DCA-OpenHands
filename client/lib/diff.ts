export type DiffLineKind = "context" | "added" | "removed" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

function splitLines(value: string | null): string[] {
  return value === null ? [] : value.split("\n");
}

/** Create a compact unified-style hunk from the snapshots returned by Agent Canvas. */
export function buildDiff(original: string | null, modified: string | null): DiffLine[] {
  const before = splitLines(original);
  const after = splitLines(modified);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (start === before.length && start === after.length) return [];

  const context = 3;
  const from = Math.max(0, start - context);
  const beforeTo = Math.min(before.length, beforeEnd + context);
  const afterTo = Math.min(after.length, afterEnd + context);
  const lines: DiffLine[] = [{
    kind: "hunk",
    text: `@@ -${from + 1},${beforeTo - from} +${from + 1},${afterTo - from} @@`,
  }];
  for (let index = from; index < start; index += 1) {
    lines.push({ kind: "context", text: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = start; index < beforeEnd; index += 1) lines.push({ kind: "removed", text: before[index], oldLine: index + 1 });
  for (let index = start; index < afterEnd; index += 1) lines.push({ kind: "added", text: after[index], newLine: index + 1 });
  for (let index = beforeEnd; index < beforeTo; index += 1) {
    const newIndex = afterEnd + (index - beforeEnd);
    lines.push({ kind: "context", text: before[index], oldLine: index + 1, newLine: newIndex + 1 });
  }
  return lines;
}
