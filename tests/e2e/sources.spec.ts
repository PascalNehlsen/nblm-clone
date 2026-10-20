// PR C1 end-to-end: the "Quellen" section on the notebook page and its
// server actions, driven with real, freshly-created local sessions (see
// helpers/session.ts) -- never a test-only login route, never a test-only
// provider switch, never the admin/service-role credential (ADR 0005).
//
// No BEDROCK_EMBEDDING_MODEL_ID is configured for this local/CI run (and no
// model provider credentials exist in the sandbox at all, per AGENTS.md), so
// every real ingestion attempt below is expected to fail closed at the model
// wrapper with the category "model_not_configured" -- rendered as "Fehlgeschlagen:
// Modell nicht konfiguriert" (lib/ops/categories.ts). That is the honest,
// secure result of this environment having no model credentials: the PDF/
// text extraction and chunking steps must still have run (and succeeded) for
// ingestion to even reach the model-call step, so this also exercises the
// real upload/extract/chunk pipeline, not just the final failure state.
//
// Expected UI contract communicated to the builder, on top of C1-API-SPEC.md's
// prose (same "fix a concrete markup" approach as tests/e2e/notebooks.spec.ts):
// the "Quellen" section is a <section> whose heading is "Quellen", and its
// list of sources is rendered as list items (role "listitem", e.g. a plain
// <ul>/<li>) so each source's title, status text and per-source buttons can
// be scoped to its own row -- the same shape MemberList already uses for
// members on this same page.
//
// Both forms on the notebook page (PDF upload, add text) have a field with
// the same accessible label "Titel" (see the C1 UI contract), so every
// locator below scopes to the specific <form> that also contains that form's
// other distinguishing field ("PDF-Datei" or "Text") before looking up
// "Titel" -- a bare `page.getByLabel("Titel")` would be ambiguous. Likewise,
// MemberList (tests/e2e/notebooks.spec.ts) already uses an "Entfernen" button
// per member row on this same page, so every "Entfernen" lookup below is
// scoped to the "Quellen" section specifically (a <section> containing the
// "Quellen" heading), never the bare page.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { seedLocalSession, seedLocalSessionWithClient } from "./helpers/session";
import { openAddSourceDialog, openSourceForm, shareViaDialog } from "./helpers/dialogs";
import { createSource, setSourceStatus } from "../rls/helpers/sources";

/** A hand-written, minimal but valid single-page PDF containing the text
 * "Hello World" -- built (not hardcoded) so its xref byte offsets are always
 * correct, regardless of how the surrounding comment text changes. Deliberately
 * uncompressed and index-correct: this must be real, extractable text, not
 * just a file that starts with "%PDF-" -- the ingestion pipeline's content/
 * magic-bytes check and PDF text extraction both have to succeed for the
 * pipeline to reach (and fail at) the model-call step, which is what these
 * tests are actually pinning down. */
