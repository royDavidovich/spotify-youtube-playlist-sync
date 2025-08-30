// src/index.js
// Entry point with interactive mode + both sync directions.
//
// Modes:
//   --mode=both   | --both
//   --mode=sp2yt  | --sp2yt
//   --mode=yt2sp  | --yt2sp
// If no mode passed and interactive TTY: shows a 1/2/3 menu.
//
// BOTH tweak:
// - After SP→YT finishes, bump YT→SP's recent window by the number of
//   actual additions from the first leg.
//
// New: Adds are applied **backwards** (oldest→newest) to preserve order.

require('dotenv').config();
const readline = require('readline');

const MODES = { BOTH: 'both', SP2YT: 'sp2yt', YT2SP: 'yt2sp' };
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

function promptMenu() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nSelect run mode:');
    console.log('  1) Run both sides (Spotify → YouTube, then YouTube → Spotify)');
    console.log('  2) Run only Spotify → YouTube');
    console.log('  3) Run only YouTube → Spotify');
    rl.question('\nEnter 1 / 2 / 3: ', answer => {
      rl.close();
      const a = String(answer).trim();
      if (a === '1') return resolve(MODES.BOTH);
      if (a === '2') return resolve(MODES.SP2YT);
      if (a === '3') return resolve(MODES.YT2SP);
      console.log('Unrecognized choice. Defaulting to "Spotify → YouTube".');
      resolve(MODES.SP2YT);
    });
  });
}

// ---- Imports from your clients (keep index.js lean) ----
const CONFIG = require('../config.json');
const { getSpotify } = require('./auth/spotifyAuth');
const { getYouTube } = require('./auth/youtubeAuth');

const {
  // SPOTIFY client
  getAllPlaylistItems,
  findSoftDupeInSpotify,
  findBestSpotifyForYouTubeVideo,
  addTracksToPlaylist
} = require('./clients/spotify');

const {
  // YOUTUBE client
  getYouTubePlaylistItems,
  findBestYouTubeForSpotifyTrack,
  insertIntoPlaylist,
  findSoftDupeInPlaylist
} = require('./clients/youtube');

const { loadCache, saveCache } = require('./util/cache');

// ---- Small local helpers & constants ----
const DEFAULT_DURATION_SLACK_SEC = 7;
const RECENT_SPOTIFY_LIMIT = 10; // only inspect last-L from Spotify when doing SP→YT
const RECENT_YOUTUBE_LIMIT = 10; // only inspect last-L from YouTube when doing YT→SP

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

