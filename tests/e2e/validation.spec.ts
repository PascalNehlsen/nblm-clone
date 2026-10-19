// The app's own validation messages and tooltips replace the browser's native
// HTML5 validation bubbles and title tooltips. Real local sessions only
// (helpers/session.ts).
import { expect, test, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

async function createNotebookViaUi(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Titel").fill(title);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);
}

test.describe("custom validation messages", () => {
  test("an empty notebook title shows the app's own alert below the field and no navigation happens", async ({
    context,
  }) => {
    await context.addCookies(await seedLocalSession("validation-e2e-empty-title"));
    const page = await context.newPage();
    await page.goto("/");

    const title = page.getByLabel("Titel");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Anlegen" }) });

    // An empty title attribute (present, not absent) suppresses Firefox's
    // native hover tooltip. Native validation itself stays on.
    expect(await page.evaluate(() => document.querySelector("input[name=title]")?.getAttribute("title"))).toBe("");

    const before = page.url();
    await page.getByRole("button", { name: "Anlegen" }).click();

    const alert = form.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("Bitte füll dieses Feld aus.");
    await expect(title).toHaveAttribute("aria-invalid", "true");

    const alertId = await alert.getAttribute("id");
    expect(alertId).toBeTruthy();
    await expect(title).toHaveAttribute("aria-describedby", new RegExp(`(^|\\s)${alertId}(\\s|$)`));

    // Directly below the field.
    const t = await title.boundingBox();
    const a = await alert.boundingBox();
    if (!t || !a) throw new Error("no bounding box for title input or alert");
    expect(a.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
    expect(a.y - (t.y + t.height)).toBeLessThan(60);

    // No navigation.
    expect(page.url()).toBe(before);
    await expect(page).toHaveURL((url) => url.pathname === "/");

    // Typing clears the message and aria-invalid.
    await title.fill("a");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(title).not.toHaveAttribute("aria-invalid", "true");
  });

  test("a non-URL Webadresse shows the app's own alert below the field", async ({ context }) => {
    await context.addCookies(await seedLocalSession("validation-e2e-bad-url"));
    const page = await context.newPage();
    await createNotebookViaUi(page, `Validierung ${Date.now()}`);

    const section = page.locator("section").filter({ has: page.getByRole("tablist", { name: "Art der Quelle" }) });
    const tab = section
      .getByRole("tablist", { name: "Art der Quelle" })
      .getByRole("tab", { name: "Webseite", exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");

    const form = section.getByRole("tabpanel").locator("form");
    await expect(form).toHaveCount(1);
    await form.getByLabel("Titel").fill("Meine Seite");
    const url = form.getByLabel("Webadresse");
    await url.fill("keine adresse");
    await form.getByRole("button", { name: "Seite hinzufügen" }).click();

    const alert = form.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("Bitte gib eine gültige Webadresse ein.");
    await expect(url).toHaveAttribute("aria-invalid", "true");

    const u = await url.boundingBox();
    const a = await alert.boundingBox();
    if (!u || !a) throw new Error("no bounding box for Webadresse input or alert");
    expect(a.y).toBeGreaterThanOrEqual(u.y + u.height - 1);
    expect(a.y - (u.y + u.height)).toBeLessThan(60);
  });
});

test.describe("custom tooltips", () => {
  test("the top-bar Profil link has no title attribute and shows its own tooltip on hover", async ({ context }) => {
    await context.addCookies(await seedLocalSession("validation-e2e-tooltip"));
    const page = await context.newPage();
    await page.goto("/");

    const profil = page.getByRole("link", { name: "Profil", exact: true });
    await expect(profil).toHaveCount(1);
    await expect(profil).not.toHaveAttribute("title", /.*/);

    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await profil.hover();
    const tip = page.getByRole("tooltip", { name: "Profil" });
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText("Profil");
  });
});
