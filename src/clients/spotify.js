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

// Extract a reliable artist name from the channel, when possible
function extractArtistFromChannel(channelTitle) {
  const t = channelTitle || '';
  const m = t.match(/^(.*)\s+-\s+topic$/i); // "Artist - Topic"
  if (m) return m[1].trim();
  if (/\bvevo\b/i.test(t)) return t.replace(/\bvevo\b/ig, '').trim(); // "Artist VEVO"
  return null;
}

function hasArtistMarkers(s) {
  const x = norm(s);
  return /(?:\s|^)(?:feat|ft|with|con|x|y)(?:\s|$)/i.test(x) || x.includes('&') || x.includes(',');
}

// Decide orientation for titles that contain a dash/en-dash
// Returns { titleCore, artistSide, orientation }
function smartSplitArtistTitle(ytTitle, channelTitle) {
  const raw = ytTitle || '';
  const parts = raw.split(/[–—-]{1,3}/); // -, – or —
  if (parts.length < 2) return { titleCore: raw.trim(), artistSide: null, orientation: 'none' };

  const left  = parts[0].trim();
  const right = raw.slice(parts[0].length + 1).trim(); // keep everything after first dash

  const channelArtist = extractArtistFromChannel(channelTitle || '');
  const chanTokens = channelArtist ? new Set(tokens(channelArtist)) : null;
  const leftTokens  = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  const overlapLeft  = chanTokens ? [...chanTokens].some(t => leftTokens.has(t))  : false;
  const overlapRight = chanTokens ? [...chanTokens].some(t => rightTokens.has(t)) : false;

  // 1) Channel overlap wins
  if (overlapLeft && !overlapRight)  return { titleCore: right, artistSide: left,  orientation: 'left-artist' };
  if (overlapRight && !overlapLeft)  return { titleCore: left,  artistSide: right, orientation: 'right-artist' };

  // 2) Artist markers (feat/&/x/with/y/con) decide
  const leftLooksArtist  = hasArtistMarkers(left);
  const rightLooksArtist = hasArtistMarkers(right);
  if (leftLooksArtist && !rightLooksArtist)  return { titleCore: right, artistSide: left,  orientation: 'left-artist' };
  if (rightLooksArtist && !leftLooksArtist)  return { titleCore: left,  artistSide: right, orientation: 'right-artist' };

  // 3) Heuristic: the side with fewer tokens is often the artist
  if (leftTokens.size < rightTokens.size)  return { titleCore: right, artistSide: left,  orientation: 'left-artist' };
  if (rightTokens.size < leftTokens.size)  return { titleCore: left,  artistSide: right, orientation: 'right-artist' };

  // 4) Fallback: assume artist-first (common case on YT)
  return { titleCore: right, artistSide: left, orientation: 'left-artist' };
}

// Only trust artist when clearly from channel (Topic/VEVO). Title-derived guess is NOT trusted.
function deriveArtistGuess(ytTitle, channelTitle) {
  const ch = extractArtistFromChannel(channelTitle || '');
  if (ch && !/^various artists$/i.test(ch)) {
    return { artistGuess: ch, trusted: true };
  }
  const split = smartSplitArtistTitle(ytTitle || '', channelTitle || '');
  if (split.artistSide) return { artistGuess: split.artistSide, trusted: false };
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
  if (!t.length) return new Set([norm(name)]); // e.g., "U2"
  return new Set(t);
}

function artistAligned(artistGuess, spTrack) {
  if (!artistGuess) return true; // if unknown/untrusted, don't block
  const guessSet = artistTokenSet(artistGuess);
  for (const a of (spTrack.artists || [])) {
    const aSet = artistTokenSet(a.name || a);
    for (const tok of guessSet) {
      if (aSet.has(tok)) return true; // word-level overlap, not substring
    }
  }
  return false;
}

// Heuristic: detect Spotify results that look like "music video" entries
function isMusicVideoName(name) {
  const x = norm(name);
  return /\bmusic\s*video\b/.test(x) || /\bofficial\s*video\b/.test(x) || /\bvideo\s+edit\b/.test(x);
}

// Exact (order-insensitive) title token equality
function isExactTitleMatch(coreTitle, spName) {
  const A = new Set(tokens(coreTitle));
  const B = new Set(tokens(spName));
  if (!A.size || !B.size) return false;
  if (A.size !== B.size) return false;
  for (const t of A) if (!B.has(t)) return false;
  return true;
}

// ---------- Soft duplicate detection in Spotify playlist ----------
function findSoftDupeInSpotify(ytItem, spPlaylistItems, { verbose = false, log = console.log } = {}) {
  const { artistGuess, trusted } = deriveArtistGuess(ytItem.title || '', ytItem.channelTitle || '');
  let best = null, bestScore = -Infinity;

  for (const it of spPlaylistItems) {
    if (!relaxedDurationOk(it.durationMs, ytItem.durationMs)) continue;

    // If we trust the artist guess, require match for non-MV titles; allow MV titles through without artist gate
    const mvTitle = isMusicVideoName(it.title || '');
    const artistOK = trusted ? (mvTitle ? true : artistAligned(artistGuess, { artists: it.artists?.map(n => ({ name: n })) || [] })) : true;
    if (!artistOK) continue;

    const ytCore = smartSplitArtistTitle(ytItem.title || '', ytItem.channelTitle || '').titleCore || ytItem.title || '';
    const sim = jaccardTitle(ytCore, it.title || '');
    if (sim < 0.45) continue;

    const score = (artistOK ? 1 : 0) + sim + (mvTitle ? 0.05 : 0); // tiny nudge toward MV when ambiguous
    if (score > bestScore) { best = it; bestScore = score; }
  }

  if (verbose && best) {
    log(`      ↳ soft-dupe on Spotify: "${best.title}" by ${best.artists?.join(', ') || 'unknown'} (score≈${bestScore.toFixed(2)})`);
  }
  return best; // canonical sp item or null
}

