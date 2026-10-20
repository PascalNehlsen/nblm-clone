// D3 NDJSON reader (spec .git/D3-API-SPEC.md "ndjson.ts").
import { describe, expect, it } from "vitest";
import { readChatEvents, type ChatEvent } from "@/lib/chat/ndjson";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

function textStream(parts: string[]): ReadableStream<Uint8Array> {
  return streamOf(parts.map((p) => encoder.encode(p)));
}

async function run(body: ReadableStream<Uint8Array>) {
  const events: ChatEvent[] = [];
  const result = await readChatEvents(body, (e) => events.push(e));
  return { events, result };
}

const DONE = {
  type: "done",
  message: { id: "m1", content: "Antwort", citations: [{ ordinal: 1, chunkId: "c1", quote: "q" }], abstained: false },
};

describe("readChatEvents", () => {
  it("reads delta lines and a done event and returns done", async () => {
    const body = textStream([
      `${JSON.stringify({ type: "delta", text: "Hal" })}\n`,
      `${JSON.stringify({ type: "delta", text: "lo" })}\n${JSON.stringify(DONE)}\n`,
    ]);
    const { events, result } = await run(body);
    expect(result).toBe("done");
    expect(events).toEqual([{ type: "delta", text: "Hal" }, { type: "delta", text: "lo" }, DONE]);
  });

  it("a done message with the extra abstention field parses and the field is ignored", async () => {
    for (const abstention of ["no_marker", "dropped", "model", "no_sources", null]) {
      const withExtra = { type: "done", message: { ...DONE.message, abstained: abstention !== null, abstention } };
      const { events, result } = await run(textStream([`${JSON.stringify(withExtra)}\n`]));
      expect(result, String(abstention)).toBe("done");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "done",
        message: { ...DONE.message, abstained: abstention !== null },
      });
      expect(Object.keys((events[0] as { message: object }).message).sort()).toEqual(
        ["abstained", "citations", "content", "id"],
      );
    }
  });

  it("joins a line that arrives in pieces", async () => {
    const line = `${JSON.stringify({ type: "delta", text: "Hallo Welt" })}\n`;
    const body = textStream([line.slice(0, 5), line.slice(5, 20), line.slice(20), `${JSON.stringify(DONE)}\n`]);
    const { events, result } = await run(body);
    expect(result).toBe("done");
    expect(events[0]).toEqual({ type: "delta", text: "Hallo Welt" });
    expect(events).toHaveLength(2);
  });

  it("decodes a UTF-8 character split across chunk boundaries", async () => {
    const bytes = encoder.encode(`${JSON.stringify({ type: "delta", text: "Grüße €" })}\n${JSON.stringify(DONE)}\n`);
    // Split inside the two-byte "ü" and inside the three-byte euro sign.
    const uIndex = bytes.indexOf(0xc3);
    const euroIndex = bytes.indexOf(0xe2);
    const body = streamOf([
      bytes.slice(0, uIndex + 1),
      bytes.slice(uIndex + 1, euroIndex + 1),
      bytes.slice(euroIndex + 1, euroIndex + 2),
      bytes.slice(euroIndex + 2),
    ]);
    const { events, result } = await run(body);
    expect(result).toBe("done");
    expect(events[0]).toEqual({ type: "delta", text: "Grüße €" });
  });

  it("ignores empty lines", async () => {
    const body = textStream([`\n\n${JSON.stringify({ type: "delta", text: "a" })}\n\n`, `${JSON.stringify(DONE)}\n\n`]);
    const { events, result } = await run(body);
    expect(result).toBe("done");
    expect(events).toHaveLength(2);
  });

  it("returns error after an error event", async () => {
    const body = textStream([`${JSON.stringify({ type: "error", label: "Modell nicht konfiguriert" })}\n`]);
    const { events, result } = await run(body);
    expect(result).toBe("error");
    expect(events).toEqual([{ type: "error", label: "Modell nicht konfiguriert" }]);
  });

  it("returns broken when the stream ends without done or error", async () => {
    const body = textStream([`${JSON.stringify({ type: "delta", text: "a" })}\n`]);
    const { events, result } = await run(body);
    expect(result).toBe("broken");
    expect(events).toEqual([{ type: "delta", text: "a" }]);
  });

  it("returns broken when a read throws", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", text: "a" })}\n`));
        } else {
          controller.error(new Error("network down"));
        }
      },
    });
    const { events, result } = await run(body);
    expect(result).toBe("broken");
    expect(events).toEqual([{ type: "delta", text: "a" }]);
  });

  it("stops at a line that is not valid JSON and emits nothing after it", async () => {
    const body = textStream([
      `${JSON.stringify({ type: "delta", text: "a" })}\nnot json\n${JSON.stringify({ type: "delta", text: "b" })}\n${JSON.stringify(DONE)}\n`,
    ]);
    const { events, result } = await run(body);
    expect(result).toBe("broken");
    expect(events).toEqual([{ type: "delta", text: "a" }]);
  });

  it("stops at a JSON line with an unknown shape", async () => {
    const body = textStream([
      `${JSON.stringify({ type: "delta", text: "a" })}\n${JSON.stringify({ type: "tool", name: "x" })}\n${JSON.stringify(DONE)}\n`,
    ]);
    const { events, result } = await run(body);
    expect(result).toBe("broken");
    expect(events).toEqual([{ type: "delta", text: "a" }]);
  });

  it("treats a delta without text as broken", async () => {
    const body = textStream([`${JSON.stringify({ type: "delta" })}\n`]);
    const { events, result } = await run(body);
    expect(result).toBe("broken");
    expect(events).toEqual([]);
  });
});