function buildMinimalPdf(): Buffer {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> " +
      "/MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const streamContent = "BT /F1 24 Tf 10 100 Td (Hello World) Tj ET";
  objects.push(`5 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`);

  let body = header;
  const offsets: number[] = [0]; // object 0 is the free-list head
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${offsets[i]!.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body + xref + trailer, "latin1");
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractUuid(text: string): string {
  const match = text.match(UUID_PATTERN);
  if (!match) throw new Error(`extractUuid: no uuid found in: ${text.slice(0, 200)}`);
  return match[0];
}

async function createNotebookViaUi(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Titel").fill(title);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);
  return page.url();
}

/** Returns the `<section>` that contains the "Quellen" heading, scoping every
 * locator below away from MemberList's own same-labelled controls. */
function sourcesSection(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Quellen" }) });
}

/** The add-source area is a modal dialog opened by the button "Quelle hinzufügen". Inside it
 * is a tab switcher: tablist "Art der Quelle" with the tabs "Text", "PDF" and "Webseite",
 * each controlling one tabpanel with its form. Only the selected panel is visible (the
 * others carry `hidden`), so `openSourceForm` (helpers/dialogs.ts) opens the dialog, clicks
 * the tab and returns the form inside the one visible panel. */

/** The PDF upload form ("PDF-Datei", "Titel", "Hochladen"). */
async function pdfForm(page: Page) {
  const form = await openSourceForm(page, "PDF");
  await expect(form.getByLabel("PDF-Datei")).toBeVisible();
  return form;
}

/** The add-text form ("Titel", "Text", "Text hinzufügen"). */
async function textForm(page: Page) {
  const form = await openSourceForm(page, "Text");
  await expect(form.getByRole("button", { name: "Text hinzufügen" })).toBeVisible();
  return form;
}

/** The add-URL form (C2) ("Titel", "Webadresse", "Seite hinzufügen"). */
async function urlForm(page: Page) {
  const form = await openSourceForm(page, "Webseite");
  await expect(form.getByLabel("Webadresse")).toBeVisible();
  return form;
}

/** Shares `notebookUrl` (created by `owner`) with a fresh user as `role`
 * ("Bearbeiter" or "Betrachter") and returns that member's own page/context,
 * ready at the notebook URL. */
async function shareWithFreshMember(
  browser: Browser,
  label: string,
  role: "Bearbeiter" | "Betrachter",
): Promise<{ ownerContext: BrowserContext; memberContext: BrowserContext; memberPage: Page; notebookUrl: string }> {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  await ownerContext.addCookies(await seedLocalSession(`${label}-owner`));
  await memberContext.addCookies(await seedLocalSession(`${label}-member`));
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();

  await memberPage.goto("/profil");
  const memberId = extractUuid(await memberPage.getByTestId("nutzer-id").innerText());

  const notebookUrl = await createNotebookViaUi(ownerPage, `${label} ${Date.now()}`);
  await shareViaDialog(ownerPage, memberId, role);

  await memberPage.goto(notebookUrl);
  return { ownerContext, memberContext, memberPage, notebookUrl };
}

test.describe("a viewer sees the sources list but no way to add sources", () => {
  test("the Quellen heading is visible, with no PDF-Datei input and no Text hinzufügen button", async ({
    browser,
  }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-viewer",
      "Betrachter",
    );

    await expect(sourcesSection(memberPage).getByRole("heading", { name: "Quellen" })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Quelle hinzufügen" })).toHaveCount(0);
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);
    // No add-source dialog is rendered for a viewer at all, not even a closed one.
    await expect(memberPage.getByRole("tablist", { name: "Art der Quelle" })).toHaveCount(0);
    await expect(memberPage.locator("dialog").filter({ has: memberPage.locator('input[type="file"]') })).toHaveCount(0);
    await expect(memberPage.getByLabel("PDF-Datei")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Text hinzufügen" })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Hochladen" })).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });
});

