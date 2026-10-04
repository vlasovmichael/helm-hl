/* global document, window */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = "src/modules/dashboard/web";
const out = process.argv[2];
const baseUrl = process.env.DASHBOARD_URL ?? "http://127.0.0.1:5173";

if (!out) throw new Error("Укажите каталог снимков: node scripts/snapshotDash.mjs docs/kit-colors/before");
mkdirSync(out, { recursive: true });

const pages = readdirSync(root).filter((name) => name.endsWith(".html")).sort();
const browser = await chromium.launch({ headless: true });
for (const theme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    for (const name of pages) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light" });
      await page.clock.install({ time: new Date("2026-10-04T10:00:00.000Z") });
      await page.addInitScript(({ selectedTheme }) => {
        localStorage.setItem("hl-scanner-theme", selectedTheme);
        document.documentElement.dataset.theme = selectedTheme;
        window.WebSocket = class { addEventListener() {} close() {} send() {} };
      }, { selectedTheme: theme });
      await page.route("**/*", async (route) => {
        const type = route.request().resourceType();
        if (["document", "stylesheet", "script", "font", "image"].includes(type)) return route.continue();
        return route.fulfill({ contentType: "application/json", body: "{}" });
      });
      await page.goto(`${baseUrl}/${name}`, { waitUntil: "commit", timeout: 10_000 });
      await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
      await page.waitForTimeout(100);
      await page.evaluate((selectedTheme) => {
        localStorage.setItem("hl-scanner-theme", selectedTheme);
        document.documentElement.dataset.theme = selectedTheme;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, `${name.replace(/\.html$/, "")}-${theme}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
}
await browser.close();
