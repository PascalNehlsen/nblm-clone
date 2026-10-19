// D3 history mapping (spec .git/D3-API-SPEC.md "history.ts").
import { describe, expect, it } from "vitest";
import { listHistory, toHistory } from "@/lib/chat/history";

type Rows = Parameters<typeof toHistory>[0];

const CHUNK = (content: string, page: number | null, title: string) => ({
  content,
  page,
  sources: { title },
});

describe("toHistory", () => {
  it("maps a user and an assistant row with citations and chunk data", () => {
    const rows = [
      { id: "u1", role: "user", content: "Frage?", created_at: "2026-10-19T10:00:00Z", message_citations: [] },
      {
        id: "a1",
        role: "assistant",
        content: "Antwort [1]",
        created_at: "2026-10-19T10:00:05Z",
        message_citations: [
          { ordinal: 1, quote: "Fiktiva", chunk_id: "c1", chunks: CHUNK("Die Fiktiva GmbH", 3, "Bericht.pdf") },
        ],
      },
    ] as unknown as Rows;

    expect(toHistory(rows)).toEqual([
      { id: "u1", role: "user", content: "Frage?", createdAt: "2026-10-19T10:00:00Z", citations: [] },
      {
        id: "a1",
        role: "assistant",
        content: "Antwort [1]",
        createdAt: "2026-10-19T10:00:05Z",
        citations: [
          { ordinal: 1, quote: "Fiktiva", chunk: { content: "Die Fiktiva GmbH", page: 3, sourceTitle: "Bericht.pdf" } },
        ],
      },
    ]);
  });

  it("maps a citation whose chunk is gone to chunk null", () => {
    const rows = [
      {
        id: "a1",
        role: "assistant",
        content: "x",
        created_at: "2026-10-19T10:00:00Z",
        message_citations: [{ ordinal: 1, quote: "q", chunk_id: null, chunks: null }],
      },
    ] as unknown as Rows;
    expect(toHistory(rows)[0]!.citations).toEqual([{ ordinal: 1, quote: "q", chunk: null }]);
  });

  it("keeps a null page", () => {
    const rows = [
      {
        id: "a1",
        role: "assistant",
        content: "x",
        created_at: "2026-10-19T10:00:00Z",
        message_citations: [{ ordinal: 1, quote: "q", chunk_id: "c", chunks: CHUNK("t", null, "Notiz") }],
      },
    ] as unknown as Rows;
    expect(toHistory(rows)[0]!.citations[0]!.chunk).toEqual({ content: "t", page: null, sourceTitle: "Notiz" });
  });

  it("sorts by createdAt, then user before assistant at the same time", () => {
    const rows = [
      { id: "a2", role: "assistant", content: "A2", created_at: "2026-10-19T10:00:10Z", message_citations: [] },
      { id: "a1", role: "assistant", content: "A1", created_at: "2026-10-19T10:00:00Z", message_citations: [] },
      { id: "u1", role: "user", content: "U1", created_at: "2026-10-19T10:00:00Z", message_citations: [] },
      { id: "u2", role: "user", content: "U2", created_at: "2026-10-19T10:00:09Z", message_citations: [] },
    ] as unknown as Rows;
    expect(toHistory(rows).map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("sorts citations by ordinal", () => {
    const rows = [
      {
        id: "a1",
        role: "assistant",
        content: "x",
        created_at: "2026-10-19T10:00:00Z",
        message_citations: [
          { ordinal: 3, quote: "c", chunk_id: "c3", chunks: CHUNK("c", 1, "S") },
          { ordinal: 1, quote: "a", chunk_id: "c1", chunks: CHUNK("a", 1, "S") },
          { ordinal: 2, quote: "b", chunk_id: "c2", chunks: CHUNK("b", 1, "S") },
        ],
      },
    ] as unknown as Rows;
    expect(toHistory(rows)[0]!.citations.map((c) => c.ordinal)).toEqual([1, 2, 3]);
  });

  it("returns an empty list for no rows", () => {
    expect(toHistory([] as unknown as Rows)).toEqual([]);
  });
});

describe("listHistory", () => {
  function fakeClient(result: { data: unknown; error: { message: string } | null }) {
    const calls: { table?: string; eq?: [string, string] } = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: string) => {
        calls.eq = [column, value];
        return builder;
      },
      order: () => Promise.resolve(result),
    };
    const client = {
      from: (table: string) => {
        calls.table = table;
        return builder;
      },
    };
    return { client: client as unknown as Parameters<typeof listHistory>[0], calls };
  }

  it("queries messages for the notebook and maps the rows", async () => {
    const { client, calls } = fakeClient({
      data: [{ id: "u1", role: "user", content: "F", created_at: "2026-10-19T10:00:00Z", message_citations: [] }],
      error: null,
    });
    const history = await listHistory(client, "nb-1");
    expect(calls.table).toBe("messages");
    expect(calls.eq).toEqual(["notebook_id", "nb-1"]);
    expect(history).toEqual([
      { id: "u1", role: "user", content: "F", createdAt: "2026-10-19T10:00:00Z", citations: [] },
    ]);
  });

  it("throws on a query error", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    await expect(listHistory(client, "nb-1")).rejects.toBeDefined();
  });
});
