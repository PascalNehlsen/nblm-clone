// PR B2 end-to-end: the notebooks list/detail/profil pages and their server
// actions, driven with real, freshly-created local sessions (see
// helpers/session.ts) -- never a test-only login route, never the
// admin/service-role credential (ADR 0005).
//
// Expected UI contract communicated to the builder (not fully pinned down by
// the plan's prose, so fixed here for the tests to target a concrete markup):
//   - "/" has a heading/text "Neues Notizbuch", a text field with accessible
//     label "Titel", and a submit button "Anlegen". Created notebooks are
//     listed by title with a German role label (Eigentümer/Bearbeiter/
//     Betrachter).
//   - "/notebooks/[id]" shows the title, the member list (MemberList), and
//     for owners only: a "Nutzer-ID" field, a role <select> with accessible
//     label "Rolle" offering Bearbeiter/Betrachter, a "Teilen" button, a
//     per-member "Entfernen" button, and a "Notizbuch löschen" button guarded
//     by a required confirmation checkbox labeled "Ich möchte dieses
//     Notizbuch endgültig löschen" (reviewer finding: a destructive action
//     needs an explicit, server-checked confirmation, not just a button).
//   - "/profil" shows the signed-in user's own id as visible text (a uuid),
//     next to a copy button.
//
// Replay technique (reviewer finding): Next.js answers a fetch-based server
// action submission with a 303 and an `x-action-redirect` header instead of
// a normal `Location` header, so `response.ok()` is false for *every* such
// response regardless of whether the action accepted or rejected the call --
// asserting `.ok() === false` alone would pass vacuously. The tests below
// read `x-action-redirect` instead, and each rejection case is paired with a
// positive control (the identical captured request, replayed with valid
// credentials) that proves the replay technique itself actually reaches the
// server action. The confirmation test is the exception: it submits the real
// form without the checkbox and reads the redirected page URL, because the
// production build renames server-action fields; its positive control is the
// owner replay in "a viewer cannot write", which submits a checked form.
import { expect, test, type APIResponse, type Browser, type Page } from "@playwright/test";
import { seedLocalSession, seedLocalSessionWithClient } from "./helpers/session";

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

interface CapturedServerAction {
  url: string;
  headers: Record<string, string>;
  postData: Buffer | null;
}

/**
 * Intercepts the next POST request carrying a `Next-Action` header (the
 * signature of a Next.js server action submission) triggered by `trigger`,
 * and returns its exact url/headers/body so a test can replay it verbatim
 * against a different browser context's cookies. With `abort: true`, the
 * real request never reaches the server at all (route.abort() happens at
 * the browser's network layer) -- used for an action whose *first* real
 * execution must never be allowed to happen (e.g. a delete triggered only to
 * capture its shape). With `abort: false`, the request is allowed through
 * normally -- used when the first execution is supposed to succeed (e.g. a
 * legitimate create, later replayed with stale cookies).
 */
async function captureServerActionRequest(
  page: Page,
  trigger: () => Promise<void>,
  options: { abort: boolean },
): Promise<CapturedServerAction> {
  let captured: CapturedServerAction | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      captured = {
        url: request.url(),
        headers: request.headers(),
        postData: request.postDataBuffer(),
      };
      if (options.abort) {
        await route.abort();
        return;
      }
    }
    await route.continue();
  });

  await trigger();
  await expect.poll(() => captured).not.toBeNull();
  await page.unroute("**/*");
  return captured as unknown as CapturedServerAction;
}

/** Strips the headers that must come from the replaying context instead of
 * the original request: a different (or absent) cookie jar, and a
 * content-length that the HTTP client recomputes for the body it is given. */
function headersForReplay(headers: Record<string, string>): Record<string, string> {
  const replay = { ...headers };
  delete replay["cookie"];
  delete replay["content-length"];
  return replay;
}

/** A Next.js server action answers a fetch-based submission with a redirect
 * carried in this header (never a plain Location + ok 2xx/3xx), so this is
 * the only reliable way to read where a replayed action call actually sent
 * the caller -- see the file header for why `response.ok()` alone proves
 * nothing here. The header's value is not a bare URL: Next writes it as
 * `${url};${type}` (type is "push" or "replace" --
 * apps/web/node_modules/next/dist/server/app-render/action-handler.js:261),
 * so the ";push"/";replace" suffix has to be stripped before parsing, or
 * e.g. "/login;push" gets read as a path of "/login;push" and "?fehler=
 * 42501;push" as a search value of "42501;push" instead of "42501". */
