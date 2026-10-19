// Reading a whole source: in the Quellen list a ready source's title is a button that opens
// the full text (all chunks in ordinal order) in the same margin as citation passages.
// Rows are inserted with the signed-in owner's own JWT (never an admin credential), like chat.spec.ts.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedLocalSessionWithClient, type SeededSession } from "./helpers/session";
import type { SignedInUser } from "../rls/helpers/clients";
import {
  createSource,
  insertChunks,
  insertCitation,
  insertMessage,
  nearbyVector,
  setSourceStatus,
} from "../rls/helpers/sources";

const READY_TITLE = "Lesebericht.txt";
const PENDING_TITLE = "Wartende Quelle.txt";
const OTHER_TITLE = "Zweite Quelle.txt";
const URL_TITLE = "Webartikel";
const PDF_TITLE = "Bericht.pdf";
const CHUNK_ONE = "Erster Abschnitt: Die Fiktiva GmbH sitzt in Bonn.";
const CHUNK_TWO = "Zweiter Abschnitt: Sie beschäftigt vierzig Personen.";
const CHUNK_ONE_B = "Dritter Abschnitt: Der Umsatz stieg im Jahr 2025 deutlich.";
const OTHER_CHUNK ="Anderer Inhalt: Der Hafen liegt in Kiel.";
const QUOTE = "Der Hafen liegt in Kiel";

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
): Promise<{ context: BrowserContext; page: Page; owner: SignedInUser; id: string; url: string }> {
  const context = await browser.newContext();
  const session = await seedLocalSessionWithClient(label);
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  const { id, url } = await createNotebookViaUi(page, `${label} ${Date.now()}`);
  return { context, page, owner: await asSignedIn(session), id, url };
}

/** A ready source with two chunks, inserted in reverse ordinal order. */
async function seedReadySource(owner: SignedInUser, notebookId: string, title: string, texts: string[]): Promise<string> {
  const sourceId = await createSource(owner, notebookId, { title });
  await insertChunks(
    owner,
    notebookId,
    sourceId,
    texts
      .map((content, ordinal) => ({ ordinal, content, embedding: nearbyVector(ordinal + 1, 0.1) }))
      .reverse(),
  );
  await setSourceStatus(owner, sourceId, "ready");
  return sourceId;
}

function titleButton(page: Page, title: string) {
  return page.getByRole("button", { name: title, exact: true });
}

function sourceRegion(page: Page, title: string) {
  return page.getByRole("region", { name: `Quelle: ${title}`, exact: true });
}

