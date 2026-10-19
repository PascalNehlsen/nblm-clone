// D2 chat (plan approved by Pascal). See .git/D2-API-SPEC.md "chat.ts": createChatCaller
// wires the Bedrock chat provider behind createModelCaller, so every chat call passes the
// budget check (AGENTS.md). Same pattern as embeddings.test.ts: no injectable deps.
// Static checks: chat.ts is server-only and never reaches the admin (service_role) module.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createModelCallerMock, callerResultSentinel, bedrockChatSentinel } = vi.hoisted(() => {
  const callerResultSentinel = vi.fn();
  return {
    createModelCallerMock: vi.fn<(deps: { provider: unknown }) => unknown>(() => callerResultSentinel),
    callerResultSentinel,
    bedrockChatSentinel: vi.fn(),
  };
});

vi.mock("@/lib/server/model/call", () => ({
  createModelCaller: createModelCallerMock,
}));

vi.mock("@/lib/server/model/bedrock", () => ({
  bedrockChat: bedrockChatSentinel,
}));

import { createChatCaller } from "@/lib/server/model/chat";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const chatFile = path.join(repoRoot, "apps/web/lib/server/model/chat.ts");

afterEach(() => {
  vi.clearAllMocks();
});

describe("createChatCaller", () => {
  it("calls createModelCaller exactly once with { provider: bedrockChat } and no other keys", () => {
    createChatCaller();

    expect(createModelCallerMock).toHaveBeenCalledTimes(1);
    const deps = createModelCallerMock.mock.calls[0]?.[0];
    expect(deps?.provider).toBe(bedrockChatSentinel);
    expect(Object.keys(deps ?? {})).toEqual(["provider"]);
  });

  it("returns createModelCaller's result", () => {
    expect(createChatCaller()).toBe(callerResultSentinel);
  });
});

describe("chat.ts: static checks", () => {
  it("the source file exists", () => {
    expect(fs.existsSync(chatFile), "apps/web/lib/server/model/chat.ts is missing").toBe(true);
  });

  it('begins with `import "server-only";` as its first line', () => {
    const firstLine = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, "utf8").split("\n")[0]?.trim() : undefined;
    expect(firstLine).toBe('import "server-only";');
  });

  it("does not import the admin module (service_role) in any form", () => {
    const content = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, "utf8") : "";
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toMatch(/lib\/server\/admin/);
    expect(content).not.toMatch(/\/admin\//);
    expect(content).not.toMatch(/from\s+["'][^"']*admin[^"']*["']/);
  });

  it("only imports the Bedrock provider and the budgeted wrapper (./bedrock, ./call)", () => {
    const content = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, "utf8") : "";
    const specifiers = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(["./bedrock", "./call"]);
  });

  it("never reaches the engine or the test-only entry point directly", () => {
    const content = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, "utf8") : "";
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain("call-core");
    expect(content).not.toContain("./testing");
  });
});
