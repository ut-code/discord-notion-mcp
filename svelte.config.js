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
    // Pages only; other responses get frame-ancestors from withSecurityHeaders (http.ts).
    // Styles stay 'unsafe-inline': Svelte transitions, toasts and style attributes inject them.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline", "https://fonts.googleapis.com"],
        "font-src": ["https://fonts.gstatic.com"],
        "img-src": ["self", "data:", "https://cdn.discordapp.com"],
        "connect-src": ["self"],
        "base-uri": ["self"],
        "form-action": ["self"],
        "object-src": ["none"],
        "frame-ancestors": ["none"],
      },
    },
  },
};

export default config;
