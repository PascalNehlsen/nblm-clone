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
import { seedLocalSession } from "./helpers/session";

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

/** The PDF upload form, identified by its "PDF-Datei" file input -- not by
 * position, since the C1 contract only fixes the two forms' own fields. */
function pdfForm(page: Page) {
  return sourcesSection(page)
    .locator("form")
    .filter({ has: page.getByLabel("PDF-Datei") });
}

/** The add-text form, identified by its "Text" textarea. */
function textForm(page: Page) {
  return sourcesSection(page)
    .locator("form")
    .filter({ has: page.getByLabel("Text", { exact: true }) });
}

/** The add-URL form (C2), identified by its "Webadresse" field. */
function urlForm(page: Page) {
  return sourcesSection(page)
    .locator("form")
    .filter({ has: page.getByLabel("Webadresse") });
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
  await ownerPage.getByLabel("Nutzer-ID").fill(memberId);
  await ownerPage.getByLabel("Rolle").selectOption({ label: role });
  await ownerPage.getByRole("button", { name: "Teilen" }).click();
  await expect(ownerPage.getByText(memberId.slice(0, 8))).toBeVisible();

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
    await expect(memberPage.getByLabel("PDF-Datei")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Text hinzufügen" })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Hochladen" })).toHaveCount(0);

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

    const form = pdfForm(memberPage);
    await form.getByLabel("PDF-Datei").setInputFiles({
      name: "test.pdf",
      mimeType: "application/pdf",
      buffer: buildMinimalPdf(),
    });
    await form.getByLabel("Titel").fill(title);
    await form.getByRole("button", { name: "Hochladen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });

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

    const form = textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Hallo, dies ist ein Testtext für die Ingestion.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });

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

    const form = urlForm(memberPage);
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

      const form = urlForm(memberPage);
      await form.getByLabel("Titel").fill(title);
      await form.getByLabel("Webadresse").fill(address);
      await form.getByRole("button", { name: "Seite hinzufügen" }).click();

      await expect(memberPage.getByText(URL_ERROR_TEXT)).toBeVisible({ timeout: 45_000 });
      await expect(memberPage).toHaveURL(/fehler=url/);
      await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);

      await ownerContext.close();
      await memberContext.close();
    });
  }
});

test.describe("an editor removes a source", () => {
  test("Entfernen removes the source from the list", async ({ browser }) => {
    const { ownerContext, memberContext, memberPage } = await shareWithFreshMember(
      browser,
      "sources-e2e-remove",
      "Bearbeiter",
    );
    const title = `Zu entfernen ${Date.now()}`;

    const form = textForm(memberPage);
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Wird gleich wieder entfernt.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    const row = sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Entfernen" }).click();
    await expect(sourcesSection(memberPage).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });
});
