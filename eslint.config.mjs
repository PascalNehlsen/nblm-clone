import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const ADMIN_IMPORTS = {
  group: ["**/lib/server/admin", "**/lib/server/admin/**", "**/server/admin", "**/server/admin/**"],
  message: "service_role code is server-only and never imported by the app (AGENTS.md).",
};

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
  // Nothing in the app reaches the admin (service_role) client, including lib/supabase/.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [ADMIN_IMPORTS] }],
    },
  },
  // Supabase clients come only from apps/web/lib/supabase/ (server-only, the user's JWT):
  // every @supabase package and subpath is off limits elsewhere; type imports stay
  // allowed. This block repeats the admin pattern because it replaces the one above.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    ignores: ["apps/web/lib/supabase/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ADMIN_IMPORTS,
            {
              group: ["@supabase/*", "@supabase/*/**"],
              allowTypeImports: true,
              message: "Use the clients in apps/web/lib/supabase/.",
            },
          ],
        },
      ],
    },
  },
  // .claude/ holds guardrail files: node --test covers the hooks, and a lint rule bump
  // must not turn the app job red on a file that needs an approved plan to change.
  globalIgnores([".claude/**", "**/.next/**", "**/node_modules/**", "**/next-env.d.ts", "coverage/**"]),
]);
