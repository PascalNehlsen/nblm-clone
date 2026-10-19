// D3 end-to-end: the "Fragen" section on the notebook page (spec
// .git/D3-API-SPEC.md), driven with real local sessions (helpers/session.ts).
// All rows are inserted with the signed-in owner's own JWT through the local
// PostgREST (never the admin/service-role credential), the same way the RLS
// helpers do it: a source, its chunks (1024-dim vectors), then status ready, a
// user message and an assistant message, and citations with chunk_id + quote.
//
// No model is configured in CI, so asking a question ends in the alert
// "Modell nicht konfiguriert" (the question embedding fails first;
// lib/ops/categories.ts, model_not_configured).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedLocalSessionWithClient, type SeededSession } from "./helpers/session";
import type { SignedInUser } from "../rls/helpers/clients";
import {
  createSource,
  insertCitation,
  insertMessage,
  nearbyVector,
  setSourceStatus,
} from "../rls/helpers/sources";

const CHUNK_TEXT = "Die Fiktiva GmbH wurde 1999 in Bonn gegründet und beschäftigt 40 Personen.";
const QUOTE = "Fiktiva GmbH wurde 1999";
const SOURCE_TITLE = "Jahresbericht.pdf";
const PAGE_NUMBER = 3;

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
  const id = url.match(/\/notebooks\/([0-9a-f-]{36})/)![1]!;
  return { id, url };
}

/** Inserts a ready source with one chunk as `owner` and returns the chunk id. */
async function seedChunk(owner: SignedInUser, notebookId: string): Promise<string> {
  const sourceId = await createSource(owner, notebookId, { title: SOURCE_TITLE });
  const { data, error } = await owner.client
    .from("chunks")
    .insert({
      notebook_id: notebookId,
      source_id: sourceId,
      ordinal: 0,
      content: CHUNK_TEXT,
      embedding: nearbyVector(1, 0.1),
      page: PAGE_NUMBER,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedChunk: ${error?.code ?? "?"} ${error?.message}`);
  await setSourceStatus(owner, sourceId, "ready");
  return data.id as string;
}

async function seedPair(
  owner: SignedInUser,
  notebookId: string,
  question: string,
  answer: string,
  citations: { chunkId: string; quote: string }[],
): Promise<void> {
  await insertMessage(owner, notebookId, "user", question);
  const assistantId = await insertMessage(owner, notebookId, "assistant", answer);
  for (const [index, citation] of citations.entries()) {
    await insertCitation(owner, notebookId, assistantId, index + 1, citation);
  }
}

function chatSection(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Fragen", exact: true }) });
}

async function ownerWithNotebook(
  browser: Browser,
  label: string,
): Promise<{ context: BrowserContext; page: Page; owner: SignedInUser; session: SeededSession; id: string; url: string }> {
  const context = await browser.newContext();
  const session = await seedLocalSessionWithClient(label);
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  const { id, url } = await createNotebookViaUi(page, `${label} ${Date.now()}`);
  return { context, page, owner: await asSignedIn(session), session, id, url };
}

test.describe("chat history", () => {
  test("an owner sees the seeded question and answer with the citation button", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-history");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann wurde die Firma gegründet?", "Sie wurde 1999 gegründet [1].", [
      { chunkId, quote: QUOTE },
    ]);
    await page.goto(url);

    const section = chatSection(page);
    await expect(section.getByRole("heading", { name: "Fragen", exact: true })).toBeVisible();
    const items = section.getByRole("listitem");
    await expect(items.filter({ hasText: "Wann wurde die Firma gegründet?" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Sie wurde 1999 gegründet" })).toHaveCount(1);
    await expect(section.getByRole("button", { name: `[1] ${SOURCE_TITLE}, S. ${PAGE_NUMBER}` })).toBeVisible();

    await context.close();
  });

  test("clicking the citation opens the passage with the quote in a mark element", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-passage");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann?", "1999 [1].", [{ chunkId, quote: QUOTE }]);
    await page.goto(url);

    const section = chatSection(page);
    await expect(section.getByRole("region", { name: "Fundstelle [1]" })).toHaveCount(0);
    await section.getByRole("button", { name: `[1] ${SOURCE_TITLE}, S. ${PAGE_NUMBER}` }).click();

    const panel = section.getByRole("region", { name: "Fundstelle [1]" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(CHUNK_TEXT);
    await expect(panel.locator("mark")).toHaveCount(1);
    await expect(panel.locator("mark")).toHaveText(QUOTE);

    // A second click closes the panel again.
    await section.getByRole("button", { name: `[1] ${SOURCE_TITLE}, S. ${PAGE_NUMBER}` }).click();
    await expect(section.getByRole("region", { name: "Fundstelle [1]" })).toHaveCount(0);

    await context.close();
  });

  test("a forged citation quote is shown without a mark element", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-forged");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann?", "1999 [1].", [{ chunkId, quote: "Die Firma wurde 2042 auf dem Mond gegründet" }]);
    await page.goto(url);

    const section = chatSection(page);
    await section.getByRole("button", { name: `[1] ${SOURCE_TITLE}, S. ${PAGE_NUMBER}` }).click();

    const panel = section.getByRole("region", { name: "Fundstelle [1]" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(CHUNK_TEXT);
    await expect(panel.locator("mark")).toHaveCount(0);

    await context.close();
  });

  test("model text with an img tag renders as literal text, never as an element", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-xss");
    await seedChunk(owner, id);
    await seedPair(owner, id, "Zeig mir etwas.", "Hier: <img src=x onerror=alert(1)> Ende", []);
    await page.goto(url);

    const section = chatSection(page);
    await expect(section.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    await expect(section.locator("img")).toHaveCount(0);
    await expect(page.locator("main img")).toHaveCount(0);

    await context.close();
  });
});

test.describe("asking a question", () => {
  test("without a configured model the alert says Modell nicht konfiguriert and no pending text remains", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-ask");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Erste Frage?", "Erste Antwort [1].", [{ chunkId, quote: QUOTE }]);
    await page.goto(url);

    const section = chatSection(page);
    const items = section.getByRole("listitem");
    await expect(items.filter({ hasText: "Erste Frage?" })).toHaveCount(1);
    const before = await items.count();

    await section.getByLabel("Frage").fill("Wie viele Personen arbeiten dort?");
    await section.getByRole("button", { name: "Fragen", exact: true }).click();

    await expect(section.getByRole("alert").filter({ hasText: "Modell nicht konfiguriert" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(section.getByRole("button", { name: "Fragen", exact: true })).toBeEnabled();

    // Only the asked question was appended: no pending or empty assistant entry is left.
    await expect(items.filter({ hasText: "Wie viele Personen arbeiten dort?" })).toHaveCount(1);
    await expect(items).toHaveCount(before + 1);

    await context.close();
  });
});

test.describe("a viewer", () => {
  test("sees the question form but not the owner's history", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-viewer-owner");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Frage des Besitzers?", "Antwort [1].", [{ chunkId, quote: QUOTE }]);

    const viewerContext = await browser.newContext();
    const viewerSession = await seedLocalSessionWithClient("chat-e2e-viewer");
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
    const section = chatSection(viewerPage);
    await expect(section.getByLabel("Frage")).toBeVisible();
    await expect(section.getByRole("button", { name: "Fragen", exact: true })).toBeEnabled();
    // Messages are visible only to their author (RLS, ADR 0004): the viewer never sees the owner's history.
    await expect(viewerPage.getByText("Frage des Besitzers?")).toHaveCount(0);

    await viewerContext.close();
    await context.close();
  });
});
