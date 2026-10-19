# 0008: Fetch user URLs through a pinned-address SSRF guard

- Status: accepted
- Date: 2026-10-19

## Context

C2 lets owners and editors add a web page as a source. The server fetches a URL the user chose, from Vercel, where the runtime API sits on loopback and AWS access comes through OIDC. A plain `fetch(url)` would reach private and metadata addresses, follow redirects into them, and resolve the name a second time at connect (DNS rebinding). The page text then goes through the C1 pipeline ([ADR 0007](0007-ingestion-pipeline.md)).

## Decision

- **URL rules** (`lib/server/fetch/url.ts`, for the input and every redirect target): WHATWG parsing only, http(s), at most 2,048 characters, no credentials, default port only, no single-label or `localhost` names. IP literals in any notation are canonicalized by the parser and checked directly.
- **Addresses** (`address.ts`): IPv4 special-purpose ranges are blocked (private, loopback, link-local incl. 169.254.169.254, CGNAT, documentation, multicast, reserved). IPv6 must lie in 2000::/3 and outside Teredo, 6to4, documentation and SRv6; everything else (loopback, IPv4-mapped, NAT64, unique local incl. fd00:ec2::254, link-local) is blocked as a whole range. If any resolved address is blocked, the fetch fails.
- **Pinned connect** (`node-transport.ts`): `node:http(s)` with a custom `lookup` that only returns the checked address and never calls DNS. The hostname stays the real name, so Host, SNI and the certificate check use it. A fresh agent per request (no keep-alive, no proxy from env), and the socket's remote address is compared with the pin.
- **Redirects**: at most 5, each parsed, resolved, checked and pinned again; https to http is refused.
- **Limits**: 20 s for DNS, connects, all hops and the body; 5 MB raw and decoded (gzip, deflate, br); HTML, XHTML or plain text only; at most 300,000 characters of text.
- **HTML to text**: our own linear single-pass scanner (`ingest/html.ts`). It drops script, style and similar elements, comments and all attributes, decodes numeric and a fixed set of named entities, and runs no code.
- **Storage**: the fetched text is stored once as a `text/plain` object at the source's path; a retry reuses it and does not fetch again. Errors become fixed `url_*` categories; logs carry neither the URL nor the page text.

## Consequences

- No new dependency. The guard is the whole control, so its tests pin each range and notation, the pinning and the redirect checks.
- The app makes outbound GETs to public hosts the user chooses, from Vercel's addresses. Bounded by 50 sources per notebook and the 20 s deadline; there is no per-user rate limit yet.
- Extraction quality is basic: no readability heuristics, navigation text ends up in chunks.
- PDF by URL is out of scope (`url_unsupported_type`).

## Alternatives considered

- **`undici` with a custom dispatcher**: a new dependency, and the global `fetch` dispatcher has version-mismatch pitfalls.
- **Resolve, check, then `fetch(url)`**: open to DNS rebinding between check and connect.
- **`htmlparser2`, `jsdom` + Readability**: new dependencies; jsdom also brings a script-engine surface.
