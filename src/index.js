// src/index.js
// Entry point with interactive mode + both sync directions.
//
// Modes:
//   --mode=both   | --both
//   --mode=sp2yt  | --sp2yt
//   --mode=yt2sp  | --yt2sp
// If no mode passed and interactive TTY: shows a 1/2/3/4/5 menu.
//
// BOTH tweak:
// - After SP→YT finishes, bump YT→SP's recent window by the number of
//   actual additions from the first leg.
//
// Adds are applied **backwards** (oldest→newest).
// Per-pair "nickname" prefix in all logs.
// NEW: --verbose prints YT→SP reasoning (orientation, queries, top candidates, etc.)

require('dotenv').config();
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const MODES = { BOTH: 'both', SP2YT: 'sp2yt', YT2SP: 'yt2sp', SPOTIFY_TOKEN: 'spotify_token', YOUTUBE_TOKEN: 'youtube_token' };
const args = process.argv.slice(2);

function parseModeFromArgs() {
  const val =
    (args.find(a => a.startsWith('--mode=')) || '').split('=')[1] ||
    (args.includes('--both') ? MODES.BOTH : null) ||
    (args.includes('--sp2yt') ? MODES.SP2YT : null) ||
    (args.includes('--yt2sp') ? MODES.YT2SP : null);
  if (val && [MODES.BOTH, MODES.SP2YT, MODES.YT2SP].includes(val)) return val;
  return null;
}

function parsePlaylistFilter() {
  const raw = (args.find(a => a.startsWith('--playlist=')) || '').split('=').slice(1).join('=').trim();
  return raw || null;
}

function filterPairs(pairs, filter) {
  if (!filter || filter === '0') return pairs;
  const n = Number(filter);
  if (!isNaN(n) && Number.isInteger(n) && n >= 1 && n <= pairs.length) return [pairs[n - 1]];
  const low = filter.toLowerCase();
  const match = pairs.filter(p => (p.nickname || '').toLowerCase().includes(low));
  if (match.length) return match;
  console.warn(`⚠️  --playlist="${filter}" matched nothing; running all playlists.`);
  return pairs;
}

function promptPlaylistMenu(pairs) {
  if (pairs.length <= 1) return Promise.resolve(pairs);
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nSelect playlist to sync:');
    console.log('  0) All playlists');
    pairs.forEach((p, i) => console.log(`  ${i + 1}) ${makePairLabel(p)}`));
    rl.question(`\nEnter 0-${pairs.length} (default 0 = all): `, answer => {
      rl.close();
      const a = String(answer).trim();
      if (!a || a === '0') return resolve(pairs);
      const n = Number(a);
      if (!isNaN(n) && Number.isInteger(n) && n >= 1 && n <= pairs.length) return resolve([pairs[n - 1]]);
      console.log('Unrecognized choice. Using all playlists.');
      resolve(pairs);
    });
  });
}

function promptMenu() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║          Spotify ↔ YouTube Playlist Sync               ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    console.log('Select an option:');
    console.log('  1) Run both sides (Spotify → YouTube, then YouTube → Spotify)');
    console.log('  2) Run only Spotify → YouTube');
    console.log('  3) Run only YouTube → Spotify');
    console.log('  4) Get new Spotify refresh token');
    console.log('  5) Get new YouTube refresh token');
    console.log('  6) Exit');
    rl.question('\nEnter 1 / 2 / 3 / 4 / 5 / 6: ', answer => {
      rl.close();
      const a = String(answer).trim();
      if (a === '1') return resolve(MODES.BOTH);
      if (a === '2') return resolve(MODES.SP2YT);
      if (a === '3') return resolve(MODES.YT2SP);
      if (a === '4') return resolve(MODES.SPOTIFY_TOKEN);
      if (a === '5') return resolve(MODES.YOUTUBE_TOKEN);
      if (a === '6') return resolve(null);
      console.log('Unrecognized choice. Defaulting to "Spotify → YouTube".');
      resolve(MODES.SP2YT);
    });
  });
}

