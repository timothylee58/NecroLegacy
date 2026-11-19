import { defineConfig } from "@playwright/test";

// Dedicated port: 3000 is commonly occupied by unrelated dev servers, which reuseExistingServer would silently adopt.
const PORT = 3107;
// CI tests the static export the job just built (what Render serves); dev-mode compilation also skews timings.
const HOST = process.env.CI ? "127.0.0.1" : "localhost";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: process.env.CI
      ? `python3 -m http.server ${PORT} --bind ${HOST} --directory out`
      : `pnpm exec next dev -p ${PORT}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { NEXT_PUBLIC_USE_MOCK: "true" },
  },
  use: { baseURL: `http://${HOST}:${PORT}` },
});
