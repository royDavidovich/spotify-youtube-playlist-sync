// src/clients/spotify.js
const { norm, tokens, jaccardTitle } = require('../util/text');

// Canonicalize a Spotify playlist item (unchanged)
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

// ---------- Shared helpers for YT → SP ----------

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

function splitArtistTitleFromVideo(ytTitle) {
  const m = (ytTitle || '').match(/^(.*?)[\s–-]{1,3}(.*)$/); // dash or en-dash
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: null, title: ytTitle || '' };
}

// Only trust the channel when it's clearly an artist channel
function deriveArtistGuess(ytTitle, channelTitle) {
  const ch = channelTitle || '';
  // "Artist - Topic"
  const mTopic = ch.match(/^(.*)\s+-\s+topic$/i);
  if (mTopic) {
    const artist = mTopic[1].trim();
    if (artist && !/^various artists$/i.test(artist)) {
      return { artistGuess: artist, trusted: true };
    }
  }
  // VEVO channels (e.g., "ArtistVEVO" or "Artist VEVO")
  if (/\bvevo\b/i.test(ch)) {
    const artist = ch.replace(/\bvevo\b/ig, '').trim();
    if (artist) return { artistGuess: artist, trusted: true };
  }
  // Title of form "Artist - Title" is also a trusted source
  const { artist } = splitArtistTitleFromVideo(ytTitle || '');
  if (artist) return { artistGuess: artist, trusted: true };

  // Otherwise, don't trust the channel as artist
  return { artistGuess: null, trusted: false };
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

function titleCoverageOk(ytCoreTitle, spName) {
  const need = new Set(tokens(ytCoreTitle));
  const have = new Set(tokens(spName));
  for (const t of need) if (!have.has(t)) return false;
  return true;
}

function artistTokenSet(name) {
  const t = tokens(name);
  // If tokens end up empty (e.g., very short names like "U2"), fallback to whole normalized string
  if (!t.length) return new Set([norm(name)]);
  return new Set(t);
}

function artistAligned(artistGuess, spTrack) {
  if (!artistGuess) return true; // if unknown/untrusted, don't block
  const guessSet = artistTokenSet(artistGuess);
  for (const a of (spTrack.artists || [])) {
    const aSet = artistTokenSet(a.name || a);
    for (const tok of guessSet) {
      if (aSet.has(tok)) return true; // token overlap (word-level), not substring
    }
  }
  return false;
}

// ---------- Soft duplicate detection in Spotify playlist ----------
function findSoftDupeInSpotify(ytItem, spPlaylistItems) {
  const { artistGuess, trusted } = deriveArtistGuess(ytItem.title || '', ytItem.channelTitle || '');
  let best = null, bestScore = -Infinity;

  for (const it of spPlaylistItems) {
    if (!relaxedDurationOk(it.durationMs, ytItem.durationMs)) continue;
    // Only enforce artist alignment if we truly trust the guess
    const artistOK = trusted ? artistAligned(artistGuess, { artists: it.artists?.map(n => ({ name: n })) || [] }) : true;
    if (!artistOK) continue;

    const sim = jaccardTitle(splitArtistTitleFromVideo(ytItem.title || '').title || ytItem.title || '', it.title || '');
    if (sim < 0.45) continue;

    const score = (artistOK ? 1 : 0) + sim;
    if (score > bestScore) { best = it; bestScore = score; }
  }
  return best; // canonical sp item or null
}

// ---------- Main: find best Spotify track for a YT video ----------
async function findBestSpotifyForYouTubeVideo(sp, ytItem, { slackSec = 7 } = {}) {
  const { artist: titleArtist, title: titleCore } = splitArtistTitleFromVideo(ytItem.title || '');
  const { artistGuess, trusted } = deriveArtistGuess(ytItem.title || '', ytItem.channelTitle || '');
  const coreTitle = titleCore || ytItem.title || '';

  const queries = [];
  if (artistGuess) queries.push(`${artistGuess} ${coreTitle}`);
  queries.push(coreTitle);

  const seenIds = new Set();
  let candidates = [];

  // Aggregate up to 10 results per query (artist+title, then title-only)
  for (const q of queries) {
    const res = await sp.searchTracks(q, { limit: 10 });
    const items = res.body.tracks?.items || [];
    for (const t of items) if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      candidates.push(t);
    }
  }

  if (!candidates.length) {
    return { best: null, reason: 'no_spotify_results', inspected: 0, escalated: false };
  }

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

    // Require version alignment
    const sTokens = versionTokens(t.name || '');
    const versionMismatch =
      (ytTokens.hasLive && !sTokens.hasLive) ||
      (ytTokens.hasRemix && !sTokens.hasRemix) ||
      (ytTokens.hasAcoustic && !sTokens.hasAcoustic) ||
      (ytTokens.hasLyric && !sTokens.hasLyric) ||
      (ytTokens.hasRemaster && !sTokens.hasRemaster);
    if (versionMismatch) return false;

    // Only enforce artist match when the guess is trusted
    if (trusted && !artistAligned(artistGuess, t)) return false;

    // Title token coverage (YT core tokens should appear in Spotify name)
    if (!titleCoverageOk(coreTitle, t.name || '')) return false;

    return true;
  };

  function score(t) {
    const sTitle = jaccardTitle(coreTitle, t.name || '');
    const sDur = 1 - (Math.abs((t.duration_ms || 0) - (ytItem.durationMs || 0)) / (slackSec * 1000));
    const sArtist = (trusted && artistAligned(artistGuess, t)) ? 1 : 0;
    const sPop = (t.popularity || 0) / 100;
    return (sTitle * 1.6) + (sDur * 1.6) + (sArtist * 1.0) + (sPop * 0.6);
  }

  let pool = all.slice(0, 5).filter(hardFilter);
  let escalated = false;
  if (pool.length === 0) {
    pool = all.slice(0, 10).filter(hardFilter);
    escalated = true;
  }
  if (pool.length === 0) {
    return {
      best: null,
      reason: 'no_candidate_passed_filters',
      inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length),
      escalated
    };
  }

  let best = null, bestScore = -Infinity;
  for (const t of pool) {
    const sc = score(t);
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return {
    best,
    reason: best ? 'ok' : 'no_best',
    inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length),
    escalated,
    score: best ? bestScore : undefined
  };
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