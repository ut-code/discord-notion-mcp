// Compiles messages/ into src/lib/paraglide when they changed since the last compile.
// The Vite plugin compiles for dev and build; this covers `bun test`, typecheck and fresh clones.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUTPUT = "src/lib/paraglide/messages.js";
const SOURCES = [
  "project.inlang/settings.json",
  "project.inlang/paraglide.config.ts",
  ...readdirSync("messages").map((file) => join("messages", file)),
];

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

if (Math.max(...SOURCES.map(modifiedAt)) > modifiedAt(OUTPUT)) {
  const result = Bun.spawnSync(["bunx", "paraglide-js", "compile", "--project", "./project.inlang"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("paraglide-js compile failed");
}
