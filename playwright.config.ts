import { defineConfig, devices } from "@playwright/test";
import { supabaseLocalConfig } from "./tests/rls/helpers/clients";

// Full-stack end-to-end tests against the local Supabase stack (`pnpm db:start`) and a
// production build of the web app. The URL and publishable key come from the same
// guarded reader as the RLS harness: loopback hosts only, never an admin key.
const supabase = supabaseLocalConfig();
const siteUrl = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: siteUrl,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter web build && pnpm --filter web start -H 127.0.0.1 -p 3000",
    url: siteUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: supabase.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.anonKey,
      NEXT_PUBLIC_SITE_URL: siteUrl,
    },
  },
});
