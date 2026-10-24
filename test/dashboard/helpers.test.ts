import { describe, expect, test } from "bun:test";
import { actionUrl } from "../../src/lib/action-url";
import { grantSubmitLabel } from "../../src/lib/grant-label";
import { diffLines } from "../../src/lib/server/dashboard/audit";
import { formatDateJst, formatJst, formatShortJst, renderRequestedPropertyValue, roleSummary } from "../../src/lib/server/dashboard/format";
import { safeNextPath } from "../../src/lib/server/dashboard/next-path";
import { guildIconUrl, memberAvatarUrl, userAvatarUrl } from "../../src/lib/server/discord/avatar";
import { initialOf } from "../../src/lib/initial";

describe("safeNextPath", () => {
  test("keeps same-origin paths", () => {
    expect(safeNextPath("/dashboard/audit?status=ok")).toBe("/dashboard/audit?status=ok");
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/sign-in?client_id=x&sig=a%2Fb#top")).toBe("/sign-in?client_id=x&sig=a%2Fb#top");
    expect(safeNextPath("/dashboard/%E3%81%82")).toBe("/dashboard/%E3%81%82");
    expect(safeNextPath("/a//b")).toBe("/a//b");
  });

  test("falls back to /dashboard for anything else", () => {
    for (const value of [
      undefined,
      null,
      "",
      "dashboard",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/a\\b",
      "/\u0000x",
      "/\tx",
      "/\nx",
      "/\u007fx",
      " /dashboard",
    ]) {
      expect(safeNextPath(value)).toBe("/dashboard");
    }
  });
});

describe("initialOf", () => {
  test("takes the first grapheme, upper-cased", () => {
    expect(initialOf("  kinako")).toBe("K");
    expect(initialOf("きなこ")).toBe("き");
    expect(initialOf("👩‍💻 dev")).toBe("👩‍💻");
    expect(initialOf("🇯🇵 team")).toBe("🇯🇵");
    expect(initialOf("école")).toBe("É");
    expect(initialOf("   ")).toBe("?");
  });
});

describe("Discord avatars", () => {
  const hash = "0123456789abcdef0123456789abcdef";

  const user = (avatar: string | null, discriminator = "0") => ({ id: "80351110224678912", avatar, discriminator });

  test("prefers the server avatar and falls back to the user avatar", () => {
    expect(memberAvatarUrl("1", user(hash), `a_${hash}`)).toBe(
      `https://cdn.discordapp.com/guilds/1/users/80351110224678912/avatars/a_${hash}.png?size=64`,
    );
    expect(memberAvatarUrl("1", user(hash), null)).toBe(`https://cdn.discordapp.com/avatars/80351110224678912/${hash}.png?size=64`);
  });

  test("without an avatar it is Discord's default one, picked by id (or by a legacy discriminator)", () => {
    // (80351110224678912 >> 22) % 6 = 5
    expect(memberAvatarUrl("1", user(null), null)).toBe("https://cdn.discordapp.com/embed/avatars/5.png");
    expect(userAvatarUrl(user(null, "1337"))).toBe("https://cdn.discordapp.com/embed/avatars/2.png");
  });

  test("server icons are static PNGs at 128px", () => {
    expect(guildIconUrl("1", `a_${hash}`)).toBe(`https://cdn.discordapp.com/icons/1/a_${hash}.png?size=128`);
    expect(guildIconUrl("1", null)).toBeNull();
  });

  test("ignores malformed hashes", () => {
    expect(guildIconUrl("1", "../../evil")).toBeNull();
    expect(userAvatarUrl(user("../../evil"))).toBe("https://cdn.discordapp.com/embed/avatars/5.png");
    expect(userAvatarUrl(user(""))).toBe("https://cdn.discordapp.com/embed/avatars/5.png");
  });
});

describe("admin formatting", () => {
  test("formats Japan time", () => {
    const date = new Date("2026-10-12T15:04:05.000Z");
    expect(formatJst(date)).toBe("2026/10/13 00:04:05");
    expect(formatShortJst(date)).toBe("10/13 00:04");
    expect(formatDateJst(date)).toBe("2026/10/13");
    expect(formatShortJst(null)).toBe("—");
  });

  test("renders requested property values", () => {
    expect(renderRequestedPropertyValue("select", { select: { name: "Done" } })).toBe("Done");
    expect(renderRequestedPropertyValue("rich_text", { rich_text: [{ text: { content: "a" } }, { text: { content: "b" } }] })).toBe("ab");
    expect(renderRequestedPropertyValue("multi_select", { multi_select: [{ name: "x" }, { name: "y" }] })).toBe("x, y");
    expect(renderRequestedPropertyValue("date", { date: { start: "2026-10-12", end: null } })).toBe("2026-10-12");
    expect(renderRequestedPropertyValue("checkbox", { checkbox: true })).toBe("true");
    expect(renderRequestedPropertyValue("number", { number: null })).toBe("");
    expect(renderRequestedPropertyValue("number", 3)).toBe("3");
  });

  test("malformed requested values render as text instead of throwing", () => {
    expect(renderRequestedPropertyValue("rich_text", { rich_text: [null, 5, { plain_text: "a" }, { text: null }] })).toBe("a");
    expect(renderRequestedPropertyValue("people", { people: [null, { id: "u1" }, { id: 2 }] })).toBe(", u1, ");
    expect(renderRequestedPropertyValue("date", { date: "2026-10-12" })).toBe("");
    expect(renderRequestedPropertyValue("select", { select: null })).toBe("");
    expect(renderRequestedPropertyValue("__proto__", {})).toBe("{}");
    expect(renderRequestedPropertyValue("formula", { formula: undefined })).toBe("");
  });

  test("diff lines separate hunks with ⋯", () => {
    expect(
      diffLines([
        { before: "a", after: "b\nc" },
        { before: "", after: "d" },
      ]),
    ).toEqual([
      { kind: "del", text: "− a" },
      { kind: "add", text: "+ b" },
      { kind: "add", text: "+ c" },
      { kind: "gap", text: "⋯" },
      { kind: "add", text: "+ d" },
    ]);
  });

  test("grant submit label", () => {
    expect(grantSubmitLabel(["Mina"], ["Notion 編集"], 1)).toBe("Mina に Notion 編集を付与");
    expect(grantSubmitLabel(["Mina"], ["Notion 編集"], 0)).toBe("Mina に Notion 編集を付与");
    expect(grantSubmitLabel(["Mina", "@staff"], ["Notion 編集"], 2)).toBe("2 件を付与");
    expect(grantSubmitLabel(["Mina"], ["Discord 閲覧", "Notion 編集"], 2)).toBe("Mina に Discord 閲覧・Notion 編集を付与");
    expect(grantSubmitLabel(["Mina", "@staff"], ["Notion 編集"], 0)).toBe("付与する");
    expect(grantSubmitLabel([], ["Notion 編集"], 0)).toBe("付与する");
  });
});

describe("roleSummary", () => {
  test("names up to two roles, then counts the rest", () => {
    expect(roleSummary(["staff"])).toBe("staff");
    expect(roleSummary(["staff", "member"])).toBe("staff, member");
    expect(roleSummary(["staff", "member", "企画", "広報"])).toBe("staff, member 他 2");
  });
});

describe("form plumbing", () => {
  test("action URLs keep the page query", () => {
    expect(actionUrl(new URL("http://x/dashboard/grants"), "create")).toBe("?/create");
    expect(actionUrl(new URL("http://x/dashboard/grants?filter=admin&/delete"), "create")).toBe("?filter=admin&/create");
  });
});