function redirectTarget(response: APIResponse): URL {
  const header = response.headers()["x-action-redirect"];
  if (!header) {
    throw new Error(
      `redirectTarget: no "x-action-redirect" header on the response (status ${response.status()}); ` +
        'a Next.js server action redirect must carry one',
    );
  }
  const withoutRedirectType = header.replace(/;(push|replace)$/, "");
  return new URL(withoutRedirectType, "http://127.0.0.1:3000");
}

test.describe("a signed-in owner creates and manages a notebook", () => {
  test("creating a notebook from the list page lands on its own page, and it appears back in the list", async ({
    context,
  }) => {
    await context.addCookies(await seedLocalSession("notebooks-e2e-create"));
    const page = await context.newPage();
    const title = `Testbuch ${Date.now()}`;

    const notebookUrl = await createNotebookViaUi(page, title);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    await page.goto("/");
    await expect(page.getByText(title)).toBeVisible();

    expect(new URL(notebookUrl).pathname).toMatch(/^\/notebooks\/[0-9a-f-]{36}$/);
  });
});

test.describe("sharing a notebook", () => {
  test("the owner adds the viewer-to-be by pasting their profil id, and the member list shows them", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    await ownerContext.addCookies(await seedLocalSession("notebooks-e2e-share-owner"));
    await viewerContext.addCookies(await seedLocalSession("notebooks-e2e-share-viewer"));
    const ownerPage = await ownerContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await ownerPage.goto("/profil");
    const ownerId = extractUuid(await ownerPage.getByTestId("nutzer-id").innerText());

    await viewerPage.goto("/profil");
    const viewerId = extractUuid(await viewerPage.getByTestId("nutzer-id").innerText());

    const notebookUrl = await createNotebookViaUi(ownerPage, `Teilen-Test ${Date.now()}`);
    await ownerPage.getByLabel("Nutzer-ID").fill(viewerId);
    await ownerPage.getByLabel("Rolle").selectOption({ label: "Betrachter" });
    await ownerPage.getByRole("button", { name: "Teilen" }).click();

    // A shortened form of the viewer's id, per the member-list contract.
    await expect(ownerPage.getByText(viewerId.slice(0, 8))).toBeVisible();

    // The viewer themselves now also sees the notebook and its member list --
    // but *their own* row reads "Du" (unit-tested in
    // tests/unit/notebooks/member-list.test.tsx), not their id prefix; only
    // the owner's row shows an id prefix, since the owner is "someone else"
    // from the viewer's perspective.
    await viewerPage.goto(notebookUrl);
    const members = viewerPage.getByRole("listitem");
    const ownRow = members.filter({ has: viewerPage.getByText("Du", { exact: true }) });
    await expect(ownRow).toContainText("Betrachter");
    await expect(members.filter({ hasText: ownerId.slice(0, 8) })).toContainText("Eigentümer");

    await ownerContext.close();
    await viewerContext.close();
  });
});