test.describe("source reader", () => {
  test("a ready source's title is a button, a pending source's title is plain text", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-buttons");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await createSource(owner, id, { title: PENDING_TITLE });
    await page.goto(url);

    await expect(titleButton(page, READY_TITLE)).toBeVisible();
    await expect(page.getByText(PENDING_TITLE, { exact: true })).toBeVisible();
    await expect(titleButton(page, PENDING_TITLE)).toHaveCount(0);

    await context.close();
  });

  test("clicking the title opens the full text, both chunks in ordinal order", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-open");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await page.goto(url);

    await expect(sourceRegion(page, READY_TITLE)).toHaveCount(0);
    await titleButton(page, READY_TITLE).click();

    const region = sourceRegion(page, READY_TITLE);
    await expect(region).toBeVisible();
    await expect(region).toContainText(CHUNK_ONE);
    await expect(region).toContainText(CHUNK_TWO);
    const text = await region.innerText();
    expect(text.indexOf(CHUNK_ONE)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(CHUNK_ONE)).toBeLessThan(text.indexOf(CHUNK_TWO));

    await context.close();
  });

  test("a text source shows the kind label Text and no original link", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-kind-text");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await page.goto(url);

    await titleButton(page, READY_TITLE).click();
    const region = sourceRegion(page, READY_TITLE);
    await expect(region).toBeVisible();
    await expect(region.getByText("Text", { exact: true })).toBeVisible();
    await expect(region.getByRole("link", { name: "Original öffnen" })).toHaveCount(0);
    await expect(region.getByText(/^Seite \d+$/)).toHaveCount(0);

    await context.close();
  });

  test("a web page source shows the label Webseite and a safe link to the original", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-kind-url");
    const sourceUrl = "https://example.com/artikel";
    // Same insert as createUrlSource in lib/sources/sources.ts (the helper has no source_url option).
    const { data, error } = await owner.client
      .from("sources")
      .insert({ notebook_id: id, kind: "url", title: URL_TITLE, source_url: sourceUrl })
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert url source: ${error?.message}`);
    const sourceId = data.id as string;
    await insertChunks(owner, id, sourceId, [
      { ordinal: 0, content: CHUNK_ONE, embedding: nearbyVector(1, 0.1) },
      { ordinal: 1, content: CHUNK_TWO, embedding: nearbyVector(2, 0.1) },
    ]);
    await setSourceStatus(owner, sourceId, "ready");
    await page.goto(url);

    await titleButton(page, URL_TITLE).click();
    const region = sourceRegion(page, URL_TITLE);
    await expect(region).toBeVisible();
    await expect(region.getByText("Webseite", { exact: true })).toBeVisible();
    const link = region.getByRole("link", { name: "Original öffnen" });
    await expect(link).toHaveAttribute("href", sourceUrl);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("rel", /noreferrer/);
    await expect(region.getByText(/^Seite \d+$/)).toHaveCount(0);

    await context.close();
  });

  test("a pdf source shows the label PDF and a Seite marker before each page's text", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-kind-pdf");
    const sourceId = await createSource(owner, id, { kind: "pdf", title: PDF_TITLE });
    // Two chunks on page 1, one on page 2: each page gets exactly one marker.
    await insertChunks(owner, id, sourceId, [
      { ordinal: 2, content: CHUNK_TWO, embedding: nearbyVector(3, 0.1), page: 2 },
      { ordinal: 1, content: CHUNK_ONE_B, embedding: nearbyVector(2, 0.1), page: 1 },
      { ordinal: 0, content: CHUNK_ONE, embedding: nearbyVector(1, 0.1), page: 1 },
    ]);
    await setSourceStatus(owner, sourceId, "ready");
    await page.goto(url);

    await titleButton(page, PDF_TITLE).click();
    const region = sourceRegion(page, PDF_TITLE);
    await expect(region).toBeVisible();
    await expect(region.getByText("PDF", { exact: true })).toBeVisible();
    await expect(region.getByRole("link", { name: "Original öffnen" })).toHaveCount(0);
    await expect(region.getByText("Seite 1", { exact: true })).toHaveCount(1);
    await expect(region.getByText("Seite 2", { exact: true })).toHaveCount(1);
    await expect(region.getByText(/^Seite \d+$/)).toHaveCount(2);
    const text = await region.innerText();
    const order = [
      text.indexOf("Seite 1"),
      text.indexOf(CHUNK_ONE),
      text.indexOf("Seite 2"),
      text.indexOf(CHUNK_TWO),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await context.close();
  });

  test("below 1280px Schließen closes the region", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-close");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(url);

    await titleButton(page, READY_TITLE).click();
    const region = sourceRegion(page, READY_TITLE);
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Schließen" }).click();
    await expect(sourceRegion(page, READY_TITLE)).toHaveCount(0);

    await context.close();
  });

  test("at 1440px the title again closes the region", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-toggle");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await titleButton(page, READY_TITLE).click();
    await expect(sourceRegion(page, READY_TITLE)).toBeVisible();
    await titleButton(page, READY_TITLE).click();
    await expect(sourceRegion(page, READY_TITLE)).toHaveCount(0);

    await context.close();
  });

  test("Escape closes the region", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-escape");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await titleButton(page, READY_TITLE).click();
    await expect(sourceRegion(page, READY_TITLE)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sourceRegion(page, READY_TITLE)).toHaveCount(0);

    await context.close();
  });

  test("a source replaces an open passage and a passage replaces an open source", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-replace");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);
    const otherSourceId = await seedReadySource(owner, id, OTHER_TITLE, [OTHER_CHUNK]);
    const { data: chunk, error } = await owner.client
      .from("chunks")
      .select("id")
      .eq("source_id", otherSourceId)
      .single();
    if (error || !chunk) throw new Error(`select chunk: ${error?.message}`);
    await insertMessage(owner, id, "user", "Wo liegt der Hafen?");
    const answerId = await insertMessage(owner, id, "assistant", "In Kiel [1].");
    await insertCitation(owner, id, answerId, 1, { chunkId: chunk.id as string, quote: QUOTE });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    const chip = page.getByRole("button", { name: `[1] ${OTHER_TITLE}` });
    await chip.click();
    await expect(page.getByRole("region", { name: "Fundstelle [1]" })).toBeVisible();

    await titleButton(page, READY_TITLE).click();
    await expect(sourceRegion(page, READY_TITLE)).toBeVisible();
    await expect(page.getByRole("region", { name: "Fundstelle [1]" })).toHaveCount(0);
    await expect(page.getByRole("region")).toHaveCount(1);

    await chip.click();
    await expect(page.getByRole("region", { name: "Fundstelle [1]" })).toBeVisible();
    await expect(sourceRegion(page, READY_TITLE)).toHaveCount(0);

    await context.close();
  });

  test("Escape in an open confirmation dialog closes only the dialog, not the open passage", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-escape-dialog");
    const sourceId = await seedReadySource(owner, id, OTHER_TITLE, [OTHER_CHUNK]);
    const { data: chunk, error } = await owner.client.from("chunks").select("id").eq("source_id", sourceId).single();
    if (error || !chunk) throw new Error(`select chunk: ${error?.message}`);
    await insertMessage(owner, id, "user", "Wo liegt der Hafen?");
    const answerId = await insertMessage(owner, id, "assistant", "In Kiel [1].");
    await insertCitation(owner, id, answerId, 1, { chunkId: chunk.id as string, quote: QUOTE });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    await page.getByRole("button", { name: `[1] ${OTHER_TITLE}` }).click();
    const passage = page.getByRole("region", { name: "Fundstelle [1]" });
    await expect(passage).toBeVisible();

    const row = page.getByRole("listitem").filter({ hasText: OTHER_TITLE });
    await row.getByRole("button", { name: "Entfernen" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(passage).toBeVisible();

    await context.close();
  });

  test("a viewer of a shared notebook can open a source",async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "reader-e2e-viewer-owner");
    await seedReadySource(owner, id, READY_TITLE, [CHUNK_ONE, CHUNK_TWO]);

    const viewerContext = await browser.newContext();
    const viewerSession = await seedLocalSessionWithClient("reader-e2e-viewer");
    await viewerContext.addCookies(viewerSession.cookies);
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto("/profil");
    const viewerId = (await viewerPage.getByTestId("nutzer-id").innerText()).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )![0];

    await page.goto(url);
    await page.getByLabel("Nutzer-ID").fill(viewerId);
    await page.getByLabel("Rolle").selectOption({ label: "Betrachter" });
    await page.getByRole("button", { name: "Teilen" }).click();
    await expect(page.getByText(viewerId.slice(0, 8))).toBeVisible();

    await viewerPage.goto(url);
    await titleButton(viewerPage, READY_TITLE).click();
    const region = sourceRegion(viewerPage, READY_TITLE);
    await expect(region).toBeVisible();
    await expect(region).toContainText(CHUNK_ONE);
    await expect(region).toContainText(CHUNK_TWO);

    await viewerContext.close();
    await context.close();
  });
});
