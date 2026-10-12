import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import { toolCall } from "../../src/lib/server/db/schema";
import { ToolError } from "../../src/lib/server/lib/errors";
import type { ErrorEntry, EventEntry, ToolCallLogEntry } from "../../src/lib/server/lib/log";
import { TokenBucketLimiter } from "../../src/lib/server/lib/rate-limit";
import { defineTool, type Principal } from "../../src/lib/server/mcp/registry";
import { runTool, type McpServerDeps } from "../../src/lib/server/mcp/server";
import type { Permission } from "../../src/lib/server/permissions/permissions";
import { startToolCallRetention, TOOL_CALL_RETENTION_MS, ToolCallStore } from "../../src/lib/server/usage/tool-calls";
import { FakeClock, makeGuild, makeMember } from "../support/fakes";

const USER = "300000000000000001";
const DAY_MS = 24 * 60 * 60_000;

function newStore() {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  const store = new ToolCallStore(database.db);
  return { store, rows: () => database.db.select().from(toolCall).orderBy(toolCall.id).all() };
}

const member = makeMember(USER);
const access = { isMember: true as const, discordUserId: USER, guild: makeGuild(), member, permissions: new Set<Permission>(["discord:read"]), isAdmin: false };
const principal: Principal = { userId: "u1", discordUserId: USER, clientId: "c1", access };

const echo = defineTool({
  name: "test_echo",
  title: "Echo",
  description: "Echoes or fails on request",
  permission: "discord:read",
  inputSchema: z.object({ mode: z.enum(["ok", "tool-error", "crash"]) }),
  handler: async ({ mode }) => {
    if (mode === "tool-error") throw new ToolError("Channel not found or not accessible.");
    if (mode === "crash") throw new Error("x".repeat(800));
    return "done";
  },
});

function serverDeps(store: ToolCallStore, extra: Partial<McpServerDeps> = {}) {
  const logs: ToolCallLogEntry[] = [];
  const errors: ErrorEntry[] = [];
  const deps: McpServerDeps = {
    tools: [echo],
    resolveAccess: async () => access,
    log: (entry) => logs.push(entry),
    record: (entry) => store.record(entry),
    logError: (entry) => errors.push(entry),
    ...extra,
  };
  return { deps, logs, errors };
}

describe("tool call recording", () => {
  test("successes, failures and crashes are stored without arguments; errors are truncated", async () => {
    const { store, rows } = newStore();
    const { deps, logs } = serverDeps(store);
    for (const mode of ["ok", "tool-error", "crash"] as const) await runTool(echo, { mode }, principal, deps);

    expect(rows().map((row) => [row.discordUserId, row.tool, row.ok, row.errorKind])).toEqual([
      [USER, "test_echo", true, null],
      [USER, "test_echo", false, "error"],
      [USER, "test_echo", false, "error"],
    ]);
    expect(rows()[0]!.error).toBeNull();
    expect(rows()[1]!.error).toBe("Channel not found or not accessible.");
    expect(rows()[2]!.error).toHaveLength(500);
    expect(rows().every((row) => row.durationMs >= 0 && row.createdAt instanceof Date)).toBe(true);
    expect(Object.keys(rows()[0]!).sort()).toEqual(["createdAt", "discordUserId", "durationMs", "error", "errorKind", "id", "ok", "tool"]);
    // The stdout JSON line is kept.
    expect(logs.map((entry) => [entry.event, entry.ok, entry.errorKind])).toEqual([
      ["tool_call", true, undefined],
      ["tool_call", false, "error"],
      ["tool_call", false, "error"],
    ]);
  });

  test("rate-limited calls are recorded as rate_limited and never reach the tool", async () => {
    const { store, rows } = newStore();
    const clock = new FakeClock();
    let ran = 0;
    const counting = { ...echo, handler: async () => (ran++, "done") };
    const { deps } = serverDeps(store, { rateLimit: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock: clock.fn }) });
    expect((await runTool(counting, { mode: "ok" }, principal, deps)).isError).toBeUndefined();
    const limited = await runTool(counting, { mode: "ok" }, principal, deps);
    expect(limited.isError).toBe(true);
    expect(ran).toBe(1);
    expect(rows().map((row) => [row.ok, row.errorKind, row.error])).toEqual([
      [true, null, null],
      [false, "rate_limited", "Rate limit exceeded; retry in 1 s."],
    ]);
  });

  test("a recording failure never fails the tool call", async () => {
    const { store } = newStore();
    const { deps, errors } = serverDeps(store, {
      record: () => {
        throw new Error("disk full");
      },
    });
    const result = await runTool(echo, { mode: "ok" }, principal, deps);
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(errors).toContainEqual({ event: "tool_call_record_failed", tool: "test_echo", error: "disk full" });
  });
});

describe("tool call retention", () => {
  test("deletes rows older than 90 days at startup and then on every interval", async () => {
    const { store, rows } = newStore();
    const clock = new FakeClock();
    const at = (ageMs: number) => new Date(clock.now - ageMs);
    const add = (createdAt: Date) => store.record({ discordUserId: USER, tool: "test_echo", ok: true, durationMs: 1, createdAt });
    add(at(TOOL_CALL_RETENTION_MS + DAY_MS));
    add(at(TOOL_CALL_RETENTION_MS - DAY_MS));
    add(at(0));

    const events: EventEntry[] = [];
    const stop = startToolCallRetention({ store, now: clock.fn, intervalMs: 20, log: (entry) => events.push(entry), logError: () => {} });
    expect(rows().length).toBe(2);
    expect(events).toEqual([{ event: "tool_calls_pruned", deleted: 1 }]);

    clock.advance(2 * DAY_MS);
    await Bun.sleep(60);
    expect(rows().map((row) => row.createdAt.getTime())).toEqual([clock.now - 2 * DAY_MS]);
    stop();

    clock.advance(TOOL_CALL_RETENTION_MS);
    await Bun.sleep(60);
    expect(rows().length).toBe(1);
  });

  test("a failing prune is logged, not thrown", () => {
    const errors: ErrorEntry[] = [];
    const stop = startToolCallRetention({
      store: {
        deleteBefore: () => {
          throw new Error("locked");
        },
      },
      log: () => {},
      logError: (entry) => errors.push(entry),
    });
    stop();
    expect(errors).toEqual([{ event: "tool_call_prune_failed", error: "locked" }]);
  });
});
