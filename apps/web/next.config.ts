import type { NextConfig } from "next";

if (!process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_USE_MOCK !== "true") {
  throw new Error(
    "NEXT_PUBLIC_API_URL is required unless NEXT_PUBLIC_USE_MOCK is set to \"true\".",
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The browser talks to the API directly, so the site ships as static files (Render static site).
  output: "export",
  // Directory-style output (perf-harness/index.html) is served by any static host without rewrites.
  trailingSlash: true,
};

export default nextConfig;
