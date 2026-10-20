// Notebook page layout and dialogs (plan feat/notebook-layout, Part A) plus the UI of an
// ungrounded answer (Part B, UI side), driven with real local sessions (helpers/session.ts).
// Rows are inserted with the signed-in owner's own JWT through the local PostgREST, never an
// admin credential (same helpers as chat.spec.ts and source-reader.spec.ts).
//
//   Desktop (min-width 1280px and min-height 640px): the notebook fills the window between top
//     bar and footer; rail, conversation and margin end at the same height and scroll inside
//     themselves; the page does not scroll. Smaller or shorter windows keep the page flow.
//   Add-source dialog: the button "Quelle hinzufügen" in the Quellen header opens a modal
//     <dialog class="confirm wide"> with the tabs; Escape closes it and focus returns to the button.
//   Members dialog: the compact member list is always visible; a non-anonymous owner gets
//     "Verwalten", which opens the dialog with role select, "Entfernen" (nested confirmation) and
//     the share form; it stays open after an action and shows the updated list.
//   Delete button: "Notizbuch löschen" sits in .nb-head next to the h1, no .danger-zone panel.
//   Reader overflow: long unbroken words wrap inside the margin.
//   Bug 6: a source that is open in the margin and then deleted closes its margin panel; a
//     citation passage of a deleted source stays and shows "Quelle gelöscht".
//   Ungrounded answer: the fixed sentence gets the class "ungrounded" and a hint, live and in history.
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedLocalSessionWithClient, type SeededSession } from "./helpers/session";
import {
  addSourceButton,
  closeDialogWithEscape,
  confirmDialog,
  manageButton,
  openMembersDialog,
  openSourceForm,
  shareViaDialog,
  visibleText,
} from "./helpers/dialogs";
import { supabaseLocalConfig, type SignedInUser } from "../rls/helpers/clients";
import {
  createSource,
  insertChunks,
  insertCitation,
  insertMessage,
  nearbyVector,
  setSourceStatus,
} from "../rls/helpers/sources";

const UNGROUNDED = "Ich konnte keine Antwort mit wörtlichen Zitaten aus den Quellen belegen.";
const ABSTENTION = "Dazu finde ich in den Quellen keine Antwort.";
const LIVE_HINT = "Der zuerst angezeigte Text wurde verworfen, weil er keine geprüften Belege enthielt.";
const HISTORY_HINT = "Ohne geprüfte Belege verworfen.";

// 19 * 16 = 304 characters, no space and no hyphen: only fits a column if it wraps anywhere.
const LONG_WORD = "Wortohnebruchstelle".repeat(16);
const READER_TITLE = "Lesebericht.txt";

async function asSignedIn(session: SeededSession): Promise<SignedInUser> {
  const { data } = await session.client.auth.getSession();
  return {
    client: session.client as SupabaseClient,
    userId: session.userId,
    accessToken: data.session?.access_token ?? "",
  };
}

async function createNotebookViaUi(page: Page, title: string): Promise<{ id: string; url: string }> {
  await page.goto("/");
  await page.getByLabel("Titel").fill(title);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);
  const url = page.url();
  return { id: url.match(/\/notebooks\/([0-9a-f-]{36})/)![1]!, url };
}

async function ownerWithNotebook(
  browser: Browser,
  label: string,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page; owner: SignedInUser; id: string; url: string }> {
  const context = await browser.newContext({ viewport });
  const session = await seedLocalSessionWithClient(label);
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  const { id, url } = await createNotebookViaUi(page, `${label} ${Date.now()}`);
  return { context, page, owner: await asSignedIn(session), id, url };
}

/** A ready source whose chunks are inserted in ordinal order. */
async function seedReadySource(
  owner: SignedInUser,
  notebookId: string,
  title: string,
  texts: string[],
): Promise<string> {
  const sourceId = await createSource(owner, notebookId, { title });
  await insertChunks(
    owner,
    notebookId,
    sourceId,
    texts.map((content, ordinal) => ({ ordinal, content, embedding: nearbyVector(ordinal + 1, 0.1) })),
  );
  await setSourceStatus(owner, sourceId, "ready");
  return sourceId;
}

