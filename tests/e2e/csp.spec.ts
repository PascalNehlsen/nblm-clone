// Content-Security-Policy end to end, against the production build the Playwright config
// starts (the same policy a deployment serves). Three things are pinned down:
//   1. /login carries an enforced policy with img-src 'self' and raises no violation.
//   2. The real flows (notebook, text source, PDF upload through the signed-URL PUT to
//      Supabase, a chat question) raise no violation, so the policy does not break the app.
//   3. The policy really blocks: an injected remote <img> is reported as an img-src
//      violation and no request ever reaches the remote host.
//
// Violations are collected with a `securitypolicyviolation` listener installed through
// addInitScript (it survives navigations) and reported to the test through an exposed
// function; console errors that mention the policy are collected as a second signal.
// No model is configured in CI, so ingestion and chat end in "Modell nicht konfiguriert"
// (see sources.spec.ts and chat.spec.ts); reaching that state proves the upload and the
// server round trips worked under the policy.
import { expect, test, type Page } from "@playwright/test";
import { seedLocalSession } from "./helpers/session";

interface Violation {
  effectiveDirective: string;
  blockedURI: string;
  documentURI: string;
}

interface Collector {
  violations: Violation[];
  cspConsoleErrors: string[];
}

async function collectViolations(page: Page): Promise<Collector> {
  const collector: Collector = { violations: [], cspConsoleErrors: [] };
  await page.exposeFunction("__reportCspViolation", (v: Violation) => {
    collector.violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (window as unknown as { __reportCspViolation?: (v: unknown) => void })
        .__reportCspViolation;
      report?.({
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
        documentURI: event.documentURI,
      });
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) {
      collector.cspConsoleErrors.push(message.text());
    }
  });
  return collector;
}

function expectClean(collector: Collector): void {
  expect(collector.violations).toEqual([]);
  expect(collector.cspConsoleErrors).toEqual([]);
}

/** A minimal, valid single-page PDF with the text "Hello World" (same construction as
 * sources.spec.ts, so the real extraction runs). */
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
  const offsets: number[] = [0];
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

function sourcesSection(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Quellen" }) });
}

async function openSourceForm(page: Page, tabName: "Text" | "PDF") {
  const tab = sourcesSection(page)
    .getByRole("tablist", { name: "Art der Quelle" })
    .getByRole("tab", { name: tabName, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const form = sourcesSection(page).getByRole("tabpanel").locator("form");
  await expect(form).toHaveCount(1);
  return form;
}

function chatSection(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Fragen", exact: true }) });
}

test.describe("Content-Security-Policy", () => {
  test("/login is served with an enforced policy (img-src 'self', frame-ancestors 'none') and raises no violation", async ({
    page,
  }) => {
    const collector = await collectViolations(page);
    const response = await page.goto("/login");
    expect(response).not.toBeNull();

    const headers = response!.headers();
    const policy = headers["content-security-policy"];
    expect(policy, "Content-Security-Policy header on /login").toBeTruthy();
    expect(headers["content-security-policy-report-only"]).toBeUndefined();

    const directives = new Map(
      policy!
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .filter((tokens) => tokens[0])
        .map(([name, ...sources]) => [name!, sources] as const),
    );
    expect(directives.get("img-src")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);

    await page.waitForLoadState("networkidle");
    expectClean(collector);
  });

  test("notebook, text source, PDF upload and a chat question raise no violation", async ({ browser }) => {
    test.setTimeout(150_000);
    const context = await browser.newContext();
    await context.addCookies(await seedLocalSession("csp-e2e-flows"));
    const page = await context.newPage();
    const collector = await collectViolations(page);

    // Create a notebook through the real form.
    await page.goto("/");
    await page.getByLabel("Titel").fill(`CSP ${Date.now()}`);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);

    // A text source.
    const textTitle = `CSP-Text ${Date.now()}`;
    const text = await openSourceForm(page, "Text");
    await text.getByLabel("Titel").fill(textTitle);
    await text.getByLabel("Text", { exact: true }).fill("Hallo, dies ist ein Testtext für die Richtlinie.");
    await text.getByRole("button", { name: "Text hinzufügen" }).click();
    const textRow = sourcesSection(page).getByRole("listitem").filter({ hasText: textTitle });
    await expect(textRow).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });

    // A PDF through the real form: the browser PUTs to a Supabase signed upload URL, which
    // connect-src and the policy must allow. Reaching the failed-at-model state shows the
    // server read the uploaded object back.
    const pdfTitle = `CSP-PDF ${Date.now()}`;
    const pdf = await openSourceForm(page, "PDF");
    await pdf.getByLabel("PDF-Datei").setInputFiles({
      name: "csp.pdf",
      mimeType: "application/pdf",
      buffer: buildMinimalPdf(),
    });
    await pdf.getByLabel("Titel").fill(pdfTitle);
    await pdf.getByRole("button", { name: "Hochladen" }).click();
    const pdfRow = sourcesSection(page).getByRole("listitem").filter({ hasText: pdfTitle });
    await expect(pdfRow).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });

    // A chat question (streams from the chat route).
    const section = chatSection(page);
    await section.getByLabel("Frage").fill("Wie viele Personen arbeiten dort?");
    await section.getByRole("button", { name: "Fragen", exact: true }).click();
    await expect(section.getByRole("alert").filter({ hasText: "Modell nicht konfiguriert" })).toBeVisible({
      timeout: 45_000,
    });

    expectClean(collector);
    await context.close();
  });

  test("enforcement probe: an injected remote image is blocked and reported as an img-src violation", async ({
    page,
  }) => {
    const collector = await collectViolations(page);
    // The page "request" event also fires for requests Chromium then blocks by CSP, so it
    // proves nothing. A CSP-blocked request never reaches the route handler: that is where
    // "reaches the network" is measured.
    const reached: string[] = [];
    const failed: { url: string; errorText: string }[] = [];
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).hostname === "evil.example") {
        failed.push({ url: request.url(), errorText: request.failure()?.errorText ?? "" });
      }
    });
    // Deterministic and offline: if the policy did not stop the image, the request would
    // reach this handler (and be aborted here), never leave the machine.
    await page.route("**://evil.example/**", (route) => {
      reached.push(route.request().url());
      return route.abort();
    });

    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    expectClean(collector);

    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://evil.example/x.png";
      document.body.appendChild(img);
    });

    await expect
      .poll(() => collector.violations.filter((v) => v.effectiveDirective === "img-src").length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const violation = collector.violations.find((v) => v.effectiveDirective === "img-src")!;
    expect(violation.blockedURI).toContain("evil.example");

    // Give a (wrongly) permitted request time to show up before asserting it did not.
    await page.waitForTimeout(500);
    expect(reached).toEqual([]);
    // Playwright reports a CSP block as a failed request; the text is "csp" or
    // "net::ERR_BLOCKED_BY_CSP" depending on the version.
    expect(failed.length).toBeGreaterThan(0);
    for (const entry of failed) expect(entry.errorText).toMatch(/csp/i);
  });
});
