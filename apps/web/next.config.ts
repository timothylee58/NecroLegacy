import type { NextConfig } from "next";

if (!process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_USE_MOCK !== "true") {
  throw new Error(
    "NEXT_PUBLIC_API_URL is required unless NEXT_PUBLIC_USE_MOCK is set to \"true\".",
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
