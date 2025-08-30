# spotify-youtube-playlist-sync 🎧✨

Keep your Spotify and YouTube playlists in sync — both directions — with smart matching, soft‑dupe detection, and a tiny local cache to remember what’s been synced.

* 🔁 **Two-way sync**: Spotify → YouTube and YouTube → Spotify
* ⏱️ **Recent-only**: looks at the most-recent additions (default 10) so you don’t backfill your entire history
* 🧠 **Robust matching**: duration slack, title-token overlap, channel trust (Topic/VEVO), version flags (live/remix), popularity, and “music video” awareness
* ➿ **Soft duplicates**: detects near-duplicates already in the destination playlist before adding
* 🗂️ **Order-safe**: when adding multiple items, inserts **oldest → newest** to preserve list order
* 🛡️ **Defensive**: if a query/title is “unintelligible”, it **skips** rather than risking a wrong add
* 🗣️ **Verbose mode**: `--verbose` explains exactly how a match was chosen

---

## Table of contents

* 🚀 [Quick start](#quick-start)
* ⚙️ [Configuration](#configuration)
* 🔐 [Environment variables](#environment-variables)
* 🔑 [OAuth: getting refresh tokens](#oauth-getting-refresh-tokens)
* 🧠 [How it decides matches](#how-it-decides-matches)
* 🎛️ [Flags & modes](#flags--modes)
* ⏰ [Scheduling (run it daily)](#scheduling-run-it-daily)
* 🗂️ [Repo structure](#repo-structure)
* 💾 [Cache & idempotency](#cache--idempotency)
* 🧰 [Troubleshooting](#troubleshooting)
* 📝 [Notes](#notes)

---

## Quick start

```bash
git clone <your-private-repo>.git
cd spotify-youtube-playlist-sync

# Node LTS recommended (18+ or 20+)
npm ci

# Create & fill .env with credentials (see below)
cp .env.example .env

# Configure the playlist pairs you want to sync
cp config.example.json config.json
# …then edit config.json

# Dry run with interactive menu
node src/index.js --dry-run

# Or choose a mode explicitly
node src/index.js --mode=both --dry-run
```

If the plan looks good, run without `--dry-run`.

---

## Configuration

`config.json` defines playlist pairs. You can add an optional `nickname` that prefixes logs when you run multiple pairs.

```json
{
  "pairs": [
    {
      "nickname": "gym",
      "spotifyPlaylistId": "37i9dQZF1DX70RN3TfWWJh",
      "youtubePlaylistId": "PLxxxxxxx_your_yt_playlist_id"
    },
    {
      "nickname": "commute",
      "spotifyPlaylistId": "37i9dQZF1DWSkkUxEhrBdF",
      "youtubePlaylistId": "PLyyyyyyy_another_yt_playlist"
    }
  ]
}
```

---

## Environment variables

Create `.env` with your client credentials and **refresh tokens**:

```dotenv
# Spotify
SP_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SP_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SP_REFRESH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# YouTube (Google)
YT_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
YT_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
YT_REFRESH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 💡 **Tip:** Do not commit `.env` or `.cache/`. Add them to `.gitignore`.

---

## OAuth: getting refresh tokens

You need **refresh tokens** so the script can run unattended.

### Spotify

* Create a Spotify app (Dashboard → Create App).
* Add a Redirect URI: `http://127.0.0.1:8080/callback` (or similar loopback).
* Use your one-time helper to obtain a refresh token. Save it in `.env` as `SP_REFRESH_TOKEN`.

### YouTube (Google)

* Create OAuth 2.0 **Desktop** or **Web** client.
* Use a loopback redirect (e.g., `http://127.0.0.1:8081/callback`) in your OAuth client.
* Run the included helper to mint a refresh token:

  * It prints an auth URL, you approve it, and it logs the `REFRESH_TOKEN`.
  * Put that into `.env` as `YT_REFRESH_TOKEN`.

> ⚠️ If you see a Google unverified-app warning during testing, add your account as a **Test user** in the Cloud Console.

---

## How it decides matches

### Spotify → YouTube

* Query: `"PrimaryArtist TrackTitle"`.
* **Hard filters**: duration within **±7s** (configurable in code), no obvious mismatches (cover, karaoke, sped up, nightcore, etc.), artist/channel alignment (Topic/VEVO or appears in title/channel), and title-token coverage.
* **Scoring** weights: channel trust (Topic/VEVO), title Jaccard, artist alignment, duration closeness, content type, popularity, category bonus (Music = 10).

### YouTube → Spotify

* Smart parsing of YT titles with dashes: decides whether it’s **Artist – Title** or **Title – Artist** using channel overlap (Topic/VEVO) and markers like `&, feat/ft/x/with`.
* Trusted artist only if it comes from **Topic/VEVO** channel (title-derived artist is **untrusted**).
* Prefers **non–music-video** exact title matches when present; otherwise gives a bump to **music video** versions.
* **Hard filters**: ±7s duration, version flags (live/remix/acoustic/lyrics) must align, title-token coverage. Artist alignment is required only when the artist is **trusted** and the candidate is **not** an MV.

### Safety / skip behavior

* If a query/title looks **unintelligible** after normalization (e.g., mostly symbols/emojis), it **skips** with `reason: "unintelligible_query"` rather than risking a wrong add.

### Search breadth

* Checks **top K=5** candidates; if nothing passes, escalates to **K=10** once, then logs and moves on.

### Duplicates

* Before adding, performs a **soft-dupe** pass on the destination playlist with relaxed rules (short-circuit to map-only if found).

---

## Flags & modes

* `--mode=sp2yt` · only Spotify → YouTube
* `--mode=yt2sp` · only YouTube → Spotify
* `--mode=both`  · runs SP→YT, then YT→SP

  * When running **both**, the second leg’s “recent window” is automatically **bumped** by how many items were actually added in the first leg (so you don’t miss pre‑existing tail items).
* `--dry-run` · plan only, no changes
* `--verbose` · prints the reasoning (orientation, trusted artist, queries, escalation, top-3 candidates with scores) for YT→SP, plus helpful extras

Examples:

```bash
# Just check what would happen
node src/index.js --mode=both --dry-run

# Debug a tricky case
node src/index.js --mode=yt2sp --dry-run --verbose
```

If you run with **no** `--mode` and you’re in a TTY, you’ll get a 1/2/3 interactive menu.

---

## Scheduling (run it daily)

Pick one:

* 🖥️ **VPS + cron** (simplest):
  `30 3 * * * cd /home/ubuntu/spotify-youtube-playlist-sync && /usr/bin/node src/index.js --mode=both >> run.log 2>&1`
* ☁️ **Render / Railway / Fly.io cron job**: set command `node src/index.js --mode=both`; attach a persistent disk for `.cache/`.
* 🤖 **GitHub Actions** (ephemeral): schedule and sync `.cache/` to S3/GCS before/after the run.
* 🪄 **AWS Lambda + EventBridge**: store `.cache/` in S3 each run; secrets in Secrets Manager.

> Your code relies on a small **file cache**. If your runner is ephemeral, back `.cache/` with S3/GCS so matches remain stable.

---

## Repo structure

```
.
├── config.json                  # your playlist pairs (nickname, spotifyPlaylistId, youtubePlaylistId)
├── .env                         # client IDs/secrets + refresh tokens (not committed)
├── .cache/                      # per-Spotify-playlist sync state (auto-created)
└── src/
    ├── index.js                 # entry point (modes, both-leg bumping, ordering)
    ├── clients/
    │   ├── spotify.js           # YT→SP: search, filters, scoring, soft-dupe
    │   └── youtube.js           # SP→YT: search, filters, scoring, soft-dupe
    ├── auth/
    │   ├── spotifyAuth.js       # builds Spotify Web API client from env
    │   └── youtubeAuth.js       # builds YouTube client from env
    └── util/
        ├── text.js              # norm/tokens/jaccard + intelligibility guard
        └── cache.js             # load/save cache for a given Spotify playlist
```

---

## Cache & idempotency

Each Spotify playlist gets a cache file in `.cache/` (JSON) that stores:

* `lastSync`
* `seenTrackIds` (to avoid retroactive backfills)
* `map` of `spotifyTrackId → youtubeVideoId`

**Reset for a single song**: remove its mapping from the cache JSON, then run again (prefer `--dry-run` first).
**First run**: marks the current playlist as “seen” so only **new additions** are considered going forward.

---

## Troubleshooting

* 🔐 **“This redirect URI is not secure” (Spotify)**
  Use a **loopback** address like `http://127.0.0.1:8080/callback` in the Spotify app settings and in your local helper.
* 🛡️ **Google “unverified app” / “access blocked”**
  In Cloud Console, add your Google account to **OAuth consent screen → Test users**.
* 🔌 **Callback opens but the script says `Listening on http://127.0.0.1:xxxx/callback`**
  Ensure the helper is actually running and your redirect URI matches exactly (host, port, and path).
* 🎯 **Wrong match**
  Run with `--verbose` to see the orientation, trusted artist, queries, and candidate scores. Remove the incorrect entry from `.cache/<spotifyId>.json` and re-run.
* 🧠 **Skipped with `unintelligible_query`**
  The title/query was normalized to mostly symbols. That’s intentional to avoid bad adds.
* 🚦 **Rate limits**
  The tool uses small queries (≤10 per item) and only checks recent additions. If you sync many pairs at once, you may hit API limits—try off‑peak hours.

---

## Notes

* Scopes used: Spotify Web API (standard) and YouTube Data API v3 (`https://www.googleapis.com/auth/youtube`).
* Additions are applied **oldest → newest** within a run to keep playlist order intuitive.
* Search breadth: top **5 results**, escalate to **10** if zero pass; then log and move on.

---

**Enjoy the auto-sync!** 🎧✨
