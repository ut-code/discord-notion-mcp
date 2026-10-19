import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // The built-in origin check runs before any hook and rejects form-urlencoded POSTs
    // without an Origin header, which MCP clients send to the OAuth token/revoke endpoints.
    // "*" turns it off; the handler in http.ts answers the API routes first and applies its
    // own Origin check to every other state-changing request (see route() there).
    csrf: { trustedOrigins: ["*"] },
    // Pages only; other responses get frame-ancestors from withSecurityHeaders (http.ts).
    // Styles stay 'unsafe-inline': Svelte transitions, toasts and style attributes inject them.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        // Only the handler Svelte puts on server-rendered <img> with spread props (bits-ui avatars)
        // to replay a load/error that fires before hydration: sha256 of "this.__e=event".
        // https://github.com/sveltejs/svelte/issues/14014
        "script-src-attr": ["unsafe-hashes", "sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I="],
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