/** 15 ready sources (the first is long and holds LONG_WORD) and a long history. */
async function seedFullNotebook(owner: SignedInUser, notebookId: string): Promise<void> {
  const readerChunks = Array.from({ length: 40 }, (_, i) =>
    i === 3
      ? `Abschnitt ${i}: ${LONG_WORD} steht hier ohne jede Trennstelle mitten im Text.`
      : `Abschnitt ${i}: ${"Die Fiktiva GmbH sitzt in Bonn und beschäftigt vierzig Personen. ".repeat(3)}`,
  );
  await seedReadySource(owner, notebookId, READER_TITLE, readerChunks);
  for (let i = 2; i <= 15; i += 1) {
    await seedReadySource(owner, notebookId, `Quelle ${i} mit einem ordentlich langen Titel.txt`, [
      `Inhalt der Quelle ${i}.`,
    ]);
  }
  for (let i = 1; i <= 12; i += 1) {
    await insertMessage(owner, notebookId, "user", `Frage Nummer ${i}?`);
    await insertMessage(
      owner,
      notebookId,
      "assistant",
      `Antwort Nummer ${i}. ${"Dies ist ein längerer Absatz, der Platz im Verlauf braucht. ".repeat(4)}`,
    );
  }
}

function chatSection(page: Page): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Fragen", exact: true }) });
}

function titleButton(page: Page, title: string): Locator {
  return page.getByRole("button", { name: title, exact: true });
}

function sourceRow(page: Page, title: string): Locator {
  return page.getByRole("listitem").filter({ hasText: title });
}

/** Deletes a source through its row's Entfernen button and the confirmation dialog. */
async function deleteSourceViaUi(page: Page, title: string): Promise<void> {
  await sourceRow(page, title).getByRole("button", { name: "Entfernen" }).click();
  const dialog = confirmDialog(page, "Quelle entfernen?");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Endgültig entfernen" }).click();
  await expect(sourceRow(page, title)).toHaveCount(0);
}

async function pageMetrics(page: Page): Promise<{ scrollHeight: number; innerHeight: number }> {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
}

async function bottomOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no bounding box");
  return box.y + box.height;
}

/** Does an element between `start` and `stop` (walking up from `start`) scroll its own content?
 * With `includeStop` false the walk ends before `stop`, so `stop` itself does not count. */
async function scrollsInside(page: Page, start: string, stop: string, includeStop: boolean): Promise<boolean> {
  return page.evaluate(
    ([startSelector, stopSelector, include]) => {
      const end = document.querySelector(stopSelector as string);
      let el = document.querySelector(startSelector as string) as HTMLElement | null;
      while (el) {
        if (el === end && !include) return false;
        const overflowY = getComputedStyle(el).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) return true;
        if (el === end) return false;
        el = el.parentElement;
      }
      return false;
    },
    [start, stop, includeStop] as const,
  );
}

