// Cloudflare Worker: autonomous streamer-link submission for HDT_LobbyMMR.
//
// One Worker does everything, same-origin (no CORS):
//   GET  /                serves the submission form
//   GET  /auth/login      redirects to Twitch OAuth
//   GET  /auth/callback   exchanges the code, verifies the Twitch login,
//                         sets a signed session cookie, returns to the form
//   POST /submit          validates the session + input, commits to
//                         submitted.txt in the repo, and fires a "republish"
//                         so the change goes live within seconds
//
// Twitch login is the trust anchor: a submitter can only attach the Twitch
// channel they actually signed in as, so channel-impersonation is impossible.
// The BG player name is self-claimed (no API anywhere can verify Hearthstone
// name ownership), so names are first-come-wins and every entry records the
// submitting Twitch login for attribution/revocation.
//
// Secrets (wrangler secret put): TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
// GITHUB_TOKEN (fine-grained, Contents:write on the streamers repo),
// SESSION_SECRET (random string). Vars (wrangler.toml): GH_OWNER, GH_REPO.

const SUBMITTED_PATH = "submitted.txt";
const ENTRY_SEPARATOR = "\n<br />";
const SESSION_TTL_SECONDS = 3600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") return serveForm(url);
      if (request.method === "GET" && url.pathname === "/auth/login") return authLogin(url, env);
      if (request.method === "GET" && url.pathname === "/auth/callback") return authCallback(url, request, env);
      if (request.method === "POST" && url.pathname === "/submit") return submit(request, env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
};

// ---- OAuth ----------------------------------------------------------------

function authLogin(url, env) {
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/auth/callback`;
  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", ""); // identity only, no scopes needed
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": cookie("oauth_state", state, 600),
    },
  });
}

async function authCallback(url, request, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("Cookie"));
  if (!code || !state || state !== cookies.oauth_state) {
    return htmlRedirect(url.origin, "Sign-in failed. Please try again.");
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return htmlRedirect(url.origin, "Sign-in failed. Please try again.");
  const { access_token } = await tokenRes.json();

  // With no id/login params, Helix returns the authorized user themselves.
  const userRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${access_token}`, "Client-Id": env.TWITCH_CLIENT_ID },
  });
  if (!userRes.ok) return htmlRedirect(url.origin, "Could not read your Twitch profile. Try again.");
  const login = (await userRes.json())?.data?.[0]?.login;
  if (!login) return htmlRedirect(url.origin, "Could not read your Twitch profile. Try again.");

  const session = await signSession({ login, exp: nowSeconds() + SESSION_TTL_SECONDS }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: [
      ["Location", `${url.origin}/?user=${encodeURIComponent(login)}`],
      ["Set-Cookie", cookie("sess", session, SESSION_TTL_SECONDS)],
      ["Set-Cookie", cookie("oauth_state", "", 0)],
    ],
  });
}

// ---- Submit ---------------------------------------------------------------

async function submit(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const session = await verifySession(cookies.sess, env.SESSION_SECRET);
  if (!session) return json({ error: "Your sign-in expired. Please sign in with Twitch again." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  // Honeypot: real users leave this empty; bots tend to fill every field.
  if (body.website) return json({ ok: true });

  const name = String(body.name || "").trim();
  const youtube = String(body.youtube || "").trim();
  const login = session.login;

  if (!name || /\s/.test(name) || name.length > 40) {
    return json({ error: "Enter your exact in-game name (no spaces)." }, 400);
  }
  if (youtube && !/^https:\/\/(www\.)?youtube\.com\//i.test(youtube)) {
    return json({ error: "YouTube link must start with https://youtube.com/" }, 400);
  }

  const twitch = `https://twitch.tv/${login}`;
  const entry = { name, twitch, youtube: youtube || null, by: login };

  const file = await getFile(env, SUBMITTED_PATH);
  const entries = parseSubmitted(file.text);

  const existing = entries.get(name);
  if (existing && existing.by && existing.by !== login) {
    return json({ error: `"${name}" is already linked to a different Twitch account. Contact the maintainer if that's wrong.` }, 409);
  }
  entries.set(name, entry);

  const newText = serializeSubmitted(entries);
  await putFile(env, SUBMITTED_PATH, newText, file.sha,
    `Submission: ${name} -> ${login}`);

  // Best-effort: make it live within seconds instead of waiting for the
  // next weekly scrape. Contents:write also authorizes repository_dispatch.
  await triggerRepublish(env);

  return json({ ok: true });
}

// ---- GitHub contents API --------------------------------------------------

async function getFile(env, path) {
  const res = await fetch(ghUrl(env, path), { headers: ghHeaders(env) });
  if (res.status === 404) return { text: "", sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  return { text: b64decodeUtf8(data.content), sha: data.sha };
}

async function putFile(env, path, text, sha, message) {
  const res = await fetch(ghUrl(env, path), {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: b64encodeUtf8(text), sha: sha || undefined }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}`);
}

async function triggerRepublish(env) {
  try {
    await fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "republish" }),
    });
  } catch { /* not fatal — weekly scrape will still pick it up */ }
}

function ghUrl(env, path) {
  return `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
}
function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hdt-lobbymmr-streamers-submit",
  };
}

// ---- submitted.txt format -------------------------------------------------
// "name https://twitch.tv/<login> <youtube|-> by:<login>", <br />-joined.
// The scraper only reads the first three tokens, so the trailing by:<login>
// attribution is invisible to it.

function parseSubmitted(text) {
  const map = new Map();
  for (const raw of text.split(ENTRY_SEPARATOR)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(" ");
    const [name, twitch, youtube] = parts;
    const byToken = parts.find((p) => p.startsWith("by:"));
    if (!name) continue;
    map.set(name, {
      name,
      twitch: twitch !== "-" ? twitch : null,
      youtube: youtube && youtube !== "-" ? youtube : null,
      by: byToken ? byToken.slice(3) : null,
    });
  }
  return map;
}

function serializeSubmitted(map) {
  return [...map.values()]
    .map((e) => `${e.name} ${e.twitch || "-"} ${e.youtube || "-"} by:${e.by || ""}`)
    .join(ENTRY_SEPARATOR);
}

// ---- Signed session (HMAC-SHA256) -----------------------------------------

async function signSession(payload, secret) {
  const data = b64url(JSON.stringify(payload));
  const sig = await hmac(data, secret);
  return `${data}.${sig}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  if ((await hmac(data, secret)) !== sig) return null;
  try {
    const payload = JSON.parse(b64urlDecode(data));
    if (!payload.login || payload.exp < nowSeconds()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

// ---- Small helpers --------------------------------------------------------

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function htmlRedirect(origin, message) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/?error=${encodeURIComponent(message)}`,
      "Set-Cookie": cookie("oauth_state", "", 0),
    },
  });
}

