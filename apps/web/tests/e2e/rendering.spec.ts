import { expect, test } from "@playwright/test";

// Headless Chromium renders WebGL with SwiftShader on the CPU, so the frame-rate
// floor is a smoke check for runaway work, not the 30 fps target on real GPUs.
const HEADLESS_FPS_FLOOR = 10;
const SAMPLE_MS = 3_000;

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

test("X-Ray overlay with 10,000 boxes shows within 1 s of toggling on", async ({ page }) => {
  await page.goto("/perf-harness?mode=xray");
  const toggle = page.getByRole("button", { name: "Vision X-Ray" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const svg = page.locator('section[aria-label="Vision X-Ray"] svg[role="img"]');
  await expect(svg.locator("rect")).not.toHaveCount(0);
  // Measure the toggle, not dev-server compilation and hydration still running after load.
  await page.waitForLoadState("networkidle");

  const elapsedMs = await page.evaluate(async () => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Vision X-Ray");
    const layer = document.querySelector('section[aria-label="Vision X-Ray"] svg[role="img"]')?.parentElement;
    if (!button || !layer) throw new Error("harness not rendered");
    const start = performance.now();
    button.click();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const style = getComputedStyle(layer);
      if (style.visibility === "visible" && Number(style.opacity) >= 0.99) return performance.now() - start;
      if (performance.now() - start > 5_000) return Number.POSITIVE_INFINITY;
    }
  });

  console.log(`X-Ray overlay visible after ${elapsedMs.toFixed(0)} ms with 10,000 boxes`);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await svg.locator("rect").count()).toBeGreaterThanOrEqual(10_000);
  expect(elapsedMs).toBeLessThan(1_000);
});

test("scene with 50 nodes and 5,000 points keeps rendering frames", async ({ page }) => {
  await page.goto("/perf-harness?mode=scene");
  await expect(page.locator('canvas[role="img"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3D rendering is unavailable")).toHaveCount(0);

  const fps = await page.evaluate(async (sampleMs) => {
    await new Promise((r) => setTimeout(r, 500));
    let frames = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        frames += 1;
        if (performance.now() - start < sampleMs) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return (frames * 1000) / (performance.now() - start);
  }, SAMPLE_MS);

  console.log(`Scene frame rate with 50 nodes and 5,000 points: ${fps.toFixed(1)} fps (headless SwiftShader)`);
  test.info().annotations.push({ type: "fps", description: fps.toFixed(1) });
  expect(fps).toBeGreaterThanOrEqual(HEADLESS_FPS_FLOOR);
});
