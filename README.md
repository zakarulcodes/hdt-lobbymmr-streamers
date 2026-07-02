# hdt-lobbymmr-streamers

Scrapes [wallii.gg](https://www.wallii.gg/)'s public Battlegrounds leaderboard pages
for player → Twitch/YouTube links, and hosts the result as a flat JSON file for the
[HDT_LobbyMMR](https://github.com/zakarulcodes/HDT_LobbyMMR) plugin to show a streamer
icon next to lobby players who are known streamers.

## How it works

`scrape.js` uses Playwright to load every `wallii.gg/lb/{region}/{mode}` leaderboard
(all/na/eu/ap/cn × solo/duo) in a real (headless) browser — the same pages a visitor
sees — clicks "Load all", then scrolls through the virtualized table collecting each
row's player name and any Twitch/YouTube link shown next to it. wallii.gg's
`robots.txt` disallows `/stats/` (individual profile pages) but allows `/lb/` (the
leaderboard pages), which is all this script touches.

Coverage note: this only finds streamers who currently rank on one of those
leaderboards. Someone linked with wallii's bot but not ranked highly enough won't show
up here even though wallii's own site can find them via direct name search (a page we
deliberately don't scrape). `manual.txt` covers exactly that gap — add
`name twitchUrlOrDash youtubeUrlOrDash` there and it always overrides scraped data for
that name.

Output is written to `dist/streamers.txt`, one entry per line (`\n<br />`-separated,
same convention as [hdt-lobbymmr-leaderboard](https://github.com/zakarulcodes/hdt-lobbymmr-leaderboard)'s
files, so the plugin's existing flat-file parser handles both with no JSON dependency):

```
playername https://twitch.tv/... https://youtube.com/...
otherplayer https://twitch.tv/... -
```

A `-` marks a missing Twitch or YouTube link.

**Merge behaviour**: each run starts from the currently-published `streamers.txt`
(fetched over HTTP, since GitHub Pages is Actions-deployed with no branch history to
read back) rather than a fresh slate. A name is only ever added (new) or updated (URL
changed), never removed just because it wasn't found in a given run — so a transient
scrape miss on one board, or a streamer temporarily dropping off a leaderboard, doesn't
lose previously-found data.

## Updating the data

**Not on a fixed GitHub-native schedule** — wallii.gg's streamer list doesn't churn
fast enough to justify frequent re-scraping, and there's no reason to hit their pages
often. Instead this repo has a `repository_dispatch`-triggered workflow
(`.github/workflows/scrape.yml`) that runs the scraper in CI and publishes via GitHub
Pages' Actions-based deployment (`actions/upload-pages-artifact` +
`actions/deploy-pages`, no `gh-pages` branch involved) — fired externally (e.g. a
weekly [cron-job.org](https://cron-job.org) job) rather than GitHub's own `schedule:`
trigger, because GitHub auto-disables `schedule:` workflows after 60 days of repo
inactivity; `repository_dispatch` has no such timeout.

To wire up an external trigger, create a cron-job.org job (or any scheduler that can
send an HTTP request) that does:

```
POST https://api.github.com/repos/zakarulcodes/hdt-lobbymmr-streamers/dispatches
Headers:
  Authorization: token <a fine-grained PAT scoped to just this repo, Contents: write>
  Accept: application/vnd.github+json
  Content-Type: application/json
Body:
  {"event_type": "scrape"}
```

Fine-grained PATs expire after at most a year, so the token (not the schedule) is what
needs periodic renewal regardless of how often the job runs.

You can also trigger a run manually any time from the repo's Actions tab
(`workflow_dispatch`), or run it locally:

```
npm install
npx playwright install chromium
npm run scrape
```

## Credit

Streamer linking data originates from [wallii.gg](https://www.wallii.gg/), which
streamers opt into via wallii's own Twitch bot.
