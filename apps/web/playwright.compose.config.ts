import { defineConfig } from "@playwright/test";

// Runs against `docker compose up` (API on :8000, WEB_ORIGIN=http://localhost:3108) with a real-service-free API configuration.
const PORT = 3108;

export default defineConfig({
  testDir: "./tests/compose",
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { NEXT_PUBLIC_USE_MOCK: "false", NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000" },
  },
  use: { baseURL: `http://localhost:${PORT}` },
});
