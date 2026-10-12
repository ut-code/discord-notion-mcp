import { describe, expect, test } from "bun:test";
import { actionUrl } from "../../src/lib/action-url";
import { grantSubmitLabel } from "../../src/lib/grant-label";
import { diffLines } from "../../src/lib/server/admin/audit";
import { formatDateJst, formatJst, formatShortJst, renderRequestedPropertyValue } from "../../src/lib/server/admin/format";
import { memberAvatarUrl, userAvatarUrl } from "../../src/lib/server/discord/avatar";
import { safeNextPath } from "../../src/lib/server/web/next-path";
import { parseSetCookie } from "../../src/lib/server/web/set-cookie";

describe("safeNextPath", () => {
  test("keeps same-origin paths", () => {
    expect(safeNextPath("/dashboard/audit?status=ok")).toBe("/dashboard/audit?status=ok");
    expect(safeNextPath("/")).toBe("/");
  });

  test("falls back to /dashboard for anything else", () => {
    for (const value of [undefined, null, "", "dashboard", "//evil.example", "/\\evil.example", "https://evil.example", "/a\\b", "/\u0000x", "/\tx"]) {
      expect(safeNextPath(value)).toBe("/dashboard");
    }
  });
});

describe("Discord avatars", () => {
  const hash = "0123456789abcdef0123456789abcdef";

  test("prefers the server avatar and falls back to the user avatar", () => {
    expect(memberAvatarUrl("1", "2", `a_${hash}`, hash)).toBe(`https://cdn.discordapp.com/guilds/1/users/2/avatars/a_${hash}.png?size=64`);
    expect(memberAvatarUrl("1", "2", null, hash)).toBe(`https://cdn.discordapp.com/avatars/2/${hash}.png?size=64`);
    expect(memberAvatarUrl("1", "2", null, null)).toBeNull();
  });

  test("ignores malformed hashes", () => {
    expect(userAvatarUrl("2", "../../evil")).toBeNull();
    expect(userAvatarUrl("2", "")).toBeNull();
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
  });

  test("diff lines separate hunks with ⋯", () => {
    expect(diffLines([{ before: "a", after: "b\nc" }, { before: "", after: "d" }])).toEqual([
      { kind: "del", text: "− a" },
      { kind: "add", text: "+ b" },
      { kind: "add", text: "+ c" },
      { kind: "gap", text: "⋯" },
      { kind: "add", text: "+ d" },
    ]);
  });

  test("grant submit label", () => {
    expect(grantSubmitLabel("Notion 書き込み", "Mina")).toBe("Mina に Notion 書き込みを付与");
    expect(grantSubmitLabel("Notion 書き込み", null)).toBe("付与する");
  });
});

describe("form plumbing", () => {
  test("action URLs keep the page query", () => {
    expect(actionUrl(new URL("http://x/dashboard/grants"), "create")).toBe("?/create");
    expect(actionUrl(new URL("http://x/dashboard/grants?filter=admin&/delete"), "create")).toBe("?filter=admin&/create");
  });

  test("Set-Cookie headers are parsed for the cookie API", () => {
    expect(parseSetCookie("better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax")).toEqual({
      name: "better-auth.session_token",
      value: "",
      options: { path: "/", maxAge: 0, httpOnly: true, secure: false, sameSite: "lax" },
    });
    expect(parseSetCookie("__Secure-a=b%3Dc; Secure; Path=/x; Expires=Wed, 21 Oct 2026 07:28:00 GMT")?.options).toMatchObject({
      path: "/x",
      secure: true,
      expires: new Date("2026-10-21T07:28:00.000Z"),
    });
    expect(parseSetCookie("__Secure-a=b%3Dc")?.value).toBe("b%3Dc");
    expect(parseSetCookie("garbage")).toBeNull();
  });
});
