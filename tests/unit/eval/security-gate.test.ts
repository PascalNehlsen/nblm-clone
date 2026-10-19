// D2 deterministic eval gate (spec .git/D2-API-SPEC.md "Eval"). It replays scripted hostile
// model outputs (tests/eval/cases.json "security") against the fixtures in tests/eval/fixtures/
// through buildChatInput, createMarkerFilter, validateCitations and runTurn with fakes. No
// network and no model: this is the hard CI gate, the live eval runner is a later PR.
//
// The server stores and the UI renders plain text, so a link or an image in an answer is shown
// as literal text (D3 tests that). This gate checks that markers and citations cannot be forged,
// and that injected text only ever sits inside its nonce block.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateCitations } from "@/lib/rag/citations";
import { ABSTENTION, buildChatInput } from "@/lib/rag/prompt";
import type { RetrievedChunk } from "@/lib/rag/retrieve";
import { createMarkerFilter } from "@/lib/rag/stream-filter";
import { runTurn, type MessageStore, type TurnDeps } from "@/lib/server/chat/turn";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";

const evalDir = path.resolve(import.meta.dirname, "../../eval");
const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const ANSWER_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "feedfacecafebeef";
const MARKER_ANYWHERE = /\[\d{1,2}:\s*"/;

interface FactCase {
  id: string;
  question: string;
  expectedTerms: string[];
  mustCite: string;
}
interface AbstentionCase {
  id: string;
  question: string;
}
interface SecurityCase {
  id: string;
  fixture: string;
  question: string;
  payloads: string[];
  deltas: string[];
  splitChars?: boolean;
  expectedValid: number;
}
interface Cases {
  facts: FactCase[];
  abstention: AbstentionCase[];
  security: SecurityCase[];
}

const cases = JSON.parse(fs.readFileSync(path.join(evalDir, "cases.json"), "utf8")) as Cases;

function fixtureText(name: string): string {
  return fs.readFileSync(path.join(evalDir, "fixtures", name), "utf8");
}

function chunksOf(fixture: string): RetrievedChunk[] {
  return fixtureText(fixture)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((content, i) => ({
      id: `chunk-${i + 1}`,
      sourceId: "source-1",
      ordinal: i,
      page: null,
      content,
      score: 0.9,
    }));
}

function deltasOf(c: SecurityCase): string[] {
  return c.splitChars ? c.deltas.join("").split("") : c.deltas;
}

describe("eval corpus is consistent", () => {
  it("has 2 to 3 fixtures, all German markdown without em dashes", () => {
    const files = fs.readdirSync(path.join(evalDir, "fixtures")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.length).toBeLessThanOrEqual(3);
    const emDash = String.fromCharCode(0x2014);
    for (const f of files) expect(fixtureText(f)).not.toContain(emDash);
  });

  it("has fact, abstention and security cases", () => {
    expect(cases.facts.length).toBeGreaterThanOrEqual(3);
    expect(cases.abstention.length).toBeGreaterThanOrEqual(2);
    expect(cases.security.length).toBeGreaterThanOrEqual(8);
  });

  it("every fact case names a fixture that exists and contains all expected terms", () => {
    for (const c of cases.facts) {
      const text = fixtureText(c.mustCite);
      for (const term of c.expectedTerms) expect(text, `${c.id}: ${term}`).toContain(term);
    }
  });

  it("every security payload is present in its fixture", () => {
    for (const c of cases.security) {
      const text = fixtureText(c.fixture);
      // Payloads that only an output script carries are allowed; at least one must be in the fixture.
      expect(c.payloads.some((p) => text.includes(p)), c.id).toBe(true);
    }
  });

  it("covers the required attack kinds", () => {
    const all = JSON.stringify(cases.security);
    expect(all).toContain("CANARY-7Q2");
    expect(all).toContain("![");
    expect(all).toContain("javascript:");
    expect(all).toContain("<script>");
    expect(cases.security.some((c) => c.splitChars === true)).toBe(true);
    expect(cases.security.some((c) => c.expectedValid === 0)).toBe(true);
  });
});

describe("the injection text sits only inside its nonce block", () => {
  for (const c of cases.security) {
    it(c.id, () => {
      const chunks = chunksOf(c.fixture);
      const input = buildChatInput(c.question, chunks, NONCE);
      const content = input.messages[0]?.content ?? "";
      const open = `<quelle-${NONCE} nr="`;
      const close = `</quelle-${NONCE}>`;

      // Exactly one real closing tag per chunk, whatever the chunks contain.
      expect(content.split(close).length - 1).toBe(chunks.length);
      expect(content.split(open).length - 1).toBe(chunks.length);

      for (const payload of c.payloads) {
        // Never in the system prompt, never in the question block.
        expect(input.system).not.toContain(payload);
        const questionBlock = content.slice(content.indexOf(`<frage-${NONCE}>`));
        expect(questionBlock).not.toContain(payload);

        let from = 0;
        for (;;) {
          const idx = content.indexOf(payload, from);
          if (idx === -1) break;
          const lastOpen = content.lastIndexOf(open, idx);
          const lastClose = content.lastIndexOf(close, idx);
          expect(lastOpen, `${payload} is outside any block`).toBeGreaterThanOrEqual(0);
          expect(lastOpen, `${payload} comes after a real closing tag`).toBeGreaterThan(lastClose);
          expect(content.indexOf(close, idx), `${payload} has no real closing tag after it`).not.toBe(-1);
          from = idx + payload.length;
        }
      }
    });
  }
});

describe("nothing streamed through the filter contains a marker", () => {
  for (const c of cases.security) {
    it(c.id, () => {
      const emitted: string[] = [];
      const f = createMarkerFilter((t) => emitted.push(t));
      for (const d of deltasOf(c)) f.push(d);
      f.end();
      const streamed = emitted.join("");
      expect(streamed).not.toMatch(MARKER_ANYWHERE);
      for (const e of emitted) expect(e).not.toMatch(MARKER_ANYWHERE);
    });
  }
});

describe("every citation that survives validation is valid", () => {
  for (const c of cases.security) {
    it(c.id, () => {
      const chunks = chunksOf(c.fixture);
      const r = validateCitations(c.deltas.join(""), chunks);
      expect(r.citations).toHaveLength(c.expectedValid);
      for (const cit of r.citations) {
        const source = chunks.find((ch) => ch.id === cit.chunkId);
        expect(source, `${c.id}: unknown chunk ${cit.chunkId}`).toBeDefined();
        expect(source?.content.normalize("NFC")).toContain(cit.quote.normalize("NFC"));
      }
      expect(r.text).not.toMatch(MARKER_ANYWHERE);
    });
  }
});

describe("runTurn with scripted hostile model output", () => {
  for (const c of cases.security) {
    it(c.id, async () => {
      const chunks = chunksOf(c.fixture);
      const saveTurn = vi.fn<MessageStore["saveTurn"]>(async () => {});
      const streamed: string[] = [];
      const callChat = async (req: ModelCallRequest<"chat">): Promise<ModelCallResult<"chat">> => {
        // The scripted model sees the real prompt: injected text must be inside blocks there too.
        expect(req.input.messages).toHaveLength(1);
        const text = deltasOf(c).join("");
        for (const d of deltasOf(c)) req.onDelta?.(d);
        await req.linkMessage?.({ text });
        return { ok: true, output: { text }, usageId: "u", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, settled: true };
      };
      const deps: TurnDeps = {
        retrieve: async () => ({ ok: true, chunks, usageId: "u-r" }),
        callChat,
        store: { saveTurn },
        log: () => {},
        now: () => 0,
        nonce: () => NONCE,
        newId: () => ANSWER_ID,
      };
      const result = await runTurn(deps, { notebookId: NOTEBOOK_ID, question: c.question, onDelta: (t) => streamed.push(t) });

      expect(result.ok).toBe(true);
      expect(streamed.join("")).not.toMatch(MARKER_ANYWHERE);
      expect(saveTurn).toHaveBeenCalledTimes(1);
      const saved = saveTurn.mock.calls[0]?.[0];
      expect(saved?.citations).toHaveLength(c.expectedValid);
      for (const cit of saved?.citations ?? []) {
        const source = chunks.find((ch) => ch.id === cit.chunkId);
        expect(source?.content.normalize("NFC")).toContain(cit.quote.normalize("NFC"));
      }
      expect(saved?.answer ?? "").not.toMatch(MARKER_ANYWHERE);
      if (c.expectedValid === 0) {
        expect(saved?.answer).toBe(ABSTENTION);
        expect(result.ok && result.message.abstained).toBe(true);
        // A model that echoes the canary without a valid citation never gets it stored or shown.
        expect(saved?.answer).not.toContain("CANARY-7Q2");
      } else {
        expect(result.ok && result.message.abstained).toBe(false);
      }
    });
  }
});
