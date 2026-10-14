import { dev } from "$app/environment";
import { composeServer, type AppServer } from "./compose";
import { ConfigError, loadConfig, type Config } from "./config";
import { logEvent } from "./lib/log";
import type { Preview } from "./preview";

export interface Runtime {
  server: AppServer;
  /** Sample-data sign-in helpers; only in `bun run preview`. */
  preview: Preview | null;
}

declare global {
  // Survives dev-server module reloads, which would otherwise boot a second server.
  var discordNotionMcpRuntime: Promise<Runtime> | undefined;
}

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
  const server = await composeServer(config);
  if (!server.notionEnabled) {
    logEvent({ event: "notion_disabled", reason: "NOTION_TOKEN is not set; Notion tools are not registered" });
  }
  logEvent({
    event: "startup",
    port: config.port,
    publicUrl: config.publicUrl,
    mcpResource: config.mcpResource,
    tools: server.tools.map((tool) => tool.name),
  });
  return { server, preview: null };
}

/** Boots the server on first call and returns it; one per process, kept across dev-server module reloads. */
export function ensureStarted(): Promise<Runtime> {
  globalThis.discordNotionMcpRuntime ??= boot();
  return globalThis.discordNotionMcpRuntime;
}
