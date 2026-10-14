import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Outdir and strategy live in project.inlang/paraglide.config.ts.
  plugins: [paraglideVitePlugin({ project: "./project.inlang" }), tailwindcss(), sveltekit()],
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
