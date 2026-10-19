import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";
import { loadConfig } from "@sveltejs/load-config";

// The Svelte config lives in vite.config.ts (sveltekit() options).
const loaded = await loadConfig("./", { traverse: false });
if (!loaded || !("config" in loaded)) throw new Error("Could not load the Svelte config", { cause: loaded?.error });
const svelteConfig = loaded.config;

export default defineConfig(
  globalIgnores(["build/", ".svelte-kit/", "node_modules/", "drizzle/meta/", "src/lib/paraglide/"]),
  js.configs.recommended,
  ts.configs.recommendedTypeChecked,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        // Files outside tsconfig's include (config files and scripts at the root), typed with its
        // options: TypeScript's defaults ignore package.json "exports" and cannot type some imports.
        projectService: {
          allowDefaultProject: ["*.js", "scripts/*.ts", "project.inlang/*.ts"],
          defaultProject: "tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
        // The same for TypeScript and Svelte files, or the project service reloads on every switch.
        // Cross-component types in .svelte need SVELTE_ESLINT_PARSER_EXPERIMENTAL_TS_SYS_HOOK=1 (set by `bun run lint`).
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // `${value satisfies never}` in exhaustiveness errors is intended.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNever: true }],
      // The app is served at the root (no `paths.base`), and hrefs are mostly built server-side
      // from DASHBOARD_PATH or are external URLs, which resolve() cannot type.
      "svelte/no-navigation-without-resolve": "off",
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    // shadcn-svelte components are generated and overwritten on update.
    files: ["src/lib/components/ui/**"],
    extends: [ts.configs.disableTypeChecked],
  },
  {
    files: ["test/**"],
    rules: {
      // bun-types declares `expect().rejects` matchers as returning void; they return promises.
      "@typescript-eslint/await-thenable": "off",
      // Fakes implement async interfaces without awaiting anything.
      "@typescript-eslint/require-await": "off",
      // bun-types types asymmetric matchers (expect.objectContaining, …) as any, and tests read
      // MCP JSON responses untyped.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Application code narrows types with guards instead of unchecked assertions; tests stay exempt.
    files: ["src/**/*.ts", "src/**/*.svelte", "src/**/*.svelte.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
);
