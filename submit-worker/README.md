# Streamer submission Worker

A single [Cloudflare Worker](https://workers.cloudflare.com/) that lets streamers
link their own channel autonomously — no GitHub account, no manual review. It serves
a small form, verifies the submitter with **Sign in with Twitch**, and commits the
entry to [`submitted.txt`](../submitted.txt) in this repo, then fires a `republish`
so it goes live within seconds.

Twitch login is the trust anchor: you can only attach the Twitch channel you actually
signed in as, so nobody can point a marker at someone else's channel. The in-game name
is self-claimed (no API anywhere can verify Hearthstone name ownership) so names are
**first-come-wins**, and every entry records the submitting Twitch login for
attribution — if someone grabs a name that isn't theirs, edit or remove it in
`submitted.txt` (or override it in `manual.txt`, which wins over everything).

Everything runs on free tiers: Cloudflare Workers (100k requests/day) and a Twitch
developer app both cost nothing at this scale.

## One-time setup

### 1. Register a Twitch application
1. Go to <https://dev.twitch.tv/console/apps> → **Register Your Application**.
2. Name: anything (e.g. "HDT Lobby MMR link"). Category: Website Integration.
3. OAuth Redirect URL: `https://<your-worker-subdomain>.workers.dev/auth/callback`
   (you'll know the exact subdomain after the first `wrangler deploy` — you can add it
   then and save). Add a custom-domain callback too if you attach one later.
4. Copy the **Client ID** and generate a **Client Secret**.

### 2. Create a GitHub token
A fine-grained PAT at <https://github.com/settings/personal-access-tokens>, scoped to
**only** `hdt-lobbymmr-streamers`, with **Repository permissions → Contents: Read and
write** (this also authorizes the `republish` dispatch). Nothing else.

### 3. Deploy the Worker
```
cd submit-worker
npm install -g wrangler        # or: npx wrangler ...
wrangler login
wrangler deploy                # prints your https://<name>.workers.dev URL

wrangler secret put TWITCH_CLIENT_ID
wrangler secret put TWITCH_CLIENT_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put SESSION_SECRET     # paste any long random string
```
Then go back to the Twitch app (step 1) and make sure its redirect URL matches the
deployed Worker's `/auth/callback`. Redeploy after adding secrets if needed.

### 4. Link it from the plugin / repo
Point users at `https://<name>.workers.dev/`. You can attach a custom domain in the
Cloudflare dashboard (Workers → your worker → Triggers → Custom Domains) for a nicer
URL — remember to add that domain's `/auth/callback` to the Twitch app too.

## How a submission flows

```
form → Sign in with Twitch → Worker verifies login
     → POST /submit → Worker commits to submitted.txt (first-come-wins)
     → Worker fires repository_dispatch {event_type: "republish"}
     → republish.yml re-folds submitted + manual into the published list (no scrape)
     → live in seconds
```

## Local development
```
cd submit-worker
npm install
wrangler dev     # runs the Worker locally; set secrets via a .dev.vars file
```
`.dev.vars` (git-ignored) mirrors the secrets for local runs:
```
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
GITHUB_TOKEN=...
SESSION_SECRET=...
```
