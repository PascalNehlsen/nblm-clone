// Account deletion in the browser: the danger zone on /profil, its confirmation dialog, and the
// fail-closed behaviour. The happy path (notebooks, Storage objects and rows really gone) is
// covered by tests/rls/account_deletion.test.ts and supabase/tests/database/080_account_deletion
// .test.sql: this suite starts the web server WITHOUT an admin key (playwright.config.ts passes
// only the URL and the publishable key), so a submitted deletion must fail closed, delete
// nothing and keep the session. Run it without the admin key in the environment: the web
// server inherits process.env.
//
// UI contract pinned here (communicated to the builder):
//   /profil, regular user   a danger zone with the button "Konto löschen"; its dialog has the
//                           heading "Konto löschen?", the buttons "Abbrechen" and "Endgültig löschen",
//                           and a description that names how many notebooks will be deleted
//                           ("1 Notizbuch" / "2 Notizbücher") and, when some are shared, how many of
//                           them ("1 davon geteilt") and that members lose access ("Zugriff")
//   /profil, demo user      the button "Demo beenden und Daten löschen" instead (no "Konto löschen")
//   failed deletion         redirect to /profil?fehler=konto_loeschen with an element role=alert
//                           reading "Das Konto konnte nicht gelöscht werden."
//   missing confirmation    redirect to /profil?fehler=bestaetigung, nothing deleted
import { expect, test, type Browser, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function createNotebookViaUi(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Titel").fill(title);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);
  return page.url();
}

async function expectNotebookStillThere(page: Page, notebookUrl: string, title: string): Promise<void> {
  const response = await page.goto(notebookUrl);
  expect(response?.status()).not.toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function expectStillSignedIn(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
}

async function profileId(page: Page): Promise<string> {
  await page.goto("/profil");
  const text = await page.getByTestId("nutzer-id").innerText();
  const match = text.match(UUID_PATTERN);
  if (!match) throw new Error(`no user id on /profil: ${text.slice(0, 100)}`);
  return match[0];
}

test.describe("the danger zone on /profil", () => {
  test("shows a Konto löschen button that only opens a dialog", async ({ context }) => {
    await context.addCookies(await seedLocalSession("acct-e2e-zone"));
    const page = await context.newPage();
    await page.goto("/profil");

    await expect(page.getByRole("button", { name: "Konto löschen" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Konto löschen" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Konto löschen?" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Abbrechen" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Endgültig löschen" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/profil");
  });

  test("the dialog names the consequences: one unshared notebook", async ({ context }) => {
    await context.addCookies(await seedLocalSession("acct-e2e-one"));
    const page = await context.newPage();
    await createNotebookViaUi(page, `Konto-Test ${Date.now()}`);

    await page.goto("/profil");
    await page.getByRole("button", { name: "Konto löschen" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleDescription(/\b1 Notizbuch\b/);
    await expect(dialog).not.toHaveAccessibleDescription(/geteilt/);
  });

  test("the dialog names the consequences: two notebooks, one shared, members lose access", async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    await ownerContext.addCookies(await seedLocalSession("acct-e2e-share-owner"));
    await viewerContext.addCookies(await seedLocalSession("acct-e2e-share-viewer"));
    const ownerPage = await ownerContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const viewerId = await profileId(viewerPage);

    await createNotebookViaUi(ownerPage, `Konto-Privat ${Date.now()}`);
    await createNotebookViaUi(ownerPage, `Konto-Geteilt ${Date.now()}`);
    await ownerPage.getByLabel("Nutzer-ID").fill(viewerId);
    await ownerPage.getByLabel("Rolle").selectOption({ label: "Betrachter" });
    await ownerPage.getByRole("button", { name: "Teilen" }).click();
    await expect(ownerPage.getByText(viewerId.slice(0, 8))).toBeVisible();

    await ownerPage.goto("/profil");
    await ownerPage.getByRole("button", { name: "Konto löschen" }).click();
    const dialog = ownerPage.getByRole("dialog");
    await expect(dialog).toHaveAccessibleDescription(/\b2 Notizbücher\b/);
    await expect(dialog).toHaveAccessibleDescription(/\b1 davon geteilt\b/);
    await expect(dialog).toHaveAccessibleDescription(/Zugriff/);

    await ownerContext.close();
    await viewerContext.close();
  });

  test("Abbrechen keeps the account and the notebooks", async ({ context }) => {
    await context.addCookies(await seedLocalSession("acct-e2e-cancel"));
    const page = await context.newPage();
    const title = `Abbrechen-Konto ${Date.now()}`;
    const notebookUrl = await createNotebookViaUi(page, title);

    await page.goto("/profil");
    await page.getByRole("button", { name: "Konto löschen" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/profil");
    expect(new URL(page.url()).searchParams.has("fehler")).toBe(false);

    await expectNotebookStillThere(page, notebookUrl, title);
    await expectStillSignedIn(page);
  });

  test("an anonymous demo user sees Demo beenden und Daten löschen instead of Konto löschen", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Demo starten (ohne Anmeldung)" }).click();
    await page.waitForURL((url) => url.pathname === "/");

    await page.goto("/profil");
    await expect(page.getByRole("button", { name: "Demo beenden und Daten löschen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Konto löschen" })).toHaveCount(0);

    await page.getByRole("button", { name: "Demo beenden und Daten löschen" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(/\b1 Notizbuch\b/);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("fail closed", () => {
  test("without an admin key, confirming shows the error, deletes no notebook and keeps the session", async ({ context }) => {
    await context.addCookies(await seedLocalSession("acct-e2e-failclosed"));
    const page = await context.newPage();
    const title = `Fail-Closed ${Date.now()}`;
    const notebookUrl = await createNotebookViaUi(page, title);

    await page.goto("/profil");
    await page.getByRole("button", { name: "Konto löschen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Endgültig löschen" }).click();

    await page.waitForURL((url) => url.pathname === "/profil" && url.searchParams.has("fehler"));
    expect(new URL(page.url()).searchParams.get("fehler")).toBe("konto_loeschen");
    // Scoped to <main>: Next.js adds its own role=alert route announcer outside it after a client navigation.
    await expect(page.locator("main").getByRole("alert")).toHaveText("Das Konto konnte nicht gelöscht werden.");

    await expectNotebookStillThere(page, notebookUrl, title);
    await expectStillSignedIn(page);
  });

  test("the server rejects a deletion whose hidden confirmation input was removed (fehler=bestaetigung)", async ({ context }) => {
    // The hidden input is located by type and value, not by name: production builds prefix
    // server-action field names.
    await context.addCookies(await seedLocalSession("acct-e2e-guard"));
    const page = await context.newPage();
    const title = `Konto-Guard ${Date.now()}`;
    const notebookUrl = await createNotebookViaUi(page, title);

    await page.goto("/profil");
    await page.getByRole("button", { name: "Konto löschen" }).click();
    const dialog = page.getByRole("dialog");
    const hidden = dialog.locator("form input[type=hidden][value=on]");
    await expect(hidden).toHaveCount(1);
    await hidden.evaluate((input) => input.remove());
    await dialog.getByRole("button", { name: "Endgültig löschen" }).click();

    await page.waitForURL((url) => url.pathname === "/profil" && url.searchParams.has("fehler"));
    expect(new URL(page.url()).searchParams.get("fehler")).toBe("bestaetigung");

    await expectNotebookStillThere(page, notebookUrl, title);
    await expectStillSignedIn(page);
  });

  test("a visitor without a session cannot reach the danger zone", async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/profil");
    expect(new URL(page.url()).pathname).toBe("/login");
    await expect(page.getByRole("button", { name: "Konto löschen" })).toHaveCount(0);
    await context.close();
  });
});
