// src/index.js
// Main one-shot sync: Spotify -> YouTube.
//
// Flags:
//   --dry-run            : plan only, no writes
//
// Behavior:
// - Inspects only the most-recent L Spotify additions (default L=10).
// - Pre-add soft-duplicate check against existing YT playlist (looser rules).
// - Strict 1→1: at most one add per Spotify track; map-only if an equivalent is already present.
// - Candidate search inspects top K=5; if none pass hard filters, escalates once to K=10 and logs.

require('dotenv').config();

const CONFIG = require('../config.json');
const { getSpotify } = require('./auth/spotifyAuth');
const { getYouTube } = require('./auth/youtubeAuth');
const { getAllPlaylistItems } = require('./clients/spotify');
const {
    getYouTubePlaylistItems,
    findBestYouTubeForSpotifyTrack,
    insertIntoPlaylist,
    findSoftDupeInPlaylist
} = require('./clients/youtube');
const { loadCache, saveCache } = require('./util/cache');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const DEFAULT_DURATION_SLACK_SEC = 7;   // allow this much shorter/longer match
const RECENT_SPOTIFY_LIMIT = 10;        // only consider last L additions each run

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

(async () => {
    const [sp, yt] = await Promise.all([getSpotify(), getYouTube()]);

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
            // If already mapped to a present video, nothing to do
            const mapped = cache.map[s.id];
            if (mapped && ytVideoSet.has(mapped)) continue;

            // NEW: pre-add soft duplicate check in existing playlist (looser rules)
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
                        console.log('  ✓ Mapped only');
                    }
                } catch (e) {
                    console.warn(`  ! Failed for ${p.s.title}: ${e.message}`);
                }
            }

            // Update baseline so backlog stays ignored
            const newSeen = Array.from(new Set([...seen, ...spItemsAll.map(i => i.id)]));
            cache.seenTrackIds = newSeen;
            cache.lastSync = new Date().toISOString();
            saveCache(spId, cache);
            console.log('• Cache updated.');
        } else {
            console.log('• DRY-RUN: no changes applied. Run without --dry-run to sync.');
        }
    }

    console.log('\nDone.');
})().catch(e => {
    console.error(e);
    process.exit(1);
});