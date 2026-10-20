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

test.describe("chat layout", () => {
  test("the question is a right-aligned bubble and the answer sits on the left", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-layout");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann wurde die Firma gegründet?", "Sie wurde 1999 gegründet [1].", [
      { chunkId, quote: QUOTE },
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    const section = chatSection(page);
    const list = section.getByRole("list");
    const question = section.getByRole("listitem").filter({ hasText: "Wann wurde die Firma gegründet?" });
    const answer = section.getByRole("listitem").filter({ hasText: "Sie wurde 1999 gegründet" });
    await expect(question).toHaveCount(1);
    await expect(answer).toHaveCount(1);

    const listBox = (await list.first().boundingBox())!;
    const questionBox = (await question.boundingBox())!;
    const answerBox = (await answer.boundingBox())!;
    expect(listBox).toBeTruthy();
    expect(questionBox).toBeTruthy();
    expect(answerBox).toBeTruthy();

    const listRight = listBox.x + listBox.width;
    // Question: right edge flush with the list, and a bubble (not full width).
    expect(Math.abs(questionBox.x + questionBox.width - listRight)).toBeLessThanOrEqual(4);
    expect(questionBox.x - listBox.x).toBeGreaterThan(listBox.width * 0.15);
    // Answer: left edge flush with the list.
    expect(Math.abs(answerBox.x - listBox.x)).toBeLessThanOrEqual(4);

    await context.close();
  });
});

test.describe("chat scrolling", () => {
  async function atBottom(list: ReturnType<ReturnType<typeof chatSection>["getByRole"]>): Promise<boolean> {
    return list.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }

  test("a long history scrolls inside the thread, keeps the composer visible and starts at the bottom", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-scroll");
    await seedChunk(owner, id);
    for (let i = 1; i <= 15; i++) {
      await seedPair(
        owner,
        id,
        `Frage Nummer ${i}?`,
        `Antwort Nummer ${i}. ${"Dies ist ein längerer Absatz, der Platz im Verlauf braucht. ".repeat(4)}`,
        [],
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    const section = chatSection(page);
    const list = section.getByRole("list").first();
    await expect(section.getByRole("listitem").filter({ hasText: "Antwort Nummer 15." })).toHaveCount(1);

    const box = (await list.boundingBox())!;
    expect(box).toBeTruthy();
    expect(box.height).toBeLessThan(900);
    // The thread is the scroll container, it does not just grow.
    const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);

    await expect(section.getByLabel("Frage")).toBeInViewport();

    await expect.poll(() => atBottom(list)).toBe(true);
    await expect(
      section.getByRole("listitem").filter({ hasText: "Antwort Nummer 15." }),
    ).toBeInViewport();

    await context.close();
  });

  test("after asking a new question the thread is scrolled to the bottom again", async ({ browser }) => {
    test.setTimeout(180_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-scroll-ask");
    await seedChunk(owner, id);
    for (let i = 1; i <= 15; i++) {
      await seedPair(owner, id, `Frage Nummer ${i}?`, `Antwort Nummer ${i}. ${"Mehr Text für die Höhe. ".repeat(8)}`, []);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    const section = chatSection(page);
    const list = section.getByRole("list").first();
    await expect(section.getByRole("listitem").filter({ hasText: "Antwort Nummer 15." })).toHaveCount(1);

    // Scroll away from the bottom first, so "again at the bottom" is a real change.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });

    await section.getByLabel("Frage").fill("Wie viele Personen arbeiten dort?");
    await section.getByRole("button", { name: "Fragen", exact: true }).click();

    await expect(
      section.getByRole("listitem").filter({ hasText: "Wie viele Personen arbeiten dort?" }),
    ).toHaveCount(1);
    await expect(section.getByRole("alert").filter({ hasText: "Modell nicht konfiguriert" })).toBeVisible({
      timeout: 45_000,
    });

    await expect.poll(() => atBottom(list)).toBe(true);
    await expect(
      section.getByRole("listitem").filter({ hasText: "Wie viele Personen arbeiten dort?" }),
    ).toBeInViewport();
    await expect(section.getByLabel("Frage")).toBeInViewport();

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

const COMPOSER_HINT = "Enter sendet, Shift+Enter für einen Zeilenumbruch.";
const CHIP_NAME = `[1] ${SOURCE_TITLE}, S. ${PAGE_NUMBER}`;

test.describe("composer keyboard", () => {
  test("Enter submits the question", async ({ browser }) => {
    test.setTimeout(60_000);
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-enter");
    await seedChunk(owner, id);
    await page.goto(url);

    const section = chatSection(page);
    const textarea = section.getByLabel("Frage");
    await textarea.fill("Wie viele Personen arbeiten dort?");
    await textarea.press("Enter");

    await expect(
      section.getByRole("listitem").filter({ hasText: "Wie viele Personen arbeiten dort?" }),
    ).toHaveCount(1);
    await expect(section.getByRole("alert").filter({ hasText: "Modell nicht konfiguriert" })).toBeVisible({
      timeout: 45_000,
    });

    await context.close();
  });

  test("Shift+Enter inserts a newline and does not submit", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-shift-enter");
    await seedChunk(owner, id);
    await page.goto(url);

    const section = chatSection(page);
    const textarea = section.getByLabel("Frage");
    await textarea.click();
    await textarea.pressSequentially("Zeile eins");
    await textarea.press("Shift+Enter");
    await textarea.pressSequentially("Zeile zwei");

    expect(await textarea.inputValue()).toContain("\n");
    await expect(section.getByRole("listitem")).toHaveCount(0);
    await expect(section.getByRole("alert")).toHaveCount(0);

    await context.close();
  });

  test("the textarea is described by a visible keyboard hint", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-hint");
    await seedChunk(owner, id);
    await page.goto(url);

    const section = chatSection(page);
    await expect(section.getByText(COMPOSER_HINT)).toBeVisible();
    await expect(section.getByLabel("Frage")).toHaveAccessibleDescription(COMPOSER_HINT);

    await context.close();
  });
});

test.describe("composer without field validation", () => {
  test("the textarea is not required and the Fragen button follows the text", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-empty-disabled");
    await seedChunk(owner, id);
    await page.goto(url);

    const section = chatSection(page);
    const textarea = section.getByLabel("Frage");
    const send = section.getByRole("button", { name: "Fragen", exact: true });

    await expect(textarea).not.toHaveAttribute("required", /.*/);
    await expect(send).toBeDisabled();

    await textarea.fill("   \n  ");
    await expect(send).toBeDisabled();

    await textarea.fill("Wie viele Personen arbeiten dort?");
    await expect(send).toBeEnabled();

    await textarea.fill("");
    await expect(send).toBeDisabled();

    await context.close();
  });

  test("Enter on an empty or whitespace-only field does nothing and shows no message", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-empty-enter");
    await seedChunk(owner, id);
    await page.goto(url);

    const section = chatSection(page);
    const textarea = section.getByLabel("Frage");
    await textarea.click();
    await textarea.press("Enter");
    await textarea.fill("   ");
    await textarea.press("Enter");

    await expect(section.getByRole("listitem")).toHaveCount(0);
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Fragen", exact: true })).toBeDisabled();
    // No native validation bubble state either: the field is not flagged invalid.
    expect(await textarea.evaluate((el) => (el as HTMLTextAreaElement).validity.valueMissing)).toBe(false);

    await context.close();
  });
});

test.describe("answer markers", () => {
  test("a bare [2] without a citation stays plain text, only [1] becomes a ref", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-bare-ref");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Frage?", "Antwort eins [1] und zwei [2].", [{ chunkId, quote: QUOTE }]);
    await page.goto(url);

    const section = chatSection(page);
    const answer = section.getByRole("listitem").filter({ hasText: "Antwort eins" });
    await expect(answer).toHaveCount(1);
    await expect(answer).toContainText("[2]");
    await expect(answer.locator(".ref")).toHaveCount(1);

    await context.close();
  });
});

