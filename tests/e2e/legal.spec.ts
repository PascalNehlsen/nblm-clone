// Public legal pages (/impressum, /datenschutz) and the footer that links them
// from every page. Real local session for the signed-in case (helpers/session.ts).
import { expect, test, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

const EM_DASH = "—";

async function expectFooterLinks(page: Page): Promise<void> {
  const footer = page.getByRole("contentinfo");
  await expect(footer).toHaveCount(1);
  const impressum = footer.getByRole("link", { name: "Impressum" });
  const datenschutz = footer.getByRole("link", { name: "Datenschutz", exact: true });
  await expect(impressum).toBeVisible();
  await expect(datenschutz).toBeVisible();
  await expect(impressum).toHaveAttribute("href", "/impressum");
  await expect(datenschutz).toHaveAttribute("href", "/datenschutz");
}

test.describe("legal pages, signed out", () => {
  test("/impressum is public and names the provider", async ({ page }) => {
    const response = await page.goto("/impressum");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL((url) => url.pathname === "/impressum");
    await expect(page.getByRole("heading", { level: 1, name: "Impressum" })).toBeVisible();

    const body = page.locator("body");
    await expect(body).toContainText("Pascal Nehlsen");
    await expect(body).toContainText("Am Stadtwald 18");
    await expect(body).toContainText("42897 Remscheid");
    await expect(body).toContainText("mail@software-mit-pascal.de");
    expect(await body.innerText()).not.toContain(EM_DASH);
  });

  test("/datenschutz is public and names processors, retention and the authority", async ({ page }) => {
    const response = await page.goto("/datenschutz");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL((url) => url.pathname === "/datenschutz");
    await expect(page.getByRole("heading", { level: 1, name: "Datenschutzerklärung" })).toBeVisible();

    const body = page.locator("body");
    for (const term of [
      "Supabase",
      "Amazon Web Services",
      "Vercel",
      "GitHub",
      "Cloudflare Turnstile",
      "24 Stunden",
      "Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen",
    ]) {
      await expect(body).toContainText(term);
    }
    expect(await body.innerText()).not.toContain(EM_DASH);
  });

  test("neither legal page redirects to /login", async ({ page }) => {
    for (const path of ["/impressum", "/datenschutz"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(response?.request().redirectedFrom()).toBeNull();
    }
  });

  test("subpaths of the legal pages stay protected", async ({ page }) => {
    await page.goto("/impressum/x");
    expect(new URL(page.url()).pathname).toBe("/login");
  });
});

test.describe("footer on every page", () => {
  test("/login (signed out) has a footer linking Impressum and Datenschutz", async ({ page }) => {
    await page.goto("/login");
    await expectFooterLinks(page);
  });

  test("the legal pages themselves have the footer", async ({ page }) => {
    await page.goto("/impressum");
    await expectFooterLinks(page);
    await page.goto("/datenschutz");
    await expectFooterLinks(page);
  });

  test("/ (signed in) has the footer and its links lead to the legal pages", async ({ context }) => {
    await context.addCookies(await seedLocalSession("legal-e2e-footer"));
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();
    await expectFooterLinks(page);

    await page.getByRole("contentinfo").getByRole("link", { name: "Impressum" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/impressum");
    await expect(page.getByRole("heading", { level: 1, name: "Impressum" })).toBeVisible();

    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "Datenschutz", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/datenschutz");
    await expect(page.getByRole("heading", { level: 1, name: "Datenschutzerklärung" })).toBeVisible();
  });
});
