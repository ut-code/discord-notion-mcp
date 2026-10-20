import { describe, expect, test } from "bun:test";
import { contentHunks, writeBlocker } from "../../src/lib/server/notion/content/content-diff";
import type { PageMarkdownUpdate } from "../../src/lib/server/notion/client/types";

const replace = (oldStr: string, newStr: string): PageMarkdownUpdate => ({
  type: "update_content",
  update_content: { content_updates: [{ old_str: oldStr, new_str: newStr }] },
});
const insert = (content: string, position: "start" | "end"): PageMarkdownUpdate => ({
  type: "insert_content",
  insert_content: { content, position: { type: position } },
});

/** Applies an update the plain way: each old_str at its first place. */
function apply(text: string, update: PageMarkdownUpdate): string {
  switch (update.type) {
    case "update_content":
      return update.update_content.content_updates.reduce((current, { old_str, new_str }) => current.replace(old_str, new_str), text);
    case "insert_content": {
      const { content, position } = update.insert_content;
      if (!text) return content;
      return position.type === "start" ? `${content}\n${text}` : `${text}\n${content}`;
    }
    case "replace_content":
      return update.replace_content.new_str;
  }
}

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

describe("contentHunks", () => {
  test("lists each changed stretch with its removed and added lines", () => {
    expect(contentHunks("a\nb\nc", "a\nb\nc")).toEqual([]);
    expect(contentHunks("a\nb\nc", "a\nB\nc")).toEqual([{ before: "b", after: "B" }]);
    expect(contentHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE")).toEqual([
      { before: "a", after: "A" },
      { before: "e", after: "E" },
    ]);
    expect(contentHunks("a\nc", "a\nb\nc")).toEqual([{ before: "", after: "b" }]);
    expect(contentHunks("a\nb\nc", "a\nc")).toEqual([{ before: "b", after: "" }]);
    expect(contentHunks("", "added")).toEqual([{ before: "", after: "added" }]);
  });

  test("a diff that would take too long shows the whole changed stretch as one hunk", () => {
    const old = Array.from({ length: 8000 }, (_, i) => `old line ${i}`);
    const rewritten = Array.from({ length: 8000 }, (_, i) => `new line ${i}`);
    const { value, ms } = timed(() => contentHunks(["kept", ...old, "kept too"].join("\n"), ["kept", ...rewritten, "kept too"].join("\n")));
    expect(value).toEqual([{ before: old.join("\n"), after: rewritten.join("\n") }]);
    expect(ms).toBeLessThan(500);
  });

  test("a long run of identical lines is quick", () => {
    const lines = Array.from({ length: 50_000 }, () => "x").join("\n");
    const { value, ms } = timed(() => contentHunks(lines, `x\n${lines}`));
    expect(value).toEqual([{ before: "", after: "x" }]);
    expect(ms).toBeLessThan(500);
  });
});