test.describe("the add-source area is a tab switcher", () => {
  test("Text is selected by default, PDF and Webseite stay hidden until clicked, one form at a time", async ({
    browser,
  }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-tabs",
      "Bearbeiter",
    );
    // The tab switcher lives in the dialog behind "Quelle hinzufügen", not on the page.
    await expect(memberPage.getByRole("tablist", { name: "Art der Quelle" })).toHaveCount(0);
    const section = await openAddSourceDialog(memberPage);
    const tablist = section.getByRole("tablist", { name: "Art der Quelle" });
    await expect(tablist).toBeVisible();
    await expect(tablist.getByRole("tab")).toHaveCount(3);
    const textTab = tablist.getByRole("tab", { name: "Text", exact: true });
    const pdfTab = tablist.getByRole("tab", { name: "PDF", exact: true });
    const urlTab = tablist.getByRole("tab", { name: "Webseite", exact: true });

    // Default: Text selected, the others not; exactly one visible panel and form.
    await expect(textTab).toHaveAttribute("aria-selected", "true");
    await expect(pdfTab).toHaveAttribute("aria-selected", "false");
    await expect(urlTab).toHaveAttribute("aria-selected", "false");
    await expect(section.locator('[role="tabpanel"]')).toHaveCount(3);
    await expect(section.locator('[role="tabpanel"][hidden]')).toHaveCount(2);
    await expect(section.getByRole("tabpanel")).toHaveCount(1);
    await expect(section.locator("form:visible")).toHaveCount(1);
    await expect(section.getByRole("button", { name: "Text hinzufügen" })).toBeVisible();
    // getByLabel does not skip hidden elements, so assert hidden, not absent.
    await expect(section.getByLabel("PDF-Datei")).toBeHidden();
    await expect(section.getByLabel("Webadresse")).toBeHidden();

    // Each tab controls its own panel.
    const textPanelId = await textTab.getAttribute("aria-controls");
    expect(textPanelId).toBeTruthy();

    await pdfTab.click();
    await expect(pdfTab).toHaveAttribute("aria-selected", "true");
    await expect(textTab).toHaveAttribute("aria-selected", "false");
    await expect(section.getByRole("tabpanel")).toHaveCount(1);
    await expect(section.locator("form:visible")).toHaveCount(1);
    await expect(section.getByLabel("PDF-Datei")).toBeVisible();
    await expect(section.getByRole("button", { name: "Hochladen" })).toBeVisible();
    await expect(section.getByRole("button", { name: "Text hinzufügen" })).toHaveCount(0);
    await expect(memberPage.locator(`#${textPanelId}`)).toHaveAttribute("hidden", /.*/);

    await urlTab.click();
    await expect(urlTab).toHaveAttribute("aria-selected", "true");
    await expect(pdfTab).toHaveAttribute("aria-selected", "false");
    await expect(section.getByRole("tabpanel")).toHaveCount(1);
    await expect(section.locator("form:visible")).toHaveCount(1);
    await expect(section.getByLabel("Webadresse")).toBeVisible();
    await expect(section.getByRole("button", { name: "Seite hinzufügen" })).toBeVisible();
    await expect(section.getByLabel("PDF-Datei")).toBeHidden();

    await ownerContext.close();
    await memberContext.close();
  });
});

test.describe("an editor uploads a PDF source", () => {
  test("the source appears in the list and ends up Fehlgeschlagen: Modell nicht konfiguriert", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-pdf",
      "Bearbeiter",
    );
    const title = `Test-PDF ${Date.now()}`;

    const form = await pdfForm(memberPage);
    await form.getByLabel("PDF-Datei").setInputFiles({
      name: "test.pdf",
      mimeType: "application/pdf",
      buffer: buildMinimalPdf(),
    });
    await form.getByLabel("Titel").fill(title);
    await form.getByRole("button", { name: "Hochladen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });
    // A finished upload closes the dialog.
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });
});

test.describe("an editor adds a text source", () => {
  test("the source appears in the list and ends up Fehlgeschlagen: Modell nicht konfiguriert", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-text",
      "Bearbeiter",
    );
    const title = `Test-Text ${Date.now()}`;

    const form = await textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Hallo, dies ist ein Testtext für die Ingestion.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });
    // The dialog closes once the action is done.
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });
});

// C2 (URL import). No external network is used: every address below is refused by the
// SSRF guard's syntactic check (parseImportUrl) in addUrlSourceAction before any row is
// inserted, so nothing is ever fetched. 127.0.0.1 and 169.254.169.254 are IP literals in
// blocked ranges (on a GitHub runner the latter is a live metadata endpoint, which is why
// it must never be requested), localhost is refused by name, ftp: by scheme. Per
// .git/C2-API-SPEC.md the action answers each with the "url" form error and creates no row.
const URL_ERROR_TEXT = "Bitte gib eine http- oder https-Adresse ohne Zugangsdaten und ohne Port an.";

