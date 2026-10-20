// C1 ingestion (approved plan, Pascal 2026-10-19; see .git/C1-API-SPEC.md "Server actions").
// Same mocking technique as tests/unit/auth/callback.test.ts and tests/unit/model/caller.test.ts:
// vi.mock every module the actions import, so the action file's own `import { x } from "@/..."`
// resolves to our fakes. next/navigation's redirect() is mocked to throw a recognizable,
// inspectable error (real Next.js redirect() also always throws) so a call to redirect() can
// be asserted without the action's control flow actually continuing past it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES } from "@/lib/sources/limits";

// vi.mock factories are hoisted above regular `const` declarations, so every
// mock (and the RedirectSignal class the redirect mock throws) must be created
// inside vi.hoisted, which is hoisted together with them. Same technique as
// tests/unit/model/call-production.test.ts.
const {
  getUserMock,
  getNotebookMock,
  createSourceMock,
  createUrlSourceMock,
  createSignedUploadMock,
  uploadTextObjectMock,
  deleteSourceMock,
  runIngestionMock,
  revalidatePathMock,
  RedirectSignal,
  redirectMock,
  notFoundMock,
} = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly url: string) {
      super(`REDIRECT:${url}`);
      this.name = "RedirectSignal";
    }
  }

  return {
    getUserMock: vi.fn(),
    getNotebookMock: vi.fn(),
    createSourceMock: vi.fn(),
    createUrlSourceMock: vi.fn(),
    createSignedUploadMock: vi.fn(),
    uploadTextObjectMock: vi.fn(),
    deleteSourceMock: vi.fn(),
    runIngestionMock: vi.fn(),
    revalidatePathMock: vi.fn(),
    RedirectSignal,
    redirectMock: vi.fn((url: string): never => {
      throw new RedirectSignal(url);
    }),
    notFoundMock: vi.fn((): never => {
      throw new Error("NOT_FOUND");
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: getUserMock } })),
}));
vi.mock("@/lib/notebooks/notebooks", () => ({ getNotebook: getNotebookMock }));
vi.mock("@/lib/sources/sources", () => ({
  createSource: createSourceMock,
  createUrlSource: createUrlSourceMock,
  createSignedUpload: createSignedUploadMock,
  uploadTextObject: uploadTextObjectMock,
  deleteSource: deleteSourceMock,
}));
vi.mock("@/lib/server/ingest/run", () => ({ runIngestion: runIngestionMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  addTextSourceAction,
  addUrlSourceAction,
  createPdfUploadAction,
  deleteSourceAction,
  ingestSourceAction,
} from "@/app/(app)/notebooks/[id]/sources/actions";

const VALID_NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const VALID_SOURCE_ID = "22222222-2222-4222-8222-222222222222";

function defaultUser(overrides: Partial<{ id: string; is_anonymous: boolean }> = {}) {
  return { id: "user-1", is_anonymous: false, ...overrides };
}

function textFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  redirectMock.mockImplementation((url: string): never => {
    throw new RedirectSignal(url);
  });
  getUserMock.mockResolvedValue({ data: { user: defaultUser() } });
  getNotebookMock.mockResolvedValue({ id: VALID_NOTEBOOK_ID, title: "Notizbuch", role: "owner" });
  createSourceMock.mockResolvedValue({ id: VALID_SOURCE_ID, storagePath: `${VALID_NOTEBOOK_ID}/${VALID_SOURCE_ID}` });
  createUrlSourceMock.mockResolvedValue({ id: VALID_SOURCE_ID, storagePath: `${VALID_NOTEBOOK_ID}/${VALID_SOURCE_ID}` });
  createSignedUploadMock.mockResolvedValue({ signedUrl: "https://signed.example/upload" });
  uploadTextObjectMock.mockResolvedValue(undefined);
  deleteSourceMock.mockResolvedValue(undefined);
  runIngestionMock.mockResolvedValue({ ok: true, chunks: 3 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPdfUploadAction", () => {
  it("no user redirects to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    await expect(
      createPdfUploadAction({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", size: 1000, type: "application/pdf" }),
    ).rejects.toMatchObject({ url: "/login" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("a non-uuid notebookId returns fehler without creating a source", async () => {
    const result = await createPdfUploadAction({
      notebookId: "not-a-uuid",
      title: "Doc",
      size: 1000,
      type: "application/pdf",
    });

    expect(result).toEqual({ ok: false, error: "fehler" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("an anonymous user is refused", async () => {
    getUserMock.mockResolvedValue({ data: { user: defaultUser({ is_anonymous: true }) } });

    const result = await createPdfUploadAction({
      notebookId: VALID_NOTEBOOK_ID,
      title: "Doc",
      size: 1000,
      type: "application/pdf",
    });

    expect(result).toEqual({ ok: false, error: "nicht_erlaubt" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  interface RefusedRoleCase {
    name: string;
    notebook: { id: string; title: string; role: "viewer" } | null;
  }
  const REFUSED_ROLE_CASES: RefusedRoleCase[] = [
    { name: "viewer", notebook: { id: VALID_NOTEBOOK_ID, title: "Notizbuch", role: "viewer" } },
    { name: "no membership", notebook: null },
  ];

  it.each(REFUSED_ROLE_CASES)("role $name is refused before any write", async ({ notebook }) => {
    getNotebookMock.mockResolvedValue(notebook);

    const result = await createPdfUploadAction({
      notebookId: VALID_NOTEBOOK_ID,
      title: "Doc",
      size: 1000,
      type: "application/pdf",
    });

    expect(result).toEqual({ ok: false, error: "nicht_erlaubt" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  const BAD_TITLES = ["", "a".repeat(201)];
  it.each(BAD_TITLES)("title %j is rejected before any write", async (title) => {
    const result = await createPdfUploadAction({ notebookId: VALID_NOTEBOOK_ID, title, size: 1000, type: "application/pdf" });

    expect(result).toEqual({ ok: false, error: "titel" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  const BAD_SIZES = [0, MAX_UPLOAD_BYTES + 1];
  it.each(BAD_SIZES)("size %i is rejected before any write", async (size) => {
    const result = await createPdfUploadAction({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", size, type: "application/pdf" });

    expect(result).toEqual({ ok: false, error: "groesse" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("a non-pdf type is rejected before any write", async () => {
    const result = await createPdfUploadAction({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", size: 1000, type: "text/html" });

    expect(result).toEqual({ ok: false, error: "typ" });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("createSource's notebook_source_limit error maps to limit", async () => {
    createSourceMock.mockRejectedValue(Object.assign(new Error("limit hit"), { code: "notebook_source_limit" }));

    const result = await createPdfUploadAction({
      notebookId: VALID_NOTEBOOK_ID,
      title: "Doc",
      size: 1000,
      type: "application/pdf",
    });

    expect(result).toEqual({ ok: false, error: "limit" });
    expect(createSignedUploadMock).not.toHaveBeenCalled();
  });

  const ALLOWED_ROLES = ["owner", "editor"] as const;
  it.each(ALLOWED_ROLES)("role %s: creates the source, then the signed upload, strictly in that order", async (role) => {
    getNotebookMock.mockResolvedValue({ id: VALID_NOTEBOOK_ID, title: "Notizbuch", role });

    const result = await createPdfUploadAction({
      notebookId: VALID_NOTEBOOK_ID,
      title: "  Mein Dokument  ",
      size: 1000,
      type: "application/pdf",
    });

    expect(createSourceMock).toHaveBeenCalledWith(expect.anything(), VALID_NOTEBOOK_ID, "pdf", "Mein Dokument");
    expect(createSignedUploadMock).toHaveBeenCalledWith(
      expect.anything(),
      `${VALID_NOTEBOOK_ID}/${VALID_SOURCE_ID}`,
    );
    expect(createSourceMock.mock.invocationCallOrder[0]!).toBeLessThan(
      createSignedUploadMock.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({ ok: true, sourceId: VALID_SOURCE_ID, signedUrl: "https://signed.example/upload" });
  });

  it("createSignedUpload failing after a real createSource returns fehler", async () => {
    createSignedUploadMock.mockRejectedValue(new Error("network down"));

    const result = await createPdfUploadAction({
      notebookId: VALID_NOTEBOOK_ID,
      title: "Doc",
      size: 1000,
      type: "application/pdf",
    });

    expect(result).toEqual({ ok: false, error: "fehler" });
  });
});

describe("addTextSourceAction", () => {
  it("a viewer is redirected with fehler=nicht_erlaubt and no source is created", async () => {
    getNotebookMock.mockResolvedValue({ id: VALID_NOTEBOOK_ID, title: "Notizbuch", role: "viewer" });

    await expect(
      addTextSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", text: "Hallo Welt" })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=nicht_erlaubt` });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  const BAD_TEXTS = ["   ", "a".repeat(MAX_TEXT_CHARS + 1)];
  it.each(BAD_TEXTS)("bad text is redirected with fehler=text", async (text) => {
    await expect(
      addTextSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", text })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=text` });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  const BAD_TITLES_FOR_TEXT = ["", "a".repeat(201)];
  it.each(BAD_TITLES_FOR_TEXT)("bad title %j is redirected with fehler=titel", async (title) => {
    await expect(
      addTextSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, title, text: "Hallo Welt" })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=titel` });
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("happy path: creates the source, uploads the text, ingests, then redirects without fehler", async () => {
    await expect(
      addTextSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", text: "  Hallo Welt  " })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}` });

    expect(createSourceMock).toHaveBeenCalledWith(expect.anything(), VALID_NOTEBOOK_ID, "text", "Doc");
    expect(uploadTextObjectMock).toHaveBeenCalledWith(
      expect.anything(),
      `${VALID_NOTEBOOK_ID}/${VALID_SOURCE_ID}`,
      "Hallo Welt",
    );
    expect(runIngestionMock).toHaveBeenCalledWith(expect.anything(), VALID_SOURCE_ID);

    const order = [
      createSourceMock.mock.invocationCallOrder[0]!,
      uploadTextObjectMock.mock.invocationCallOrder[0]!,
      runIngestionMock.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("an ingestion failure still redirects without fehler (shown in the list, not as a query flag)", async () => {
    runIngestionMock.mockResolvedValue({ ok: false, category: "model_not_configured" });

    await expect(
      addTextSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, title: "Doc", text: "Hallo Welt" })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}` });
  });
});

describe("addUrlSourceAction (C2)", () => {
  const GOOD_URL = "https://example.com/artikel";

  function urlForm(overrides: Record<string, string> = {}): FormData {
    return textFormData({ notebookId: VALID_NOTEBOOK_ID, title: "Seite", url: GOOD_URL, ...overrides });
  }

  function expectNoWrite(): void {
    expect(createUrlSourceMock).not.toHaveBeenCalled();
    expect(createSourceMock).not.toHaveBeenCalled();
    expect(uploadTextObjectMock).not.toHaveBeenCalled();
    expect(runIngestionMock).not.toHaveBeenCalled();
  }

  it("no user redirects to /login before anything else", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({ url: "/login" });
    expectNoWrite();
  });

  it("a non-uuid notebookId redirects to / without a write", async () => {
    await expect(addUrlSourceAction(urlForm({ notebookId: "not-a-uuid" }))).rejects.toMatchObject({ url: "/" });
    expectNoWrite();
  });

  it("a viewer is redirected with fehler=nicht_erlaubt and nothing is created", async () => {
    getNotebookMock.mockResolvedValue({ id: VALID_NOTEBOOK_ID, title: "Notizbuch", role: "viewer" });

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=nicht_erlaubt`,
    });
    expectNoWrite();
  });

  it("a user without membership is redirected with fehler=nicht_erlaubt", async () => {
    getNotebookMock.mockResolvedValue(null);

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=nicht_erlaubt`,
    });
    expectNoWrite();
  });

  it("an anonymous user is redirected with fehler=nicht_erlaubt even as owner", async () => {
    getUserMock.mockResolvedValue({ data: { user: defaultUser({ is_anonymous: true }) } });

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=nicht_erlaubt`,
    });
    expectNoWrite();
  });

  const BAD_TITLES_FOR_URL = ["", "a".repeat(201)];
  it.each(BAD_TITLES_FOR_URL)("bad title %j is redirected with fehler=titel before the URL is looked at", async (title) => {
    await expect(addUrlSourceAction(urlForm({ title, url: "ftp://example.com/" }))).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=titel`,
    });
    expectNoWrite();
  });

  const BAD_URLS = [
    "",
    "   ",
    "not a url",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pw@example.com/",
    "https://example.com:8080/",
    "http://localhost/",
    "http://intranet/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    `https://example.com/${"a".repeat(2100)}`,
  ];
  it.each(BAD_URLS)("url %j is redirected with fehler=url before any insert", async (url) => {
    await expect(addUrlSourceAction(urlForm({ url }))).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=url`,
    });
    expectNoWrite();
  });

  const YOUTUBE_URLS = [
    "https://youtube.com/watch?v=abc",
    "https://www.youtube.com/watch?v=abc",
    "https://m.youtube.com/watch?v=abc",
    "https://music.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://www.youtube-nocookie.com/embed/abc",
    "https://youtube-nocookie.com/embed/abc",
    "https://studio.youtube.com/",
    "http://WWW.YOUTUBE.COM/watch?v=abc",
    "  https://youtu.be/abc  ",
  ];
  it.each(YOUTUBE_URLS)("youtube url %j is redirected with fehler=youtube before any write or fetch", async (url) => {
    await expect(addUrlSourceAction(urlForm({ url }))).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=youtube`,
    });
    expectNoWrite();
  });

  const LOOKALIKE_URLS = [
    "https://notyoutube.com/watch",
    "https://youtube.com.evil.example/watch",
    "https://example.com/youtube.com/watch",
    "https://example.com/?u=youtu.be",
  ];
  it.each(LOOKALIKE_URLS)("look-alike %j is not rejected as youtube", async (url) => {
    await expect(addUrlSourceAction(urlForm({ url }))).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}`,
    });
    expect(createUrlSourceMock).toHaveBeenCalledTimes(1);
    expect(runIngestionMock).toHaveBeenCalledTimes(1);
  });

  it("a missing url field is redirected with fehler=url", async () => {
    const fd = new FormData();
    fd.set("notebookId", VALID_NOTEBOOK_ID);
    fd.set("title", "Seite");

    await expect(addUrlSourceAction(fd)).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=url` });
    expectNoWrite();
  });

  it("createUrlSource's notebook_source_limit error maps to fehler=limit and nothing is ingested", async () => {
    createUrlSourceMock.mockRejectedValue(Object.assign(new Error("limit hit"), { code: "notebook_source_limit" }));

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=limit`,
    });
    expect(runIngestionMock).not.toHaveBeenCalled();
  });

  it("any other createUrlSource error maps to fehler=fehler and nothing is ingested", async () => {
    createUrlSourceMock.mockRejectedValue(Object.assign(new Error("boom"), { code: "fehler" }));

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({
      url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=fehler`,
    });
    expect(runIngestionMock).not.toHaveBeenCalled();
  });

  const ALLOWED_URL_ROLES = ["owner", "editor"] as const;
  it.each(ALLOWED_URL_ROLES)("role %s: inserts kind url with the normalized URL, ingests, redirects without fehler", async (role) => {
    getNotebookMock.mockResolvedValue({ id: VALID_NOTEBOOK_ID, title: "Notizbuch", role });

    await expect(
      addUrlSourceAction(urlForm({ title: "  Meine Seite  ", url: "  HTTPS://Example.COM/Artikel#abschnitt  " })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}` });

    expect(createUrlSourceMock).toHaveBeenCalledTimes(1);
    expect(createUrlSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      VALID_NOTEBOOK_ID,
      "Meine Seite",
      "https://example.com/Artikel",
    );
    expect(createSourceMock).not.toHaveBeenCalled();
    expect(uploadTextObjectMock).not.toHaveBeenCalled();
    expect(runIngestionMock).toHaveBeenCalledWith(expect.anything(), VALID_SOURCE_ID);
    expect(createUrlSourceMock.mock.invocationCallOrder[0]!).toBeLessThan(runIngestionMock.mock.invocationCallOrder[0]!);
  });

  it("an ingestion failure still redirects without fehler (shown on the source in the list)", async () => {
    runIngestionMock.mockResolvedValue({ ok: false, category: "url_blocked" });

    await expect(addUrlSourceAction(urlForm())).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}` });
  });
});

describe("ingestSourceAction", () => {
  it("a non-uuid sourceId never calls runIngestion", async () => {
    await ingestSourceAction({ notebookId: VALID_NOTEBOOK_ID, sourceId: "not-a-uuid" });

    expect(runIngestionMock).not.toHaveBeenCalled();
  });

  it("valid ids: calls runIngestion, revalidates the notebook path, and returns {ok:true}", async () => {
    runIngestionMock.mockResolvedValue({ ok: true, chunks: 5 });

    const result = await ingestSourceAction({ notebookId: VALID_NOTEBOOK_ID, sourceId: VALID_SOURCE_ID });

    expect(runIngestionMock).toHaveBeenCalledWith(expect.anything(), VALID_SOURCE_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/notebooks/${VALID_NOTEBOOK_ID}`);
    expect(result).toEqual({ ok: true });
  });

  it("passes a failed outcome's category through unchanged", async () => {
    runIngestionMock.mockResolvedValue({ ok: false, category: "budget_exceeded" });

    const result = await ingestSourceAction({ notebookId: VALID_NOTEBOOK_ID, sourceId: VALID_SOURCE_ID });

    expect(result).toEqual({ ok: false, category: "budget_exceeded" });
  });
});

describe("deleteSourceAction", () => {
  it("calls deleteSource with the user's client and the sourceId, then redirects without fehler", async () => {
    await expect(
      deleteSourceAction(
        textFormData({ notebookId: VALID_NOTEBOOK_ID, sourceId: VALID_SOURCE_ID, confirm: "on" }),
      ),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}` });

    expect(deleteSourceMock).toHaveBeenCalledWith(expect.anything(), VALID_SOURCE_ID);
  });

  it("without the confirm field it redirects with fehler=bestaetigung_quelle and never calls deleteSource", async () => {
    await expect(
      deleteSourceAction(textFormData({ notebookId: VALID_NOTEBOOK_ID, sourceId: VALID_SOURCE_ID })),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=bestaetigung_quelle` });

    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("a nicht_erlaubt error redirects with fehler=nicht_erlaubt", async () => {
    deleteSourceMock.mockRejectedValue(Object.assign(new Error("not allowed"), { code: "nicht_erlaubt" }));

    await expect(
      deleteSourceAction(
        textFormData({ notebookId: VALID_NOTEBOOK_ID, sourceId: VALID_SOURCE_ID, confirm: "on" }),
      ),
    ).rejects.toMatchObject({ url: `/notebooks/${VALID_NOTEBOOK_ID}?fehler=nicht_erlaubt` });
  });
});

describe("app/(app)/notebooks/[id]/page: maxDuration", () => {
  it("exports maxDuration = 300 (a pdf's extraction + embedding can run close to the default limit)", async () => {
    const page = await import("@/app/(app)/notebooks/[id]/page");

    expect(page.maxDuration).toBe(300);
  });
});