// ---------- Main: find best Spotify track for a YT video ----------
async function findBestSpotifyForYouTubeVideo(sp, ytItem, { slackSec = 7, verbose = false, log = console.log } = {}) {
  const split = smartSplitArtistTitle(ytItem.title || '', ytItem.channelTitle || '');
  const titleCore = split.titleCore || (ytItem.title || '');
  const { artistGuess, trusted } = deriveArtistGuess(ytItem.title || '', ytItem.channelTitle || '');

  const queries = [];
  if (trusted && artistGuess) queries.push(`${artistGuess} ${titleCore}`);
  if (!trusted && split.artistSide) queries.push(`${split.artistSide} ${titleCore}`);
  queries.push(titleCore);

  if (verbose) {
    log(`    YT→SP debug:`);
    log(`      title="${ytItem.title}"  channel="${ytItem.channelTitle}"`);
    log(`      orientation=${split.orientation}  titleCore="${titleCore}"  artistSide="${split.artistSide || ''}"`);
    log(`      trustedArtist=${trusted ? 'yes' : 'no'}  artistGuess="${artistGuess || ''}"`);
    log(`      queries: ${queries.map(q => `"${q}"`).join(' | ')}`);
  }

  const seenIds = new Set();
  let candidates = [];

  // Aggregate up to 10 results per query
  for (const q of queries) {
    const res = await sp.searchTracks(q, { limit: 10 });
    const items = res.body.tracks?.items || [];
    for (const t of items) if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      candidates.push(t);
    }
  }

  if (verbose) log(`      candidates fetched: ${candidates.length}`);

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

    // Require version alignment (live/remix/acoustic/lyric/remaster)
    const sTokens = versionTokens(t.name || '');
    const versionMismatch =
      (ytTokens.hasLive && !sTokens.hasLive) ||
      (ytTokens.hasRemix && !sTokens.hasRemix) ||
      (ytTokens.hasAcoustic && !sTokens.hasAcoustic) ||
      (ytTokens.hasLyric && !sTokens.hasLyric) ||
      (ytTokens.hasRemaster && !sTokens.hasRemaster);
    if (versionMismatch) return false;

    // Enforce artist alignment ONLY when we trust the guess AND the candidate is NOT an MV
    if (trusted && !isMusicVideoName(t.name || '') && !artistAligned(artistGuess, t)) return false;

    // Title token coverage (YT core tokens should appear in Spotify name)
    if (!titleCoverageOk(titleCore, t.name || '')) return false;

    return true;
  };

  function score(t) {
    const mv = isMusicVideoName(t.name || '');
    const sTitle = jaccardTitle(titleCore, t.name || '');
    const sDur = 1 - (Math.abs((t.duration_ms || 0) - (ytItem.durationMs || 0)) / (slackSec * 1000));
    const sArtist = (trusted && !mv && artistAligned(artistGuess, t)) ? 1 : 0;
    const sPop = (t.popularity || 0) / 100;
    const sMV = mv ? 0.3 : 0.0; // prefer MV unless an exact non-MV exists (handled below)
    return (sTitle * 1.6) + (sDur * 1.6) + (sArtist * 1.0) + (sPop * 0.6) + sMV;
  }

  let pool = all.slice(0, 5).filter(hardFilter);
  let escalated = false;
  if (pool.length === 0) {
    pool = all.slice(0, 10).filter(hardFilter);
    escalated = true;
  }
  if (verbose) log(`      filtered pool: ${pool.length}${escalated ? ' (escalated to 10)' : ''}`);
  if (pool.length === 0) {
    return {
      best: null,
      reason: 'no_candidate_passed_filters',
      inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length),
      escalated
    };
  }

  // If there is an exact title match that is NOT an MV, prefer it outright.
  const exactNonMV = pool.filter(t => isExactTitleMatch(titleCore, t.name || '') && !isMusicVideoName(t.name || ''));
  if (exactNonMV.length) {
    // tie-break within these by duration closeness + popularity
    let chosen = null, bestTie = -Infinity;
    for (const t of exactNonMV) {
      const tie = (1 - (Math.abs((t.duration_ms || 0) - (ytItem.durationMs || 0)) / (slackSec * 1000))) + ((t.popularity || 0) / 200);
      if (tie > bestTie) { bestTie = tie; chosen = t; }
    }
    if (verbose) log(`      exact non-MV title match chosen: "${chosen.name}" by ${chosen.artists.map(a=>a.name).join(', ')} (score≈${bestTie.toFixed(2)})`);
    return {
      best: chosen,
      reason: 'ok',
      inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length),
      escalated,
      score: bestTie
    };
  }

  // Otherwise, score and show top-3 for visibility
  const scored = pool.map(t => ({ t, sc: score(t) }))
                     .sort((a, b) => b.sc - a.sc);
  if (verbose) {
    for (const { t, sc } of scored.slice(0, 3)) {
      const mv = isMusicVideoName(t.name || '');
      const durDelta = Math.abs((t.duration_ms || 0) - (ytItem.durationMs || 0));
      log(`      → cand: "${t.name}" by ${t.artists.map(a=>a.name).join(', ')}  mv=${mv ? 'yes' : 'no'}  Δms=${durDelta}  score=${sc.toFixed(2)}`);
    }
  }

  const best = scored[0]?.t || null;
  return {
    best,
    reason: best ? 'ok' : 'no_best',
    inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length),
    escalated,
    score: scored[0]?.sc
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