describe("writeBlocker: someone else's edit between our read and our write", () => {
  const doc = "# Notes\n\nIntro\n\n1. first\n2. second\n\nMiddle\n\nOutro";

  test("our own change alone is not flagged", () => {
    for (const update of [replace("Middle", "Middle changed"), insert("Added", "end"), insert("Added", "start")]) {
      expect(writeBlocker(doc, apply(doc, update), update, 0)).toBeNull();
    }
  });

  test("a change elsewhere is flagged", () => {
    const theirs = doc.replace("Intro", "Intro edited by someone");
    for (const update of [replace("Middle", "Middle changed"), insert("Added", "end")]) {
      expect(writeBlocker(doc, apply(theirs, update), update, 0)).toBe("concurrent_edit");
    }
    const atEnd = doc.replace("Outro", "Outro edited");
    expect(writeBlocker(doc, apply(atEnd, insert("Added", "start")), insert("Added", "start"), 0)).toBe("concurrent_edit");
  });

  test("Notion renumbering a list or dropping blank lines is not flagged", () => {
    const update = replace("1. first", "1. first\n2. inserted");
    const renumbered = apply(doc, update).replace("2. second", "3. second");
    expect(writeBlocker(doc, renumbered, update, 0)).toBeNull();
    const blankDropped = apply(doc, replace("Middle", "Middle changed")).replace("\n\nOutro", "\nOutro");
    expect(writeBlocker(doc, blankDropped, replace("Middle", "Middle changed"), 0)).toBeNull();
  });

  test("an edit of the very next block is flagged", () => {
    const update = replace("Middle", "Middle changed");
    expect(writeBlocker(doc, apply(doc.replace("Outro", "Outro edited"), update), update, 0)).toBe("concurrent_edit");
    expect(writeBlocker(doc, apply(doc.replace("2. second", "2. second edited"), update), update, 0)).toBe("concurrent_edit");
  });

  test("an edit whose place cannot be located is not revertible", () => {
    // Two "Note" lines in what we read, yet Notion (matching whitespace-tolerantly) applied it.
    expect(writeBlocker("Note\n\nBody\n\nNote ", "Note changed\n\nBody\n\nNote ", replace("Note", "Note changed"), 0)).toBe(
      "unlocated_edit",
    );
    // Found nowhere in what we read, and Notion did not report it missed.
    expect(writeBlocker("Body", "Changed", replace("Bodyy", "Changed"), 0)).toBe("unlocated_edit");
  });

  test("edits Notion reported missed changed nothing, so the others are still located", () => {
    const update: PageMarkdownUpdate = {
      type: "update_content",
      update_content: {
        content_updates: [
          { old_str: "Middle", new_str: "Middle changed" },
          { old_str: "Nowhere", new_str: "x" },
        ],
      },
    };
    const after = doc.replace("Middle", "Middle changed");
    expect(writeBlocker(doc, after, update, 1)).toBeNull();
    expect(writeBlocker(doc, after, update, 0)).toBe("unlocated_edit");
  });

  test("an edit within the lines we changed cannot be told apart", () => {
    const update = replace("Middle", "Middle changed");
    expect(writeBlocker(doc, apply(doc, update).replace("Middle changed", "Middle changed twice"), update, 0)).toBeNull();
  });

  test("stays quick on long runs of identical lines", () => {
    const lines = Array.from({ length: 8000 }, () => "x");
    const before = lines.join("\n");
    const { value, ms } = timed(() => writeBlocker(before, `x\n${before}`, insert("x", "start"), 0));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(500);
    // Two edits leave a long untouched stretch between them to find in what Notion returned.
    const runs = [...lines, "a", ...lines, "b", ...lines].join("\n");
    const update: PageMarkdownUpdate = {
      type: "update_content",
      update_content: {
        content_updates: [
          { old_str: "a", new_str: "A" },
          { old_str: "b", new_str: "B" },
        ],
      },
    };
    const both = timed(() => writeBlocker(runs, apply(runs, update), update, 0));
    expect(both.value).toBeNull();
    expect(both.ms).toBeLessThan(500);
  });

  test("randomized: never flags our own edit; always flags a change to any other line", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const filler = ["", "", "- item", "1. step", "\tchild", "| a | b |", "<empty-block/>"];
    for (let i = 0; i < 3000; i++) {
      const lines = Array.from({ length: 3 + Math.floor(random() * 15) }, (_, n) => (random() < 0.5 ? `line ${n}.` : pick(filler)));
      lines.push(`line ${lines.length}.`);
      const before = lines.join("\n");
      const unique = lines.flatMap((line, n) => (line.startsWith("line ") ? [n] : []));
      const kind = random();
      let update: PageMarkdownUpdate;
      let start: number;
      let end: number;
      if (kind < 0.2) {
        update = insert(`added ${i}\n${pick(filler)}`, "end");
        [start, end] = [lines.length, lines.length];
      } else if (kind < 0.3) {
        update = insert(`added ${i}`, "start");
        [start, end] = [0, 0];
      } else {
        const at = pick(unique);
        update = replace(lines[at]!, random() < 0.5 ? `${lines[at]} changed` : `${pick(filler)}\nnew ${i}\n${pick(filler)}`);
        [start, end] = [at, at + 1];
      }

      expect(writeBlocker(before, apply(before, update), update, 0)).toBeNull();

      const far = lines.flatMap((line, n) => ((n < start || n >= end) && line.startsWith("line ") ? [n] : []));
      if (far.length === 0) continue;
      const theirs = [...lines];
      const target = pick(far);
      theirs[target] = `${theirs[target]} by someone else`;
      expect(writeBlocker(before, apply(theirs.join("\n"), update), update, 0)).toBe("concurrent_edit");
    }
  });
});
