// Discord tool for finding server members.
import { z } from "zod";
import { displayName } from "../../lib/display-name";
import { isSnowflake } from "../../lib/snowflake";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import type { MemberInfo } from "../types";
import { withDiscordErrors, type DiscordToolDeps } from "./shared";

export function createMemberTools(deps: DiscordToolDeps): { findMember: AnyToolDefinition } {
  const findMember = defineTool({
    name: "discord_find_member",
    title: "Find Discord server members",
    description:
      "Look up server members to get their user id (needed for author_id / mentions_user_id in discord_search_messages). Matches the start of the username or server nickname, or an exact user id.",
    permission: "discord:read",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(100).describe("Start of a username or server nickname, or a user id"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max members to return (1-25)"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      let members: MemberInfo[];
      if (isSnowflake(args.query)) {
        const member = await deps.api.fetchMember(args.query);
        members = member ? [member] : [];
      } else {
        members = await deps.api.searchMembers(args.query, args.limit);
      }
      if (members.length === 0) return `No members match "${args.query}".`;

      const guild = principal.access.guild;
      const roleNames = new Map(guild.roles.map((role) => [role.id, role.name]));
      const lines = members.map((member) => {
        const roles = member.roles.map((id) => roleNames.get(id)).filter((name): name is string => Boolean(name));
        const roleText = roles.length > 0 ? ` — roles: ${roles.join(", ")}` : "";
        return `- ${displayName(member)} (@${member.username}, id ${member.userId})${roleText}`;
      });
      return [`Members matching "${args.query}" (${members.length}):`, ...lines].join("\n");
    }),
  });

  return { findMember };
}
