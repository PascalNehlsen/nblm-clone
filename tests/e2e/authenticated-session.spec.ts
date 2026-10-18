// With a real, seeded session (see helpers/session.ts), the protected app
// must render, /login must bounce a logged-in user straight to "/", and
// signing out must actually end the session rather than just navigate away.
import { expect, test } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

test.describe("a logged-in visitor", () => {
  test.beforeEach(async ({ context }) => {
    const cookies = await seedLocalSession("session-e2e");
    await context.addCookies(cookies);
  });

  test("sees the protected page with an Abmelden button, and /login redirects to /", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("http://127.0.0.1:3000/");
    await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();

    await page.goto("/login");
    await expect(page).toHaveURL("http://127.0.0.1:3000/");
  });

  test("clicking Abmelden logs out: ends on /login, and / redirects to /login again", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Abmelden" }).click();

    // Sign-out redirects; wait for navigation to settle instead of reading
    // page.url() the instant the click handler returns.
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/");
    const redirected = new URL(page.url());
    expect(redirected.pathname).toBe("/login");
    expect(redirected.searchParams.get("next")).toBe("/");
  });

  test("the old session is no longer accepted after logout: the server-side session lookup rejects it", async ({
    page,
    context,
    browser,
  }) => {
    await page.goto("/");
    const cookiesBeforeLogout = await context.cookies();

    await page.getByRole("button", { name: "Abmelden" }).click();
    await expect(page).toHaveURL(/\/login/);

    // A fresh browser context standing in for "the old cookies replayed
    // elsewhere" (a stolen cookie, a reused backup, a second tab that never
    // reloaded): sign-out must revoke the session server-side, not just
    // clear the cookie in the browser that clicked the button.
    //
    // Known gap (ADR 0005): with asymmetric JWT signing keys, the proxy's
    // getClaims() verifies the access token's signature locally and does not
    // contact Auth on every request. Sign-out revokes the refresh token
    // server-side, but an access token copied *before* logout stays valid,
    // on its own, until it naturally expires -- this test exercises the
    // server-side session/refresh lookup rejecting the old session, not
    // instant revocation of an unexpired access token already in hand.
    const strangerContext = await browser.newContext();
    await strangerContext.addCookies(cookiesBeforeLogout);
    const strangerPage = await strangerContext.newPage();

    await strangerPage.goto("/");
    const redirected = new URL(strangerPage.url());
    expect(redirected.pathname).toBe("/login");
    expect(redirected.searchParams.get("next")).toBe("/");

    await strangerContext.close();
  });
});
