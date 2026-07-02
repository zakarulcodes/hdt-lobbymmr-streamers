// Renders wallii.gg's public "all regions" leaderboard pages (solo + duo) in a
// real browser, clicks "Load all", and reads the player name + Twitch/YouTube
// links straight off the rendered page — the same data a visitor sees.
//
// robots.txt for wallii.gg allows /lb/ (disallows only /stats/, which this
// script never visits). Manual/occasional run only — no schedule, no polling.
//
// Usage: npm install && npm run scrape

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MODES = ["solo", "duo"];
const OUT_FILE = path.join(__dirname, "dist", "streamers.json");
const USER_AGENT = "hdt-lobbymmr-streamers (https://github.com/zakarulcodes/hdt-lobbymmr-streamers)";

// The table body is virtualized: only ~30 rows exist in the DOM at once,
// swapped out as you scroll. So "Load all" just removes pagination, not
// virtualization — we still have to scroll the whole way down ourselves,
// harvesting rows into a Map as they pass through the DOM.
async function readVisibleRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("a[href^='/stats/']"));
    return rows.map((nameLink) => {
      const name = nameLink.textContent.trim();
      const cell = nameLink.closest("td") || nameLink.parentElement;
      const twitch = cell?.querySelector("a[href*='twitch.tv/']")?.getAttribute("href") || null;
      const youtube = cell?.querySelector("a[href*='youtube.com/']")?.getAttribute("href") || null;
      return { name, twitch, youtube };
    });
  });
}

async function scrapeMode(page, mode) {
  await page.goto(`https://www.wallii.gg/lb/all/${mode}`, { waitUntil: "networkidle" });

  const loadAll = page.getByRole("button", { name: /load all/i }).first();
  if (await loadAll.count()) {
    await loadAll.click();
    await page.waitForTimeout(1000);
  }

  const byName = new Map();
  let stableRounds = 0;
  for (let i = 0; i < 500 && stableRounds < 3; i++) {
    const before = byName.size;
    for (const row of await readVisibleRows(page)) {
      if (row.name) byName.set(row.name, row);
    }
    stableRounds = byName.size > before ? 0 : stableRounds + 1;
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
  }

  return [...byName.values()].filter((r) => r.twitch || r.youtube);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: USER_AGENT });

  const byName = new Map();
  for (const mode of MODES) {
    console.log(`Scraping ${mode}...`);
    const entries = await scrapeMode(page, mode);
    console.log(`  found ${entries.length} streamers`);
    for (const entry of entries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }

  await browser.close();

  if (byName.size === 0) {
    throw new Error("No streamers found — page structure may have changed. Aborting without overwriting output.");
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const output = Object.fromEntries(
    [...byName.values()].map(({ name, twitch, youtube }) => [name, { twitch, youtube }])
  );
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${byName.size} entries to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
