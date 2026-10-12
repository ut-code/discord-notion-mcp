import { describe, expect, test } from "bun:test";
import type { ErrorEntry, ErrorSink, EventEntry, EventSink } from "../../src/lib/server/lib/log";

describe("typed log entries", () => {
  test("sinks accept only known events with their fields", () => {
    const events: EventEntry[] = [];
    const errors: ErrorEntry[] = [];
    const logEvent: EventSink = (entry) => events.push(entry);
    const logError: ErrorSink = (entry) => errors.push(entry);

    logEvent({ event: "tool_calls_pruned", deleted: 1 });
    logError({ event: "access_resolution_failed", source: "dashboard", discordUserId: "1", error: "boom" });
    // @ts-expect-error unknown event names are rejected
    logEvent({ event: "not_an_event" });
    // @ts-expect-error errors do not go to the event sink
    logEvent({ event: "http_error", path: "/", error: "boom" });
    // @ts-expect-error fields are checked per event
    logError({ event: "admin_lookup_failed", lookup: "user", error: "boom" });

    // The type checker, not the runtime, rejects the lines above.
    expect(events.map((entry): string => entry.event)).toEqual(["tool_calls_pruned", "not_an_event", "http_error"]);
    expect(errors.map((entry): string => entry.event)).toEqual(["access_resolution_failed", "admin_lookup_failed"]);
  });
});
