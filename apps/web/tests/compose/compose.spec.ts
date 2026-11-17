import { expect, test } from "@playwright/test";

const LEDGER = "1994 Mainframe Ledger Dump";
const MANIFEST = "Faded Dot-Matrix Manifest";
const DONE = "api_resurrector: completed";

test.describe("web against docker-compose API", () => {
  test("keyboard-only preset flow reaches results", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Drop files here/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: LEDGER })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });
  });

  test("file upload reaches results", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({
      name: "ledger.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("id,qty\n1,5\n2,-3\n"),
    });
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });
  });

  test("Vision X-Ray toggles over the real image preset", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("radio", { name: MANIFEST }).click();
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });
    const image = page.getByRole("img", { name: "Uploaded legacy document" });
    await expect(image).toBeVisible();
    expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThanOrEqual(1000);
    const toggle = page.getByRole("button", { name: "Vision X-Ray" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("stream reconnects after the SSE connection is killed", async ({ page }) => {
    let aborted = false;
    await page.route("**/api/sessions/*/events*", async (route) => {
      if (!aborted) {
        aborted = true;
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await page.goto("/");
    await page.getByRole("radio", { name: LEDGER }).click();
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });
    expect(aborted).toBe(true);
  });
});
