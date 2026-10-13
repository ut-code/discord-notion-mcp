import { describe, expect, test } from "bun:test";
import {
  applyContentUpdates,
  buildRevertPlan,
  ContentUpdateError,
  countOccurrences,
  type RevertPlan,
} from "../../src/lib/server/notion/content/content-diff";
import type { ContentUpdate, PageMarkdownUpdate } from "../../src/lib/server/notion/client/types";

function updatesOf(plan: RevertPlan): ContentUpdate[] {
  if (plan.kind !== "revertible" || plan.inverse.type !== "update_content") throw new Error(`unexpected plan ${JSON.stringify(plan)}`);
  return plan.inverse.update_content.content_updates;
}

/** Applies an inverse the way the fake Notion does. */
function applyInverse(after: string, inverse: PageMarkdownUpdate): string {
  if (inverse.type === "update_content") return applyContentUpdates(after, inverse.update_content.content_updates);
  const { content, position } = inverse.insert_content;
  if (!after) return content;
  return position.type === "start" ? `${content}\n${after}` : `${after}\n${content}`;
}

function expectRoundTrip(before: string, after: string): RevertPlan {
  const plan = buildRevertPlan(before, after);
  if (plan.kind === "unchanged") {
    expect(after.trim() === before.trim()).toBe(true);
    return plan;
  }
  if (plan.kind === "unsupported") {
    // Only a whitespace-only result has nothing to anchor on.
    expect(after.trim()).toBe("");
    return plan;
  }
  expect(plan.kind).toBe("revertible");
  if (plan.kind !== "revertible") return plan;
  expect(applyInverse(after, plan.inverse)).toBe(before);
  if (plan.inverse.type === "update_content") {
    for (const update of plan.inverse.update_content.content_updates) {
      expect(countOccurrences(after, update.old_str)).toBe(1);
      expect(update.old_str.length).toBeGreaterThan(0);
    }
  }
  return plan;
}

describe("applyContentUpdates", () => {
  test("replaces exactly one match per update, in order", () => {
    expect(
      applyContentUpdates("a b c", [
        { old_str: "b", new_str: "B" },
        { old_str: "B c", new_str: "x" },
      ]),
    ).toBe("a x");
  });

  test("no match and multiple matches are errors", () => {
    expect(() => applyContentUpdates("abc", [{ old_str: "z", new_str: "" }])).toThrow(ContentUpdateError);
    expect(() => applyContentUpdates("abc", [{ old_str: "z", new_str: "" }])).toThrow("No matches found");
    expect(() => applyContentUpdates("a a", [{ old_str: "a", new_str: "" }])).toThrow("Multiple matches found");
    expect(() => applyContentUpdates("aaa", [{ old_str: "aa", new_str: "" }])).toThrow("Multiple matches found");
  });
});

