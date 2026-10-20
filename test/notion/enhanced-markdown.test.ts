import { describe, expect, test } from "bun:test";
import { assertNoChildObjects, countChildObjects } from "../../src/lib/server/notion/content/enhanced-markdown";

const TAG = '<page url="">P</page>';
const rejects = (content: string) => expect(() => assertNoChildObjects(content, "content")).toThrow('"content" contains a <');

// Each case was checked against what Notion creates for the same content.
describe("child object tags", () => {
  test("tags are refused anywhere, code included", () => {
    rejects(TAG);
    rejects("<page>P</page>");
    rejects("<page url=''>P</page>");
    rejects('Intro\n<database url="" inline="true">D</database>');
    rejects('<data-source url="x"/>');
    rejects(`Text with ${TAG} inline`);
    rejects('<page url=""x>P</page>');
    rejects(`<details>\n<summary>T</summary>\n\n\t${TAG}\n</details>`);
    rejects(`    ${TAG}`);
    rejects(`~~~\n${TAG}\n~~~`);
    // Notion closes a fence at any ``` line, unlike CommonMark: each of these made a page.
    rejects(`\`\`\`\`\nA\n\`\`\`\n${TAG}`);
    rejects(`\`\`\`\nA\n\`\`\` x\n${TAG}`);
    rejects(`- item\n\t\`\`\`\n\tA\n\`\`\`\n${TAG}`);
    // Text to Notion, refused all the same.
    rejects(`\`\`\`\n${TAG}\n\`\`\``);
    rejects(`Text \`${TAG}\` here`);
    rejects('<PAGE url="">P</PAGE>');
    rejects('<page\nurl="">P</page>');
    rejects(`\\\\${TAG}`);
    rejects(`\`a\\\`${TAG}`);
  });

  test("a backslash right before the tag keeps it text, in code or not", () => {
    const escaped = `\\${TAG}`;
    const literal = [
      escaped,
      `text ${escaped}`,
      `\`\`\`\n${escaped}\n\`\`\``,
      `\`${escaped}\``,
      `- item\n\t\`\`\`\n\t${escaped}\n\t\`\`\``,
      `<callout icon="💡">${escaped}</callout>`,
      `<details>\n<summary>S</summary>\n\t${escaped}\n</details>`,
      `| a |\n| --- |\n| ${escaped} |`,
      '&lt;page url=""\\>P&lt;/page\\>',
      "A <pager> and <databases> are other tags",
    ];
    for (const content of literal) expect(() => assertNoChildObjects(content, "content")).not.toThrow();
  });

  test("child pages and databases are counted as Notion renders them, not text in code or escaped", () => {
    const markdown = [
      '<page url="https://app.notion.com/p/1">One</page>',
      '\t<database url="https://app.notion.com/p/2" inline="true">Two</database>',
      '```\n<page url="">In code</page>\n```',
      '\\<page url="https://app.notion.com/p/4"\\>Escaped',
    ].join("\n");
    expect(countChildObjects(markdown)).toBe(2);
  });

  test("counting stays linear on tag starts without a url, e.g. pasted into code", () => {
    const start = performance.now();
    expect(countChildObjects(`\`\`\`\n${"<page ".repeat(33_000)}\n\`\`\``)).toBe(0);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
