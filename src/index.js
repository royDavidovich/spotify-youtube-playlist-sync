// Main one-shot sync: Spotify -> YouTube.
// Flags:
//   --dry-run            : plan only, no writes
//   --duration-slack=7  : match window in seconds
//
// Behavior:
// - On first run (no cache): sync everything missing on YouTube.
// - On later runs: only process truly "new" Spotify tracks (added since lastSync or unseen IDs).
// - Maintains mapping (Spotify track ID -> YouTube video ID) for idempotency.

require('dotenv').config();
const CONFIG = require('../config.json');
const SpotifyWebApi = require('spotify-web-api-node');
const { getSpotify } = require('./auth/spotifyAuth');
const { getYouTube } = require('./auth/youtubeAuth');
const { getAllPlaylistItems } = require('./clients/spotify');
const { getYouTubePlaylistItems, searchYouTubeBest, insertIntoPlaylist } = require('./clients/youtube');
const { loadCache, saveCache } = require('./util/cache');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const durArg = args.find(x => x.startsWith('--duration-slack='));
const durationSlackSec = durArg ? parseInt(durArg.split('=')[1], 10) : 7;   //if no slac arg, default slac 7 sec

function isAfter(aIso, bIso) {
  if (!aIso) return false;
  if (!bIso) return true;
  return new Date(aIso) > new Date(bIso);
}

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(official.+?\)|\s*\[official.+?\]/g, '')
    .replace(/official video|lyrics?|audio|mv|hd|4k|remaster(ed)?/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

  for (const pair of CONFIG.pairs) {
    const spId = pair.spotifyPlaylistId;
    const ytId = pair.youtubePlaylistId;
    if (!spId || !ytId || spId === 'SPOTIFY_PLAYLIST_ID' || ytId === 'YOUTUBE_PLAYLIST_ID') {
      console.log('⚠️  Set real playlist IDs in config.json'); continue;
    }

    console.log(`\n🎯 Syncing Spotify (${spId}) → YouTube (${ytId}) ${dryRun ? '[DRY-RUN]' : ''}`);

    // Load caches and current states
    const cache = loadCache(spId);                 // { lastSync, seenTrackIds[], map{} }
    const seen = new Set(cache.seenTrackIds || []);

    const [spItems, ytItems] = await Promise.all([
      getAllPlaylistItems(sp, spId),
      getYouTubePlaylistItems(yt, ytId)
    ]);

    const ytVideoSet = new Set(ytItems.map(v => v.id));

    // Determine which Spotify tracks to process now:
    // - First run: all tracks not already mapped to a video that exists in target.
    // - Later: tracks added since lastSync OR not seen before OR mapped-to video missing in YouTube.
    const candidates = [];
    for (const it of spItems) {
      const mapped = cache.map[it.id];
      const addedRecently = isAfter(it.addedAt, cache.lastSync);
      const unseen = !seen.has(it.id);
      const mappedButMissing = mapped && !ytVideoSet.has(mapped);
      const firstRun = !cache.lastSync;

      if (
        (firstRun && (!mapped || !ytVideoSet.has(mapped))) ||
        addedRecently || unseen || mappedButMissing
      ) {
        candidates.push(it);
      }
    }

    console.log(`• Spotify tracks total: ${spItems.length}`);
    console.log(`• YouTube videos total: ${ytItems.length}`);
    console.log(`• Candidates to process: ${candidates.length}`);

    // Plan actions
    const plan = [];
    for (const s of candidates) {
      const mapped = cache.map[s.id];
      if (mapped && ytVideoSet.has(mapped)) {
        // Already present by mapping
        continue;
      }
      // Search best YouTube candidate
      const q = `${s.artists?.[0] || ''} ${s.title}`.trim();
      const best = await searchYouTubeBest(yt, q, s.durationMs, durationSlackSec);
      if (!best) {
        plan.push({ s, action: 'skip', reason: 'no_youtube_match' });
        continue;
      }
      if (ytVideoSet.has(best.id)) {
        // Already there but mapping missing → record mapping only
        plan.push({ s, action: 'map-only', videoId: best.id });
      } else {
        plan.push({ s, action: 'add', videoId: best.id, candidateTitle: best.title });
      }
    }

    // Show plan
    for (const p of plan) {
      if (p.action === 'add') {
        console.log(`  + ADD  ${p.s.artists[0] || ''} - ${p.s.title}  →  ${p.videoId}`);
      } else if (p.action === 'map-only') {
        console.log(`  = MAP  ${p.s.artists[0] || ''} - ${p.s.title}  ↔  ${p.videoId} (already present)`);
      } else {
        console.log(`  ~ SKIP ${p.s.artists[0] || ''} - ${p.s.title}  (${p.reason})`);
      }
    }
    if (!plan.length) console.log('  (Nothing to do)');

    // Apply
    if (!dryRun) {
      for (const p of plan) {
        try {
          if (p.action === 'add') {
            await insertIntoPlaylist(yt, ytId, p.videoId);
            ytVideoSet.add(p.videoId);
            cache.map[p.s.id] = p.videoId;
            console.log(`  ✓ Added → ${p.videoId}`);
          } else if (p.action === 'map-only') {
            cache.map[p.s.id] = p.videoId;
            console.log(`  ✓ Mapped only`);
          }
        } catch (e) {
          console.warn(`  ! Failed for ${p.s.title}: ${e.message}`);
        }
      }
      // Update baseline
      const newSeen = Array.from(new Set([...seen, ...spItems.map(i => i.id)]));
      cache.seenTrackIds = newSeen;
      cache.lastSync = new Date().toISOString();
      saveCache(spId, cache);
      console.log('• Cache updated.');
    } else {
      console.log('• DRY-RUN: no changes applied. Use without --dry-run to sync.');
    }
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
