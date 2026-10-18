import { describe, expect, test } from "bun:test";
import type { FormattableMessage } from "../../src/lib/server/discord/format";
import { formatMessage, formatTimestamp, resolveMarkup } from "../../src/lib/server/discord/format";
import { GUILD_ID } from "../support/fakes";

const CHANNEL = "200000000000000010";

const ctx = {
  guildId: GUILD_ID,
  channelNames: new Map([["200000000000000011", "general"]]),
  roleNames: new Map([["200000000000000099", "Moderators"]]),
};

function msg(overrides: Partial<FormattableMessage>): FormattableMessage {
  return {
    id: "200000000000000020",
    channel_id: CHANNEL,
    content: "hello",
    timestamp: "2026-10-12T14:03:27.123Z",
    type: 0,
    author: { id: "300000000000000001", username: "alice", global_name: "Alice A", discriminator: "0", avatar: null },
    mentions: [],
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

describe("formatMessage", () => {
  test("renders the header line and link", () => {
    expect(formatMessage(msg({}), ctx)).toBe(
      [
        "[2026-10-12 14:03 UTC] Alice A (@alice): hello",
        `  link: https://discord.com/channels/${GUILD_ID}/${CHANNEL}/200000000000000020`,
      ].join("\n"),
    );
  });

  test("falls back to username without global_name and prefers member nick", () => {
    const author = { id: "1", username: "bob", global_name: null, discriminator: "0", avatar: null };
    expect(formatMessage(msg({ author }), ctx)).toStartWith("[2026-10-12 14:03 UTC] bob (@bob):");
    expect(formatMessage(msg({ author, member: { nick: "Bobby" } }), ctx)).toStartWith("[2026-10-12 14:03 UTC] Bobby (@bob):");
  });

  test("resolves user, role and channel mentions; leaves unknown ones", () => {
    const content =
      "hi <@300000000000000002> and <@!300000000000000003>, see <#200000000000000011> <@&200000000000000099> <#1234567890123456789> <@1234567890123456789>";
    const mentions = [
      { id: "300000000000000002", username: "carol", global_name: "Carol", discriminator: "0", avatar: null },
      { id: "300000000000000003", username: "dave", global_name: null, discriminator: "0", avatar: null },
    ];
    expect(resolveMarkup(content, mentions, ctx)).toBe(
      "hi @Carol and @dave, see #general @Moderators <#1234567890123456789> <@1234567890123456789>",
    );
  });

  test("rewrites timestamps in UTC and custom emoji by name; leaves malformed markup", () => {
    expect(resolveMarkup("starts <t:1760000000:R>, ends <t:1760003600>", [], ctx)).toBe(
      "starts 2025-10-09 08:53 UTC, ends 2025-10-09 09:53 UTC",
    );
    expect(resolveMarkup("nice <:yatta:123456789012345678> <a:dance:223456789012345678>", [], ctx)).toBe("nice :yatta: :dance:");
    expect(resolveMarkup("<t:99999999999999> <t:12:Q> <:x:1>", [], ctx)).toBe("<t:99999999999999> <t:12:Q> <:x:1>");
  });

  test("embeds show their title and description, plus their URL when the text does not have it", () => {
    const embed = { title: "Build failed", description: "main #42", url: "https://ci.example/42" };
    expect(formatMessage(msg({ content: "", embeds: [embed] }), ctx)).toContain("  embed: Build failed — main #42 https://ci.example/42");
    const preview = { title: "Example", url: "https://example.com/a" };
    expect(formatMessage(msg({ content: "look https://example.com/a", embeds: [preview] }), ctx)).toContain("  embed: Example\n");
    expect(formatMessage(msg({ content: "", embeds: [{ url: "https://img.example/x.png" }] }), ctx)).toContain(
      "  embed: https://img.example/x.png",
    );
  });

  test("lists attachments", () => {
    const out = formatMessage(
      msg({
        content: "",
        attachments: [
          { id: "1", filename: "a.png", size: 1, url: "https://cdn.discordapp.com/a.png", proxy_url: "x" },
          { id: "2", filename: "b.pdf", size: 1, url: "https://cdn.discordapp.com/b.pdf", proxy_url: "y" },
        ],
      }),
      ctx,
    );
    expect(out).toContain("(@alice): (no text content)");
    expect(out).toContain("  attachment: a.png https://cdn.discordapp.com/a.png");
    expect(out).toContain("  attachment: b.pdf https://cdn.discordapp.com/b.pdf");
  });

  test("marks replies", () => {
    const out = formatMessage(
      msg({ type: 19, message_reference: { message_id: "200000000000000015", channel_id: CHANNEL, type: 0 } }),
      ctx,
    );
    expect(out).toContain("  ↪ reply to 200000000000000015");
  });

  test("highlights a target message and tags bots", () => {
    const author = { id: "1", username: "botty", global_name: null, discriminator: "0", avatar: null, bot: true };
    expect(formatMessage(msg({ author }), ctx, { highlight: true })).toStartWith("▶ [2026-10-12 14:03 UTC] botty (@botty) [bot]:");
  });
});

describe("formatTimestamp", () => {
  test("formats in UTC with minute precision", () => {
    expect(formatTimestamp("2026-10-12T23:59:59+09:00")).toBe("2026-10-12 14:59 UTC");
  });
});
