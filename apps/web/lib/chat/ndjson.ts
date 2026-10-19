// Reads the NDJSON events of a chat turn in the browser (block D3). Client-safe: no secrets,
// no server imports. Anything unexpected ends the read as "broken", so the caller drops the
// streamed text instead of keeping unchecked model output.

export interface ChatCitation {
  ordinal: number;
  chunkId: string;
  quote: string;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message: { id: string; content: string; citations: ChatCitation[]; abstained: boolean } }
  | { type: "error"; label: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCitation(value: unknown): value is ChatCitation {
  return (
    isRecord(value) &&
    typeof value.ordinal === "number" &&
    typeof value.chunkId === "string" &&
    typeof value.quote === "string"
  );
}

function parseEvent(line: string): ChatEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "delta" && typeof value.text === "string") return { type: "delta", text: value.text };
  if (value.type === "error" && typeof value.label === "string") return { type: "error", label: value.label };
  if (value.type === "done" && isRecord(value.message)) {
    const m = value.message;
    if (
      typeof m.id === "string" &&
      typeof m.content === "string" &&
      typeof m.abstained === "boolean" &&
      Array.isArray(m.citations) &&
      m.citations.every(isCitation)
    ) {
      return { type: "done", message: { id: m.id, content: m.content, citations: m.citations, abstained: m.abstained } };
    }
  }
  return null;
}

export async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: ChatEvent) => void,
): Promise<"done" | "error" | "broken"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1 || (done && buffer.length > 0)) {
        const line = newline === -1 ? buffer : buffer.slice(0, newline);
        buffer = newline === -1 ? "" : buffer.slice(newline + 1);
        if (line.trim() !== "") {
          const event = parseEvent(line);
          if (!event) {
            await reader.cancel().catch(() => undefined);
            return "broken";
          }
          onEvent(event);
          if (event.type !== "delta") {
            await reader.cancel().catch(() => undefined);
            return event.type;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (done) return "broken";
    }
  } catch {
    return "broken";
  }
}
