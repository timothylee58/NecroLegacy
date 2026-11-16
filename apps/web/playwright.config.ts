import { defineConfig } from "@playwright/test";

// Dedicated port: 3000 is commonly occupied by unrelated dev servers, which reuseExistingServer would silently adopt.
const PORT = 3107;

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { NEXT_PUBLIC_USE_MOCK: "true" },
  },
  use: { baseURL: `http://localhost:${PORT}` },
});
