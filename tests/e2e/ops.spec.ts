// /ops is for operators only (app_metadata.ops === true). Everyone else gets a real 404 that
// reveals nothing, and a visitor without a session goes to /login like on any protected page.
// There is no operator case here: a local user cannot be given app_metadata without the admin
// credential, which tests never use (AGENTS.md); isOperator and the layout are covered in
// tests/unit/ops/access.test.ts instead.
//
// Not covered: an anonymous demo user. There is no seeding helper for one in helpers/session.ts
// (the demo sign-in sits behind Turnstile); the same case is in tests/unit/ops/access.test.ts and
// tests/rls/ops.test.ts.
import { expect, test } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

test.describe("ops: signed-in user without the operator flag", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(await seedLocalSession("ops-e2e"));
  });

  test("GET /ops answers 404 and stays on /ops (no redirect, no hint)", async ({ page }) => {
    const response = await page.goto("/ops");
    expect(response?.status()).toBe(404);
    expect(new URL(page.url()).pathname).toBe("/ops");
  });

  test("the 404 page shows none of the ops page", async ({ page }) => {
    await page.goto("/ops");
    await expect(page.getByRole("heading", { name: "Betrieb" })).toHaveCount(0);
    await expect(page.getByText("Fehler beim Import")).toHaveCount(0);
    await expect(page.getByText("Kosten pro Tag")).toHaveCount(0);
  });

  test("a query string does not change that (/ops?days=30 is a 404 too)", async ({ page }) => {
    const response = await page.goto("/ops?days=30");
    expect(response?.status()).toBe(404);
  });

  test("a made-up flag in the URL does not open it", async ({ page }) => {
    const response = await page.goto("/ops?ops=true&operator=1");
    expect(response?.status()).toBe(404);
  });
});

test.describe("ops: no session", () => {
  test("GET /ops ends on /login?next=%2Fops", async ({ page }) => {
    await page.goto("/ops");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/ops");
  });
});