test.describe("passage focus", () => {
  test("opening moves focus to the passage, Escape closes it and returns focus to the chip", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-focus-esc");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann?", "1999 [1].", [{ chunkId, quote: QUOTE }]);
    await page.goto(url);

    const section = chatSection(page);
    const chip = section.getByRole("button", { name: CHIP_NAME });
    await chip.click();

    const region = page.getByRole("region", { name: "Fundstelle [1]" });
    await expect(region).toBeVisible();
    await expect(region).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Fundstelle [1]" })).toHaveCount(0);
    await expect(chip).toBeFocused();

    await context.close();
  });

  test("Schließen closes the passage and returns focus to the chip", async ({ browser }) => {
    const { context, page, owner, id, url } = await ownerWithNotebook(browser, "chat-e2e-focus-close");
    const chunkId = await seedChunk(owner, id);
    await seedPair(owner, id, "Wann?", "1999 [1].", [{ chunkId, quote: QUOTE }]);
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(url);

    const section = chatSection(page);
    const chip = section.getByRole("button", { name: CHIP_NAME });
    await chip.click();

    const region = page.getByRole("region", { name: "Fundstelle [1]" });
    await expect(region).toBeFocused();
    await region.getByRole("button", { name: "Schließen" }).click();
    await expect(page.getByRole("region", { name: "Fundstelle [1]" })).toHaveCount(0);
    await expect(chip).toBeFocused();

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
    await section.getByLabel("Frage").fill("Worum geht es?");
    await expect(section.getByRole("button", { name: "Fragen", exact: true })).toBeEnabled();
    // Messages are visible only to their author (RLS, ADR 0004): the viewer never sees the owner's history.
    await expect(viewerPage.getByText("Frage des Besitzers?")).toHaveCount(0);

    await viewerContext.close();
    await context.close();
  });
});
