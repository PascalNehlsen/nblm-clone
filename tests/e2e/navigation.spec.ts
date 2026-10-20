// UX navigation fixes: empty-state copy, a way back from /profil, and a German
// not-found page with a way home. Real local sessions only (helpers/session.ts).
import { expect, test, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";
import { shareViaDialog } from "./helpers/dialogs";

async function createNotebookViaUi(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Titel").fill(title);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);
}

async function expectGermanNotFound(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Seite nicht gefunden" })).toBeVisible();
  const home = page.getByRole("link", { name: "Zu deinen Notizbüchern" });
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute("href", "/");
  // A short explanation besides heading and link.
  const main = page.locator("main");
  const text = (await main.count()) > 0 ? await main.innerText() : await page.locator("body").innerText();
  const explanation = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "Seite nicht gefunden" && line !== "Zu deinen Notizbüchern");
  expect(explanation.some((line) => line.length >= 15)).toBe(true);
}

test.describe("empty states", () => {
  test("home without notebooks explains the first step and no longer promises 'Bald kannst du'", async ({
    context,
  }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-empty-home"));
    const page = await context.newPage();
    await page.goto("/");

    await expect(
      page.getByText(
        "Noch keine Notizbücher. Leg unten dein erstes an, füg Quellen hinzu und stell Fragen dazu.",
      ),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Bald kannst du");
  });

  test("a new notebook without sources tells the user in the Fragen section to add a source first", async ({
    context,
  }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-empty-notebook"));
    const page = await context.newPage();
    await createNotebookViaUi(page, `Leer ${Date.now()}`);

    const fragen = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Fragen", exact: true }) });
    await expect(
      fragen.getByText(
        "Noch keine Quellen bereit. Füge links eine Quelle hinzu; sobald sie bereit ist, kannst du hier Fragen stellen.",
      ),
    ).toBeVisible();
  });

  test("a viewer of a shared notebook without sources is told that editors add sources, not to add one themselves", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    await ownerContext.addCookies(await seedLocalSession("navigation-e2e-viewer-empty-owner"));
    await viewerContext.addCookies(await seedLocalSession("navigation-e2e-viewer-empty-viewer"));
    const ownerPage = await ownerContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await viewerPage.goto("/profil");
    const viewerId = (await viewerPage.getByTestId("nutzer-id").innerText()).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0];
    if (!viewerId) throw new Error("no viewer id found on /profil");

    await createNotebookViaUi(ownerPage, `Leer geteilt ${Date.now()}`);
    const notebookUrl = ownerPage.url();
    await shareViaDialog(ownerPage, viewerId, "Betrachter");

    await viewerPage.goto(notebookUrl);
    const fragen = viewerPage
      .locator("section")
      .filter({ has: viewerPage.getByRole("heading", { name: "Fragen", exact: true }) });
    await expect(
      fragen.getByText(
        "Noch keine Quellen bereit. Sobald jemand mit Bearbeitungsrechten eine Quelle hinzufügt, kannst du hier Fragen stellen.",
      ),
    ).toBeVisible();
    await expect(viewerPage.locator("body")).not.toContainText("Füge links eine Quelle hinzu");

    await ownerContext.close();
    await viewerContext.close();
  });
});

test.describe("getting around", () => {
  test("the profile page links back to the notebook list", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-profil"));
    const page = await context.newPage();
    await page.goto("/profil");

    const back = page.getByRole("link", { name: "Alle Notizbücher" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();
  });

  test("the notebook header's 'Alle Notizbücher' link leads back to the list", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-header"));
    const page = await context.newPage();
    await createNotebookViaUi(page, `Zurueck ${Date.now()}`);

    await page.getByRole("link", { name: "Alle Notizbücher" }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();
  });
});

test.describe("navigation feedback", () => {
  test("the nav progress bar is active while a notebook loads and gone once it shows", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-nav-progress"));
    const page = await context.newPage();
    const title = `Fortschritt ${Date.now()}`;
    await createNotebookViaUi(page, title);

    await page.goto("/");
    const card = page.locator("main").locator('a[href^="/notebooks/"]').filter({ hasText: title }).first();
    await expect(card).toBeVisible();
    const progress = page.locator(".nav-progress");
    await expect(progress).not.toHaveAttribute("data-active", /.*/);

    // Delay the document/RSC request for the notebook so the pending state is observable.
    await page.route(/\/notebooks\/[0-9a-f-]{36}/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });

    await card.click();
    await expect(progress).toHaveAttribute("data-active", /.*/, { timeout: 900 });
    await expect(page).toHaveURL(/\/notebooks\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(progress).not.toHaveAttribute("data-active", /.*/);
  });
});

async function expectProfilInTopBar(page: Page): Promise<void> {
  const links = page.getByRole("link", { name: "Profil", exact: true });
  await expect(links).toHaveCount(1);
  const profil = links.first();
  await expect(profil).toBeVisible();
  await expect(profil).toHaveAttribute("href", "/profil");
  // Top bar, not page content.
  await expect(page.locator("main").getByRole("link", { name: "Profil", exact: true })).toHaveCount(0);
  // Same row as "Abmelden".
  const logout = page.getByRole("button", { name: "Abmelden" });
  await expect(logout).toBeVisible();
  const a = await profil.boundingBox();
  const b = await logout.boundingBox();
  if (!a || !b) throw new Error("no bounding box for Profil link or Abmelden button");
  expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(40);
}

test.describe("profile link in the top bar", () => {
  test("on the notebook list exactly one 'Profil' link sits next to Abmelden and leads to /profil", async ({
    context,
  }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-profil-home"));
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();

    await expectProfilInTopBar(page);

    await page.getByRole("link", { name: "Profil", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/profil");
    await expect(page.getByRole("heading", { name: "Profil", exact: true })).toBeVisible();
  });

  test("on a notebook page the 'Profil' link is present and leads to /profil", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-profil-notebook"));
    const page = await context.newPage();
    await createNotebookViaUi(page, `Profil ${Date.now()}`);

    await expectProfilInTopBar(page);

    await page.getByRole("link", { name: "Profil", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/profil");
    await expect(page.getByRole("heading", { name: "Profil", exact: true })).toBeVisible();
  });

  test("a signed-out visitor on /login sees no 'Profil' link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Profil", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Abmelden" })).toHaveCount(0);
  });
});

test.describe("not found", () => {
  test("an unknown path shows the German not-found page and keeps status 404", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-404-path"));
    const page = await context.newPage();
    const response = await page.goto("/gibt-es-nicht");

    expect(response?.status()).toBe(404);
    await expectGermanNotFound(page);
  });

  test("a missing notebook shows the same German not-found page", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-404-notebook"));
    const page = await context.newPage();
    const response = await page.goto("/notebooks/00000000-0000-4000-8000-000000000000");

    expect(response?.status()).toBe(404);
    await expectGermanNotFound(page);
  });

  test("the not-found link leads to the notebook list", async ({ context }) => {
    await context.addCookies(await seedLocalSession("navigation-e2e-404-link"));
    const page = await context.newPage();
    await page.goto("/gibt-es-nicht");

    await page.getByRole("link", { name: "Zu deinen Notizbüchern" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "Deine Notizbücher" })).toBeVisible();
  });
});
