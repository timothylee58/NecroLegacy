import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("../next.config");
}

describe("next.config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws naming NEXT_PUBLIC_API_URL when missing and mock is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "");
    await expect(load()).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it("loads when NEXT_PUBLIC_USE_MOCK is true", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "true");
    await expect(load()).resolves.toBeDefined();
  });

  it("loads when NEXT_PUBLIC_API_URL is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000");
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "");
    await expect(load()).resolves.toBeDefined();
  });
});
