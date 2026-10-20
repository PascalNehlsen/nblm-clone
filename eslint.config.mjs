import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Every source extension Next can bundle, not only TypeScript: a page.jsx or route.cjs must
// not get around the import bans below.
const APP_FILES = "apps/web/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}";

// These bans match path segments on purpose and fail loudly (lint error) when they
// overmatch, e.g. a future components/admin/ or a package subpath ending in /testing.
// Widen the exception for that file instead of renaming it around the rule.
// Any specifier with an "admin" path segment, so relative forms like "../admin/usage"
// from a sibling directory are caught as well as "@/lib/server/admin/...".
const ADMIN_IMPORTS = {
  regex: "(^|/)admin(/|$)",
  message: "service_role code is server-only and never imported by the app (AGENTS.md).",
};

// lib/server/model/call.ts is the one importer of the admin usage module (ADR 0006),
// and of nothing else under admin.
const ADMIN_IMPORTS_EXCEPT_USAGE = {
  regex: "(^|/)admin(/(?!usage$)|$)",
  message: "Only lib/server/admin/usage may be imported here (ADR 0006).",
};

// lib/server/account/delete-account.ts is the one importer of the admin accounts module
// (account deletion, ADR 0021), and of nothing else under admin.
const ADMIN_IMPORTS_EXCEPT_ACCOUNTS = {
  regex: "(^|/)admin(/(?!accounts$)|$)",
  message: "Only lib/server/admin/accounts may be imported here (ADR 0021).",
};

// The model-call engine is imported only by call.ts (production wiring) and testing.ts.
const CALL_CORE_IMPORTS = {
  regex: "(^|/)call-core(\\.[cm]?[jt]sx?)?$",
  message: "Call models through lib/server/model/call.ts (createModelCaller).",
};

// The injectable test entry point is for tests/ only, never for app code.
const TESTING_IMPORTS = {
  regex: "(^|/)testing(\\.[cm]?[jt]sx?)?$",
  message: "lib/server/model/testing.ts is for tests/ only; use createModelCaller from call.ts.",
};

// The Bedrock provider and the AWS Bedrock SDK only inside lib/server/model/, so every
// model call goes through createModelCaller and its budget check (Pascal, 2026-10-19).
const BEDROCK_IMPORTS = {
  regex: "(^|/)bedrock(\\.[cm]?[jt]sx?)?$",
  message: "Call models through lib/server/model/ (createModelCaller), never the provider directly.",
};

const BEDROCK_SDK_IMPORTS = {
  group: ["@aws-sdk/client-bedrock-runtime", "@aws-sdk/client-bedrock-runtime/**"],
  message: "The Bedrock SDK is used only inside lib/server/model/.",
};

const SUPABASE_IMPORTS = {
  group: ["@supabase/*", "@supabase/*/**"],
  allowTypeImports: true,
  message: "Use the clients in apps/web/lib/supabase/.",
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
    files: [APP_FILES],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [ADMIN_IMPORTS, CALL_CORE_IMPORTS, TESTING_IMPORTS, BEDROCK_IMPORTS, BEDROCK_SDK_IMPORTS] },
      ],
    },
  },
  // Supabase clients come only from apps/web/lib/supabase/ (server-only, the user's JWT):
  // every @supabase package and subpath is off limits elsewhere; type imports stay
  // allowed. This block repeats the admin pattern because it replaces the one above.
  {
    files: [APP_FILES],
    ignores: ["apps/web/lib/supabase/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ADMIN_IMPORTS,
            CALL_CORE_IMPORTS,
            TESTING_IMPORTS,
            BEDROCK_IMPORTS,
            BEDROCK_SDK_IMPORTS,
            SUPABASE_IMPORTS,
          ],
        },
      ],
    },
  },
  // The model-call code itself may use the Bedrock provider and SDK; everything else above
  // still applies (call.ts and testing.ts get their own blocks below).
  {
    files: ["apps/web/lib/server/model/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [ADMIN_IMPORTS, CALL_CORE_IMPORTS, TESTING_IMPORTS, SUPABASE_IMPORTS] },
      ],
    },
  },
  // The model-call wrapper may import the admin usage module (and nothing else under admin)
  // and the engine.
  {
    files: ["apps/web/lib/server/model/call.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [ADMIN_IMPORTS_EXCEPT_USAGE, TESTING_IMPORTS, SUPABASE_IMPORTS] },
      ],
    },
  },
  // The test entry point may import the engine, never the admin module.
  {
    files: ["apps/web/lib/server/model/testing.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [ADMIN_IMPORTS, TESTING_IMPORTS, SUPABASE_IMPORTS] },
      ],
    },
  },
  // The admin modules (usage, ADR 0006; accounts, ADR 0021) are the places that hold the
  // service_role key, so they may import @supabase/supabase-js. Every other @supabase package
  // stays banned, and neither may import the other ("./usage", "./accounts").
  {
    files: ["apps/web/lib/server/admin/usage.ts", "apps/web/lib/server/admin/accounts.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ADMIN_IMPORTS,
            CALL_CORE_IMPORTS,
            TESTING_IMPORTS,
            BEDROCK_IMPORTS,
            BEDROCK_SDK_IMPORTS,
            { ...SUPABASE_IMPORTS, group: [...SUPABASE_IMPORTS.group, "!@supabase/supabase-js"] },
            { regex: "^\\./(usage|accounts)(\\.[cm]?[jt]sx?)?$", message: "The admin modules stay separate (ADR 0006, ADR 0021)." },
          ],
        },
      ],
    },
  },
  // Account deletion may import the admin accounts module (and nothing else under admin).
  // The Supabase client is injected: only type imports of @supabase stay allowed.
  {
    files: ["apps/web/lib/server/account/delete-account.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ADMIN_IMPORTS_EXCEPT_ACCOUNTS,
            CALL_CORE_IMPORTS,
            TESTING_IMPORTS,
            BEDROCK_IMPORTS,
            BEDROCK_SDK_IMPORTS,
            SUPABASE_IMPORTS,
          ],
        },
      ],
    },
  },
  // .claude/ holds guardrail files: node --test covers the hooks, and a lint rule bump
  // must not turn the app job red on a file that needs an approved plan to change.
  globalIgnores([".claude/**", "**/.next/**", "**/node_modules/**", "**/next-env.d.ts", "coverage/**"]),
]);
