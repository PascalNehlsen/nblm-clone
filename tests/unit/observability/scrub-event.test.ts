// scrubEvent is an allowlist: only technical fields survive. User text (prompts, source text,
// answers, emails, cookies, URLs with queries) must never reach Sentry, whichever field it is in.
import { describe, expect, it } from "vitest";

const MODULE_PATH = "../../../apps/web/lib/observability/sentry-options";

type Ev = Record<string, unknown>;
interface Mod {
  scrubEvent: (event: Ev) => Ev | null;
}

async function load(): Promise<Mod> {
  return (await import(MODULE_PATH)) as Mod;
}

const S = "SENTINEL-7f3a-user-text";

function dirtyEvent(): Ev {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1760000000,
    level: "error",
    platform: "javascript",
    release: "sha123",
    environment: "production",
    server_name: `host-${S}`,
    message: `message ${S}`,
    logentry: { message: `log ${S}`, params: [S, { nested: S }] },
    exception: {
      values: [
        {
          type: "TypeError",
          value: `value ${S}`,
          mechanism: { type: "onerror", handled: false, data: { note: S } },
          stacktrace: {
            frames: [
              {
                filename: "app:///_next/static/chunks/app/page.js",
                function: "handleSubmit",
                lineno: 42,
                colno: 7,
                in_app: true,
                module: "app/page",
                abs_path: `https://example.com/page.js?q=${S}`,
                vars: { question: S },
                pre_context: [`pre ${S}`],
                context_line: `line ${S}`,
                post_context: [`post ${S}`],
              },
            ],
          },
        },
      ],
    },
    request: {
      url: `https://nblm-web.vercel.app/notebooks/abc/chat?q=${S}#frag-${S}`,
      method: "POST",
      data: { question: S },
      cookies: { session: S },
      headers: { cookie: S, authorization: `Bearer ${S}`, "user-agent": S },
      query_string: `q=${S}`,
      env: { REMOTE_ADDR: S },
    },
    user: { id: S, email: `${S}@example.com`, ip_address: S, username: S },
    extra: { prompt: S },
    contexts: {
      custom: { text: S },
      runtime: { name: "node", version: "22.1.0", extra: S },
      os: { name: "Linux", version: "6.1", kernel_version: S },
      browser: { name: "Chrome", version: "130" },
      device: { family: S, name: "Pixel", version: "9" },
      trace: { trace_id: S },
    },
    tags: { runtime: "node", question: S, transaction: S },
    breadcrumbs: [{ category: "console", message: S, data: { s: S } }],
    fingerprint: [S],
    transaction: `/notebooks/${S}`,
    modules: { [S]: "1.0.0" },
    sdk: { name: "sentry.javascript.nextjs", version: "10.76.0" },
  };
}

