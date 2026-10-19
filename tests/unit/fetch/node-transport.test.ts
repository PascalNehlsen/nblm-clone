// C2 URL import: the real node:http/node:https transport, against an in-process
// loopback server only (no external network). The transport does not run the guard,
// so the unresolvable host example.invalid with a loopback port is fine here: the
// request only works if the connection goes to the pinned address and never to DNS.
// See .git/C2-API-SPEC.md ("node-transport.ts") and ADR 0008.
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportRequest } from "@/lib/server/fetch/guarded-fetch";
import { createNodeTransport } from "@/lib/server/fetch/node-transport";

const HEADERS = {
  "user-agent": "nblm-url-import/1",
  accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function request(port: number, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: new URL(`http://example.invalid:${port}/path?x=1`),
    address: "127.0.0.1",
    family: 4,
    headers: { ...HEADERS },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe("createNodeTransport: pinned connection", () => {
  it("connects to the pinned address while the Host header keeps the real name", async () => {
    let seen: http.IncomingHttpHeaders = {};
    let seenUrl = "";
    let seenMethod = "";
    const port = await startServer((req, res) => {
      seen = req.headers;
      seenUrl = req.url ?? "";
      seenMethod = req.method ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });

    const transport = createNodeTransport();
    const response = await transport(request(port));

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect((await collect(response.body)).toString()).toBe("hello");
    expect(seen.host).toBe(`example.invalid:${port}`);
    expect(seenUrl).toBe("/path?x=1");
    expect(seenMethod).toBe("GET");
    expect(seen["user-agent"]).toBe("nblm-url-import/1");
    expect(seen.accept).toBe(HEADERS.accept);
    expect(seen["accept-encoding"]).toBe(HEADERS["accept-encoding"]);
    expect(seen.cookie).toBeUndefined();
    expect(seen.referer).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
  });

  it("returns raw (still encoded) bytes and lower-case header names", async () => {
    const gz = gzipSync(Buffer.from("compressed page"));
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip", "X-Custom": "1" });
      res.end(gz);
    });
    const response = await createNodeTransport()(request(port));
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.headers["x-custom"]).toBe("1");
    expect((await collect(response.body)).equals(gz)).toBe(true);
  });

  it("does not follow redirects itself", async () => {
    let hits = 0;
    const port = await startServer((req, res) => {
      hits += 1;
      if (req.url === "/target") {
        res.writeHead(200).end("target");
        return;
      }
      res.writeHead(302, { Location: "/target" }).end();
    });
    const response = await createNodeTransport()(request(port, { url: new URL(`http://example.invalid:${port}/start`) }));
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/target");
    await collect(response.body);
    expect(hits).toBe(1);
  });

  it("still connects directly when proxy variables are set", async () => {
    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      vi.stubEnv(name, "http://127.0.0.1:1");
    }
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("NO_PROXY", "");
    let hits = 0;
    const port = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/plain" }).end("direct");
    });
    const response = await createNodeTransport()(request(port));
    expect((await collect(response.body)).toString()).toBe("direct");
    expect(hits).toBe(1);
  });

  it("rejects when the abort signal fires on a server that never answers", async () => {
    const port = await startServer(() => {
      // never respond
    });
    const controller = new AbortController();
    const pending = createNodeTransport()(request(port, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeDefined();
  });

  it("rejects when the connection is refused", async () => {
    const port = await startServer((_req, res) => res.end());
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(createNodeTransport()(request(port))).rejects.toBeDefined();
  });
});

