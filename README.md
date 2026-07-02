# hdt-lobbymmr-streamers

Scrapes [wallii.gg](https://www.wallii.gg/)'s public Battlegrounds leaderboard pages
for player → Twitch/YouTube links, and hosts the result as a flat JSON file for the
[HDT_LobbyMMR](https://github.com/zakarulcodes/HDT_LobbyMMR) plugin to show a streamer
icon next to lobby players who are known streamers.

## How it works

`scrape.js` uses Playwright to load `wallii.gg/lb/all/solo` and `wallii.gg/lb/all/duo`
in a real (headless) browser — the same pages a visitor sees — clicks "Load all", then
scrolls through the virtualized table collecting each row's player name and any
Twitch/YouTube link shown next to it. wallii.gg's `robots.txt` disallows `/stats/`
(individual profile pages) but allows `/lb/` (the leaderboard pages), which is all this
script touches.

Output is written to `dist/streamers.json`:

```json
{
  "playername": { "twitch": "https://twitch.tv/...", "youtube": "https://youtube.com/@..." }
}
```

## Updating the data

This is **run manually, not on a schedule** — wallii.gg's streamer list doesn't churn
fast enough to need frequent re-scraping, and there's no reason to hit their pages
often.

```
npm install
npx playwright install chromium
npm run scrape
git add dist/streamers.json
git commit -m "Update streamer data"
git push
```

`dist/streamers.json` is served via GitHub Pages for the plugin to fetch.

## Credit

Streamer linking data originates from [wallii.gg](https://www.wallii.gg/), which
streamers opt into via wallii's own Twitch bot.
