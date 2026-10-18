// Routes that work without a session. Exact matches only: "/login/x" is protected.
export const PUBLIC_PATHS = ["/login", "/auth/callback"] as const;

export function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(pathname);
}
