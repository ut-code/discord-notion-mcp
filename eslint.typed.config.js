import ts from "typescript-eslint";
import base from "./eslint.config.js";

const typeCheckedRules = Object.fromEntries(
  ts.configs.recommendedTypeCheckedOnly
    .flatMap((config) => Object.entries(config.rules ?? {}))
    .filter(([name]) => name.startsWith("@typescript-eslint/")),
);

// Type-aware rules (`bun run lint:typed`, run in CI). extraFileExtensions must be the same for
// every file, or the project service reloads the whole project on each switch between .ts and
// .svelte. Route components annotate their props (PageProps/LayoutProps): the parser does not
// infer SvelteKit's generated types for unannotated `$props()`.
export default [
  ...base,
  {
    files: ["src/**/*.ts", "src/**/*.svelte"],
    // shadcn-svelte components are generated and overwritten on update.
    ignores: ["src/lib/components/ui/**"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname, extraFileExtensions: [".svelte"] },
    },
    rules: {
      ...typeCheckedRules,
      // `${value satisfies never}` in exhaustiveness errors is intended.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNever: true }],
      // Some APIs (Better Auth's createAuthMiddleware) only accept async handlers.
      "@typescript-eslint/require-await": "off",
    },
  },
];