// ====================== SPOTIFY → YOUTUBE ======================
async function runSp2Yt({ dryRun }) {
  const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

  let addedCountTotal = 0; // returned for BOTH-mode bump

  for (const pair of CONFIG.pairs) {
    const spId = pair.spotifyPlaylistId;
    const ytId = pair.youtubePlaylistId;

    if (!spId || !ytId || spId === 'SPOTIFY_PLAYLIST_ID' || ytId === 'YOUTUBE_PLAYLIST_ID') {
      console.log('⚠️  Set real playlist IDs in config.json');
      continue;
    }

    console.log(`\n🎯 Syncing Spotify (${spId}) → YouTube (${ytId}) ${dryRun ? '[DRY-RUN]' : ''}`);

    const cache = loadCache(spId); // { lastSync, seenTrackIds[], map{} }
    if (!cache.map) cache.map = {};
    const seen = new Set(cache.seenTrackIds || []);

    const [spItemsAll, ytItems] = await Promise.all([
      getAllPlaylistItems(sp, spId),
      getYouTubePlaylistItems(yt, ytId)
    ]);

    const ytVideoSet = new Set(ytItems.map(v => v.id));

    // Only look at last L Spotify additions
    const spItemsSorted = sortByAddedAtDesc(spItemsAll);
    const spItems = spItemsSorted.slice(0, Math.min(RECENT_SPOTIFY_LIMIT, spItemsSorted.length));

    console.log(`• Spotify tracks total: ${spItemsAll.length}`);
    console.log(`• YouTube videos total: ${ytItems.length}`);
    console.log(`• Limiting to last ${RECENT_SPOTIFY_LIMIT} Spotify additions → ${spItems.length} to inspect`);

    // Determine candidates within last-L:
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

    console.log(`• Candidates to process (within last ${RECENT_SPOTIFY_LIMIT}): ${candidates.length}`);

    const plan = [];
    for (const s of candidates) {
      const mapped = cache.map[s.id];
      if (mapped && ytVideoSet.has(mapped)) continue;

      // pre-add soft-dupe check in existing playlist (looser rules)
      const softDupe = findSoftDupeInPlaylist(s, ytItems);
      if (softDupe) {
        plan.push({ s, action: 'map-only', videoId: softDupe.id, reason: 'soft-dup-in-playlist' });
        continue;
      }

      // Find best candidate via search (K=5, escalate→10 if needed)
      const { best, reason, inspected, escalated } =
        await findBestYouTubeForSpotifyTrack(yt, s, { slackSec: DEFAULT_DURATION_SLACK_SEC });

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

    // Show plan
    if (plan.length) {
      for (const p of plan) {
        const label = p.escalated ? ' (escalated to 10)' : '';
        if (p.action === 'add') {
          console.log(`  + ADD  ${p.s.artists[0] || ''} - ${p.s.title}  →  ${p.videoId}${label}`);
        } else if (p.action === 'map-only') {
          const why = p.reason ? ` [${p.reason}]` : '';
          console.log(`  = MAP  ${p.s.artists[0] || ''} - ${p.s.title}  ↔  ${p.videoId}${why}${label}`);
        } else {
          console.log(`  ~ SKIP ${p.s.artists[0] || ''} - ${p.s.title}  (${p.reason})${label}`);
        }
      }
    } else {
      console.log('  (Nothing to do)');
    }

    // Apply — add **backwards** (oldest→newest)
    let addedThisPair = 0;
    if (!dryRun) {
      const adds = plan.filter(p => p.action === 'add');
      const maps = plan.filter(p => p.action === 'map-only');

      // Add in reverse plan order to preserve final ordering
      for (const p of adds.slice().reverse()) {
        try {
          await insertIntoPlaylist(yt, ytId, p.videoId);
          ytVideoSet.add(p.videoId);
          cache.map[p.s.id] = p.videoId;
          addedThisPair += 1;
          console.log(`  ✓ Added → ${p.videoId}`);
        } catch (e) {
          console.warn(`  ! Failed to add ${p.s.title}: ${e.message}`);
        }
      }

      // Map-only (order irrelevant)
      for (const p of maps) {
        try {
          cache.map[p.s.id] = p.videoId;
          console.log('  ✓ Mapped only');
        } catch (e) {
          console.warn(`  ! Failed to map ${p.s.title}: ${e.message}`);
        }
      }

      // Update baseline: mark ALL current Spotify tracks as seen so backlog is ignored
      const newSeen = Array.from(new Set([...seen, ...spItemsAll.map(i => i.id)]));
      cache.seenTrackIds = newSeen;
      cache.lastSync = new Date().toISOString();
      saveCache(spId, cache);
      console.log(`• Cache updated. (+${addedThisPair} additions on YouTube)`);
    } else {
      console.log('• DRY-RUN: no changes applied. Run without --dry-run to sync.');
    }

    addedCountTotal += addedThisPair;
  }

  return { addedCount: addedCountTotal };
}

// ====================== YOUTUBE → SPOTIFY ======================
async function runYt2Sp({ dryRun, recentLimitOverride }) {
  const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

  for (const pair of CONFIG.pairs) {
    const spId = pair.spotifyPlaylistId;
    const ytId = pair.youtubePlaylistId;

    if (!spId || !ytId || spId === 'SPOTIFY_PLAYLIST_ID' || ytId === 'YOUTUBE_PLAYLIST_ID') {
      console.log('⚠️  Set real playlist IDs in config.json');
      continue;
    }

    const effectiveRecent = Number.isFinite(recentLimitOverride)
      ? Math.max(0, recentLimitOverride)
      : RECENT_YOUTUBE_LIMIT;

    console.log(`\n🎯 Syncing YouTube (${ytId}) → Spotify (${spId}) ${dryRun ? '[DRY-RUN]' : ''}`);
    if (effectiveRecent !== RECENT_YOUTUBE_LIMIT) {
      console.log(`• Adjusted recent window for YT→SP: ${RECENT_YOUTUBE_LIMIT} → ${effectiveRecent}`);
    }

    const cache = loadCache(spId); // reuse same cache file keyed by Spotify playlist
    if (!cache.map) cache.map = {};

    // Build reverse map: ytVideoId -> spTrackId
    const reverseMap = new Map();
    for (const [spTrackId, ytVideoId] of Object.entries(cache.map)) {
      if (ytVideoId) reverseMap.set(ytVideoId, spTrackId);
    }

    const [spItemsAll, ytItemsAll] = await Promise.all([
      getAllPlaylistItems(sp, spId),
      getYouTubePlaylistItems(yt, ytId)
    ]);

    // Only look at last "effectiveRecent" YouTube additions
    const ytItemsSorted = sortByAddedAtDesc(ytItemsAll);
    const ytItems = ytItemsSorted.slice(0, Math.min(effectiveRecent, ytItemsSorted.length));

    const spTrackSet = new Set(spItemsAll.map(i => i.id));

    console.log(`• YouTube videos total: ${ytItemsAll.length}`);
    console.log(`• Spotify tracks total: ${spItemsAll.length}`);
    console.log(`• Limiting to last ${effectiveRecent} YouTube additions → ${ytItems.length} to inspect`);

    const plan = [];
    for (const v of ytItems) {
      // Already mapped?
      const mappedSp = reverseMap.get(v.id);
      if (mappedSp) {
        if (spTrackSet.has(mappedSp)) {
          continue; // already present
        } else {
          plan.push({ v, action: 'add', spTrackId: mappedSp, reason: 'mapped-but-missing' });
          continue;
        }
      }

      // soft dupe check in Spotify playlist
      const softDup = findSoftDupeInSpotify(v, spItemsAll);
      if (softDup) {
        plan.push({ v, action: 'map-only', spTrackId: softDup.id, reason: 'soft-dup-in-playlist' });
        continue;
      }

      // search Spotify (K=5 → escalate 10)
      const { best, reason, inspected, escalated } =
        await findBestSpotifyForYouTubeVideo(sp, v, { slackSec: DEFAULT_DURATION_SLACK_SEC });

      if (!best) {
        plan.push({ v, action: 'skip', reason: reason || 'no_match', inspected, escalated });
        continue;
      }

      if (spTrackSet.has(best.id)) {
        plan.push({ v, action: 'map-only', spTrackId: best.id, inspected, escalated });
      } else {
        plan.push({ v, action: 'add', spTrackId: best.id, inspected, escalated });
      }
    }

    // Show plan
    if (plan.length) {
      for (const p of plan) {
        const label = p.escalated ? ' (escalated to 10)' : '';
        if (p.action === 'add') {
          console.log(`  + ADD  ${p.v.title}  →  spotify:track:${p.spTrackId}${label}`);
        } else if (p.action === 'map-only') {
          const why = p.reason ? ` [${p.reason}]` : '';
          console.log(`  = MAP  ${p.v.title}  ↔  spotify:track:${p.spTrackId}${why}${label}`);
        } else {
          console.log(`  ~ SKIP ${p.v.title}  (${p.reason})${label}`);
        }
      }
    } else {
      console.log('  (Nothing to do)');
    }

    // Apply — add **backwards** (oldest→newest)
    if (!dryRun) {
      const adds = plan.filter(p => p.action === 'add');
      const maps = plan.filter(p => p.action === 'map-only');

      // Add in reverse plan order to preserve final ordering
      for (const p of adds.slice().reverse()) {
        try {
          await addTracksToPlaylist(sp, spId, [p.spTrackId]);
          spTrackSet.add(p.spTrackId);
          cache.map[p.spTrackId] = p.v.id; // record mapping
          console.log(`  ✓ Added → spotify:track:${p.spTrackId}`);
        } catch (e) {
          console.warn(`  ! Failed to add ${p.v.title}: ${e.message}`);
        }
      }

      // Map-only
      for (const p of maps) {
        try {
          cache.map[p.spTrackId] = p.v.id;
          console.log('  ✓ Mapped only');
        } catch (e) {
          console.warn(`  ! Failed to map ${p.v.title}: ${e.message}`);
        }
      }

      // Update baseline: mark all current Spotify tracks as seen
      const seen = new Set(cache.seenTrackIds || []);
      const newSeen = Array.from(new Set([
        ...seen,
        ...spItemsAll.map(i => i.id),
        ...adds.map(p => p.spTrackId)
      ]));
      cache.seenTrackIds = newSeen;
      cache.lastSync = new Date().toISOString();
      saveCache(spId, cache);
      console.log('• Cache updated.');
    } else {
      console.log('• DRY-RUN: no changes applied. Run without --dry-run to sync.');
    }
  }
}

// ====================== MAIN ======================
(async () => {
  const dryRun = args.includes('--dry-run');
  let mode = parseModeFromArgs();
  if (!mode) {
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    mode = isInteractive ? await promptMenu() : MODES.SP2YT;
  }

  if (mode === MODES.SP2YT) {
    await runSp2Yt({ dryRun });
  } else if (mode === MODES.YT2SP) {
    await runYt2Sp({ dryRun });
  } else if (mode === MODES.BOTH) {
    // 1) Run SP→YT
    const { addedCount } = await runSp2Yt({ dryRun });
    // 2) Bump the YT→SP recent window by the number of *actual* additions
    const bumpedWindow = RECENT_YOUTUBE_LIMIT + (addedCount || 0);
    await runYt2Sp({ dryRun, recentLimitOverride: bumpedWindow });
  }

  console.log('\nDone.');
})().catch(e => {
  console.error(e);
  process.exit(1);
});