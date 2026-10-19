// readSourceAction: loads a source's full text on demand with the signed-in user's client
// (RLS decides). Same mocking technique as tests/unit/sources/actions.test.ts; createClient
// returns a recording query builder so the test can assert what was queried.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, fromMock, tables, calls } = vi.hoisted(() => {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const tables: Record<string, { single: unknown; many: unknown }> = {};
  const fromMock = vi.fn((table: string) => {
    const result = () => tables[table] ?? { single: { data: null, error: null }, many: { data: [], error: null } };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) =>
      (...args: unknown[]) => {
        calls.push({ table, method, args });
        if (method === "single" || method === "maybeSingle") return Promise.resolve(result().single);
        return builder;
      };
    for (const method of ["select", "eq", "order", "limit", "range", "single", "maybeSingle"]) {
      builder[method] = chain(method);
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result().many).then(resolve, reject);
    return builder;
  });
  return { getUserMock: vi.fn(), fromMock, tables, calls };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: getUserMock }, from: fromMock })),
}));
vi.mock("@/lib/notebooks/notebooks", () => ({ getNotebook: vi.fn() }));
vi.mock("@/lib/sources/sources", () => ({
  createSource: vi.fn(),
  createUrlSource: vi.fn(),
  createSignedUpload: vi.fn(),
  uploadTextObject: vi.fn(),
  deleteSource: vi.fn(),
}));
vi.mock("@/lib/server/ingest/run", () => ({ runIngestion: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { readSourceAction } from "@/app/(app)/notebooks/[id]/sources/actions";
import { chunkPages } from "@/lib/server/ingest/chunk";

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const FIRST = "Erster Abschnitt";
const SECOND = "Zweiter Abschnitt";

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1", is_anonymous: false } } });
  tables.sources = {
    single: { data: { id: SOURCE_ID, title: "Bericht.txt", status: "ready" }, error: null },
    many: { data: [{ id: SOURCE_ID, title: "Bericht.txt", status: "ready" }], error: null },
  };
  tables.chunks = {
    single: { data: null, error: null },
    many: {
      data: [
        { ordinal: 0, content: FIRST },
        { ordinal: 1, content: SECOND },
      ],
      error: null,
    },
  };
});

describe("readSourceAction", () => {
  it("queries chunks filtered by notebook_id and source_id, ordered by ordinal", async () => {
    await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    const chunkCalls = calls.filter((c) => c.table === "chunks");
    const eqs = chunkCalls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["notebook_id", NOTEBOOK_ID]);
    expect(eqs).toContainEqual(["source_id", SOURCE_ID]);
    const order = chunkCalls.find((c) => c.method === "order");
    expect(order?.args[0]).toBe("ordinal");
    expect((order?.args[1] as { ascending?: boolean } | undefined)?.ascending).not.toBe(false);
  });

  it("queries sources filtered by notebook_id and id", async () => {
    await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    const eqs = calls.filter((c) => c.table === "sources" && c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["notebook_id", NOTEBOOK_ID]);
    expect(eqs).toContainEqual(["id", SOURCE_ID]);
  });

  it("returns the title and the chunk texts in ordinal order, without a text field", async () => {
    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    expect(result).toMatchObject({ ok: true, title: "Bericht.txt", truncated: false });
    if (!result.ok) throw new Error("expected ok");
    expect("text" in result).toBe(false);
    expect(result.sections).toHaveLength(1);
    const text = result.sections[0]!.text;
    expect(text.indexOf(FIRST)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(FIRST)).toBeLessThan(text.indexOf(SECOND));
  });

  it("selects kind, source_url and title from sources and content, page and ordinal from chunks", async () => {
    await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    const columns = (table: string) =>
      String(calls.find((c) => c.table === table && c.method === "select")?.args[0] ?? "")
        .split(",")
        .map((s) => s.trim());
    expect(columns("sources")).toEqual(expect.arrayContaining(["kind", "source_url", "title"]));
    expect(columns("chunks")).toEqual(expect.arrayContaining(["content", "page", "ordinal"]));
  });

  it("a url source returns kind url, its source_url and one section (page null), non-overlapping chunks joined with a newline", async () => {
    tables.sources = {
      single: {
        data: { kind: "url", source_url: "https://example.com/artikel", title: "Seite" },
        error: null,
      },
      many: { data: [], error: null },
    };
    tables.chunks = {
      single: { data: null, error: null },
      many: {
        data: [
          { ordinal: 0, content: FIRST, page: null },
          { ordinal: 1, content: SECOND, page: null },
        ],
        error: null,
      },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result).toMatchObject({ kind: "url", url: "https://example.com/artikel" });
    expect(result.sections).toEqual([{ page: null, text: `${FIRST}\n${SECOND}` }]);
  });

  it("a pdf source returns kind pdf, url null and one section per distinct page, overlap removed", async () => {
    tables.sources = {
      single: { data: { kind: "pdf", source_url: null, title: "Bericht.pdf" }, error: null },
      many: { data: [], error: null },
    };
    tables.chunks = {
      single: { data: null, error: null },
      many: {
        data: [
          { ordinal: 0, content: "Alpha Beta Gamma Delta Epsilon", page: 1 },
          { ordinal: 1, content: "Delta Epsilon Zeta Eta", page: 1 },
          { ordinal: 2, content: SECOND, page: 2 },
        ],
        error: null,
      },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result).toMatchObject({ kind: "pdf", url: null });
    expect(result.sections).toEqual([
      { page: 1, text: "Alpha Beta Gamma Delta Epsilon Zeta Eta" },
      { page: 2, text: SECOND },
    ]);
  });

  it("a common prefix and suffix that does not start at a word boundary in the previous chunk is not dropped", async () => {
    tables.chunks = {
      single: { data: null, error: null },
      many: {
        data: [
          { ordinal: 0, content: "Das Haus", page: null },
          { ordinal: 1, content: "aus ist groß", page: null },
        ],
        error: null,
      },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result.sections).toEqual([{ page: null, text: "Das Haus\naus ist groß" }]);
  });

  it("chunks produced by the real chunker merge back to the original text exactly", async () => {
    const paragraphs = Array.from({ length: 20 },(_, i) =>
      [
        `Abschnitt ${i + 1}: Die Fiktiva GmbH prüft im Quartal ${i + 1} die Berichte der Standorte.`,
        `Dabei wurden ${100 + i * 7} Vorgänge bearbeitet, und jeder Vorgang erhielt eine eigene Nummer ${9000 + i * 13}.`,
        `Besonders auffällig war, dass die Kosten im Bereich ${i % 3 === 0 ? "Logistik" : "Verwaltung"} stiegen.`,
        `Die Geschäftsführung entschied daher, die Prozesse gründlich zu überarbeiten und neu zu dokumentieren.`,
      ].join(" "),
    );
    const original = paragraphs.join("\n\n");
    expect(original.length).toBeGreaterThan(5000);

    const drafts = chunkPages([{ page: null, text: original }]);
    expect(drafts.length).toBeGreaterThan(2);
    // The chunker really overlaps neighbours (otherwise this test proves nothing).
    expect(drafts[1]!.start).toBeLessThan(drafts[0]!.start + drafts[0]!.content.length);

    tables.chunks = {
      single: { data: null, error: null },
      many: {
        data: drafts.map((d) => ({ ordinal: d.ordinal, content: d.content, page: d.page })),
        error: null,
      },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toEqual({ page: null, text: original });
  });

  it("chunks cut inside a whitespace-free token (the chunker's hard cut) merge back to the original text exactly", async () => {
    // Layout: a short lead-in, a 700-character token, then a paragraph break. The first chunk
    // ends at the break (the only "\n\n" inside its cut window), so its last 200 characters are
    // all token and the next chunk starts mid-token (chunk.ts nextStart, hard-cut branch).
    const body = Array.from({ length: 80 }, (_, i) => `s${i}x${(i * 7919) % 9973}`).join("-");
    const token = `https://example.com/pfad/${body}`.slice(0, 700);
    expect(token).toHaveLength(700);
    expect(/\s/.test(token)).toBe(false);
    const lead = "Die Fiktiva GmbH veröffentlicht ihre Berichte unter dieser Adresse: ";
    // One long paragraph (no "\n\n" before offset 1500), then more paragraphs.
    const sentences = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `Im Bericht ${i + 1} stehen ${200 + i * 11} Kennzahlen zu den Standorten und ihrer Entwicklung.`,
      ).join(" ");
    const original = [`${lead}${token}`, "", sentences(14), "", sentences(14)].join("\n");
    expect(original.length).toBeGreaterThan(2500);
    expect(original.indexOf("\n\n", original.indexOf(token) + token.length + 2)).toBeGreaterThan(1500);

    const drafts = chunkPages([{ page: null, text: original }]);
    expect(drafts.length).toBeGreaterThan(2);
    const tokenStart = original.indexOf(token);
    // Precondition: some chunk really starts inside the token, not at a word start.
    expect(
      drafts.some(
        (d) => d.start > tokenStart && d.start < tokenStart + token.length && !/\s/.test(original[d.start - 1]!),
      ),
    ).toBe(true);

    tables.chunks = {
      single: { data: null, error: null },
      many: {
        data: drafts.map((d) => ({ ordinal: d.ordinal, content: d.content, page: d.page })),
        error: null,
      },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toEqual({ page: null, text: original });
  });

  it("a text source returns kind text and url null;a stray source_url is not exposed", async () => {
    tables.sources = {
      single: { data: { kind: "text", source_url: "https://stray.example/", title: "Notiz" }, error: null },
      many: { data: [], error: null },
    };

    const result = await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID });

    if (!result.ok) throw new Error("expected ok");
    expect(result).toMatchObject({ kind: "text", url: null });
    expect(result.sections).toHaveLength(1);
  });

  it.each([
    ["a non-uuid sourceId", { notebookId: NOTEBOOK_ID, sourceId: "not-a-uuid" }],
    ["a non-uuid notebookId", { notebookId: "not-a-uuid", sourceId: SOURCE_ID }],
  ])("%s returns ok false without any query", async (_name, input) => {
    const result = await readSourceAction(input);

    expect(result).toEqual({ ok: false });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("a source that is not visible in this notebook (no row) returns ok false", async () => {
    tables.sources = { single: { data: null, error: null }, many: { data: [], error: null } };
    tables.chunks = { single: { data: null, error: null }, many: { data: [], error: null } };

    expect(await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID })).toEqual({ ok: false });
  });

  it("a query error returns ok false", async () => {
    tables.chunks = { single: { data: null, error: null }, many: { data: null, error: { message: "boom" } } };

    expect(await readSourceAction({ notebookId: NOTEBOOK_ID, sourceId: SOURCE_ID })).toEqual({ ok: false });
  });
});