test.describe("a viewer cannot import a URL", () => {
  test("no Webadresse field and no Seite hinzufügen button", async ({ browser }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-url-viewer",
      "Betrachter",
    );

    await expect(sourcesSection(memberPage).getByRole("heading", { name: "Quellen" })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Quelle hinzufügen" })).toHaveCount(0);
    await expect(memberPage.getByLabel("Webadresse")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Seite hinzufügen" })).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });
});

test.describe("an editor sees the URL form", () => {
  test("a Webadresse field (type url) and a Seite hinzufügen button", async ({ browser }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-url-form",
      "Bearbeiter",
    );

    const form = await urlForm(memberPage);
    await expect(form.getByLabel("Titel")).toBeVisible();
    await expect(form.getByLabel("Webadresse")).toHaveAttribute("type", "url");
    await expect(form.getByLabel("Webadresse")).toHaveAttribute("maxlength", "2048");
    await expect(form.getByRole("button", { name: "Seite hinzufügen" })).toBeVisible();

    await ownerContext.close();
    await memberContext.close();
  });
});

test.describe("an editor imports an address the guard refuses", () => {
  const REFUSED_ADDRESSES = [
    { name: "loopback IP literal", address: "http://127.0.0.1/" },
    { name: "cloud metadata IP literal", address: "http://169.254.169.254/latest/meta-data/" },
    { name: "localhost by name", address: "http://localhost/" },
    { name: "a non-http scheme (ftp)", address: "ftp://example.com/" },
  ];

  for (const { name, address } of REFUSED_ADDRESSES) {
    test(`${name} (${address}): the url error is shown and no source row is created`, async ({ browser }) => {
      test.setTimeout(60_000);
      const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
        browser,
        "sources-e2e-url-refused",
        "Bearbeiter",
      );
      const title = `Test-URL ${Date.now()}`;

      const form = await urlForm(memberPage);
      await form.getByLabel("Titel").fill(title);
      await form.getByLabel("Webadresse").fill(address);
      await form.getByRole("button", { name: "Seite hinzufügen" }).click();

      // The redirect closes the dialog; the error shows in the notebook header.
      await expect(memberPage.locator(".nb-head").getByRole("alert")).toHaveText(URL_ERROR_TEXT, {
        timeout: 45_000,
      });
      await expect(memberPage.getByRole("dialog")).toHaveCount(0);
      await expect(memberPage).toHaveURL(/fehler=url/);
      await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);

      await ownerContext.close();
      await memberContext.close();
    });
  }
});

// Layout bugs seen at desktop width (1440x900, sources panel about 320px wide).
test.describe("source rows and the upload form fit the narrow sources panel", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function ownerNotebook(browser: Browser, label: string) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const session = await seedLocalSessionWithClient(label);
    await context.addCookies(session.cookies);
    const page = await context.newPage();
    const notebookUrl = await createNotebookViaUi(page, `${label} ${Date.now()}`);
    const notebookId = new URL(notebookUrl).pathname.split("/").pop()!;
    // Seeding helpers only use `client`; the token is not needed here.
    const owner = { client: session.client, userId: session.userId, accessToken: "" };
    return { context, page, notebookId, owner };
  }

  test("a failed source with a long status keeps its short title on one line", async ({ browser }) => {
    const { context, page, notebookId, owner } = await ownerNotebook(browser, "sources-e2e-layout-title");
    const sourceId = await createSource(owner, notebookId, { kind: "text", title: "Test" });
    await setSourceStatus(owner, sourceId, "failed", "no_text");
    await page.reload();

    const row = sourcesSection(page).getByRole("listitem").filter({ hasText: "Kein Text gefunden" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Fehlgeschlagen: Kein Text gefunden");
    const status = row.locator(".status");
    await expect(status).toBeVisible();

    const title = row.locator(".title");
    await expect(title).toHaveText("Test");
    const box = await title.boundingBox();
    expect(box).not.toBeNull();
    // One line is about 20px; wrapping one letter per line gives 80px or more.
    expect(box!.height).toBeLessThan(40);
    expect(box!.width).toBeGreaterThanOrEqual(40);

    await context.close();
  });

  test("a chosen PDF with a long file name does not push the file input out of the panel", async ({ browser }) => {
    const { context, page } = await ownerNotebook(browser, "sources-e2e-layout-pdf");

    const form = await pdfForm(page);
    const input = form.getByLabel("PDF-Datei");
    await input.setInputFiles({
      name: "Flyer_A_sachlich_Druckerei_CMYK_mit_sehr_langem_Namen.pdf",
      mimeType: "application/pdf",
      buffer: buildMinimalPdf(),
    });

    // The upload form now sits in the add-source dialog, which is the panel it must fit.
    const panelBox = await page.getByRole("dialog").boundingBox();
    const inputBox = await input.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);

    await context.close();
  });

  test("a chosen PDF with a 120-character file name shows its full name, wrapped inside the form", async ({
    browser,
  }) => {
    const { context, page } = await ownerNotebook(browser, "sources-e2e-layout-longname");

    const form = await pdfForm(page);
    const input = form.getByLabel("PDF-Datei");
    // No spaces or hyphens: the name has no natural break point, so it only fits if it wraps anywhere.
    const fileName = `${"Flyer_A_sachlich_Druckerei_CMYK_".repeat(4)}Ende.pdf`;
    expect(fileName.length).toBeGreaterThanOrEqual(120);
    await input.setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: buildMinimalPdf() });

    // The input stays visible and labelled; the full name is shown in a separate element.
    await expect(input).toBeVisible();
    const nameElement = form.getByText(fileName, { exact: true });
    await expect(nameElement).toBeVisible();

    const formBox = (await form.boundingBox())!;
    const nameBox = (await nameElement.boundingBox())!;
    expect(formBox).toBeTruthy();
    expect(nameBox).toBeTruthy();
    expect(nameBox.x).toBeGreaterThanOrEqual(formBox.x - 1);
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(formBox.x + formBox.width + 1);
    // It wraps instead of truncating: more than one line high.
    const lineHeight = await nameElement.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
    expect(nameBox.height).toBeGreaterThan(lineHeight * 1.5);
    // Not clipped by an ellipsis and no horizontal overflow of the form.
    const style = await nameElement.evaluate((el) => {
      const s = getComputedStyle(el);
      return { textOverflow: s.textOverflow, whiteSpace: s.whiteSpace };
    });
    expect(style.textOverflow).not.toBe("ellipsis");
    expect(style.whiteSpace).not.toBe("nowrap");
    expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const inputBox = (await input.boundingBox())!;
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(formBox.x + formBox.width + 1);

    await context.close();
  });
});

