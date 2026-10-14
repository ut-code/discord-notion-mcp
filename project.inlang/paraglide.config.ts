import { defineConfig } from "@inlang/paraglide-js";

// Japanese only: no URL prefixes and no locale detection.
export default defineConfig({
  outdir: "./src/lib/paraglide",
  strategy: ["baseLocale"],
});
