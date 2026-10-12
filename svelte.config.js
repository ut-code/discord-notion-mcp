import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Form posts are checked against PUBLIC_URL in hooks.server.ts; the built-in check
    // compares against the request URL, which is wrong behind a TLS-terminating proxy.
    csrf: { trustedOrigins: ["*"] },
  },
};

export default config;