function updateEnvFile(tokenKey, newToken) {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.log('⚠️  .env file not found. Creating new one...');
    fs.writeFileSync(envPath, `${tokenKey}=${newToken}\n`, 'utf8');
    console.log('✅ Created .env file with new token.');
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${tokenKey}=.*$`, 'm');

  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${tokenKey}=${newToken}`);
    console.log(`✅ Updated ${tokenKey} in .env file.`);
  } else {
    if (!envContent.endsWith('\n')) envContent += '\n';
    envContent += `${tokenKey}=${newToken}\n`;
    console.log(`✅ Added ${tokenKey} to .env file.`);
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
}

async function runSpotifyTokenScript() {
  console.log('\n🔐 Getting Spotify refresh token...\n');

  const http = require('http');
  const { URL } = require('url');
  const SpotifyWebApi = require('spotify-web-api-node');

  const sp = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
  });

  const scopes = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-library-read',
    'user-library-modify'
  ];

  const authURL = sp.createAuthorizeURL(scopes, 'sync_state', true);

  console.log('Open this URL in your browser to authorize:\n');
  console.log(authURL);
  console.log('\nListening on http://127.0.0.1:8080/callback ...\n');

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1:8080');
      if (u.pathname !== '/callback') { res.end('OK'); return; }

      const code = u.searchParams.get('code');
      try {
        const data = await sp.authorizationCodeGrant(code);
        const refreshToken = data.body.refresh_token;

        console.log('\n✅ Successfully obtained Spotify refresh token!');
        updateEnvFile('SPOTIFY_REFRESH_TOKEN', refreshToken);

        res.end('✅ Success! Token saved to .env. You can close this tab and return to the terminal.');
        server.close();
        resolve();
      } catch (e) {
        console.error('❌ Auth error:', e.body?.error_description || e.message);
        res.statusCode = 500;
        res.end('❌ Auth error. Check terminal.');
        server.close();
        resolve();
      }
    }).listen(8080);
  });
}

async function runYouTubeTokenScript() {
  console.log('\n🔐 Getting YouTube refresh token...\n');

  const http = require('http');
  const { URL } = require('url');
  const { google } = require('googleapis');

  const REDIRECT = process.env.YT_REDIRECT_URI || 'http://127.0.0.1:8081/callback';
  const parsed = new URL(REDIRECT);
  const HOST = parsed.hostname || '127.0.0.1';
  const PORT = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  const CALLBACK_PATH = parsed.pathname || '/callback';

  const oAuth2Client = new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    REDIRECT
  );

  const scopes = ['https://www.googleapis.com/auth/youtube'];

  const authURL = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });

  console.log('Open this URL in your browser to authorize:\n');
  console.log(authURL);
  console.log(`\nListening on ${parsed.origin}${CALLBACK_PATH} ...\n`);

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `${parsed.origin}`);
      if (u.pathname !== CALLBACK_PATH) {
        res.statusCode = 200;
        res.end(`OK – waiting for ${CALLBACK_PATH}`);
        return;
      }

      const oauthError = u.searchParams.get('error');
      if (oauthError) {
        console.error('❌ Auth error from Google:', oauthError);
        res.statusCode = 400;
        res.end('❌ Auth error from Google. Check terminal logs.');
        server.close();
        resolve();
        return;
      }

      const code = u.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end("❌ Missing 'code' param on callback URL.");
        server.close();
        resolve();
        return;
      }

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;

        if (!refreshToken) {
          console.warn('\n⚠️  No REFRESH_TOKEN returned.');
          console.warn('Tips:');
          console.warn('  • Ensure access_type=offline and prompt=consent (already set).');
          console.warn('  • Revoke the app at https://myaccount.google.com/permissions and try again.');
          console.warn('  • Make sure your OAuth consent screen is in Testing mode.\n');
          res.end('⚠️  No refresh token received. See terminal for details.');
          server.close();
          resolve();
          return;
        }

        console.log('\n✅ Successfully obtained YouTube refresh token!');
        updateEnvFile('YT_REFRESH_TOKEN', refreshToken);

        res.end('✅ Success! Token saved to .env. You can close this tab and return to the terminal.');
        server.close();
        resolve();
      } catch (e) {
        console.error('❌ Auth exchange failed:', e.message || e);
        res.statusCode = 500;
        res.end('❌ Auth exchange failed. Check terminal.');
        server.close();
        resolve();
      }
    }).listen(PORT, HOST, () => {
      console.log(`Server bound on http://${HOST}:${PORT}${CALLBACK_PATH}`);
    });
  });
}

