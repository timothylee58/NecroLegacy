// Records the NecroLegacy demo against the deployed site: real runs (cache-missing copies of the presets),
// captions and title cards drawn into the page, scene start times written to build/timeline.json for compose.py.
// Run from the repo root after `say` narration exists in build/: node devpost/record-demo.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const SITE = process.env.SITE ?? "https://necrolegacy-web.onrender.com/";
const BUILD = new URL("./build/", import.meta.url).pathname;
const dur = JSON.parse(readFileSync(`${BUILD}durations.json`, "utf8"));
// Byte-different copies of the presets, so each take is a real run instead of a Redis replay. Use a new VARIANT
// directory (see README) for every take: a completed run is cached for 24 hours.
const VARIANT = process.env.VARIANT ?? "variant";
const FNB = `${BUILD}${VARIANT}/corrupted_fnb_warehouse_pos_batch.txt`;
const MANIFEST = `${BUILD}${VARIANT}/faded_dotmatrix_manifest.png`;
const W = 1920;
const H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = 0;
const marks = {};
const mark = (name) => (marks[name] = (Date.now() - t0) / 1000);

const CURSOR = () => {
  const dot = document.createElement("div");
  dot.id = "__cursor";
  Object.assign(dot.style, {
    position: "fixed", left: "0", top: "0", width: "26px", height: "26px", margin: "-13px 0 0 -13px",
    borderRadius: "50%", border: "2px solid #EFE4CC", background: "rgba(232,176,79,.30)",
    pointerEvents: "none", zIndex: "2147483647", transform: "translate(960px,540px)",
  });
  const add = () => document.documentElement.appendChild(dot);
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add);
  addEventListener("mousemove", (e) => (dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`), true);
  addEventListener("mousedown", () => (dot.style.background = "rgba(220,20,60,.65)"), true);
  addEventListener("mouseup", () => (dot.style.background = "rgba(232,176,79,.30)"), true);
};

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!t) return el?.remove();
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      Object.assign(el.style, {
        position: "fixed", left: "50%", bottom: "36px", transform: "translateX(-50%)", maxWidth: "1200px",
        padding: "14px 26px", background: "rgba(10,9,7,.9)", border: "1px solid #3A332A", borderRadius: "2px",
        color: "#EFE4CC", font: "600 24px/1.3 Archivo, system-ui, sans-serif", letterSpacing: ".01em",
        zIndex: "2147483646", textAlign: "center", pointerEvents: "none", whiteSpace: "nowrap",
      });
      document.documentElement.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function showCard(page, html) {
  await page.evaluate((markup) => {
    const cursor = document.getElementById("__cursor");
    if (cursor) cursor.style.display = "none";
    document.getElementById("__card")?.remove();
    const el = document.createElement("div");
    el.id = "__card";
    el.innerHTML = markup;
    Object.assign(el.style, {
      position: "fixed", inset: "0", background: "#0f0d0a", color: "#EFE4CC", zIndex: "2147483645",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center",
      opacity: "0", transition: "opacity .7s ease",
    });
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = "1")));
  }, html);
  await sleep(800);
}

async function hideCard(page) {
  await page.evaluate(() => {
    const el = document.getElementById("__card");
    if (el) el.style.opacity = "0";
  });
  await sleep(800);
  await page.evaluate(() => {
    document.getElementById("__card")?.remove();
    const cursor = document.getElementById("__cursor");
    if (cursor) cursor.style.display = "";
  });
}

const MONO = "font:500 22px/1.4 'JetBrains Mono', ui-monospace, monospace;letter-spacing:.14em;text-transform:uppercase;";
const TITLE_CARD = `
  <div style="${MONO}color:#E8B04F;margin-bottom:28px">Kiroween 2026 · Frankenstein</div>
  <div class="font-display" style="font-size:210px;line-height:.92;text-transform:uppercase;letter-spacing:.01em">NecroLegacy</div>
  <div style="font:400 38px/1.3 Archivo, system-ui, sans-serif;color:#B9AE98;margin-top:34px">A digital autopsy for legacy data</div>
  <div style="${MONO}color:#6f6657;margin-top:70px;font-size:20px">necrolegacy-web.onrender.com</div>`;
const END_CARD = `
  <div class="font-display" style="font-size:132px;line-height:.95;text-transform:uppercase">Autopsy the past.</div>
  <div class="font-display" style="font-size:132px;line-height:.95;text-transform:uppercase;color:#FF6B81">Ship the future.</div>
  <div style="display:grid;gap:14px;margin-top:64px;font:500 28px/1.35 Archivo, system-ui, sans-serif;color:#EFE4CC">
    <div>Built with Kiro: a 19-requirement spec, 28 tasks, 3 steering files</div>
    <div style="color:#B9AE98">MCP server · inspect_legacy_schema · query_rot_anomalies</div>
    <div style="color:#B9AE98">Cloud Run · Render · Neon · Upstash</div>
  </div>
  <div style="${MONO}color:#E8B04F;margin-top:56px;font-size:21px">necrolegacy-web.onrender.com &nbsp;·&nbsp; github.com/timothylee58/NecroLegacy</div>`;

let cur = { x: 960, y: 540 };
async function moveTo(page, x, y, ms = 800) {
  const n = Math.max(10, Math.round(ms / 16));
  const from = { ...cur };
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(ms / n);
  }
  cur = { x, y };
}
async function glide(page, locator, ms = 800, dx = 0, dy = 0) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await moveTo(page, b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, ms);
}

async function scene(name, narration, fn) {
  mark(name);
  const start = Date.now();
  await fn();
  const rest = narration * 1000 + 900 - (Date.now() - start);
  if (rest > 0) await sleep(rest);
}

async function uploadViaDropzone(page, file) {
  const zone = page.getByRole("button", { name: /drop files here/i });
  await glide(page, zone, 900);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), zone.click()]);
  await chooser.setFiles(file);
}

const done = (page) => page.getByText("api_resurrector: completed").waitFor({ timeout: 150_000 });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: `${BUILD}rec/`, size: { width: W, height: H } },
});
await ctx.addInitScript(CURSOR);
t0 = Date.now();
const page = await ctx.newPage();

try {
  await page.goto(SITE, { waitUntil: "load" });
  await page.getByRole("dialog").waitFor();
  await page.waitForResponse((r) => r.url().endsWith("/api/health"), { timeout: 60_000 }).catch(() => {});

  // 0. Title card over the loaded app
  await scene("s0", dur.s0, async () => {
    await showCard(page, TITLE_CARD);
  });
  await hideCard(page);

  // 1. Intake
  await scene("s1", dur.s1, async () => {
    await caption(page, "Drop a dump, a copybook or a scan");
    await moveTo(page, 960, 520, 700);
    await sleep(900);
    for (const radio of await page.getByRole("radio").all()) {
      await glide(page, radio, 650);
      await sleep(700);
    }
  });

  // 2. A real run on a cache-missing copy of the POS batch
  await scene("s2", dur.s2, async () => {
    await caption(page, "Five agents, fixed order. Numbers before language models");
    await uploadViaDropzone(page, FNB);
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60_000 });
    await moveTo(page, 1150, 560, 900);
    await done(page);
  });

  // 3. Verdict, orbit, inspector
  await scene("s3", dur.s3, async () => {
    await caption(page, "Critical rot glows crimson");
    const canvas = page.locator("canvas[role=img]").first();
    const b = await canvas.boundingBox();
    await moveTo(page, b.x + b.width * 0.45, b.y + b.height * 0.55, 900);
    await page.mouse.down();
    await moveTo(page, b.x + b.width * 0.62, b.y + b.height * 0.42, 1800);
    await moveTo(page, b.x + b.width * 0.5, b.y + b.height * 0.6, 1200);
    await page.mouse.up();
    await sleep(500);
    // Open a specimen that has something to show, not a healthy one.
    const list = page.getByRole("list", { name: "Entities" }).getByRole("button");
    const first = (await list.filter({ hasText: /critical/i }).count()) ? list.filter({ hasText: /critical/i }).first() : list.first();
    await glide(page, first, 900);
    await page.mouse.click(cur.x, cur.y);
    await page.getByRole("dialog").waitFor();
    await sleep(2200);
    await page.mouse.wheel(0, 380);
    await sleep(1800);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  });

  // 4. Search, then the generated wrapper
  await scene("s4", dur.s4, async () => {
    await caption(page, "Plain-word search, then a generated FastAPI wrapper");
    const box = page.getByRole("searchbox");
    await glide(page, box, 900);
    await box.click();
    await box.pressSequentially("Show all warehouse transfers with missing branch codes", { delay: 38 });
    const button = page.getByRole("button", { name: /^search$/i });
    await glide(page, button, 500);
    await button.click();
    await page.getByRole("list", { name: /search results/ }).waitFor({ timeout: 25_000 }).catch(() => {});
    await sleep(1400);
    const download = page.getByRole("button", { name: /download generated code/i });
    await glide(page, download, 900);
  });

  // 5. A scanned manifest and the Vision X-Ray
  await scene("s5a", dur.s5a, async () => {
    await caption(page, "It reads paper too");
    await page.evaluate(() => scrollTo({ top: 0, behavior: "smooth" }));
    await sleep(900);
    const newAutopsy = page.getByRole("button", { name: "New autopsy" });
    await glide(page, newAutopsy, 800);
    await newAutopsy.click();
    await page.getByRole("dialog").waitFor();
    await uploadViaDropzone(page, MANIFEST);
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60_000 });
    await done(page);
  });
  await scene("s5b", dur.s5b, async () => {
    await caption(page, "Vision X-Ray: green is confident, crimson is doubtful");
    const xray = page.getByRole("button", { name: "Vision X-Ray" });
    await glide(page, xray, 900);
    await xray.click();
    await sleep(1200);
    const svg = page.locator('section[aria-label="Vision X-Ray"] svg[role=img]').first();
    await svg.scrollIntoViewIfNeeded();
    const b = await svg.boundingBox();
    await moveTo(page, b.x + b.width * 0.7, b.y + b.height * 0.72, 1200);
    await sleep(900);
    await moveTo(page, b.x + b.width * 0.5, b.y + b.height * 0.9, 1200);
  });

  // 6. End card
  await scene("s6", dur.s6, async () => {
    await caption(page, "");
    await showCard(page, END_CARD);
    await sleep(2500);
  });
  mark("end");
} finally {
  const video = page.video();
  await ctx.close();
  await browser.close();
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(`${BUILD}timeline.json`, JSON.stringify(marks, null, 1));
  const file = readdirSync(`${BUILD}rec/`).filter((f) => f.endsWith(".webm")).sort().at(-1);
  if (file) renameSync(`${BUILD}rec/${file}`, `${BUILD}demo.webm`);
  console.log("timeline", marks);
}
