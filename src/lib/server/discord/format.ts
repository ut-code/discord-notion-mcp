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

export function resolveMentions(
  content: string,
  mentions: readonly MentionedUser[],
  ctx: Pick<FormatContext, "channelNames" | "roleNames">,
): string {
  const usersById = new Map(mentions.map((user) => [user.id, user]));
  return content
    .replace(/<@!?(\d+)>/g, (match, id: string) => {
      const user = usersById.get(id);
      return user ? `@${userDisplayName(user, user.member?.nick)}` : match;
    })
    .replace(/<@&(\d+)>/g, (match, id: string) => {
      const name = ctx.roleNames.get(id);
      return name ? `@${name}` : match;
    })
    .replace(/<#(\d+)>/g, (match, id: string) => {
      const name = ctx.channelNames.get(id);
      return name ? `#${name}` : match;
    });
}

export function formatMessage(message: FormattableMessage, ctx: FormatContext, options: { highlight?: boolean } = {}): string {
  const author = message.author;
  const displayName = userDisplayName(author, message.member?.nick);
  const botTag = author.bot ? " [bot]" : "";
  const content = resolveMentions(message.content ?? "", message.mentions ?? [], ctx);
  const prefix = options.highlight ? "▶ " : "";
  const lines = [
    `${prefix}[${formatTimestamp(message.timestamp)}] ${displayName} (@${author.username})${botTag}: ${content || "(no text content)"}`,
  ];

  if (message.type === MessageType.Reply && message.message_reference?.message_id) {
    lines.push(`  ↪ reply to ${message.message_reference.message_id}`);
  }
  for (const snapshot of message.message_snapshots ?? []) {
    const forwarded = snapshot.message.content
      ? resolveMentions(snapshot.message.content, snapshot.message.mentions ?? [], ctx)
      : "(no text content)";
    lines.push(`  ⤷ forwarded: ${forwarded}`);
  }
  for (const attachment of message.attachments ?? []) {
    lines.push(`  attachment: ${attachment.filename} ${attachment.url}`);
  }
  for (const embed of message.embeds ?? []) {
    const parts = [embed.title, embed.description].filter((part): part is string => Boolean(part));
    if (parts.length > 0) lines.push(`  embed: ${truncate(parts.join(" — "), MAX_EMBED_TEXT)}`);
  }
  lines.push(`  link: ${buildMessageLink(ctx.guildId, message.channel_id, message.id)}`);
  return lines.join("\n");
}

export function formatMessages(messages: readonly FormattableMessage[], ctx: FormatContext, highlightId?: string): string {
  return messages.map((message) => formatMessage(message, ctx, { highlight: message.id === highlightId })).join("\n\n");
}