const CONFIG = require('../config.json');
const { getSpotify } = require('./auth/spotifyAuth');
const { getYouTube } = require('./auth/youtubeAuth');

const {
  getAllPlaylistItems,
  findSoftDupeInSpotify,
  findBestSpotifyForYouTubeVideo,
  addTracksToPlaylist
} = require('./clients/spotify');

const {
  getYouTubePlaylistItems,
  findBestYouTubeForSpotifyTrack,
  insertIntoPlaylist,
  findSoftDupeInPlaylist
} = require('./clients/youtube');

const { loadCache, saveCache } = require('./util/cache');

const DEFAULT_DURATION_SLACK_SEC = 7;
const RECENT_SPOTIFY_LIMIT = 10;
const RECENT_YOUTUBE_LIMIT = 10;

function isAfter(aIso, bIso) {
  if (!aIso) return false;
  if (!bIso) return true;
  return new Date(aIso) > new Date(bIso);
}
function sortByAddedAtDesc(items) {
  return [...items].sort((a, b) => {
    const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
    const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
    return tb - ta;
  });
}
function makePairLabel(pair) {
  const { nickname, spotifyPlaylistId: spId, youtubePlaylistId: ytId } = pair;
  if (nickname && nickname.trim()) return nickname.trim();
  const spShort = (spId || 'sp').slice(0, 6);
  const ytShort = (ytId || 'yt').slice(0, 6);
  return `sp:${spShort}→yt:${ytShort}`;
}
function makeLogger(label) {
  return (...args) => console.log(`[${label}]`, ...args);
}

