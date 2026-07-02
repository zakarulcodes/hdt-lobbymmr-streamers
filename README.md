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

Output is written to `dist/streamers.txt`, one entry per line (`\n<br />`-separated,
same convention as [hdt-lobbymmr-leaderboard](https://github.com/zakarulcodes/hdt-lobbymmr-leaderboard)'s
files, so the plugin's existing flat-file parser handles both with no JSON dependency):

```
playername https://twitch.tv/... https://youtube.com/...
otherplayer https://twitch.tv/... -
```

A `-` marks a missing Twitch or YouTube link.

## Updating the data

This is **run manually, not on a schedule** — wallii.gg's streamer list doesn't churn
fast enough to need frequent re-scraping, and there's no reason to hit their pages
often.

```
npm install
npx playwright install chromium
npm run scrape
```

Then publish `dist/streamers.txt` to the `gh-pages` branch (served via GitHub Pages,
`zakarulcodes.github.io/hdt-lobbymmr-streamers/streamers.txt`) for the plugin to fetch:

```
git checkout gh-pages
cp dist/streamers.txt streamers.txt
git add streamers.txt
git commit -m "Update streamer data"
git push
git checkout main
```

## Credit

Streamer linking data originates from [wallii.gg](https://www.wallii.gg/), which
streamers opt into via wallii's own Twitch bot.