test.describe("a viewer cannot write", () => {
  async function setUpSharedNotebook(browser: Browser) {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    await ownerContext.addCookies(await seedLocalSession("notebooks-e2e-viewer-write-owner"));
    await viewerContext.addCookies(await seedLocalSession("notebooks-e2e-viewer-write-viewer"));
    const ownerPage = await ownerContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await viewerPage.goto("/profil");
    const viewerId = extractUuid(await viewerPage.locator("body").innerText());

    const title = `Schreibschutz ${Date.now()}`;
    const notebookUrl = await createNotebookViaUi(ownerPage, title);
    await ownerPage.getByLabel("Nutzer-ID").fill(viewerId);
    await ownerPage.getByLabel("Rolle").selectOption({ label: "Betrachter" });
    await ownerPage.getByRole("button", { name: "Teilen" }).click();
    await expect(ownerPage.getByText(viewerId.slice(0, 8))).toBeVisible();

    return { ownerContext, viewerContext, ownerPage, viewerPage, notebookUrl, title };
  }

  test("the viewer sees the notebook but none of the owner-only controls", async ({ browser }) => {
    const { ownerContext, viewerContext, viewerPage, notebookUrl, title } = await setUpSharedNotebook(browser);

    await viewerPage.goto("/");
    await expect(viewerPage.getByText(title)).toBeVisible();

    await viewerPage.goto(notebookUrl);
    await expect(viewerPage.getByRole("button", { name: "Teilen" })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: "Entfernen" })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: "Notizbuch löschen" })).toHaveCount(0);

    await ownerContext.close();
    await viewerContext.close();
  });

  test("replaying the owner's own delete-notebook request with the viewer's cookies is rejected (redirects with fehler=42501, notebook survives); the same request replayed with the owner's cookies really deletes it", async ({
    browser,
  }) => {
    const { ownerContext, viewerContext, ownerPage, notebookUrl, title } = await setUpSharedNotebook(browser);

    // The delete form requires a checked confirmation checkbox (see the
    // "requires explicit confirmation" describe below) -- checked here so
    // the captured request is exactly what a real, intentional delete looks
    // like. Capture only, aborted before it reaches the server: the owner's
    // own notebook must not be deleted by this step.
    const captured = await captureServerActionRequest(
      ownerPage,
      async () => {
        await ownerPage.getByLabel("Ich möchte dieses Notizbuch endgültig löschen").check();
        await ownerPage.getByRole("button", { name: "Notizbuch löschen" }).click();
      },
      { abort: true },
    );

    // viewerContext.request automatically sends *its own* cookies for a
    // same-origin request -- this is the actual security boundary under
    // test: the same server-action network request, replayed with a
    // different (viewer, not owner) session.
    const viewerReplayResponse = await viewerContext.request.post(captured.url, {
      headers: headersForReplay(captured.headers),
      data: captured.postData ?? undefined,
    });
    const viewerRedirect = redirectTarget(viewerReplayResponse);
    expect(viewerRedirect.pathname).toBe(new URL(notebookUrl).pathname);
    expect(viewerRedirect.searchParams.get("fehler")).toBe("42501");

    await ownerPage.reload();
    await expect(ownerPage.getByText(title)).toBeVisible();

    // Positive control: the exact same captured request, replayed with the
    // OWNER's still-valid cookies, must really delete the notebook -- this
    // is what makes the viewer-rejection assertion above meaningful (a
    // request dropped earlier than the action itself, e.g. by the proxy,
    // would otherwise make that assertion pass for the wrong reason).
    const ownerReplayResponse = await ownerContext.request.post(captured.url, {
      headers: headersForReplay(captured.headers),
      data: captured.postData ?? undefined,
    });
    const ownerRedirect = redirectTarget(ownerReplayResponse);
    expect(ownerRedirect.searchParams.get("fehler")).toBeNull();

    const afterDelete = await ownerPage.goto(notebookUrl);
    expect(afterDelete?.status()).toBe(404);

    await ownerContext.close();
    await viewerContext.close();
  });
});

test.describe("deleting a notebook requires explicit confirmation", () => {
  test("submitting the delete form with the confirmation checkbox left unchecked does not delete, and redirects with fehler=bestaetigung", async ({
    context,
  }) => {
    // Deliberately does not depend on the server action's raw field names
    // (Next's production build prefixes them, e.g. "_1_confirm", unlike the
    // dev build): this submits through the real page with the real button,
    // and only bypasses the checkbox's `required` HTML attribute -- the one
    // thing that would otherwise stop an unchecked submission from ever
    // reaching the network at all -- so what is actually under test is the
    // server action's own confirmation check, not the browser's.
    await context.addCookies(await seedLocalSession("notebooks-e2e-confirm"));
    const page = await context.newPage();
    const title = `Bestaetigung-Test ${Date.now()}`;
    const notebookUrl = await createNotebookViaUi(page, title);

    const checkbox = page.getByLabel("Ich möchte dieses Notizbuch endgültig löschen");
    await checkbox.evaluate((input: HTMLInputElement) => input.removeAttribute("required"));
    await expect(checkbox).not.toBeChecked();

    await page.getByRole("button", { name: "Notizbuch löschen" }).click();
    // The page is already on the notebook path before the click, so wait for the
    // server action's redirect to add an error, not just for the path.
    await page.waitForURL(
      (url) => url.pathname === new URL(notebookUrl).pathname && url.searchParams.has("fehler"),
    );

    const redirectedUrl = new URL(page.url());
    expect(redirectedUrl.searchParams.get("fehler")).toBe("bestaetigung");

    // Still there: a fresh navigation shows the title, not a not-found page.
    const response = await page.goto(notebookUrl);
    expect(response?.status()).not.toBe(404);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });
});