async function runSp2Yt({ dryRun, verbose, pairs = CONFIG.pairs }) {
  const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

  let addedCountTotal = 0;

  for (const pair of pairs) {
    const spId = pair.spotifyPlaylistId;
    const ytId = pair.youtubePlaylistId;
    const label = makePairLabel(pair);
    const log = makeLogger(label);

    if (!spId || !ytId || spId === 'SPOTIFY_PLAYLIST_ID' || ytId === 'YOUTUBE_PLAYLIST_ID') {
      log('⚠️  Set real playlist IDs in config.json');
      continue;
    }

    log(`🎯 Syncing Spotify (${spId}) → YouTube (${ytId}) ${dryRun ? '[DRY-RUN]' : ''}`);

    const cache = loadCache(spId);
    if (!cache.map) cache.map = {};
    const seen = new Set(cache.seenTrackIds || []);

    const [spItemsAll, ytItems] = await Promise.all([
      getAllPlaylistItems(sp, spId),
      getYouTubePlaylistItems(yt, ytId)
    ]);

    const ytVideoSet = new Set(ytItems.map(v => v.id));

    const spItemsSorted = sortByAddedAtDesc(spItemsAll);
    const spItems = spItemsSorted.slice(0, Math.min(RECENT_SPOTIFY_LIMIT, spItemsSorted.length));

    log(`• Spotify tracks total: ${spItemsAll.length}`);
    log(`• YouTube videos total: ${ytItems.length}`);
    log(`• Limiting to last ${RECENT_SPOTIFY_LIMIT} Spotify additions → ${spItems.length} to inspect`);

    const candidates = [];
    const firstRun = !cache.lastSync;

    for (const it of spItems) {
      const mapped = cache.map[it.id];
      const addedRecently = isAfter(it.addedAt, cache.lastSync);
      const unseen = !seen.has(it.id);
      const mappedButMissing = mapped && !ytVideoSet.has(mapped);

      if ((firstRun && (!mapped || mappedButMissing)) || addedRecently || unseen || mappedButMissing) {
        candidates.push(it);
      }
    }

    log(`• Candidates to process (within last ${RECENT_SPOTIFY_LIMIT}): ${candidates.length}`);

    const plan = [];
    for (const s of candidates) {
      const mapped = cache.map[s.id];
      if (mapped && ytVideoSet.has(mapped)) continue;

      const softDupe = findSoftDupeInPlaylist(s, ytItems);
      if (softDupe) {
        plan.push({ s, action: 'map-only', videoId: softDupe.id, reason: 'soft-dup-in-playlist' });
        continue;
      }

      const { best, reason, inspected, escalated } =
        await findBestYouTubeForSpotifyTrack(yt, s, { slackSec: DEFAULT_DURATION_SLACK_SEC, verbose, log });

      if (!best) {
        plan.push({ s, action: 'skip', reason: reason || 'no_match', inspected, escalated });
        continue;
      }

      if (ytVideoSet.has(best.id)) {
        plan.push({ s, action: 'map-only', videoId: best.id, inspected, escalated });
      } else {
        plan.push({ s, action: 'add', videoId: best.id, inspected, escalated });
      }
    }

    if (plan.length) {
      for (const p of plan) {
        const labelEsc = p.escalated ? ' (escalated to 10)' : '';
        if (p.action === 'add') {
          log(`  + ADD  ${p.s.artists[0] || ''} - ${p.s.title}  →  ${p.videoId}${labelEsc}`);
        } else if (p.action === 'map-only') {
          const why = p.reason ? ` [${p.reason}]` : '';
          log(`  = MAP  ${p.s.artists[0] || ''} - ${p.s.title}  ↔  ${p.videoId}${why}${labelEsc}`);
        } else {
          log(`  ~ SKIP ${p.s.artists[0] || ''} - ${p.s.title}  (${p.reason})${labelEsc}`);
        }
      }
    } else {
      log('  (Nothing to do)');
    }

    let addedThisPair = 0;
    if (!dryRun) {
      const adds = plan.filter(p => p.action === 'add');
      const maps = plan.filter(p => p.action === 'map-only');

      for (const p of adds.slice().reverse()) {
        try {
          await insertIntoPlaylist(yt, ytId, p.videoId);
          ytVideoSet.add(p.videoId);
          cache.map[p.s.id] = p.videoId;
          addedThisPair += 1;
          log(`  ✔ Added → ${p.videoId}`);
        } catch (e) {
          log(`  ! Failed to add ${p.s.title}: ${e.message}`);
        }
      }

      for (const p of maps) {
        try {
          cache.map[p.s.id] = p.videoId;
          log('  ✔ Mapped only');
        } catch (e) {
          log(`  ! Failed to map ${p.s.title}: ${e.message}`);
        }
      }

      const newSeen = Array.from(new Set([...seen, ...spItemsAll.map(i => i.id)]));
      cache.seenTrackIds = newSeen;
      cache.lastSync = new Date().toISOString();
      saveCache(spId, cache);
      log(`• Cache updated. (+${addedThisPair} additions on YouTube)`);
    } else {
      log('• DRY-RUN: no changes applied. Run without --dry-run to sync.');
    }

    addedCountTotal += addedThisPair;
  }

  return { addedCount: addedCountTotal };
}

