import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// One config for the whole workspace. Next 16 dropped `next lint`, so ESLint runs directly.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: { next: { rootDir: "apps/web/" } },
    rules: {
      // AGENTS.md: no `any` without a comment, so every exception is an explained disable.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  // .claude/ holds guardrail files: node --test covers the hooks, and a lint rule bump
  // must not turn the app job red on a file that needs an approved plan to change.
  globalIgnores([".claude/**", "**/.next/**", "**/node_modules/**", "**/next-env.d.ts", "coverage/**"]),
]);
