// An invalid/expired OAuth code must never leave the user stuck on an
// attacker-chosen host, and must never log them in. Also exercises the
// safeNextPath() fallback end to end: `next=//evil.example` must not survive
// into a redirect.
import { expect, test } from "@playwright/test";

test("an invalid code lands back on /login (same origin) with an error, and no session is created", async ({
  page,
}) => {
  await page.goto("/auth/callback?code=invalid&next=//evil.example");

  const url = new URL(page.url());
  expect(url.origin).toBe("http://127.0.0.1:3000");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("fehler")).toBe("anmeldung");
  await expect(page.locator("body")).toContainText("Die Anmeldung hat nicht geklappt");

  // Not logged in: the protected root still bounces to /login.
  await page.goto("/");
  const redirected = new URL(page.url());
  expect(redirected.pathname).toBe("/login");
  expect(redirected.searchParams.get("next")).toBe("/");
});