test.describe("replay after logout (ADR 0005)", () => {
  test("replaying the owner's own create-notebook request with pre-logout cookies, after logout, redirects to /login and creates nothing extra; the same request replayed while still logged in really creates one", async ({
    browser,
  }) => {
    // Deliberately does NOT rely on page-level navigation/redirect to prove
    // the point (tests/e2e/authenticated-session.spec.ts's "old session"
    // test already covers that the *layout* bounces a revoked session to
    // /login). This test instead replays the exact create-notebook network
    // request directly -- ADR 0005: "a server action runs before any layout
    // ... the layout's check never stands in for them" -- so it stays
    // meaningful even if a future change ever let a stale cookie reach "/".
    const label = `notebooks-e2e-replay-${Date.now()}`;
    const { cookies, client } = await seedLocalSessionWithClient(label);

    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    const title = `replay-create ${Date.now()}`;

    // The legitimate first creation: captured, but allowed to go through, so
    // the exact real request body/headers can be replayed verbatim later.
    await page.goto("/");
    const captured = await captureServerActionRequest(
      page,
      async () => {
        await page.getByLabel("Titel").fill(title);
        await page.getByRole("button", { name: "Anlegen" }).click();
      },
      { abort: false },
    );
    await page.waitForURL(/\/notebooks\/[0-9a-f-]{36}/);

    // Positive control, while still logged in: the exact same captured
    // request, replayed again, must really create a second notebook with
    // this title -- without this, the post-logout rejection below could pass
    // simply because the replayed request never reached the action at all
    // (e.g. dropped by the proxy, or malformed).
    const controlResponse = await context.request.post(captured.url, {
      headers: headersForReplay(captured.headers),
      data: captured.postData ?? undefined,
    });
    const controlRedirect = redirectTarget(controlResponse);
    expect(controlRedirect.pathname).toMatch(/^\/notebooks\/[0-9a-f-]{36}$/);

    const { data: beforeLogout, error: beforeLogoutError } = await client
      .from("notebooks")
      .select("id")
      .eq("title", title);
    expect(beforeLogoutError).toBeNull();
    expect(beforeLogout).toHaveLength(2); // the UI creation above, plus this positive control

    await page.getByRole("button", { name: "Abmelden" }).click();
    await expect(page).toHaveURL(/\/login/);

    // Replay the exact same request with the pre-logout cookies, in a fresh
    // context that never saw the logout -- standing in for a stolen cookie
    // or a second tab that never reloaded.
    const replayContext = await browser.newContext();
    await replayContext.addCookies(cookies);
    const replayResponse = await replayContext.request.post(captured.url, {
      headers: headersForReplay(captured.headers),
      data: captured.postData ?? undefined,
    });
    const replayRedirect = redirectTarget(replayResponse);
    expect(replayRedirect.pathname).toBe("/login");

    // The app has no email/password login (GitHub OAuth only, per B1), so
    // "logging in again" to check the list uses this same user's own
    // still-valid API client instead (never the admin/service-role
    // credential): a plain read, not a bypass of anything asserted above.
    const { data: afterReplay, error: afterReplayError } = await client
      .from("notebooks")
      .select("id")
      .eq("title", title);
    expect(afterReplayError).toBeNull();
    expect(afterReplay).toHaveLength(2); // unchanged from the positive control above, not 3

    await context.close();
    await replayContext.close();
  });
});

test.describe("a stranger cannot reach someone else's notebook", () => {
  test("opening the notebook URL as a stranger gets the not-found page", async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const strangerContext = await browser.newContext();
    await ownerContext.addCookies(await seedLocalSession("notebooks-e2e-stranger-owner"));
    await strangerContext.addCookies(await seedLocalSession("notebooks-e2e-stranger-stranger"));
    const ownerPage = await ownerContext.newPage();
    const strangerPage = await strangerContext.newPage();

    const notebookUrl = await createNotebookViaUi(ownerPage, `Fremdzugriff ${Date.now()}`);

    const response = await strangerPage.goto(notebookUrl);
    expect(response?.status()).toBe(404);

    await ownerContext.close();
    await strangerContext.close();
  });
});
