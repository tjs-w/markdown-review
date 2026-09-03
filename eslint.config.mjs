import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.build/**",
      "coverage/**",
      "playwright-report/**",
      "server/dist/**",
      "test-results/**",
      "web/dist/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["**/*.mjs", "eslint.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["packages/review-ui/src/mount.ts"],
    rules: {
      // Runtime capability checks intentionally defend lightweight DOM and embedded WebView hosts.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
    },
  },
  {
    files: [
      "packages/contracts/src/**/*.ts",
      "packages/core/src/**/*.ts",
      "packages/review-ui/src/**/*.ts",
      "packages/dyna-contracts/src/**/*.ts",
      "packages/dyna-core/src/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["node:*", "@modelcontextprotocol/*", "@tauri-apps/*"],
        },
      ],
    },
  },
);
