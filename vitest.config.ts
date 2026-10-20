import { fileURLToPath } from "node:url";
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
        // Unit tests run as server code, so "server-only" resolves the way Next resolves
        // it on the server (the package's react-server export, an empty module).
        resolve: {
          alias: {
            // Same as apps/web/tsconfig.json paths: "@/*" -> apps/web/*.
            "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
            "server-only": fileURLToPath(
              new URL("./apps/web/node_modules/server-only/empty.js", import.meta.url),
            ),
            // Installed in apps/web only: one id for the app's import and a test's vi.mock.
            "@sentry/nextjs": fileURLToPath(new URL("./apps/web/node_modules/@sentry/nextjs", import.meta.url)),
          },
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
