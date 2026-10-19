// UX navigation fixes: empty-state copy, a way back from /profil, and a German
// not-found page with a way home. Real local sessions only (helpers/session.ts).
import { expect, test, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

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
    await ownerPage.getByLabel("Nutzer-ID").fill(viewerId);
    await ownerPage.getByLabel("Rolle").selectOption({ label: "Betrachter" });
    await ownerPage.getByRole("button", { name: "Teilen" }).click();
    await expect(ownerPage.getByText(viewerId.slice(0, 8))).toBeVisible();

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
