import { MessageType, type APIMessage, type APIUser } from "discord-api-types/v10";
import { displayName } from "../lib/display-name";
import { buildMessageLink } from "./links";

export type FormattableMessage = Pick<APIMessage, "id" | "channel_id" | "content" | "timestamp" | "author" | "type"> &
  Partial<Pick<APIMessage, "mentions" | "attachments" | "embeds" | "message_reference" | "message_snapshots">> & {
    member?: { nick?: string | null };
  };

export interface FormatContext {
  guildId: string;
  channelNames: ReadonlyMap<string, string>;
  roleNames: ReadonlyMap<string, string>;
}

type MentionedUser = APIUser & { member?: { nick?: string | null } };

const MAX_EMBED_TEXT = 300;

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function userDisplayName(user: APIUser, nick?: string | null): string {
  return displayName({ nick, globalName: user.global_name, username: user.username });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface MarkupContext extends Pick<FormatContext, "channelNames" | "roleNames"> {
  users: ReadonlyMap<string, MentionedUser>;
}

interface MarkupRule {
  pattern: RegExp;
  /** The readable text for a match (its capture groups), or null to leave the markup as it is. */
  render: (groups: string[], ctx: MarkupContext) => string | null;
}

/**
 * Discord markup that carries ids or numbers, as text the AI can read; one rule per kind.
 * Every pattern is delimited by literal characters, so matching stays linear in the text.
 */
const MARKUP_RULES: readonly MarkupRule[] = [
  // <@id> and <@!id>: users, named from the message's own mention list.
  {
    pattern: /<@!?(\d+)>/g,
    render: ([id], ctx) => {
      const user = id ? ctx.users.get(id) : undefined;
      return user ? `@${userDisplayName(user, user.member?.nick)}` : null;
    },
  },
  // <@&id>: roles.
  { pattern: /<@&(\d+)>/g, render: ([id], ctx) => (id && ctx.roleNames.has(id) ? `@${ctx.roleNames.get(id)}` : null) },
  // <#id>: channels; only those the reader can see are in the map.
  { pattern: /<#(\d+)>/g, render: ([id], ctx) => (id && ctx.channelNames.has(id) ? `#${ctx.channelNames.get(id)}` : null) },
  // <t:seconds> and <t:seconds:style>: Discord shows them in each reader's time zone.
  {
    pattern: /<t:(-?\d{1,13})(?::[tTdDfFsSR])?>/g,
    render: ([seconds]) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime()) ? null : formatTimestamp(date.toISOString());
    },
  },
  // <:name:id> and <a:name:id>: custom emoji, whose id means nothing to a reader.
  { pattern: /<a?:(\w{2,32}):\d+>/g, render: ([name]) => `:${name}:` },
];

/** Rewrites Discord markup (mentions, timestamps, custom emoji) as readable text; unknown ids stay. */
export function resolveMarkup(
  content: string,
  mentions: readonly MentionedUser[],
  ctx: Pick<FormatContext, "channelNames" | "roleNames">,
): string {
  const markupCtx: MarkupContext = { ...ctx, users: new Map(mentions.map((user) => [user.id, user])) };
  return MARKUP_RULES.reduce(
    (text, rule) =>
      text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
        // The callback receives the capture groups, then the offset and the whole string.
        const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
        return rule.render(groups, markupCtx) ?? match;
      }),
    content,
  );
}

export function formatMessage(message: FormattableMessage, ctx: FormatContext, options: { highlight?: boolean } = {}): string {
  const author = message.author;
  const displayName = userDisplayName(author, message.member?.nick);
  const botTag = author.bot ? " [bot]" : "";
  const content = resolveMarkup(message.content ?? "", message.mentions ?? [], ctx);
  const prefix = options.highlight ? "▶ " : "";
  const lines = [
    `${prefix}[${formatTimestamp(message.timestamp)}] ${displayName} (@${author.username})${botTag}: ${content || "(no text content)"}`,
  ];

  if (message.type === MessageType.Reply && message.message_reference?.message_id) {
    lines.push(`  ↪ reply to ${message.message_reference.message_id}`);
  }
  for (const snapshot of message.message_snapshots ?? []) {
    const forwarded = snapshot.message.content
      ? resolveMarkup(snapshot.message.content, snapshot.message.mentions ?? [], ctx)
      : "(no text content)";
    lines.push(`  ⤷ forwarded: ${forwarded}`);
  }
  for (const attachment of message.attachments ?? []) {
    lines.push(`  attachment: ${attachment.filename} ${attachment.url}`);
  }
  for (const embed of message.embeds ?? []) {
    const text = truncate([embed.title, embed.description].filter(Boolean).join(" — "), MAX_EMBED_TEXT);
    // A link preview repeats a URL already in the text; a bot's embed may be the only place it appears.
    const url = embed.url && !message.content?.includes(embed.url) ? embed.url : "";
    const parts = [text, url].filter(Boolean);
    if (parts.length > 0) lines.push(`  embed: ${parts.join(" ")}`);
  }
  lines.push(`  link: ${buildMessageLink(ctx.guildId, message.channel_id, message.id)}`);
  return lines.join("\n");
}

export function formatMessages(messages: readonly FormattableMessage[], ctx: FormatContext, highlightId?: string): string {
  return messages.map((message) => formatMessage(message, ctx, { highlight: message.id === highlightId })).join("\n\n");
}
