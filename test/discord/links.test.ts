import { describe, expect, test } from "bun:test";
import { parseMessageLink } from "../../src/lib/server/discord/links";
import { GUILD_ID } from "../support/fakes";

const CHANNEL = "200000000000000010";
const MESSAGE = "200000000000000020";

describe("parseMessageLink", () => {
  test("parses a valid link", () => {
    const result = parseMessageLink(`https://discord.com/channels/${GUILD_ID}/${CHANNEL}/${MESSAGE}`, GUILD_ID);
    expect(result).toEqual({ ok: true, ref: { guildId: GUILD_ID, channelId: CHANNEL, messageId: MESSAGE } });
  });

  test("accepts ptb/canary/discordapp hosts and trailing whitespace", () => {
    for (const host of ["ptb.discord.com", "canary.discord.com", "discordapp.com"]) {
      const result = parseMessageLink(` https://${host}/channels/${GUILD_ID}/${CHANNEL}/${MESSAGE} `, GUILD_ID);
      expect(result.ok).toBe(true);
    }
  });

  test("rejects links to another guild", () => {
    const result = parseMessageLink(`https://discord.com/channels/999999999999999999/${CHANNEL}/${MESSAGE}`, GUILD_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("different Discord server");
  });

  test("rejects DM links", () => {
    expect(parseMessageLink(`https://discord.com/channels/@me/${CHANNEL}/${MESSAGE}`, GUILD_ID).ok).toBe(false);
  });

  test("rejects malformed links", () => {
    for (const link of [
      "not a url",
      `http://discord.com/channels/${GUILD_ID}/${CHANNEL}/${MESSAGE}`,
      `https://evil.example/channels/${GUILD_ID}/${CHANNEL}/${MESSAGE}`,
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL}`,
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL}/abc`,
      `https://discord.com/guilds/${GUILD_ID}/${CHANNEL}/${MESSAGE}`,
    ]) {
      expect(parseMessageLink(link, GUILD_ID).ok).toBe(false);
    }
  });
});