test.describe("desktop layout: the notebook fills the window and scrolls inside its panels", () => {
  test("at 1440x900 the page does not scroll, rail, conversation and margin end together, the sources list and the open source scroll inside", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-desktop");
    await seedFullNotebook(owner, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await titleButton(page, READER_TITLE).click();
    const region = page.getByRole("region", { name: `Quelle: ${READER_TITLE}`, exact: true });
    await expect(region).toBeVisible();
    await expect(region).toContainText("Abschnitt 39", { timeout: 15_000 });

    const { scrollHeight, innerHeight } = await pageMetrics(page);
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight);

    const railBottom = await bottomOf(page.locator(".nb-rail"));
    const conversationBottom = await bottomOf(page.locator(".conversation"));
    const marginBottom = await bottomOf(page.locator(".margin"));
    expect(Math.abs(railBottom - conversationBottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(marginBottom - conversationBottom)).toBeLessThanOrEqual(2);

    // The 15 sources do not fit the rail: the list scrolls inside it (the rail itself does not).
    expect(await scrollsInside(page, ".nb-rail .sources li", ".nb-rail", false)).toBe(true);
    // The long source scrolls inside the margin.
    expect(await scrollsInside(page, ".margin .reader .text", ".margin", true)).toBe(true);
    // Still no page scroll after all of that.
    expect((await pageMetrics(page)).scrollHeight).toBeLessThanOrEqual(innerHeight);

    await context.close();
  });

  test("a 300-character unbroken word wraps inside the open source: no horizontal overflow of the margin", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-longword");
    await seedFullNotebook(owner, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await titleButton(page, READER_TITLE).click();
    const region = page.getByRole("region", { name: `Quelle: ${READER_TITLE}`, exact: true });
    await expect(region).toContainText(LONG_WORD, { timeout: 15_000 });
    await region.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

    const margin = page.locator(".margin");
    expect(await margin.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    const paragraph = region.locator(".text p").filter({ hasText: LONG_WORD });
    await expect(paragraph).toHaveCount(1);
    expect(await paragraph.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const marginBox = (await margin.boundingBox())!;
    const paragraphBox = (await paragraph.boundingBox())!;
    expect(paragraphBox.x + paragraphBox.width).toBeLessThanOrEqual(marginBox.x + marginBox.width + 1);

    await context.close();
  });

  test("a citation passage with a long unbroken word and a long unbroken source title wraps inside the margin", async ({
    browser,
  }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-passage");
    const longTitle = `${"Titel".repeat(24)}.txt`;
    const sourceId = await seedReadySource(owner, id, longTitle, [`Der Satz ${LONG_WORD} endet hier.`]);
    const { data: chunk, error } = await owner.client.from("chunks").select("id").eq("source_id", sourceId).single();
    if (error || !chunk) throw new Error(`select chunk: ${error?.message}`);
    await insertMessage(owner, id, "user", "Was steht da?");
    const answerId = await insertMessage(owner, id, "assistant", "Ein Satz [1].");
    await insertCitation(owner, id, answerId, 1, { chunkId: chunk.id as string, quote: "endet hier" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await page.locator(".chip").first().click();
    const passage = page.getByRole("region", { name: "Fundstelle [1]" });
    await expect(passage).toBeVisible();
    // The passage slides in; measure only after its animations are done.
    await passage.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

    const margin = page.locator(".margin");
    expect(await margin.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const marginBox = (await margin.boundingBox())!;
    for (const part of [passage.locator(".src"), passage.locator("p").filter({ hasText: LONG_WORD })]) {
      const box = (await part.first().boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(marginBox.x + marginBox.width + 1);
    }

    await context.close();
  });

  test("an empty margin is shorter than the conversation", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-empty-margin");
    await seedFullNotebook(owner, id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await expect(page.getByRole("region", { name: "Verlauf" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Fundstellen" }).getByRole("region")).toHaveCount(0);
    const margin = (await page.locator(".margin").boundingBox())!;
    const conversation = (await page.locator(".conversation").boundingBox())!;
    expect(margin.height).toBeLessThan(conversation.height - 100);

    await context.close();
  });
});

test.describe("smaller or shorter windows keep the page flow", () => {
  for (const viewport of [
    { width: 1100, height: 900 },
    { width: 1440, height: 560 },
  ]) {
    test(`at ${viewport.width}x${viewport.height} the page scrolls and the composer is reachable`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-flow", viewport);
      await seedFullNotebook(owner, id);
      await page.goto(url);
      await expect(page.getByRole("region", { name: "Verlauf" })).toBeVisible();

      const { scrollHeight, innerHeight } = await pageMetrics(page);
      expect(scrollHeight).toBeGreaterThan(innerHeight);

      const composer = chatSection(page).getByLabel("Frage");
      await composer.scrollIntoViewIfNeeded();
      await expect(composer).toBeInViewport();

      await context.close();
    });
  }
});

test.describe("the add-source dialog", () => {
  test("Quellen has a header row with the button; the form is not on the page until it is opened; Escape closes and returns focus", async ({
    browser,
  }) => {
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-add-open");

    const heading = page.getByRole("heading", { name: "Quellen", exact: true });
    const opener = addSourceButton(page);
    await expect(heading).toBeVisible();
    await expect(opener).toBeVisible();
    const headingBox = (await heading.boundingBox())!;
    const openerBox = (await opener.boundingBox())!;
    // Same row: the vertical ranges overlap, the button is to the right of the heading.
    expect(openerBox.y).toBeLessThan(headingBox.y + headingBox.height);
    expect(headingBox.y).toBeLessThan(openerBox.y + openerBox.height);
    expect(openerBox.x).toBeGreaterThan(headingBox.x);

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Art der Quelle" })).toHaveCount(0);

    await opener.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/\bwide\b/);
    await expect(dialog.getByRole("tablist", { name: "Art der Quelle" })).toBeVisible();
    await expect(dialog.getByRole("tab")).toHaveCount(3);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    await context.close();
  });

  test("a text source: the dialog stays open while the action is pending, then closes and the source is listed", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-add-text");
    const title = `Dialog-Text ${Date.now()}`;

    // Hold the server action until the test releases it, to observe the pending state.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/notebooks/**", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        held = true;
        await released;
      }
      await route.continue();
    });

    const form = await openSourceForm(page, "Text");
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Text", { exact: true }).fill("Hallo, dies ist ein Testtext für den Dialog.");
    await form.getByRole("button", { name: "Text hinzufügen" }).click();

    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole("dialog")).toBeVisible();

    release();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 45_000 });
    const row = sourceRow(page, title);
    await expect(row).toContainText("Fehlgeschlagen: Modell nicht konfiguriert", { timeout: 45_000 });

    await context.close();
  });

  test("an address the guard refuses closes the dialog and shows the error in the notebook header", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-add-url");
    const title = `Dialog-URL ${Date.now()}`;

    const form = await openSourceForm(page, "Webseite");
    await form.getByLabel("Titel").fill(title);
    await form.getByLabel("Webadresse").fill("http://127.0.0.1/");
    await form.getByRole("button", { name: "Seite hinzufügen" }).click();

    await expect(page.locator(".nb-head").getByRole("alert")).toHaveText(
      "Bitte gib eine http- oder https-Adresse ohne Zugangsdaten und ohne Port an.",
      { timeout: 45_000 },
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(sourceRow(page, title)).toHaveCount(0);

    await context.close();
  });

  test("a PDF whose upload to Storage fails keeps the dialog open with a message and the source ends up failed, not Wartet", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-add-pdf-fail");
    const supabaseUrl = supabaseLocalConfig().url;

    // The browser PUTs the file to a signed upload URL of the local Supabase Storage. Answer it
    // with a server error (and the CORS headers the cross-origin request needs).
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "PUT, OPTIONS",
      "access-control-allow-headers": "*",
    };
    await page.route(`${supabaseUrl}/storage/v1/object/upload/sign/**`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      await route.fulfill({ status: 500, headers: cors, body: "upload failed" });
    });
    // Server actions (create the upload, ingest) are POSTs with a Next-Action header.
    let serverActions = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) serverActions += 1;
    });

    const form = await openSourceForm(page, "PDF");
    await form.getByLabel("PDF-Datei").setInputFiles({
      name: "kaputt.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n", "latin1"),
    });
    const title = `Kaputt ${Date.now()}`;
    await form.getByLabel("Titel").fill(title);
    await form.getByRole("button", { name: "Hochladen" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toHaveText("Das Hochladen hat nicht geklappt.", { timeout: 30_000 });
    await expect(dialog).toBeVisible();
    // Create and ingest both ran: ingesting marks the row failed instead of leaving it "Wartet".
    await expect.poll(() => serverActions, { timeout: 30_000 }).toBe(2);
    // The list behind the open modal is in the DOM, so query the rail's list directly.
    const row = page.locator(".nb-rail .sources li").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Hochgeladene Datei fehlt", { timeout: 30_000 });
    await expect(row).not.toContainText("Wartet");
    await page.waitForTimeout(1_000);
    expect(serverActions).toBe(2);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText("Das Hochladen hat nicht geklappt.");

    await context.close();
  });

  test("a PDF whose upload request fails with a network error is handled the same way", async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-add-pdf-abort");
    const supabaseUrl = supabaseLocalConfig().url;

    // No answer at all: the browser's fetch to the signed upload URL rejects with a network error.
    await page.route(`${supabaseUrl}/storage/v1/object/upload/sign/**`, (route) => route.abort("failed"));
    let serverActions = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) serverActions += 1;
    });

    const form = await openSourceForm(page, "PDF");
    await form.getByLabel("PDF-Datei").setInputFiles({
      name: "abgebrochen.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n", "latin1"),
    });
    const title = `Abgebrochen ${Date.now()}`;
    await form.getByLabel("Titel").fill(title);
    await form.getByRole("button", { name: "Hochladen" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toHaveText("Das Hochladen hat nicht geklappt.", { timeout: 30_000 });
    await expect(dialog).toBeVisible();
    await expect.poll(() => serverActions, { timeout: 30_000 }).toBe(2);
    const row = page.locator(".nb-rail .sources li").filter({ hasText: title });
    await expect(row).toContainText("Fehlgeschlagen: Hochgeladene Datei fehlt", { timeout: 30_000 });
    await expect(row).not.toContainText("Wartet");
    await page.waitForTimeout(1_000);
    expect(serverActions).toBe(2);
    await expect(dialog).toBeVisible();

    await context.close();
  });
});