async function runYt2Sp({ dryRun, recentLimitOverride, verbose, pairs = CONFIG.pairs }) {
  const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

  for (const pair of pairs) {
    const spId = pair.spotifyPlaylistId;
    const ytId = pair.youtubePlaylistId;
    const label = makePairLabel(pair);
    const log = makeLogger(label);
    const vlog = (...xs) => { if (verbose) log(...xs); };

    if (!spId || !ytId || spId === 'SPOTIFY_PLAYLIST_ID' || ytId === 'YOUTUBE_PLAYLIST_ID') {
      log('⚠️  Set real playlist IDs in config.json');
      continue;
    }

    const effectiveRecent = Number.isFinite(recentLimitOverride)
      ? Math.max(0, recentLimitOverride)
      : RECENT_YOUTUBE_LIMIT;

    log(`🎯 Syncing YouTube (${ytId}) → Spotify (${spId}) ${dryRun ? '[DRY-RUN]' : ''}`);
    if (effectiveRecent !== RECENT_YOUTUBE_LIMIT) {
      log(`• Adjusted recent window for YT→SP: ${RECENT_YOUTUBE_LIMIT} → ${effectiveRecent}`);
    }

    const cache = loadCache(spId);
    if (!cache.map) cache.map = {};

    const reverseMap = new Map();
    for (const [spTrackId, ytVideoId] of Object.entries(cache.map)) {
      if (ytVideoId) reverseMap.set(ytVideoId, spTrackId);
    }

    const [spItemsAll, ytItemsAll] = await Promise.all([
      getAllPlaylistItems(sp, spId),
      getYouTubePlaylistItems(yt, ytId)
    ]);

    const ytItemsSorted = sortByAddedAtDesc(ytItemsAll);
    const ytItems = ytItemsSorted.slice(0, Math.min(effectiveRecent, ytItemsSorted.length));

    const spTrackSet = new Set(spItemsAll.map(i => i.id));

    log(`• YouTube videos total: ${ytItemsAll.length}`);
    log(`• Spotify tracks total: ${spItemsAll.length}`);
    log(`• Limiting to last ${effectiveRecent} YouTube additions → ${ytItems.length} to inspect`);

    const plan = [];
    for (const v of ytItems) {
      if (verbose) {
        vlog(`→ Inspect YT: "${v.title}" (${v.durationMs || '?'}ms)  channel="${v.channelTitle}"`);
      }
      const mappedSp = reverseMap.get(v.id);
      if (mappedSp) {
        if (spTrackSet.has(mappedSp)) {
          vlog('    already mapped & present on Spotify — skip');
          continue;
        } else {
          vlog(`    mapped-but-missing on Spotify → plan ADD spotify:track:${mappedSp}`);
          plan.push({ v, action: 'add', spTrackId: mappedSp, reason: 'mapped-but-missing' });
          continue;
        }
      }

      const softDup = findSoftDupeInSpotify(v, spItemsAll, { verbose, log: msg => vlog(msg) });
      if (softDup) {
        plan.push({ v, action: 'map-only', spTrackId: softDup.id, reason: 'soft-dup-in-playlist' });
        continue;
      }

      const { best, reason, inspected, escalated, score } =
        await findBestSpotifyForYouTubeVideo(sp, v, {
          slackSec: DEFAULT_DURATION_SLACK_SEC,
          verbose,
          log: msg => vlog(msg)
        });

      if (!best) {
        vlog(`    no best match (${reason}); inspected=${inspected}${escalated ? ', escalated' : ''}`);
        plan.push({ v, action: 'skip', reason: reason || 'no_match', inspected, escalated });
        continue;
      }

      if (spTrackSet.has(best.id)) {
        vlog(`    best: "${best.name}" [present in playlist] → MAP-ONLY`);
        plan.push({ v, action: 'map-only', spTrackId: best.id, inspected, escalated, score });
      } else {
        vlog(`    best: "${best.name}" [NOT present] → ADD`);
        plan.push({ v, action: 'add', spTrackId: best.id, inspected, escalated, score });
      }
    }

    if (plan.length) {
      for (const p of plan) {
        const labelEsc = p.escalated ? ' (escalated to 10)' : '';
        if (p.action === 'add') {
          log(`  + ADD  ${p.v.title}  →  spotify:track:${p.spTrackId}${labelEsc}${verbose && p.score != null ? ` [score≈${p.score.toFixed(2)}]` : ''}`);
        } else if (p.action === 'map-only') {
          const why = p.reason ? ` [${p.reason}]` : '';
          log(`  = MAP  ${p.v.title}  ↔  spotify:track:${p.spTrackId}${why}${labelEsc}${verbose && p.score != null ? ` [score≈${p.score.toFixed(2)}]` : ''}`);
        } else {
          log(`  ~ SKIP ${p.v.title}  (${p.reason})${labelEsc}`);
        }
      }
    } else {
      log('  (Nothing to do)');
    }

    if (!dryRun) {
      const adds = plan.filter(p => p.action === 'add');
      const maps = plan.filter(p => p.action === 'map-only');

      for (const p of adds.slice().reverse()) {
        try {
          await addTracksToPlaylist(sp, spId, [p.spTrackId]);
          spTrackSet.add(p.spTrackId);
          cache.map[p.spTrackId] = p.v.id;
          log(`  ✔ Added → spotify:track:${p.spTrackId}`);
        } catch (e) {
          log(`  ! Failed to add ${p.v.title}: ${e.message}`);
        }
      }

      for (const p of maps) {
        try {
          cache.map[p.spTrackId] = p.v.id;
          log('  ✔ Mapped only');
        } catch (e) {
          log(`  ! Failed to map ${p.v.title}: ${e.message}`);
        }
      }

      const seen = new Set(cache.seenTrackIds || []);
      const newSeen = Array.from(new Set([
        ...seen,
        ...spItemsAll.map(i => i.id),
        ...adds.map(p => p.spTrackId)
      ]));
      cache.seenTrackIds = newSeen;
      cache.lastSync = new Date().toISOString();
      saveCache(spId, cache);
      log('• Cache updated.');
    } else {
      log('• DRY-RUN: no changes applied. Run without --dry-run to sync.');
    }
  }
}

