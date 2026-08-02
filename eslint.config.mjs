import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/next-env.d.ts",
      "packages/db/drizzle/**",
      "packages/agent-protocol/snippets/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/CI scripts run under plain Node, so they legitimately use the Node
    // globals the browser/TS config knows nothing about. Declared inline rather
    // than pulling in the `globals` package for two names.
    files: ["**/scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
);
