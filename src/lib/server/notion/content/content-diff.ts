import { createHash } from "node:crypto";
import { diffArrays } from "diff";
import type { ContentUpdate, PageMarkdownUpdate } from "../client/types";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Occurrences of `needle` in `text`, counting overlapping matches (an empty needle matches everywhere). */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

export class ContentUpdateError extends Error {
  override name = "ContentUpdateError";
}

function preview(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/**
 * Applies updates in order with the semantics of Notion's update_content: each old_str
 * must occur exactly once in the text as updated so far.
 */
export function applyContentUpdates(text: string, updates: readonly ContentUpdate[]): string {
  let current = text;
  for (const update of updates) {
    const count = countOccurrences(current, update.old_str);
    if (count === 0) throw new ContentUpdateError(`No matches found for old_str ${preview(update.old_str)}.`);
    if (count > 1) throw new ContentUpdateError(`Multiple matches found for old_str ${preview(update.old_str)}.`);
    const at = current.indexOf(update.old_str);
    current = current.slice(0, at) + update.new_str + current.slice(at + update.old_str.length);
  }
  return current;
}

/** A changed region: lines [aStart, aEnd) of `before` became lines [bStart, bEnd) of `after`. */
interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Changed lines only, for display in the audit log. */
export interface ContentHunk {
  before: string;
  after: string;
}

function lineHunks(a: string[], b: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  let open: Hunk | null = null;
  for (const change of diffArrays(a, b)) {
    const n = change.value.length;
    if (!change.added && !change.removed) {
      if (open) hunks.push(open);
      open = null;
      ai += n;
      bi += n;
      continue;
    }
    open ??= { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi };
    if (change.removed) {
      ai += n;
      open.aEnd = ai;
    } else {
      bi += n;
      open.bEnd = bi;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";

/**
 * Builds inverse updates (old_str from `after`, new_str from `before`) for each hunk.
 * Context lines are added one above and one below at a time until the old_str is
 * unambiguous, both in `after` and in the text as it will be when this update is
 * applied (earlier inverse updates already done). Both sides must be non-empty so the
 * line separators stay balanced, and edges prefer non-blank lines because Notion
 * matches blocks whitespace-tolerantly. Groups that touch or overlap are merged.
 */
function inverseUpdates(a: string[], b: string[], raw: Hunk[], after: string): ContentUpdate[] {
  const groups: Hunk[] = [];
  const satisfied = (g: Hunk): boolean => {
    if (g.aEnd === g.aStart || g.bEnd === g.bStart) return false;
    if (g.bStart > 0 && isBlank(b[g.bStart])) return false;
    if (g.bEnd < b.length && isBlank(b[g.bEnd - 1])) return false;
    const oldStr = b.slice(g.bStart, g.bEnd).join("\n");
    if (countOccurrences(after, oldStr) !== 1) return false;
    const atApplication = [...a.slice(0, g.aStart), ...b.slice(g.bStart)].join("\n");
    return countOccurrences(atApplication, oldStr) === 1;
  };

  let next = 0;
  while (next < raw.length) {
    let g: Hunk = { ...raw[next++]! };
    for (;;) {
      const previous = groups.at(-1);
      if (previous && previous.bEnd >= g.bStart) {
        groups.pop();
        g = { aStart: previous.aStart, aEnd: g.aEnd, bStart: previous.bStart, bEnd: g.bEnd };
        continue;
      }
      const following = raw[next];
      if (following && following.bStart <= g.bEnd) {
        g = { ...g, aEnd: following.aEnd, bEnd: following.bEnd };
        next++;
        continue;
      }
      if (satisfied(g)) break;
      const canGrowUp = g.bStart > 0;
      const canGrowDown = g.bEnd < b.length;
      if (!canGrowUp && !canGrowDown) break;
      if (canGrowUp) g = { ...g, aStart: g.aStart - 1, bStart: g.bStart - 1 };
      if (canGrowDown) g = { ...g, aEnd: g.aEnd + 1, bEnd: g.bEnd + 1 };
    }
    groups.push(g);
  }
  return groups.map((g) => ({ old_str: b.slice(g.bStart, g.bEnd).join("\n"), new_str: a.slice(g.aStart, g.aEnd).join("\n") }));
}

export type RevertPlan =
  | { kind: "unchanged" }
  | { kind: "revertible"; inverse: PageMarkdownUpdate; hunks: ContentHunk[] }
  | { kind: "unsupported"; reason: string; hunks: ContentHunk[] };

/** Computes how to turn `after` back into `before` with Notion's markdown endpoint. */
export function buildRevertPlan(before: string, after: string): RevertPlan {
  if (before === after) return { kind: "unchanged" };
  const a = before.split("\n");
  const b = after.split("\n");
  const raw = lineHunks(a, b);
  const hunks = raw.map((h) => ({ before: a.slice(h.aStart, h.aEnd).join("\n"), after: b.slice(h.bStart, h.bEnd).join("\n") }));

  // Nothing left to anchor an update on: put the old content back instead.
  if (after.trim() === "") {
    if (before.trim() === "") return { kind: "unchanged" };
    if (after !== "") return { kind: "unsupported", reason: "the page has no text left to anchor a revert on", hunks };
    return { kind: "revertible", inverse: { type: "insert_content", insert_content: { content: before, position: { type: "start" } } }, hunks };
  }

  const updates = inverseUpdates(a, b, raw, after);
  let restored: string | null = null;
  try {
    restored = applyContentUpdates(after, updates);
  } catch {
    restored = null;
  }
  if (restored !== before) return { kind: "unsupported", reason: "no unambiguous inverse edit could be computed", hunks };
  return { kind: "revertible", inverse: { type: "update_content", update_content: { content_updates: updates } }, hunks };
}
