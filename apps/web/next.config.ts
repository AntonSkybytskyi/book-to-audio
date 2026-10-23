import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";
// The pnpm workspace: the standalone build traces files from here, and the contracts package lives here.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

// Next.js inlines small scripts and styles into every page, so those need
// 'unsafe-inline'. Everything else is limited to this origin. React's dev build
// needs eval and a websocket for hot reload.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, for the Docker image.
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  poweredByHeader: false,
  // Same values as API_SECURITY_HEADERS in apps/api/src/security.ts, with a CSP that fits pages.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
    ];
  },
};

export default nextConfig;
