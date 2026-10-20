// /login?konto=geloescht is where a deleted account lands. It shows the fixed notice
// "Dein Konto wurde gelöscht." (role=status, like the other notices on that page) and nothing
// else changes. The parameter is never echoed: any other value shows no notice.
import { expect, test } from "@playwright/test";

const NOTICE = "Dein Konto wurde gelöscht.";

test.describe("the account-deleted notice on /login", () => {
  test("?konto=geloescht shows the notice as a status message and keeps the login options", async ({ page }) => {
    await page.goto("/login?konto=geloescht");

    await expect(page.getByRole("status").filter({ hasText: NOTICE })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Demo starten (ohne Anmeldung)" })).toBeVisible();
  });

  test("plain /login shows no such notice", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
    await expect(page.getByText(NOTICE)).toHaveCount(0);
  });

  for (const value of ["1", "ja", "GELOESCHT", "%3Cb%3Eboese%3C%2Fb%3E", "geloescht%20oder%20nicht"]) {
    test(`?konto=${value} shows no notice and is not echoed`, async ({ page }) => {
      await page.goto(`/login?konto=${value}`);

      await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
      await expect(page.getByText(NOTICE)).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("boese");
      await expect(page.locator("main")).not.toContainText("oder nicht");
    });
  }

  test("the notice does not hide a login error: both statuses show together", async ({ page }) => {
    await page.goto("/login?konto=geloescht&fehler=anmeldung");

    await expect(page.getByRole("status").filter({ hasText: NOTICE })).toBeVisible();
    expect(await page.getByRole("status").count()).toBeGreaterThanOrEqual(2);
  });
});
