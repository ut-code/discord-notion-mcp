import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Outdir and strategy live in project.inlang/paraglide.config.ts.
  plugins: [
    paraglideVitePlugin({ project: "./project.inlang" }),
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
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
          "style-src": ["self", "unsafe-inline"],
          // data: for icons drawn in CSS (app.css) and the preview's server icon; the CDN for Discord avatars.
          "img-src": ["self", "data:", "https://cdn.discordapp.com"],
          "connect-src": ["self"],
          "base-uri": ["self"],
          "form-action": ["self"],
          "object-src": ["none"],
          "frame-ancestors": ["none"],
        },
      },
    }),
  ],
  // Same port as PUBLIC_URL in .env (OAuth redirects come back here).
  // `.ts.net`: reachable through `tailscale serve` from other tailnet devices.
  server: { port: Number(process.env.PORT ?? 3000), strictPort: true, allowedHosts: [".ts.net"] },
  ssr: {
    // Provided by the Bun runtime.
    external: ["bun:sqlite"],
  },
  build: {
    rollupOptions: { external: ["bun:sqlite"] },
  },
});
