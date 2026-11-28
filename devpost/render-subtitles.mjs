// Renders each subtitle cue in build/cues.json to a transparent PNG (build/subs/NNN.png) with the site's Archivo font.
// This ffmpeg has no libass or drawtext, so compose.py overlays these images instead. Called by compose.py.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, rmSync } from "node:fs";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const SITE = process.env.SITE ?? "https://necrolegacy-web.onrender.com/";
const BUILD = new URL("./build/", import.meta.url).pathname;
const OUT = `${BUILD}subs/`;
const W = 1920;
const BAND = 220; // image height; the text sits on its bottom edge

const cues = JSON.parse(readFileSync(`${BUILD}cues.json`, "utf8"));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: 1080 } });
await page.goto(SITE, { waitUntil: "load" });
await page.evaluate(
  ({ band }) => {
    document.documentElement.style.cssText = "background:transparent";
    document.body.style.cssText = "background:transparent;margin:0;overflow:hidden";
    document.body.innerHTML = `<div id="band" style="position:fixed;left:0;top:0;width:${1920}px;height:${band}px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px"><div style="max-width:1320px;text-align:center;text-wrap:balance;font:600 36px/1.62 Archivo, system-ui, sans-serif;letter-spacing:.005em;color:#F4EBD6"><span id="cue" style="padding:5px 20px;background:rgba(10,9,7,.84);border-radius:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone;text-shadow:0 1px 2px rgba(0,0,0,.6)"></span></div></div>`;
  },
  { band: BAND },
);
await page.evaluate(() => document.fonts.load("600 36px Archivo"));
await page.waitForTimeout(300);

for (const [i, cue] of cues.entries()) {
  await page.evaluate((t) => (document.getElementById("cue").textContent = t), cue.text);
  const file = `${OUT}${String(i + 1).padStart(3, "0")}.png`;
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: W, height: BAND } });
}

// The licence credit shown over the end card (CC BY 4.0 asks for the title, performer, licence and any changes).
const CREDIT_BAND = 120;
await page.evaluate(
  ({ band }) => {
    document.getElementById("band").style.height = `${band}px`;
    const cue = document.getElementById("cue");
    cue.parentElement.style.font = "500 23px/1.6 Archivo, system-ui, sans-serif";
    cue.parentElement.style.color = "#D8CFB8";
    cue.parentElement.style.maxWidth = "1500px";
    cue.innerHTML =
      "Music: Toccata and Fugue in D minor, BWV 565 (J. S. Bach), performed by Norbert Schenk, " +
      "CC BY 4.0, via Wikimedia Commons<br>Trimmed, faded and lowered under the narration.";
  },
  { band: CREDIT_BAND },
);
await page.screenshot({ path: `${BUILD}credit.png`, omitBackground: true, clip: { x: 0, y: 0, width: W, height: CREDIT_BAND } });
await browser.close();
console.log(`rendered ${cues.length} subtitle images and the credit`);
