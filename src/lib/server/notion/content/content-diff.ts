import { createHash } from "node:crypto";
import { diffArrays, type ArrayChange } from "diff";
import type { PageMarkdownUpdate } from "../client/types";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A changed stretch of a page: lines removed and lines added, for display. */
export interface ContentHunk {
  before: string;
  after: string;
}

/** Longest a diff for display may take; past it the whole changed stretch shows as one hunk. */
const DIFF_TIMEOUT_MS = 50;

/**
 * The changed stretches between two versions of a page, line by line. Lines both share at the
 * start and the end are set aside first, so the diff only sees what changed; a diff that takes
 * too long (many changed lines) gives one hunk for that whole stretch instead.
 */
export function contentHunks(before: string, after: string): ContentHunk[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const changedA = a.slice(head, a.length - tail);
  const changedB = b.slice(head, b.length - tail);
  const changes = diffArrays(changedA, changedB, { timeout: DIFF_TIMEOUT_MS });
  if (!changes) return [{ before: changedA.join("\n"), after: changedB.join("\n") }];
  return groupChanges(changes);
}

/** Consecutive removed and added runs as hunks; unchanged runs separate them. */
function groupChanges(changes: readonly ArrayChange<string>[]): ContentHunk[] {
  const hunks: ContentHunk[] = [];
  let open: { before: string[]; after: string[] } | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (open) hunks.push({ before: open.before.join("\n"), after: open.after.join("\n") });
      open = null;
      continue;
    }
    open ??= { before: [], after: [] };
    (change.removed ? open.before : open.after).push(...change.value);
  }
  if (open) hunks.push({ before: open.before.join("\n"), after: open.after.join("\n") });
  return hunks;
}

/** 0, 1, or 2 for two or more places `needle` occurs in `text`, overlapping ones included. */
function occurrences(text: string, needle: string): 0 | 1 | 2 {
  const first = text.indexOf(needle);
  if (first === -1) return 0;
  return text.indexOf(needle, first + 1) === -1 ? 1 : 2;
}

/**
 * The lines of a stretch as compared: Notion re-counts list numbers when an item is added
 * and drops blank lines between blocks, so neither may count as someone else's change.
 */
const comparable = (lines: readonly string[]) =>
  lines.map((line) => line.replace(/^(\s*)\d+\.(\s)/, "$11.$2").trimEnd()).filter((line) => line !== "");

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;

/**
 * Lines [start, end) of `before` the update may change, or null when they cannot be told:
 * an old_str that matches several places, or none while Notion reported no miss for it (it
 * matches whitespace-tolerantly). Notion applies the edits that match and reports each miss,
 * so when every edit found nowhere is accounted for by `missed`, those changed nothing.
 */
function touchedRanges(before: string, lineCount: number, update: PageMarkdownUpdate, missed: number): Array<[number, number]> | null {
  switch (update.type) {
    case "insert_content": {
      const at = update.insert_content.position.type === "start" ? 0 : lineCount;
      return [[at, at]];
    }
    case "replace_content":
      return [[0, lineCount]];
    case "update_content": {
      const ranges: Array<[number, number]> = [];
      const written: string[] = [];
      let unmatched = 0;
      for (const { old_str, new_str } of update.update_content.content_updates) {
        const found = occurrences(before, old_str);
        if (found === 2) return null;
        if (found === 1) {
          const at = before.indexOf(old_str);
          ranges.push([lineAt(before, at), lineAt(before, at + old_str.length) + 1]);
        } else if (!written.some((text) => text.includes(old_str))) {
          unmatched++;
        }
        // Otherwise it edits text an earlier update of this call wrote, inside that update's range.
        written.push(new_str);
      }
      return unmatched === missed ? ranges : null;
    }
    default:
      throw new Error(`Unknown markdown update: ${update satisfies never}`);
  }
}

/** Where `needle` first occurs in `haystack` within [from, to), by line; -1 if nowhere. Knuth–Morris–Pratt, so linear. */
function indexOfLines(haystack: readonly string[], needle: readonly string[], from: number, to: number): number {
  if (needle.length === 0) return from;
  const fallback: number[] = [0];
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = fallback[k - 1] ?? 0;
    if (needle[i] === needle[k]) k++;
    fallback[i] = k;
  }
  for (let i = from, k = 0; i < to; i++) {
    while (k > 0 && haystack[i] !== needle[k]) k = fallback[k - 1] ?? 0;
    if (haystack[i] === needle[k]) k++;
    if (k === needle.length) return i - needle.length + 1;
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

/**
 * Why a write cannot be reverted by putting `before` back: someone else edited the page between
 * our read and our write (putting it back would undo theirs), or where our update landed cannot
 * be told (so neither can someone else's edit).
 */
export type WriteBlocker = "concurrent_edit" | "unlocated_edit";

/**
 * Checks that `after` is `before` changed only by `update`. `missed` counts the edits Notion
 * reported it found no match for.
 */
export function writeBlocker(before: string, after: string, update: PageMarkdownUpdate, missed: number): WriteBlocker | null {
  if (before === after) return null;
  const a = before.split("\n");
  const touched = touchedRanges(before, a.length, update, missed);
  if (!touched) return "unlocated_edit";
  return changedOnlyWhereTouched(a, after.split("\n"), touched) ? null : "concurrent_edit";
}