describe("scrubEvent: nothing user-supplied survives", () => {
  it("returns a non-null event", async () => {
    const { scrubEvent } = await load();
    expect(scrubEvent(dirtyEvent())).not.toBeNull();
  });

  it("the sentinel never appears anywhere in the serialized result", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent());
    expect(JSON.stringify(out)).not.toContain(S);
    expect(JSON.stringify(out)).not.toContain("example.com");
  });

  const fields: [string, (e: Ev) => void][] = [
    ["request.data", (e) => ((e.request as Ev).data = S)],
    ["request.cookies", (e) => ((e.request as Ev).cookies = S)],
    ["request.headers", (e) => ((e.request as Ev).headers = { x: S })],
    ["request.query_string", (e) => ((e.request as Ev).query_string = S)],
    ["request.url query", (e) => ((e.request as Ev).url = `https://a.example/p?x=${S}`)],
    ["request.url fragment", (e) => ((e.request as Ev).url = `https://a.example/p#${S}`)],
    ["exception value", (e) => ((e.exception as { values: Ev[] }).values[0]!.value = S)],
    ["message", (e) => (e.message = S)],
    ["logentry", (e) => (e.logentry = { message: S, params: [S] })],
    ["extra", (e) => (e.extra = { a: { b: S } })],
    ["contexts.custom", (e) => ((e.contexts as Ev).custom = { a: S })],
    ["user", (e) => (e.user = { id: S, email: S, ip_address: S })],
    ["non-allowlisted tag", (e) => (e.tags = { other: S })],
    ["breadcrumbs", (e) => (e.breadcrumbs = [{ message: S }])],
    ["server_name", (e) => (e.server_name = S)],
    ["fingerprint", (e) => (e.fingerprint = [S])],
    ["transaction name", (e) => (e.transaction = S)],
    [
      "frame vars and context lines",
      (e) => {
        const frame = (e.exception as { values: { stacktrace: { frames: Ev[] } }[] }).values[0]!
          .stacktrace.frames[0]!;
        frame.vars = { a: S };
        frame.pre_context = [S];
        frame.context_line = S;
        frame.post_context = [S];
      },
    ],
  ];
  for (const [name, plant] of fields) {
    it(`drops the sentinel planted in ${name}`, async () => {
      const { scrubEvent } = await load();
      const event = dirtyEvent();
      plant(event);
      expect(JSON.stringify(scrubEvent(event))).not.toContain(S);
    });
  }

  it("replaces the exception value with a fixed text", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent()) as { exception: { values: { value?: string }[] } };
    expect(out.exception.values[0]!.value).toBe("redacted");
  });

  it("has no user, extra, breadcrumbs, message or logentry key", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent())!;
    for (const key of ["user", "extra", "breadcrumbs", "message", "logentry", "server_name"]) {
      expect(out, key).not.toHaveProperty(key);
    }
  });

  it("keeps no request field except the path-only url (and method)", async () => {
    const { scrubEvent } = await load();
    const request = (scrubEvent(dirtyEvent()) as { request?: Ev }).request ?? {};
    for (const key of ["data", "cookies", "headers", "query_string", "env"]) {
      expect(request, key).not.toHaveProperty(key);
    }
  });

  it("does not mutate-leak: scrubbing a bare event with only unknown keys stays clean", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent({ whatever: S, nested: { deep: S } });
    expect(JSON.stringify(out)).not.toContain(S);
  });
});

describe("scrubEvent: positive control (technical data survives)", () => {
  it("keeps ids, level, platform, release and environment", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent())!;
    expect(out.event_id).toBe("0123456789abcdef0123456789abcdef");
    expect(out.timestamp).toBe(1760000000);
    expect(out.level).toBe("error");
    expect(out.platform).toBe("javascript");
    expect(out.release).toBe("sha123");
    expect(out.environment).toBe("production");
  });

  it("keeps the exception type and mechanism", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent()) as {
      exception: { values: { type: string; mechanism: { type: string; handled: boolean } }[] };
    };
    expect(out.exception.values[0]!.type).toBe("TypeError");
    expect(out.exception.values[0]!.mechanism.type).toBe("onerror");
    expect(out.exception.values[0]!.mechanism.handled).toBe(false);
  });

  it("keeps frame filename, function, lineno, colno, in_app and module", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent()) as {
      exception: { values: { stacktrace: { frames: Ev[] } }[] };
    };
    const frame = out.exception.values[0]!.stacktrace.frames[0]!;
    expect(frame.filename).toBe("app:///_next/static/chunks/app/page.js");
    expect(frame.function).toBe("handleSubmit");
    expect(frame.lineno).toBe(42);
    expect(frame.colno).toBe(7);
    expect(frame.in_app).toBe(true);
    expect(frame.module).toBe("app/page");
    for (const key of ["vars", "pre_context", "context_line", "post_context"]) {
      expect(frame, key).not.toHaveProperty(key);
    }
  });

  it("reduces request.url to the path, without origin, query or fragment", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent()) as { request: { url: string } };
    expect(out.request.url).toBe("/notebooks/abc/chat");
  });

  it("keeps the runtime tag and technical runtime/os/browser version fields", async () => {
    const { scrubEvent } = await load();
    const out = scrubEvent(dirtyEvent()) as {
      tags: Record<string, string>;
      contexts: Record<string, Record<string, string>>;
    };
    expect(out.tags).toEqual({ runtime: "node" });
    expect(out.contexts.runtime).toMatchObject({ name: "node", version: "22.1.0" });
    expect(out.contexts.os).toMatchObject({ name: "Linux", version: "6.1" });
    expect(out.contexts.browser).toMatchObject({ name: "Chrome", version: "130" });
    expect(out.contexts).not.toHaveProperty("custom");
    expect(out.contexts).not.toHaveProperty("trace");
  });
});