test.describe("the members dialog", () => {
  async function ownerAndMember(browser: Browser, label: string, role: "Bearbeiter" | "Betrachter") {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ownerContext.addCookies((await seedLocalSessionWithClient(`${label}-owner`)).cookies);
    await memberContext.addCookies((await seedLocalSessionWithClient(`${label}-member`)).cookies);
    const ownerPage = await ownerContext.newPage();
    const memberPage = await memberContext.newPage();

    await memberPage.goto("/profil");
    const memberId = (await memberPage.getByTestId("nutzer-id").innerText()).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )![0];
    const { url } = await createNotebookViaUi(ownerPage, `${label} ${Date.now()}`);
    await shareViaDialog(ownerPage, memberId, role);
    return { ownerContext, memberContext, ownerPage, memberPage, memberId, url };
  }

  test("the compact list is always visible; the share form is only in the dialog behind Verwalten", async ({
    browser,
  }) => {
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-members-compact");

    await expect(page.getByRole("heading", { name: "Mitglieder" })).toBeVisible();
    const own = page.getByRole("listitem").filter({ hasText: "Eigentümer" });
    await expect(own).toHaveCount(1);
    await expect(own).toContainText("Du");
    await expect(manageButton(page)).toBeVisible();
    await expect(page.getByLabel("Nutzer-ID")).toBeHidden();
    await expect(page.getByRole("button", { name: "Teilen" })).toBeHidden();

    const dialog = await openMembersDialog(page);
    await expect(dialog.getByLabel("Nutzer-ID")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Teilen" })).toBeVisible();
    await closeDialogWithEscape(page);
    await expect(manageButton(page)).toBeFocused();

    await context.close();
  });

  test("after sharing and closing the dialog, a reload does not re-open it", async ({ browser }) => {
    // ownerAndMember shares through the dialog and closes it with Escape.
    const { ownerContext, memberContext, ownerPage } = await ownerAndMember(
      browser,
      "layout-e2e-members-reload",
      "Betrachter",
    );
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);

    await ownerPage.reload();
    await expect(manageButton(ownerPage)).toBeVisible();
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);
    // Not re-opened late either.
    await ownerPage.waitForTimeout(1_000);
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });

  test("after sharing and closing the dialog, visiting another notebook and coming back does not open it on either page", async ({
    browser,
  }) => {
    const { ownerContext, memberContext, ownerPage, url } = await ownerAndMember(
      browser,
      "layout-e2e-members-other",
      "Betrachter",
    );
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);

    await createNotebookViaUi(ownerPage, `Zweites Notizbuch ${Date.now()}`);
    await expect(manageButton(ownerPage)).toBeVisible();
    await ownerPage.waitForTimeout(1_000);
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);

    await ownerPage.goto(url);
    await expect(manageButton(ownerPage)).toBeVisible();
    await ownerPage.waitForTimeout(1_000);
    await expect(ownerPage.getByRole("dialog")).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });

  test("sharing with an id that is not a user closes the dialog and shows the error in the notebook header", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-members-invalid");

    const dialog = await openMembersDialog(page);
    const form = dialog.locator("form").filter({ has: page.getByLabel("Nutzer-ID") });
    await form.getByLabel("Nutzer-ID").fill("00000000-0000-4000-8000-000000000001");
    await form.getByRole("button", { name: "Teilen" }).click();

    await expect(page).toHaveURL(/fehler=/, { timeout: 30_000 });
    await expect(page.locator(".nb-head").getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await context.close();
  });

  test("changing a role keeps the dialog open and shows the new role", async ({ browser }) => {
    const { ownerContext, memberContext, ownerPage, memberId } = await ownerAndMember(
      browser,
      "layout-e2e-members-role",
      "Betrachter",
    );
    const prefix = memberId.slice(0, 8);

    const dialog = await openMembersDialog(ownerPage);
    const row = dialog.getByRole("listitem").filter({ hasText: prefix });
    await row.getByLabel("Rolle ändern").selectOption({ label: "Bearbeiter" });
    await row.getByRole("button", { name: "Speichern" }).click();

    // Wait for the server round trip: the compact list (the panel's own list, not the dialog's
    // rows) carries the new role. Only then is the page re-mounted and the dialog re-opened.
    const compactRow = ownerPage.locator(".members > ul > li").filter({ hasText: prefix });
    await expect(compactRow).toContainText("Bearbeiter", { timeout: 15_000 });
    await expect(compactRow).not.toContainText("Betrachter");

    // The dialog is still open, and its row now carries the new role.
    await expect(dialog).toBeVisible();
    await expect(row.getByLabel("Rolle ändern")).toHaveValue("editor");

    await closeDialogWithEscape(ownerPage);
    await expect(compactRow).toContainText("Bearbeiter");
    await expect(compactRow).not.toContainText("Betrachter");

    await ownerContext.close();
    await memberContext.close();
  });

  test("Escape in the nested removal confirmation closes only the confirmation", async ({ browser }) => {
    const { ownerContext, memberContext, ownerPage, memberId } = await ownerAndMember(
      browser,
      "layout-e2e-members-nested",
      "Betrachter",
    );

    const members = await openMembersDialog(ownerPage);
    await members.getByRole("listitem").filter({ hasText: memberId.slice(0, 8) }).getByRole("button", { name: "Entfernen" }).click();
    const confirm = confirmDialog(ownerPage, "Mitglied entfernen?");
    await expect(confirm).toBeVisible();

    await ownerPage.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(members).toBeVisible();
    await expect(members.getByText(memberId.slice(0, 8)).filter({ visible: true })).toBeVisible();

    await closeDialogWithEscape(ownerPage);
    await expect(visibleText(ownerPage, memberId.slice(0, 8))).toBeVisible();

    await ownerContext.close();
    await memberContext.close();
  });

  for (const role of ["Bearbeiter", "Betrachter"] as const) {
    test(`a ${role} sees the member list but no Verwalten, no share form and no Entfernen`, async ({ browser }) => {
      const { ownerContext, memberContext, memberPage, url } = await ownerAndMember(
        browser,
        `layout-e2e-members-${role.toLowerCase()}`,
        role,
      );
      await memberPage.goto(url);

      await expect(memberPage.getByRole("heading", { name: "Mitglieder" })).toBeVisible();
      await expect(memberPage.getByRole("listitem").filter({ hasText: "Eigentümer" })).toHaveCount(1);
      await expect(memberPage.getByRole("listitem").filter({ hasText: role })).toHaveCount(1);
      await expect(manageButton(memberPage)).toHaveCount(0);
      await expect(memberPage.getByLabel("Nutzer-ID")).toBeHidden();
      await expect(memberPage.getByRole("button", { name: "Entfernen" })).toHaveCount(0);
      await expect(memberPage.getByRole("button", { name: "Notizbuch löschen" })).toHaveCount(0);
      // An editor may add sources, a viewer may not.
      await expect(addSourceButton(memberPage)).toHaveCount(role === "Bearbeiter" ? 1 : 0);

      await ownerContext.close();
      await memberContext.close();
    });
  }
});

