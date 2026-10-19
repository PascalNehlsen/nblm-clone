// F2 end-to-end: the demo login from /login (spec .git/F2-SPEC.md). The local stack has
// anonymous sign-in on and no captcha, and no NEXT_PUBLIC_TURNSTILE_SITE_KEY, so the
// button signs in without a token. The seed registers the demo template (supabase/seed.sql,
// titles in tests/rls/helpers/demo.ts); the F1 trigger copies its ready sources.
import { expect, test } from "@playwright/test";
import { SEED_READY_SOURCES } from "../rls/helpers/demo";

const NOTEBOOK_URL = /\/notebooks\/[0-9a-f-]{36}$/;

test.describe("demo login", () => {
  test("the login page offers the demo button and the retention line", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Demo starten (ohne Anmeldung)" })).toBeVisible();
    await expect(page.getByText("Die Demo-Daten werden nach 24 Stunden gelöscht.")).toBeVisible();
  });

  test("the login page does not contact Cloudflare before the click", async ({ page }) => {
    const hosts: string[] = [];
    page.on("request", (request) => hosts.push(new URL(request.url()).hostname));
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    expect(hosts.filter((host) => host.endsWith("cloudflare.com"))).toEqual([]);
    await expect(page.locator('script[src*="challenges.cloudflare.com"]')).toHaveCount(0);
  });

  test("Demo starten lands on the notebook list, and the copied notebook has its two ready sources", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Demo starten (ohne Anmeldung)" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();

    await page.getByRole("link", { name: /Demo: Beispielquellen/ }).click();
    await page.waitForURL(NOTEBOOK_URL);

    await expect(page.getByRole("heading", { name: "Demo: Beispielquellen" })).toBeVisible();

    const sources = page.locator("section").filter({ has: page.getByRole("heading", { name: "Quellen", exact: true }) });
    const items = sources.getByRole("listitem");
    await expect(items).toHaveCount(SEED_READY_SOURCES.length);
    for (const source of SEED_READY_SOURCES) {
      await expect(items.filter({ hasText: source.title })).toHaveCount(1);
    }
    await expect(items.filter({ hasText: "Bereit" })).toHaveCount(SEED_READY_SOURCES.length);
    // The template's pending source is never copied.
    await expect(page.getByText("Beispiel: Noch in Arbeit.txt")).toHaveCount(0);
  });

  test("the notebook has no 24 hour note, no delete button, no source controls, but the chat form", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Demo starten (ohne Anmeldung)" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("link", { name: /Demo: Beispielquellen/ }).click();
    await page.waitForURL(NOTEBOOK_URL);
    await expect(page.getByRole("heading", { name: "Demo: Beispielquellen" })).toBeVisible();

    await expect(page.getByRole("note")).toHaveCount(0);
    await expect(page.getByText("werden nach 24 Stunden gelöscht")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Notizbuch löschen" })).toHaveCount(0);

    await expect(page.getByText("Quelle hinzufügen")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Quelle hinzufügen" })).toHaveCount(0);
    await expect(page.getByLabel("PDF-Datei")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hochladen" })).toHaveCount(0);
    const sources = page.locator("section").filter({ has: page.getByRole("heading", { name: "Quellen", exact: true }) });
    await expect(sources.getByRole("button", { name: "Entfernen" })).toHaveCount(0);

    const chat = page.locator("section").filter({ has: page.getByRole("heading", { name: "Fragen", exact: true }) });
    await expect(chat.getByLabel("Frage")).toBeVisible();
    await expect(chat.getByRole("button", { name: "Fragen", exact: true })).toBeEnabled();
  });
});
