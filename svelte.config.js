import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // The built-in origin check runs before any hook and rejects form-urlencoded POSTs
    // without an Origin header, which MCP clients send to the OAuth token/revoke endpoints.
    // "*" turns it off; hooks.server.ts lets the API routes through first and then applies
    // its own Origin check (isCrossOriginWrite in http.ts) to the UI's form posts.
    csrf: { trustedOrigins: ["*"] },
  },
};

export default config;
