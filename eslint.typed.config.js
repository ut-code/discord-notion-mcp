import ts from "typescript-eslint";
import base from "./eslint.config.js";

// Type-aware rules for .ts files only (`bun run lint:typed`, run in CI). In .svelte files the
// parser cannot resolve SvelteKit's generated `./$types`, so these rules would report false
// positives there; svelte-check covers their types instead.
export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      ...Object.assign({}, ...ts.configs.recommendedTypeCheckedOnly.map((config) => config.rules ?? {})),
      // `${value satisfies never}` in exhaustiveness errors is intended.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNever: true }],
    },
  },
];
