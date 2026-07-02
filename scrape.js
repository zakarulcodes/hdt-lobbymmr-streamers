// Renders wallii.gg's public per-region leaderboard pages (solo + duo) in a
// real browser, clicks "Load all", and reads the player name + Twitch/YouTube
// links straight off the rendered page — the same data a visitor sees.
//
// robots.txt for wallii.gg allows /lb/ (disallows only /stats/, which this
// script never visits). Manual/occasional run only — no schedule, no polling.
//
// Coverage note: this only finds streamers who currently rank on one of
// these leaderboards. Someone linked with wallii's bot but not ranked highly
// enough (or not ranked at all) won't show up here even though wallii's own
// site can find them via a direct name search (a page we deliberately don't
// scrape). manual.txt exists to cover exactly that gap — see below.
//
// Usage: npm install && npm run scrape

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REGIONS = ["all", "na", "eu", "ap", "cn"];
const MODES = ["solo", "duo"];
const MANUAL_FILE = path.join(__dirname, "manual.txt");
const OUT_FILE = path.join(__dirname, "dist", "streamers.txt");
const USER_AGENT = "hdt-lobbymmr-streamers (https://github.com/zakarulcodes/hdt-lobbymmr-streamers)";
const ENTRY_SEPARATOR = "\n<br />"; // matches the plugin's leaderboard file format

// The table body is virtualized: only ~30 rows exist in the DOM at once,
// swapped out as you scroll. So "Load all" just removes pagination, not
// virtualization — we still have to scroll the whole way down ourselves,
// harvesting rows into a Map as they pass through the DOM. Mid-scroll, a row
// can transiently render as a loading placeholder (name text literally
// "null") before its real data streams in — reject those.
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

function isValidName(name) {
  return !!name && name.toLowerCase() !== "null";
}

async function scrapeBoard(page, region, mode) {
  await page.goto(`https://www.wallii.gg/lb/${region}/${mode}`, { waitUntil: "networkidle" });

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
      if (isValidName(row.name)) byName.set(row.name, row);
    }
    stableRounds = byName.size > before ? 0 : stableRounds + 1;
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
  }

  return [...byName.values()].filter((r) => r.twitch || r.youtube);
}

// manual.txt: same "name twitch|- youtube|-" format as the output, one entry
// per line (plain newlines, no <br /> separator needed here). Lets anyone
// who isn't leaderboard-ranked get added regardless of scrape coverage.
// Manual entries always win over scraped ones for the same name.
function loadManualEntries() {
  if (!fs.existsSync(MANUAL_FILE)) return [];
  return fs
    .readFileSync(MANUAL_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, twitch, youtube] = line.split(" ");
      return { name, twitch: twitch !== "-" ? twitch : null, youtube: youtube !== "-" ? youtube : null };
    });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: USER_AGENT });

  const byName = new Map();
  for (const region of REGIONS) {
    for (const mode of MODES) {
      console.log(`Scraping ${region}/${mode}...`);
      const entries = await scrapeBoard(page, region, mode);
      console.log(`  found ${entries.length} streamers`);
      for (const entry of entries) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      }
    }
  }

  await browser.close();

  for (const entry of loadManualEntries()) byName.set(entry.name, entry);

  if (byName.size === 0) {
    throw new Error("No streamers found — page structure may have changed. Aborting without overwriting output.");
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  // "name twitchUrlOrDash youtubeUrlOrDash" per entry, same style as the
  // leaderboard repo's flat files — keeps the plugin's parser dependency-free
  // (no JSON library needed for a net472 WPF plugin).
  const lines = [...byName.values()].map(
    ({ name, twitch, youtube }) => `${name} ${twitch || "-"} ${youtube || "-"}`
  );
  fs.writeFileSync(OUT_FILE, lines.join(ENTRY_SEPARATOR));
  console.log(`Wrote ${byName.size} entries to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
