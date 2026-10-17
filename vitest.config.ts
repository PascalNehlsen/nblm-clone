import { defineConfig } from "vitest/config";

// One config for every vitest suite: `pnpm test` runs "unit", `pnpm test:rls` runs "rls".
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        // Needs the local stack (`pnpm db:start`): real sign-ins against local Auth,
        // queries through PostgREST with the resulting JWTs. Never the service role.
        extends: true,
        test: {
          name: "rls",
          include: ["tests/rls/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