test.describe("the delete button", () => {
  test("sits in the notebook header on the title's row, and there is no danger zone panel", async ({ browser }) => {
    const { context, page } = await ownerWithNotebook(browser, "layout-e2e-delete");

    const head = page.locator(".nb-head");
    const button = head.getByRole("button", { name: "Notizbuch löschen" });
    await expect(button).toBeVisible();
    const h1 = head.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();

    const buttonBox = (await button.boundingBox())!;
    const h1Box = (await h1.boundingBox())!;
    expect(buttonBox.y).toBeLessThan(h1Box.y + h1Box.height);
    expect(h1Box.y).toBeLessThan(buttonBox.y + buttonBox.height);
    expect(buttonBox.x).toBeGreaterThan(h1Box.x);

    await expect(page.locator(".danger-zone")).toHaveCount(0);
    await expect(page.locator(".nb-rail").getByRole("button", { name: "Notizbuch löschen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Notizbuch löschen" })).toHaveCount(1);

    // The confirmation dialog is unchanged.
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Notizbuch löschen?" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Endgültig löschen" })).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await context.close();
  });
});

test.describe("bug 6: a source that is deleted while it is open in the margin", () => {
  test("the source reader closes: no stale region stays in the margin", async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-bug6-source");
    await seedReadySource(owner, id, "Zu loeschen.txt", ["Erster Abschnitt.", "Zweiter Abschnitt."]);
    await seedReadySource(owner, id, "Bleibt.txt", ["Anderer Inhalt."]);
    await page.goto(url);

    await titleButton(page, "Zu loeschen.txt").click();
    const region = page.getByRole("region", { name: "Quelle: Zu loeschen.txt", exact: true });
    await expect(region).toBeVisible();
    await expect(region).toContainText("Erster Abschnitt.");

    await deleteSourceViaUi(page, "Zu loeschen.txt");

    await expect(region).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Fundstellen" }).getByRole("region")).toHaveCount(0);
    // The other source is untouched and still opens.
    await titleButton(page, "Bleibt.txt").click();
    await expect(page.getByRole("region", { name: "Quelle: Bleibt.txt", exact: true })).toBeVisible();

    await context.close();
  });

  test("regression guard: a citation passage of a deleted source stays open and says Quelle gelöscht", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-bug6-cite");
    const sourceId = await seedReadySource(owner, id, "Zitiert.txt", ["Die Fiktiva GmbH wurde 1999 in Bonn gegründet."]);
    const { data: chunk, error } = await owner.client.from("chunks").select("id").eq("source_id", sourceId).single();
    if (error || !chunk) throw new Error(`select chunk: ${error?.message}`);
    await insertMessage(owner, id, "user", "Wann wurde die Firma gegründet?");
    const answerId = await insertMessage(owner, id, "assistant", "Im Jahr 1999 [1].");
    await insertCitation(owner, id, answerId, 1, { chunkId: chunk.id as string, quote: "wurde 1999" });
    await page.goto(url);

    await page.getByRole("button", { name: "[1] Zitiert.txt" }).click();
    const passage = page.getByRole("region", { name: "Fundstelle [1]" });
    await expect(passage).toContainText("Die Fiktiva GmbH wurde 1999 in Bonn gegründet.");

    await deleteSourceViaUi(page, "Zitiert.txt");

    await expect(passage).toBeVisible();
    await expect(passage).toContainText("Quelle gelöscht", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "[1] Quelle gelöscht" })).toBeVisible();

    await context.close();
  });
});

