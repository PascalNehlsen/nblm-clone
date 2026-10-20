import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Built at build time from the public env (Vercel sets it per project). A build without
  // env (the CI build job) gets the policy without a Supabase origin, never a looser one.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
          siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "",
          isDev: process.env.NODE_ENV === "development",
        }),
      },
    ];
  },
};

export default nextConfig;
