// A visitor with no session must never see a protected page. proxy.ts (the
// middleware/proxy) has to redirect to /login with a `next` that is exactly
// the original path and query, percent-encoded as a query value. This is the
// end-to-end counterpart of the safeNextPath() unit tests: the unit tests
// cover the sanitizer itself, this covers what the proxy actually puts on
// the wire for a real request.
import { expect, test } from "@playwright/test";

test.describe("logged out: every protected path redirects to /login?next=...", () => {
  test("GET / ends on /login?next=%2F", async ({ page }) => {
    await page.goto("/");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.search).toBe("?next=%2F");
    expect(url.searchParams.get("next")).toBe("/");
  });

  test("GET /irgendwas?x=1 ends on /login?next=%2Firgendwas%3Fx%3D1", async ({ page }) => {
    await page.goto("/irgendwas?x=1");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.search).toBe("?next=%2Firgendwas%3Fx%3D1");
    expect(url.searchParams.get("next")).toBe("/irgendwas?x=1");
  });
});
