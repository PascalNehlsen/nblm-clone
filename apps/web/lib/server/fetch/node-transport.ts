import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import type { TransportRequest, TransportResponse } from "./guarded-fetch";
import { bareHostname } from "./url";

// The real transport behind the SSRF guard (ADR 0008). It connects to the address the
// guard checked: the custom lookup only ever yields that address and never calls DNS,
// while hostname stays the real name, so Node sets Host, SNI and the certificate check
// from it. A fresh agent per request: no socket reuse across pins and no proxy from env.

export interface NodeTransportOptions {
  httpRequest?: typeof http.request;
  httpsRequest?: typeof https.request;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

function sameAddress(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const strip = (s: string) => (s.toLowerCase().startsWith("::ffff:") && isIP(s.slice(7)) === 4 ? s.slice(7) : s.toLowerCase());
  return strip(a) === strip(b);
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function createNodeTransport(opts: NodeTransportOptions = {}): (req: TransportRequest) => Promise<TransportResponse> {
  const httpRequest = opts.httpRequest ?? http.request;
  const httpsRequest = opts.httpsRequest ?? https.request;

  return (req) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const secure = req.url.protocol === "https:";
      const hostname = bareHostname(req.url);
      const literal = isIP(hostname) !== 0;

      const lookup = (host: string, options: unknown, callback?: LookupCallback) => {
        const cb = (typeof options === "function" ? options : callback) as LookupCallback;
        const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
        if (host !== hostname) {
          cb(Object.assign(new Error("lookup refused"), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (all) cb(null, [{ address: req.address, family: req.family }]);
        else cb(null, req.address, req.family);
      };

      const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
      const options: https.RequestOptions = {
        protocol: req.url.protocol,
        hostname,
        port: req.url.port === "" ? (secure ? 443 : 80) : Number(req.url.port),
        path: `${req.url.pathname}${req.url.search}`,
        method: "GET",
        headers: req.headers,
        agent,
        signal: req.signal,
        lookup: lookup as unknown as http.RequestOptions["lookup"],
        ...(secure && !literal ? { servername: hostname } : {}),
      };

      const onResponse = (res: http.IncomingMessage) => {
        if (!sameAddress(res.socket?.remoteAddress, req.address)) {
          res.destroy();
          reject(new Error("connected to an unexpected address"));
          return;
        }
        resolve({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body: res });
      };

      const request = secure ? httpsRequest(options, onResponse) : httpRequest(options, onResponse);
      request.on("error", reject);
      request.end();
    });
}

export async function resolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, order: "verbatim" });
  return records.map((r) => r.address);
}