(async () => {
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  const cliPlaylistFilter = parsePlaylistFilter();
  const cliPairs = cliPlaylistFilter ? filterPairs(CONFIG.pairs, cliPlaylistFilter) : null;

  let mode = parseModeFromArgs();

  while (true) {
    if (!mode) {
      mode = isInteractive ? await promptMenu() : MODES.SP2YT;
    }

    if (!mode) {
      console.log('\nExiting...');
      break;
    }

    if (mode === MODES.SPOTIFY_TOKEN) {
      await runSpotifyTokenScript();
      mode = null;
      continue;
    } else if (mode === MODES.YOUTUBE_TOKEN) {
      await runYouTubeTokenScript();
      mode = null;
      continue;
    }

    let pairs;
    if (cliPairs) {
      pairs = cliPairs;
    } else if (isInteractive) {
      pairs = await promptPlaylistMenu(CONFIG.pairs);
    } else {
      pairs = CONFIG.pairs;
    }

    if (mode === MODES.SP2YT) {
      await runSp2Yt({ dryRun, verbose, pairs });
    } else if (mode === MODES.YT2SP) {
      await runYt2Sp({ dryRun, verbose, pairs });
    } else if (mode === MODES.BOTH) {
      // Run SP→YT first, then bump the YT→SP window by actual additions from the first leg.
      const { addedCount } = await runSp2Yt({ dryRun, verbose, pairs });
      const bumpedWindow = RECENT_YOUTUBE_LIMIT + (addedCount || 0);
      await runYt2Sp({ dryRun, recentLimitOverride: bumpedWindow, verbose, pairs });
    }

    console.log('\nDone.');

    if (parseModeFromArgs()) {
      break;
    }
    mode = null;
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