test.describe("an ungrounded answer", () => {
  test("live: the fixed sentence gets the class ungrounded and a hint that the streamed text was dropped", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-ungrounded-live");
    await seedReadySource(owner, id, "Quelle.txt", ["Die Fiktiva GmbH sitzt in Bonn."]);

    // Same NDJSON lines as lib/server/chat/http.ts: delta lines, then one done line whose
    // message is the stored fixed sentence. The extra "abstention" field is ignored by the client.
    const STREAMED = "Eine erfundene Antwort ohne jeden Beleg.";
    await page.route("**/notebooks/*/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const lines = [
        { type: "delta", text: "Eine erfundene Antwort " },
        { type: "delta", text: "ohne jeden Beleg." },
        {
          type: "done",
          message: {
            id: "99999999-9999-4999-8999-999999999999",
            content: UNGROUNDED,
            citations: [],
            abstained: true,
            abstention: "no_marker",
          },
        },
      ];
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
        body: lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
      });
    });
    await page.goto(url);

    const section = chatSection(page);
    await section.getByLabel("Frage").fill("Wie viele Personen arbeiten dort?");
    await section.getByRole("button", { name: "Fragen", exact: true }).click();

    await expect(section.getByText(UNGROUNDED)).toBeVisible({ timeout: 15_000 });
    await expect(section.locator(".ungrounded").first()).toBeVisible();
    await expect(section.getByText(LIVE_HINT)).toBeVisible();
    // The unchecked streamed text does not stay on screen.
    await expect(section.getByText(STREAMED)).toHaveCount(0);

    await context.close();
  });

  test("history: the stored sentence shows the class and the short hint after a reload; grounded answers and the plain abstention do not", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "layout-e2e-ungrounded-history");
    const sourceId = await seedReadySource(owner, id, "Quelle.txt", ["Die Fiktiva GmbH wurde 1999 in Bonn gegründet."]);
    const { data: chunk, error } = await owner.client.from("chunks").select("id").eq("source_id", sourceId).single();
    if (error || !chunk) throw new Error(`select chunk: ${error?.message}`);

    await insertMessage(owner, id, "user", "Erste Frage?");
    await insertMessage(owner, id, "assistant", UNGROUNDED);
    await insertMessage(owner, id, "user", "Zweite Frage?");
    await insertMessage(owner, id, "assistant", ABSTENTION);
    await insertMessage(owner, id, "user", "Dritte Frage?");
    const groundedId = await insertMessage(owner, id, "assistant", "Im Jahr 1999 [1].");
    await insertCitation(owner, id, groundedId, 1, { chunkId: chunk.id as string, quote: "wurde 1999" });
    await page.goto(url);
    await page.reload();

    const section = chatSection(page);
    const isUngrounded = (item: Locator) =>
      item.evaluate((el) => el.matches(".ungrounded") || el.querySelector(".ungrounded") !== null);

    const ungrounded = section.getByRole("listitem").filter({ hasText: UNGROUNDED });
    await expect(ungrounded).toHaveCount(1);
    expect(await isUngrounded(ungrounded)).toBe(true);
    await expect(ungrounded).toContainText(HISTORY_HINT);
    // The live hint is only for the answer that was just streamed.
    await expect(section.getByText(LIVE_HINT)).toHaveCount(0);

    const abstained = section.getByRole("listitem").filter({ hasText: ABSTENTION });
    await expect(abstained).toHaveCount(1);
    expect(await isUngrounded(abstained)).toBe(false);
    await expect(abstained).not.toContainText(HISTORY_HINT);

    const grounded = section.getByRole("listitem").filter({ hasText: "Im Jahr 1999" });
    await expect(grounded).toHaveCount(1);
    expect(await isUngrounded(grounded)).toBe(false);
    await expect(grounded).not.toContainText(HISTORY_HINT);

    await context.close();
  });
});
