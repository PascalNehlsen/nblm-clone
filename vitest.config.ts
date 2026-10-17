import { defineConfig } from "vitest/config";

// One config for every vitest suite. The "rls" project joins in PR 2.
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
    ],
  },
});