describe("buildRevertPlan", () => {
  test("unchanged content needs no revert", () => {
    expect(buildRevertPlan("a\nb", "a\nb")).toEqual({ kind: "unchanged" });
  });

  test("a single edited line becomes a single inverse update without context", () => {
    const plan = expectRoundTrip("Title\nOld sentence.\nEnd", "Title\nNew sentence.\nEnd");
    expect(updatesOf(plan)).toEqual([{ old_str: "New sentence.", new_str: "Old sentence." }]);
    if (plan.kind === "revertible") expect(plan.hunks).toEqual([{ before: "Old sentence.", after: "New sentence." }]);
  });

  test("separated edits produce separate updates", () => {
    const before = ["# A", "one", "two", "three", "four", "five", "six"].join("\n");
    const after = ["# A", "ONE", "two", "three", "four", "five", "SIX"].join("\n");
    const plan = expectRoundTrip(before, after);
    expect(updatesOf(plan)).toEqual([
      { old_str: "ONE", new_str: "one" },
      { old_str: "SIX", new_str: "six" },
    ]);
  });

  test("insertion in the middle anchors on a neighbouring line", () => {
    const before = "Anchor A.\nAnchor B.";
    const after = "Anchor A.\nInserted paragraph.\n- bullet\nAnchor B.";
    const plan = expectRoundTrip(before, after);
    const [update] = updatesOf(plan);
    expect(update!.old_str).toContain("Inserted paragraph.\n- bullet");
    expect(update!.new_str.length).toBeGreaterThan(0);
  });

  test("insertion at the start and at the end", () => {
    expect(updatesOf(expectRoundTrip("Body", "Intro\nBody"))).toEqual([{ old_str: "Intro\nBody", new_str: "Body" }]);
    expect(updatesOf(expectRoundTrip("Body", "Body\nOutro"))).toEqual([{ old_str: "Body\nOutro", new_str: "Body" }]);
  });

  test("an inserted blank line plus paragraph anchors on the non-blank line above", () => {
    const plan = expectRoundTrip("Anchor A.\nTail", "Anchor A.\n\nInserted.\nTail");
    const [update] = updatesOf(plan);
    expect(update!.old_str.startsWith("Anchor A.")).toBe(true);
  });

  test("deletion is reverted by re-inserting with context", () => {
    const plan = expectRoundTrip("keep 1\ndrop me\nkeep 2", "keep 1\nkeep 2");
    const [update] = updatesOf(plan);
    expect(update!.new_str).toContain("drop me");
  });

  test("repeated lines expand the context until the old_str is unique", () => {
    const before = ["- [ ] task", "x", "- [ ] task", "y", "- [ ] task", "z"].join("\n");
    const after = ["- [ ] task", "x", "- [x] task", "y", "- [ ] task", "z"].join("\n");
    expect(updatesOf(expectRoundTrip(before, after))).toEqual([{ old_str: "- [x] task", new_str: "- [ ] task" }]);

    const before2 = ["item", "item", "item"].join("\n");
    const after2 = ["item", "item", "new", "item"].join("\n");
    const plan2 = expectRoundTrip(before2, after2);
    for (const update of updatesOf(plan2)) expect(countOccurrences(after2, update.old_str)).toBe(1);
  });

  test("hunks whose contexts touch are merged into one update", () => {
    const before = ["same", "a", "same", "b", "same"].join("\n");
    const after = ["same", "A", "same", "B", "same"].join("\n");
    const plan = expectRoundTrip(before, after);
    expect(updatesOf(plan).length).toBeLessThanOrEqual(2);

    const repetitive = ["x", "x", "x", "x"].join("\n");
    const changed = ["x", "y", "x", "y", "x", "x"].join("\n");
    expectRoundTrip(repetitive, changed);
  });

  test("an empty page: the inverse removes the whole content", () => {
    const plan = expectRoundTrip("", "# Heading\nBody text");
    expect(updatesOf(plan)).toEqual([{ old_str: "# Heading\nBody text", new_str: "" }]);
  });

  test("content deleted entirely is restored by inserting it again", () => {
    const plan = expectRoundTrip("# Heading\nBody", "");
    expect(plan.kind === "revertible" && plan.inverse).toEqual({
      type: "insert_content",
      insert_content: { content: "# Heading\nBody", position: { type: "start" } },
    });
  });

  test("toggle children (tab-indented) round-trip", () => {
    const before = "<details>\n<summary>More</summary>\n\tChild one\n</details>\nAfter";
    const after = "<details>\n<summary>More</summary>\n\tChild one\n\tChild two\n</details>\nAfter";
    expectRoundTrip(before, after);
  });

  test("property: applying the inverse to after always yields before (randomized)", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const vocabulary = ["a", "b", "c", "", "- x", "# H", "\tchild", "a b", "b a"];
    const doc = (max: number) =>
      Array.from({ length: Math.floor(random() * max) }, () => vocabulary[Math.floor(random() * vocabulary.length)]!).join("\n");
    const mutate = (text: string) => {
      const lines = text.split("\n");
      const edits = 1 + Math.floor(random() * 4);
      for (let i = 0; i < edits; i++) {
        const at = Math.floor(random() * (lines.length + 1));
        const choice = random();
        const line = vocabulary[Math.floor(random() * vocabulary.length)]!;
        if (choice < 0.4) lines.splice(at, 0, line);
        else if (choice < 0.7 && lines.length > 0) lines.splice(Math.min(at, lines.length - 1), 1);
        else if (lines.length > 0) lines[Math.min(at, lines.length - 1)] = line;
      }
      return lines.join("\n");
    };
    for (let i = 0; i < 2000; i++) {
      const before = doc(12);
      const after = random() < 0.1 ? doc(12) : mutate(before);
      expectRoundTrip(before, after);
    }
  });
});
