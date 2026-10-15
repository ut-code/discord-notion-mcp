import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const FOLDER = join(import.meta.dir, "../../drizzle");
const files = readdirSync(FOLDER)
  .filter((file) => file.endsWith(".sql"))
  .sort();

function apply(db: Database, file: string): void {
  for (const statement of readFileSync(join(FOLDER, file), "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) db.run(statement);
  }
}

describe("0006: notes move out of `error`, interruption becomes a status", () => {
  test("converts rows written by earlier versions", () => {
    const db = new Database(":memory:");
    const target = files.findIndex((file) => file.startsWith("0006_"));
    for (const file of files.slice(0, target)) apply(db, file);

    const insert = db.prepare(
      "INSERT INTO notion_audit (created_at, discord_user_id, discord_display_name, operation, request, status, error, revert_note) VALUES (0, '1', 'a', ?, '{}', ?, ?, ?)",
    );
    insert.run("archive_page", "failed", "interrupted (server restarted)", null);
    insert.run("archive_page", "failed", "body failed validation", null);
    insert.run("append_content", "ok", '{"kind":"revert_blocked","blocker":"no_anchor"}', null);
    insert.run("create_page", "ok", "Page created, but adding its content failed: too long", "The page was already in the trash.");
    insert.run("archive_page", "ok", null, '{"kind":"already_restored"}');

    apply(db, files[target]!);
    const rows = db.query("SELECT status, error, note, revert_note AS revertNote FROM notion_audit ORDER BY id").all();
    expect(rows).toEqual([
      { status: "interrupted", error: null, note: null, revertNote: null },
      { status: "failed", error: "body failed validation", note: null, revertNote: null },
      { status: "ok", error: null, note: '{"kind":"revert_blocked","blocker":"no_anchor"}', revertNote: null },
      {
        status: "ok",
        error: null,
        note: '{"kind":"legacy","text":"Page created, but adding its content failed: too long"}',
        revertNote: '{"kind":"legacy","text":"The page was already in the trash."}',
      },
      { status: "ok", error: null, note: null, revertNote: '{"kind":"already_restored"}' },
    ]);
  });
});
