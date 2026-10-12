import { dev } from "$app/environment";
import { composeServer, type ComposedServer } from "./compose";
import { ConfigError, loadConfig, type Config } from "./config";
import { logEvent } from "./lib/log";
import type { Preview } from "./preview";

export interface Runtime {
  composed: ComposedServer;
  /** Sample-data sign-in helpers; only in `bun run preview`. */
  preview: Preview | null;
}

const RUNTIME_KEY = Symbol.for("discord-notion-mcp.runtime");

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function boot(): Promise<Runtime> {
  if (dev && process.env.PREVIEW === "1") {
    const { startPreview } = await import("./preview");
    return startPreview();
  }
  const config = readConfig();
  const composed = await composeServer(config);
  if (!composed.notionEnabled) {
    logEvent({ event: "notion_disabled", reason: "NOTION_TOKEN is not set; Notion tools are not registered" });
  }
  logEvent({
    event: "startup",
    port: config.port,
    publicUrl: config.publicUrl,
    mcpResource: config.mcpResource,
    tools: composed.tools.map((tool) => tool.name),
  });
  return { composed, preview: null };
}

/** The composed server, created once per process (kept across dev-server module reloads). */
export function runtime(): Promise<Runtime> {
  const store = globalThis as typeof globalThis & { [RUNTIME_KEY]?: Promise<Runtime> };
  store[RUNTIME_KEY] ??= boot();
  return store[RUNTIME_KEY];
}