// UTF-8-safe base64 (player names include Cyrillic/CJK).
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

// ---- Form page ------------------------------------------------------------

function serveForm(url) {
  const user = url.searchParams.get("user");
  const error = url.searchParams.get("error");
  return new Response(formHtml(user, error), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function formHtml(user, error) {
  const safeUser = user ? escapeHtml(user) : "";
  const safeError = error ? escapeHtml(error) : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link your stream — HDT Lobby MMR</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #1c2022; color: #e8e3e3;
    font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: #2e3235; border: 1px solid #4a5256;
    border-radius: 10px; padding: 28px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: #9a9494; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: #9a9494; margin: 16px 0 6px; }
  input[type=text] {
    width: 100%; padding: 10px 12px; font-size: 15px; border-radius: 6px;
    border: 1px solid #4a5256; background: #23272a; color: #e8e3e3;
  }
  input:focus { outline: none; border-color: #9146ff; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 12px; margin-top: 20px; font-size: 15px; font-weight: 600;
    border: none; border-radius: 6px; cursor: pointer; text-decoration: none;
  }
  .btn-twitch { background: #9146ff; color: #fff; }
  .btn-submit { background: #d9a441; color: #1c2022; }
  .btn[disabled] { opacity: .5; cursor: default; }
  .signed { font-size: 14px; color: #e8e3e3; margin-bottom: 4px; }
  .signed b { color: #9146ff; }
  .hp { position: absolute; left: -9999px; }
  .msg { margin-top: 16px; font-size: 14px; line-height: 1.5; }
  .msg.err { color: #e24b4a; }
  .msg.ok { color: #63c088; }
  .foot { margin-top: 22px; font-size: 12px; color: #6e7275; line-height: 1.5; }
  .foot a { color: #9a9494; }
</style>
</head>
<body>
  <div class="card">
    <h1>Link your stream</h1>
    <p class="sub">Streaming Hearthstone Battlegrounds? Link your channel so the
      HDT Lobby MMR plugin shows a marker next to your name in other players' lobbies.</p>

    <div id="signin" style="display:none">
      <a class="btn btn-twitch" href="/auth/login">Sign in with Twitch</a>
      <p class="foot">We only read your Twitch username to confirm the channel is
        yours. Nothing is posted to your channel.</p>
    </div>

    <form id="form" style="display:none">
      <p class="signed">Signed in as <b id="who"></b></p>
      <label for="name">Your exact in-game name</label>
      <input type="text" id="name" autocomplete="off" placeholder="e.g. soliduz">
      <label for="youtube">YouTube channel (optional)</label>
      <input type="text" id="youtube" autocomplete="off" placeholder="https://youtube.com/@yourchannel">
      <input type="text" id="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit" class="btn btn-submit" id="go">Link my channel</button>
      <div class="msg" id="msg"></div>
    </form>

    <div class="msg err" id="topmsg"></div>

    <p class="foot">Data source and this form are community-run and separate from
      wallii.gg. Your in-game name is self-provided — first person to link a name keeps it.</p>
  </div>

<script>
  var USER = ${JSON.stringify(safeUser)};
  var ERR = ${JSON.stringify(safeError)};
  if (ERR) document.getElementById("topmsg").textContent = ERR;
  if (USER) {
    document.getElementById("form").style.display = "block";
    document.getElementById("who").textContent = USER;
  } else {
    document.getElementById("signin").style.display = "block";
  }
  var form = document.getElementById("form");
  if (form) form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var go = document.getElementById("go");
    var msg = document.getElementById("msg");
    msg.className = "msg"; msg.textContent = "";
    go.disabled = true;
    try {
      var res = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: document.getElementById("name").value,
          youtube: document.getElementById("youtube").value,
          website: document.getElementById("website").value,
        }),
      });
      var data = await res.json();
      if (res.ok && data.ok) {
        msg.className = "msg ok";
        msg.textContent = "Linked! Your marker will appear shortly.";
      } else {
        msg.className = "msg err";
        msg.textContent = data.error || "Something went wrong.";
        go.disabled = false;
      }
    } catch (_) {
      msg.className = "msg err";
      msg.textContent = "Network error. Try again.";
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
