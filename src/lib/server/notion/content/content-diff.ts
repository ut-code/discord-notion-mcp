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
  for (let start = raw[next]; start !== undefined; start = raw[next]) {
    next++;
    let g: Hunk = { ...start };
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

/**
 * The lines of a stretch as compared: Notion re-counts list numbers when an item is added
 * and drops blank lines between blocks, so neither may count as someone else's change.
 */
const comparable = (lines: readonly string[]) =>
  lines.map((line) => line.replace(/^(\s*)\d+\.(\s)/, "$11.$2").trimEnd()).filter((line) => line !== "");

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;

/**
 * Lines [start, end) of `before` the update may change, or null when they cannot be told
 * (an old_str that matches several places, or none where Notion still found one).
 */
function touchedRanges(before: string, lineCount: number, update: PageMarkdownUpdate): Array<[number, number]> | null {
  if (update.type === "insert_content") {
    const at = update.insert_content.position.type === "start" ? 0 : lineCount;
    return [[at, at]];
  }
  const ranges: Array<[number, number]> = [];
  const written: string[] = [];
  for (const { old_str, new_str } of update.update_content.content_updates) {
    const count = countOccurrences(before, old_str);
    if (count === 1) {
      const at = before.indexOf(old_str);
      ranges.push([lineAt(before, at), lineAt(before, at + old_str.length) + 1]);
    } else if (count > 1 || !written.some((text) => text.includes(old_str))) {
      return null;
    }
    // Otherwise it edits text an earlier update of this call wrote, inside that update's range.
    written.push(new_str);
  }
  return ranges;
}

function indexOfLines(haystack: readonly string[], needle: readonly string[], from: number, to: number): number {
  for (let at = from; at + needle.length <= to; at++) {
    if (needle.every((line, offset) => haystack[at + offset] === line)) return at;
  }
  return -1;
}

/**
 * Whether `after` differs from `before` only within the ranges the update touched: every
 * untouched stretch of `before` must still appear in `after`, in order. A change anywhere else
 * was made by someone else between our read and our write. A change within our own lines
 * cannot be told from how Notion renders what we wrote.
 */
function changedOnlyWhereTouched(a: readonly string[], b: readonly string[], ranges: Array<[number, number]>): boolean {
  const after = comparable(b);
  // Untouched stretches: before the first range, between ranges, after the last one.
  const stretches: Array<[number, number]> = [];
  let from = 0;
  for (const [start, end] of [...ranges].sort((x, y) => x[0] - y[0])) {
    stretches.push([from, Math.max(from, start)]);
    from = Math.max(from, end);
  }
  const [head = [0, 0], ...between] = stretches;
  const first = comparable(a.slice(...head));
  const last = comparable(a.slice(from));

  if (first.length + last.length > after.length) return false;
  if (first.some((line, index) => after[index] !== line)) return false;
  const tail = after.length - last.length;
  if (last.some((line, index) => after[tail + index] !== line)) return false;
  let position = first.length;
  for (const [start, end] of between) {
    const stretch = comparable(a.slice(start, end));
    if (stretch.length === 0) continue;
    const found = indexOfLines(after, stretch, position, tail);
    if (found === -1) return false;
    position = found + stretch.length;
  }
  return true;
}

/** Why no inverse edit exists: nothing left to anchor it on, no unique one, or someone else edited meanwhile. */
export type RevertPlanBlocker = "no_anchor" | "ambiguous_inverse" | "concurrent_edit";

export type RevertPlan =
  | { kind: "unchanged" }
  | { kind: "revertible"; inverse: PageMarkdownUpdate; hunks: ContentHunk[] }
  | { kind: "unsupported"; blocker: RevertPlanBlocker; hunks: ContentHunk[] };

/**
 * Computes how to turn `after` back into `before` with Notion's markdown endpoint. With the
 * `update` that produced `after`, a change outside what it touched means someone else edited
 * the page between our read and our write; undoing it would undo theirs, so it is refused.
 */
export function buildRevertPlan(before: string, after: string, update?: PageMarkdownUpdate): RevertPlan {
  if (before === after) return { kind: "unchanged" };
  const a = before.split("\n");
  const b = after.split("\n");
  const raw = lineHunks(a, b);
  const hunks = raw.map((h) => ({ before: a.slice(h.aStart, h.aEnd).join("\n"), after: b.slice(h.bStart, h.bEnd).join("\n") }));

  const touched = update ? touchedRanges(before, a.length, update) : null;
  if (touched && !changedOnlyWhereTouched(a, b, touched)) return { kind: "unsupported", blocker: "concurrent_edit", hunks };

  // Nothing left to anchor an update on: put the old content back instead.
  if (after.trim() === "") {
    if (before.trim() === "") return { kind: "unchanged" };
    if (after !== "") return { kind: "unsupported", blocker: "no_anchor", hunks };
    return {
      kind: "revertible",
      inverse: { type: "insert_content", insert_content: { content: before, position: { type: "start" } } },
      hunks,
    };
  }

  const updates = inverseUpdates(a, b, raw, after);
  let restored: string | null;
  try {
    restored = applyContentUpdates(after, updates);
  } catch (error) {
    if (!(error instanceof ContentUpdateError)) throw error;
    restored = null;
  }
  if (restored !== before) return { kind: "unsupported", blocker: "ambiguous_inverse", hunks };
  return { kind: "revertible", inverse: { type: "update_content", update_content: { content_updates: updates } }, hunks };
}
