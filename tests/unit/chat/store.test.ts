// D2 message store (spec .git/D2-API-SPEC.md "Chat turn / store.ts"). The fake client is
// minimal and records, in order, every insert and delete with its table, payload and the
// flat list of chained filter arguments, like tests/unit/sources/source-store.test.ts: the
// exact PostgREST chain (eq / in / select / single) is an implementation detail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { messageStore } from "@/lib/server/chat/store";

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const ANSWER_ID = "22222222-2222-4222-8222-222222222222";
const QUESTION_RETURNED_ID = "33333333-3333-4333-8333-333333333333";

interface Op {
  kind: "insert" | "delete";
  table: string;
  rows: Record<string, unknown>[];
  args: unknown[];
}

type Failing = "messages-1" | "messages-2" | "message_citations" | null;

// failingDeletes: 1-based positions of the delete calls that return an error.
function fake(failing: Failing = null, failingDeletes: number[] = []) {
  const ops: Op[] = [];
  let messageInserts = 0;
  let deleteCalls = 0;

  function chain(op: Op, result: () => { data: unknown; error: unknown }): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve(result()).then(ok, bad);
          }
          return (...args: unknown[]) => {
            op.args.push(prop, ...args);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const op: Op = { kind: "insert", table, rows: [payload].flat(), args: [] };
          ops.push(op);
          let key = table as string;
          if (table === "messages") {
            messageInserts += 1;
            key = `messages-${messageInserts}`;
          }
          const fails = failing === key;
          // An array that also has an id: works for .single() and for data[0] readers.
          const data = Object.assign([{ id: QUESTION_RETURNED_ID }], { id: QUESTION_RETURNED_ID });
          return chain(op, () => (fails ? { data: null, error: { message: "insert failed" } } : { data, error: null }));
        },
        delete() {
          const op: Op = { kind: "delete", table, rows: [], args: [] };
          ops.push(op);
          deleteCalls += 1;
          const fails = failingDeletes.includes(deleteCalls);
          return chain(op, () => ({ data: null, error: fails ? { message: "delete failed" } : null }));
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, ops };
}

const CITATIONS = [
  { ordinal: 1, chunkId: "chunk-a", quote: "sitzt in Bonn" },
  { ordinal: 2, chunkId: "chunk-b", quote: "Nuss" },
];

function save(client: SupabaseClient) {
  return messageStore(client).saveTurn({
    notebookId: NOTEBOOK_ID,
    question: "Wo sitzt die Firma?",
    answerId: ANSWER_ID,
    answer: "In Bonn [1] mit Nuss [2].",
    citations: CITATIONS,
  });
}

describe("messageStore.saveTurn", () => {
  it("inserts question, answer, citations in that order with the right columns", async () => {
    const { client, ops } = fake();
    await save(client);
    const inserts = ops.filter((o) => o.kind === "insert");
    expect(inserts.map((o) => o.table)).toEqual(["messages", "messages", "message_citations"]);

    expect(inserts[0]?.rows).toHaveLength(1);
    expect(inserts[0]?.rows[0]).toMatchObject({
      notebook_id: NOTEBOOK_ID,
      role: "user",
      content: "Wo sitzt die Firma?",
    });
    expect(inserts[0]?.rows[0]).not.toHaveProperty("user_id");

    expect(inserts[1]?.rows[0]).toMatchObject({
      id: ANSWER_ID,
      notebook_id: NOTEBOOK_ID,
      role: "assistant",
      content: "In Bonn [1] mit Nuss [2].",
    });
    expect(inserts[1]?.rows[0]).not.toHaveProperty("user_id");

    expect(inserts[2]?.rows).toEqual([
      { message_id: ANSWER_ID, notebook_id: NOTEBOOK_ID, ordinal: 1, chunk_id: "chunk-a", quote: "sitzt in Bonn" },
      { message_id: ANSWER_ID, notebook_id: NOTEBOOK_ID, ordinal: 2, chunk_id: "chunk-b", quote: "Nuss" },
    ]);
    expect(ops.some((o) => o.kind === "delete")).toBe(false);
  });

  it("a citation insert failure deletes the answer and the question, then throws", async () => {
    const { client, ops } = fake("message_citations");
    await expect(save(client)).rejects.toThrow();
    const deletes = ops.filter((o) => o.kind === "delete");
    expect(deletes.map((o) => o.table)).toEqual(["messages", "messages"]);
    // Answer first, found by its id; the question by its id (the inserted or the returned one).
    expect(deletes[0]?.args).toContain(ANSWER_ID);
    const questionRow = ops.find((o) => o.kind === "insert")?.rows[0];
    const questionIds: unknown[] = [questionRow?.id, QUESTION_RETURNED_ID].filter((x) => x !== undefined);
    expect(deletes[1]?.args.some((a) => questionIds.includes(a))).toBe(true);
    // Deletes come after all inserts.
    const lastInsert = ops.map((o) => o.kind).lastIndexOf("insert");
    const firstDelete = ops.map((o) => o.kind).indexOf("delete");
    expect(firstDelete).toBeGreaterThan(lastInsert);
  });

  it("a failed answer delete after a citation failure still deletes the question and throws a cleanup error", async () => {
    const { client, ops } = fake("message_citations", [1]);
    await expect(save(client)).rejects.toThrow(/cleanup/);
    expect(ops.filter((o) => o.kind === "delete")).toHaveLength(2);
  });

  it("a failed question delete after a citation failure throws a cleanup error", async () => {
    const { client } = fake("message_citations", [2]);
    await expect(save(client)).rejects.toThrow(/cleanup/);
  });

  it("a failed question delete after an answer insert error throws a cleanup error", async () => {
    const { client } = fake("messages-2", [1]);
    await expect(save(client)).rejects.toThrow(/cleanup/);
  });

  it("when cleanup succeeds the thrown error does not mention cleanup", async () => {
    const { client } = fake("message_citations");
    await expect(save(client)).rejects.toThrow(/^(?!.*cleanup)/s);
  });

  it("a question insert error throws and nothing else is inserted", async () => {
    const { client, ops } = fake("messages-1");
    await expect(save(client)).rejects.toThrow();
    expect(ops.filter((o) => o.kind === "insert")).toHaveLength(1);
  });

  it("an answer insert error throws and no citations are inserted", async () => {
    const { client, ops } = fake("messages-2");
    await expect(save(client)).rejects.toThrow();
    expect(ops.some((o) => o.table === "message_citations")).toBe(false);
    // The question row must not stay behind: exactly one delete on messages, by question id.
    const deletes = ops.filter((o) => o.kind === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.table).toBe("messages");
    const questionRow = ops.find((o) => o.kind === "insert")?.rows[0];
    const questionIds: unknown[] = [questionRow?.id, QUESTION_RETURNED_ID].filter((x) => x !== undefined);
    expect(deletes[0]?.args.some((a) => questionIds.includes(a))).toBe(true);
    const lastInsert = ops.map((o) => o.kind).lastIndexOf("insert");
    expect(ops.map((o) => o.kind).indexOf("delete")).toBeGreaterThan(lastInsert);
  });
});
