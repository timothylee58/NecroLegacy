import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const LEDGER = "1994 Mainframe Ledger Dump";
const MANIFEST = "Faded Dot-Matrix Manifest";

async function disableWebGL(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
}

async function choosePreset(page: Page, label: string) {
  await page.getByRole("radio", { name: label }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("api_resurrector: completed")).toBeVisible({ timeout: 15_000 });
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("keyboard and preset flow", () => {
  test("keyboard-only: dialog traps focus, preset via keyboard reaches results, drawer opens and returns focus", async ({
    page,
  }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Upload files/ })).toBeFocused();
    await page.keyboard.press("Tab");
    const first = page.getByRole("radio", { name: LEDGER });
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Corrupted F&B Warehouse POS Batch" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(dialog).toBeHidden();
    await expect(page.getByText("api_resurrector: completed")).toBeVisible({ timeout: 15_000 });

    const entity = page.getByRole("list", { name: "Entities" }).getByRole("button").first();
    await entity.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.locator(":focus")).toBeVisible();
  });

  test("preset to results shows entities, summary and generated code", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await expect(page.getByRole("list", { name: "Entities" }).getByRole("button")).not.toHaveCount(0);
    await expect(page.locator("#autopsy-summary")).toBeAttached();
    await expect(page.getByRole("heading", { name: /generated/i })).toBeVisible();
  });
});

test.describe("Vision X-Ray", () => {
  test("toggle shows dashed flagged rectangles and responds to keyboard", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, MANIFEST);
    const toggle = page.getByRole("button", { name: "Vision X-Ray" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const svg = page.locator('svg[role="img"]');
    await expect(svg).toBeVisible();
    const strokeWidths = await svg.locator("rect[stroke-dasharray]").evaluateAll((els) =>
      els.map((e) => Number(e.getAttribute("stroke-width"))),
    );
    expect(strokeWidths.length).toBeGreaterThan(0);
    expect(Math.min(...strokeWidths)).toBeGreaterThanOrEqual(2);
    await expect(svg.locator('rect[stroke="#FFFFFF"]').first()).toBeAttached();

    await expect(page.getByText(/Vision X-Ray on\. \d+ flagged/)).toBeAttached();

    const item = page.locator("section[aria-label='Vision X-Ray'] ul li").first();
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("tooltip")).toBeVisible();

    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("drawer", () => {
  test("opens from entity list with fields and closes with Escape", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await page.getByRole("list", { name: "Entities" }).getByRole("button").first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "Fields" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});

test.describe("WebGL unavailable", () => {
  test("falls back to the entity list and a status message", async ({ page }) => {
    await disableWebGL(page);
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await expect(page.getByText("3D rendering is unavailable")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Entities" }).getByRole("button")).not.toHaveCount(0);
  });
});

test.describe("zoom 100/150/200%", () => {
  // Browser zoom Z on a 1280px viewport yields a layout viewport of 1280/Z CSS px.
  for (const zoom of [1, 1.5, 2]) {
    test(`no horizontal scroll at ${zoom * 100}% (text and image)`, async ({ page }) => {
      await page.setViewportSize({ width: Math.round(1280 / zoom), height: 800 });
      await page.goto("/");
      const fits = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      await choosePreset(page, LEDGER);
      expect(await fits()).toBe(true);
      await page.getByRole("button", { name: "New autopsy" }).click();
      await choosePreset(page, MANIFEST);
      await page.getByRole("button", { name: "Vision X-Ray" }).click();
      expect(await fits()).toBe(true);
      await page.getByRole("list", { name: "Entities" }).getByRole("button").first().click();
      expect(await fits()).toBe(true);
    });
  }
});

test.describe("axe-core", () => {
  test("empty state (dialog dismissed)", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expectNoViolations(page);
  });

  test("empty state with dropzone open", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoViolations(page);
  });

  test("loaded text session", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await expectNoViolations(page);
  });

  test("loaded image session with X-Ray on", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, MANIFEST);
    await page.getByRole("button", { name: "Vision X-Ray" }).click();
    await expect(page.locator('svg[role="img"]')).toBeVisible();
    await expectNoViolations(page);
  });

  test("open drawer", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await page.getByRole("list", { name: "Entities" }).getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoViolations(page);
  });

  test("WebGL unavailable", async ({ page }) => {
    await disableWebGL(page);
    await page.goto("/");
    await choosePreset(page, LEDGER);
    await expect(page.getByText("3D rendering is unavailable")).toBeVisible();
    await expectNoViolations(page);
  });
});
