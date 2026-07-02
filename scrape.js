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
// Merge behaviour: each run starts from the currently-published streamers.txt
// (not a fresh slate), so a name that drops off a leaderboard between runs is
// never removed — only added (new names) or updated (URL changed for a name
// still found). GitHub Pages is Actions-deployed with no branch history to
// read back, so the live hosted file is the baseline, fetched over HTTP.
//
// Usage: npm install && npm run scrape

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REGIONS = ["all", "na", "eu", "ap", "cn"];
const MODES = ["solo", "duo"];
const MANUAL_FILE = path.join(__dirname, "manual.txt");
const OUT_FILE = path.join(__dirname, "dist", "streamers.txt");
const LIVE_URL = "https://zakarulcodes.github.io/hdt-lobbymmr-streamers/streamers.txt";
const USER_AGENT = "hdt-lobbymmr-streamers (https://github.com/zakarulcodes/hdt-lobbymmr-streamers)";
const ENTRY_SEPARATOR = "\n<br />"; // matches the plugin's leaderboard file format

function parseEntries(text) {
  const map = new Map();
  for (const rawLine of text.split(ENTRY_SEPARATOR)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [name, twitch, youtube] = line.split(" ");
    if (!name) continue;
    map.set(name, { name, twitch: twitch !== "-" ? twitch : null, youtube: youtube !== "-" ? youtube : null });
  }
  return map;
}

async function loadPublishedEntries() {
  try {
    const res = await fetch(LIVE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseEntries(await res.text());
  } catch (err) {
    console.warn(`Could not load published streamer data (${err.message}); starting from an empty baseline.`);
    return new Map();
  }
}

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

function sameUrls(a, b) {
  return a.twitch === b.twitch && a.youtube === b.youtube;
}

async function main() {
  const merged = await loadPublishedEntries();
  console.log(`Loaded ${merged.size} previously-published entries as baseline`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: USER_AGENT });

  const freshByName = new Map();
  for (const region of REGIONS) {
    for (const mode of MODES) {
      console.log(`Scraping ${region}/${mode}...`);
      const entries = await scrapeBoard(page, region, mode);
      console.log(`  found ${entries.length} streamers`);
      for (const entry of entries) {
        if (!freshByName.has(entry.name)) freshByName.set(entry.name, entry);
      }
    }
  }

  await browser.close();

  // Additive merge: never drop a name missing from this run, only add new
  // names or update the URL for a name that's still found.
  let added = 0;
  let updated = 0;
  for (const entry of freshByName.values()) {
    const existing = merged.get(entry.name);
    if (!existing) added++;
    else if (!sameUrls(existing, entry)) updated++;
    merged.set(entry.name, entry);
  }
  console.log(`${added} new, ${updated} updated, ${merged.size} total before manual overrides`);

  for (const entry of loadManualEntries()) merged.set(entry.name, entry);

  if (merged.size === 0) {
    throw new Error("No streamers found — page structure may have changed. Aborting without overwriting output.");
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  // "name twitchUrlOrDash youtubeUrlOrDash" per entry, same style as the
  // leaderboard repo's flat files — keeps the plugin's parser dependency-free
  // (no JSON library needed for a net472 WPF plugin).
  const lines = [...merged.values()].map(
    ({ name, twitch, youtube }) => `${name} ${twitch || "-"} ${youtube || "-"}`
  );
  fs.writeFileSync(OUT_FILE, lines.join(ENTRY_SEPARATOR));
  console.log(`Wrote ${merged.size} entries to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