describe("createNodeTransport: request options (through the injected request functions)", () => {
  it("passes the real host name, a lookup that only yields the pinned address, a non-keepalive agent and the signal", async () => {
    let captured: http.RequestOptions | undefined;
    const httpRequest = ((options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
      captured = options;
      return http.request(options, callback);
    }) as unknown as typeof http.request;
    const port = await startServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("x"));
    const controller = new AbortController();

    const response = await createNodeTransport({ httpRequest })(request(port, { signal: controller.signal }));
    await collect(response.body);

    expect(captured).toBeDefined();
    const options = captured!;
    expect(options.hostname).toBe("example.invalid");
    expect(options.signal).toBeDefined();

    const agent = options.agent as http.Agent & { options?: { keepAlive?: boolean } };
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent.options?.keepAlive).toBe(false);

    const lookup = options.lookup as unknown as (
      host: string,
      opts: object,
      cb: (err: Error | null, address?: unknown, family?: number) => void,
    ) => void;
    expect(typeof lookup).toBe("function");

    const single = await new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
      lookup("example.invalid", {}, (err, address, family) => resolve({ err, address, family }));
    });
    expect(single.err).toBeNull();
    expect(single.address).toBe("127.0.0.1");
    expect(single.family).toBe(4);

    const all = await new Promise<{ err: Error | null; address?: unknown }>((resolve) => {
      lookup("example.invalid", { all: true }, (err, address) => resolve({ err, address }));
    });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("the lookup refuses any other host name and never yields an address for it", async () => {
    let captured: http.RequestOptions | undefined;
    const httpRequest = ((options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
      captured = options;
      return http.request(options, callback);
    }) as unknown as typeof http.request;
    const port = await startServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("x"));
    const response = await createNodeTransport({ httpRequest })(request(port));
    await collect(response.body);

    const lookup = captured!.lookup as unknown as (
      host: string,
      opts: object,
      cb: (err: Error | null, address?: unknown, family?: number) => void,
    ) => void;
    let yielded: unknown;
    let failed = false;
    try {
      lookup("other.example", {}, (err, address) => {
        if (err) failed = true;
        else yielded = address;
      });
    } catch {
      failed = true;
    }
    expect(yielded).toBeUndefined();
    expect(failed).toBe(true);
  });

  it("for https uses httpsRequest with servername set to the host name and certificate checks on", async () => {
    let captured: http.RequestOptions & { servername?: string; rejectUnauthorized?: boolean } = {};
    const httpsRequest = ((options: typeof captured) => {
      captured = options;
      const fake = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; setTimeout: () => void };
      fake.end = () => {
        queueMicrotask(() => fake.emit("error", new Error("stop here")));
      };
      fake.destroy = () => {};
      fake.setTimeout = () => {};
      return fake;
    }) as unknown as typeof import("node:https").request;

    await expect(
      createNodeTransport({ httpsRequest })({
        url: new URL("https://example.com/page"),
        address: "93.184.215.14",
        family: 4,
        headers: { ...HEADERS },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined();

    expect(captured.hostname).toBe("example.com");
    expect(captured.servername).toBe("example.com");
    expect(captured.rejectUnauthorized).not.toBe(false);
    const agent = captured.agent as { options?: { keepAlive?: boolean } };
    expect(agent.options?.keepAlive).toBe(false);
  });

  it("does not use httpsRequest for an http URL", async () => {
    const httpsRequest = vi.fn() as unknown as typeof import("node:https").request;
    const port = await startServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("x"));
    const response = await createNodeTransport({ httpsRequest })(request(port));
    await collect(response.body);
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});

describe("createNodeTransport: remote address assertion", () => {
  it("rejects when the socket ends up connected to an address other than the pinned one", async () => {
    // The wrapper rewires the lookup so the real connection goes to 127.0.0.1 while
    // the request claims the pinned address 127.0.0.2: the post-connect check must abort.
    const httpRequest = ((options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) =>
      http.request(
        {
          ...options,
          lookup: ((_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) =>
            cb(null, "127.0.0.1", 4)) as unknown as http.RequestOptions["lookup"],
        },
        callback,
      )) as unknown as typeof http.request;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("secret");
    });

    // The transport itself must reject, before any response is handed to the caller.
    await expect(createNodeTransport({ httpRequest })(request(port, { address: "127.0.0.2" }))).rejects.toBeDefined();
  });
});
