const { norm, tokens, jaccardTitle } = require('../util/text');

// Canonicalize a Spotify playlist item you already had:
function canonicalFromPlaylistItem(it) {
  const t = it.track;
  if (!t) return null;
  return {
    id: t.id,
    title: t.name,
    artists: (t.artists || []).map(a => a.name),
    album: t.album?.name,
    durationMs: t.duration_ms,
    addedAt: it.added_at
  };
}

async function getAllPlaylistItems(sp, playlistId) {
  let items = [];
  let offset = 0;
  while (true) {
    const res = await sp.getPlaylistTracks(playlistId, { limit: 100, offset });
    items = items.concat(res.body.items || []);
    offset += res.body.items?.length || 0;
    if (!res.body.next) break;
  }
  return items.map(canonicalFromPlaylistItem).filter(Boolean);
}

// ---------- Helpers for YT → SP ----------
function relaxedDurationOk(trackMs, candMs) {
  if (!trackMs || !candMs) return false;
  const slackMs = Math.max(12000, Math.floor(0.04 * trackMs)); // max(12s, 4%)
  return Math.abs(trackMs - candMs) <= slackMs;
}

function durationClose(trackMs, candMs, slackSec = 7) {
  if (!trackMs || !candMs) return false;
  const slack = slackSec * 1000;
  return Math.abs(trackMs - candMs) <= slack;
}

// Pull a best-guess artist/title from a YouTube video
function extractArtistFromChannel(channelTitle) {
  const t = channelTitle || '';
  const m = t.match(/^(.*)\s+-\s+topic$/i);
  if (m) return m[1].trim();
  const n = t.replace(/\bvevo\b/i, '').trim();
  return n || null;
}
function splitArtistTitleFromVideo(ytTitle) {
  const m = (ytTitle || '').match(/^(.*?)[\s–-]{1,3}(.*)$/); // dash/en dash
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: null, title: ytTitle || '' };
}

function versionTokens(s) {
  const x = norm(s);
  return {
    hasLive: /\blive\b/.test(x),
    hasRemix: /\bremix\b/.test(x),
    hasAcoustic: /\bacoustic\b/.test(x),
    hasLyric: /\blyric(s)?\b/.test(x),
    hasRemaster: /\bremaster(ed)?\b/.test(x)
  };
}

function artistAligned(artistGuess, spTrack) {
  if (!artistGuess) return true; // if unknown, don't block
  const a = norm(artistGuess);
  const names = (spTrack.artists || []).map(x => norm(x.name || x));
  return names.some(n => n.includes(a) || a.includes(n));
}

function titleCoverageOk(ytCoreTitle, spName) {
  const need = new Set(tokens(ytCoreTitle));
  const have = new Set(tokens(spName));
  for (const t of need) if (!have.has(t)) return false;
  return true;
}

// Soft duplicate detection against an existing Spotify playlist (looser than hard filters)
function findSoftDupeInSpotify(ytItem, spPlaylistItems) {
  const { artist: tArtist, title: tTitle } = splitArtistTitleFromVideo(ytItem.title || '');
  const artistGuess = tArtist || extractArtistFromChannel(ytItem.channelTitle || '');
  let best = null, bestScore = -Infinity;

  for (const it of spPlaylistItems) {
    if (!relaxedDurationOk(it.durationMs, ytItem.durationMs)) continue;
    const artistOK = artistAligned(artistGuess, { artists: it.artists?.map(n => ({ name: n })) || [] });
    if (!artistOK) continue;
    const sim = jaccardTitle(tTitle || ytItem.title || '', it.title || '');
    if (sim < 0.45) continue;
    const score = (artistOK ? 1 : 0) + sim;
    if (score > bestScore) { best = it; bestScore = score; }
  }
  return best; // canonical sp item or null
}

// Find the best Spotify track for a given YouTube video (K=5, escalate→10)
// Mirrors the spirit of your YT side ranking (duration/artist/title/popularity).
async function findBestSpotifyForYouTubeVideo(sp, ytItem, { slackSec = 7 } = {}) {
  const { artist: titleArtist, title: titleCore } = splitArtistTitleFromVideo(ytItem.title || '');
  const channelArtist = extractArtistFromChannel(ytItem.channelTitle || '');
  const artistGuess = titleArtist || channelArtist;
  const coreTitle = titleCore || ytItem.title || '';

  const queries = [];
  if (artistGuess) queries.push(`${artistGuess} ${coreTitle}`);
  queries.push(coreTitle);

  const seenIds = new Set();
  let candidates = [];

  for (const q of queries) {
    const res = await sp.searchTracks(q, { limit: 10 });
    const items = res.body.tracks?.items || [];
    for (const t of items) if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      candidates.push(t);
    }
  }

  if (!candidates.length) return { best: null, reason: 'no_spotify_results', inspected: 0, escalated: false };

  function candToObj(t) {
    return {
      id: t.id,
      name: t.name,
      artists: t.artists,             // array of { name }
      duration_ms: t.duration_ms,
      popularity: t.popularity || 0,
      explicit: t.explicit
    };
  }
  const all = candidates.map(candToObj);

  const ytTokens = versionTokens(ytItem.title || '');
  const hardFilter = (t) => {
    if (!durationClose(ytItem.durationMs, t.duration_ms, slackSec)) return false;

    const sTokens = versionTokens(t.name || '');
    const versionMismatch =
      (ytTokens.hasLive && !sTokens.hasLive) ||
      (ytTokens.hasRemix && !sTokens.hasRemix) ||
      (ytTokens.hasAcoustic && !sTokens.hasAcoustic) ||
      (ytTokens.hasLyric && !sTokens.hasLyric) ||
      (ytTokens.hasRemaster && !sTokens.hasRemaster);
    if (versionMismatch) return false;

    if (!artistAligned(artistGuess, t)) return false;

    if (!titleCoverageOk(coreTitle, t.name || '')) return false;

    return true;
  };

  function score(t) {
    const sTitle = jaccardTitle(coreTitle, t.name || '');
    const sDur = 1 - (Math.abs((t.duration_ms || 0) - (ytItem.durationMs || 0)) / (slackSec * 1000));
    const sArtist = artistAligned(artistGuess, t) ? 1 : 0;
    const sPop = (t.popularity || 0) / 100;
    return (sTitle * 1.6) + (sDur * 1.2) + (sArtist * 1.0) + (sPop * 0.6);
  }

  let pool = all.slice(0, 5).filter(hardFilter);
  let escalated = false;
  if (pool.length === 0) {
    pool = all.slice(0, 10).filter(hardFilter);
    escalated = true;
  }
  if (pool.length === 0) {
    return { best: null, reason: 'no_candidate_passed_filters', inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length), escalated };
  }

  let best = null, bestScore = -Infinity;
  for (const t of pool) {
    const sc = score(t);
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return { best, reason: 'ok', inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length), escalated, score: bestScore };
}

// Convenience: add plain track IDs to a playlist
async function addTracksToPlaylist(sp, playlistId, trackIds) {
  if (!trackIds || trackIds.length === 0) return;
  const uris = trackIds.map(id => `spotify:track:${id}`);
  await sp.addTracksToPlaylist(playlistId, uris);
}

module.exports = {
  getAllPlaylistItems,
  // YT→SP exports:
  findSoftDupeInSpotify,
  findBestSpotifyForYouTubeVideo,
  addTracksToPlaylist
};
