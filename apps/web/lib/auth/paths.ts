// Routes that work without a session. Exact matches only: "/login/x" is protected.
// /api/canary has no session either: its secret header protects it (ADR 0014).
export const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/canary"] as const;

// Request header the proxy sets to the requested path (pathname + search), so server
// components can build /login?next=... Always overwritten by the proxy; sanitize on read.
export const REQUEST_PATH_HEADER = "x-request-path";

export function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(pathname);
}