test.describe("an editor removes a source", () => {
  test("Entfernen removes the source from the list", async ({ browser }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-remove",
      "Bearbeiter",
    );
    const title = `Zu entfernen ${Date.now()}`;

    const form = await textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Wird gleich wieder entfernt.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Entfernen" }).click();
    const dialog = memberPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Endgültig entfernen" }).click();
    await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    // The dialog closes with the submit, it does not stay open over the page.
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });

  test("Entfernen only opens a confirmation dialog, and Abbrechen keeps the source", async ({ browser }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-remove-cancel",
      "Bearbeiter",
    );
    const title = `Bleibt ${Date.now()}`;

    const form = await textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Bleibt nach Abbrechen erhalten.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);

    await row.getByRole("button", { name: "Entfernen" }).click();
    const dialog = memberPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Quelle entfernen?" })).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(new RegExp(title));
    await expect(dialog).toHaveAccessibleDescription(/wird mit ihren Abschnitten aus dem Notizbuch entfernt/);
    await expect(dialog.getByRole("button", { name: "Abbrechen" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Endgültig entfernen" })).toBeVisible();

    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(memberPage.getByRole("dialog")).toHaveCount(0);
    await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(1);

    await memberPage.reload();
    await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(1);

    await ownerContext.close();
    await memberContext.close();
  });

  test("the server rejects a removal whose hidden confirmation input was removed (fehler=bestaetigung_quelle), the source stays", async ({
    browser,
  }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-remove-guard",
      "Bearbeiter",
    );
    const title = `Geschuetzt ${Date.now()}`;

    const form = await textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Darf ohne Bestätigung nicht verschwinden.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toBeVisible();
    const notebookPath = new URL(memberPage.url()).pathname;

    await row.getByRole("button", { name: "Entfernen" }).click();
    const dialog = memberPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Located by type and value, not by name: production builds prefix server-action field names.
    const hidden = memberPage.getByRole("dialog").locator("form input[type=hidden][value=on]");
    await expect(hidden).toHaveCount(1);
    await hidden.evaluate((input) => input.remove());

    await dialog.getByRole("button", { name: "Endgültig entfernen" }).click();
    await memberPage.waitForURL(
      (url) => url.pathname === notebookPath && url.searchParams.has("fehler"),
    );
    expect(new URL(memberPage.url()).searchParams.get("fehler")).toBe("bestaetigung_quelle");

    await memberPage.goto(notebookPath);
    await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(1);

    await ownerContext.close();
    await memberContext.close();
  });
});
