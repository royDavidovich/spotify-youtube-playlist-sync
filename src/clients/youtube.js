const { norm, normForVersionCheck, tokens, jaccardTitle, hasUsableTokens } = require('../util/text');

const isoDur = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;

function toMsFromISO8601(iso) {
  if (!iso) return undefined;
  const m = isoDur.exec(iso);
  const h = m?.[1] ? parseInt(m[1], 10) : 0;
  const min = m?.[2] ? parseInt(m[2], 10) : 0;
  const sec = m?.[3] ? parseInt(m[3], 10) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000;
}

// e.g. "Closer (feat. Halsey)" → "Closer"
function stripFeaturing(title) {
  return title
    .replace(/\s*[\(\[](feat|ft|featuring|with)\.?\s+[^\)\]]+[\)\]]/gi, '') // (feat. X) / [ft. X]
    .replace(/\s+(?:feat|ft|featuring)\.?\s+.+$/i, '')                       // trailing feat. X
    .trim();
}

function hasAllTitleTokens(spotifyTitle, ytTitle) {
  // Strip featuring info so "(feat. X)" doesn't become a required token.
  const need = new Set(tokens(stripFeaturing(spotifyTitle)));
  if (need.size === 0) return true;
  const have = new Set(tokens(ytTitle));
  for (const t of need) if (!have.has(t)) return false;
  return true;
}

function jaccardTitleLocal(a, b) {
  return jaccardTitle(a, b);
}

function isShortVideo(trackMs, candMs) {
  return trackMs && trackMs > 60000 && candMs && candMs < 60000;
}

const VARIANT_TOKENS = ['live','acoustic','remix','remaster','clean','explicit','radio edit'];
// Language-specific subtitle words (legendado, subtitulado, paroles…) are not listed here —
// they're caught structurally by the pipe check in violatesVersionRules instead.
const DISALLOWED_TOKENS = [
  'cover','karaoke','sped up','speed up','nightcore','slowed','8d','8d audio','loop','extended',
  'reaction','compilation','mix','full album','tribute','fanmade','edit','reverb','bass boosted',
];

const LYRICS_RE = /\blyrics?\b/;

// Word-boundary regexes prevent "mix" from false-matching inside "remix".
function makeWordBoundaryRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`);
}
const DISALLOWED_REGEXES = DISALLOWED_TOKENS.map(makeWordBoundaryRegex);

// trusted = artist's own channel / VEVO / Topic; relaxes pipe and lyric checks.
function violatesVersionRules(spotifyTitle, ytTitle, { trusted = false } = {}) {
  // Pipe in YT title = fan-made subtitle/translation video (structural signal, any language).
  if (!trusted && /\|/.test(ytTitle) && !/\|/.test(spotifyTitle)) return true;

  const st = normForVersionCheck(spotifyTitle);
  const yt = normForVersionCheck(ytTitle);

  const allowed = new Set();
  for (const v of VARIANT_TOKENS) if (st.includes(v)) allowed.add(v);
  for (const v of VARIANT_TOKENS) {
    if (yt.includes(v) && !allowed.has(v)) return true;
  }
  for (const re of DISALLOWED_REGEXES) {
    if (re.test(yt) && !re.test(st)) return true;
  }
  // Official lyric videos from the artist's channel are audio-identical to the Spotify track.
  if (!trusted && LYRICS_RE.test(yt) && !LYRICS_RE.test(st)) return true;

  return false;
}

function artistAlignment(primaryArtist, ytTitle, ytChannel) {
  const a = norm(primaryArtist);
  const t = norm(ytTitle);
  const c = norm(ytChannel);
  const inTitle = t.includes(a);
  const channelExact = c === a;
  const channelTopic = c === `${a} - topic`;
  const channelVevo = c.includes('vevo');
  const channelContainsArtist = c.includes(a);
  return inTitle || channelExact || channelTopic || channelVevo || channelContainsArtist;
}

function trustScore(primaryArtist, ytChannel) {
  const a = norm(primaryArtist);
  const c = norm(ytChannel);
  if (c === a) return 3.0;
  if (c === `${a} - topic`) return 2.6;
  if (c.includes('vevo')) return 2.6;
  if (c.includes(a)) return 2.2;
  return 1.0;
}

function contentTypeScore(ytTitle, ytChannel) {
  const t = norm(ytTitle);
  const c = norm(ytChannel);
  let s = 0;
  if (t.includes('official audio')) s += 0.4;
  if (c.endsWith(' - topic')) s += 0.4;
  if (t.includes('official video')) s += 0.2;
  return s;
}

function popularityScore(views, publishedAt) {
  const v = Math.log10((Number(views) || 0) + 1);
  let s = v / 8;
  if (publishedAt) {
    const days = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
    if (days < 30) s *= 0.5;
  }
  return s;
}

function durationCloseness(trackMs, candMs, slackSec) {
  if (!trackMs || !candMs) return 0;
  const slack = (slackSec || 7) * 1000;
  const delta = Math.abs(trackMs - candMs);
  if (delta > slack) return 0;
  return 1 - (delta / slack);
}

function categoryBonus(categoryId) {
  return categoryId === '10' ? 0.3 : 0.0;
}

function filterReason(spItem, cand, slackSec) {
  if (durationCloseness(spItem.durationMs, cand.durationMs, slackSec) === 0) return 'duration_out_of_range';
  if (isShortVideo(spItem.durationMs, cand.durationMs)) return 'short_video';
  const primary = spItem.artists?.[0] || '';
  const trusted = trustScore(primary, cand.channelTitle) >= 2.2; // artist channel / VEVO / Topic
  if (violatesVersionRules(spItem.title, cand.title, { trusted })) return 'version_mismatch';
  if (!artistAlignment(primary, cand.title, cand.channelTitle)) return 'artist_not_aligned';
  if (!hasAllTitleTokens(spItem.title, cand.title)) return 'missing_title_tokens';
  return null;
}

function passesHardFilters(spItem, cand, slackSec) {
  return filterReason(spItem, cand, slackSec) === null;
}

function scoreCandidate(spItem, cand, slackSec) {
  const primary = spItem.artists?.[0] || '';
  const sTrust = trustScore(primary, cand.channelTitle);
  const sTitle = jaccardTitleLocal(spItem.title, cand.title);
  const sArtist = artistAlignment(primary, cand.title, cand.channelTitle) ? 1 : 0;
  const sDur = durationCloseness(spItem.durationMs, cand.durationMs, slackSec);
  const sType = contentTypeScore(cand.title, cand.channelTitle);
  const sPop = popularityScore(cand.viewCount, cand.publishedAt);
  const sCat = categoryBonus(cand.categoryId);
  const ytHasLyrics = LYRICS_RE.test((cand.title || '').toLowerCase());
  const spHasLyrics = LYRICS_RE.test((spItem.title || '').toLowerCase());
  const sLyrics = (ytHasLyrics && !spHasLyrics) ? -0.5 : 0; // penalise lyric videos that slipped past the hard filter
  return (sTrust * 2.0) + (sTitle * 1.6) + (sArtist * 1.0) + (sDur * 1.4) + (sType * 0.6) + (sPop * 0.4) + sCat + sLyrics;
}

async function getYouTubePlaylistItems(youtube, playlistId) {
  let items = [];
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ['snippet','contentDetails'],
      playlistId,
      maxResults: 50,
      pageToken
    });
    items = items.concat(res.data.items || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const ids = items.map(i => i.contentDetails?.videoId).filter(Boolean);
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i+50));

  const byId = new Map();
  for (const b of batches) {
    const r = await youtube.videos.list({ id: b, part: ['contentDetails','snippet','statistics'] });
    (r.data.items || []).forEach(v => byId.set(v.id, v));
  }

  const canon = [];
  for (const it of items) {
    const v = byId.get(it.contentDetails?.videoId);
    if (!v) continue;
    canon.push({
      id: v.id,
      title: v.snippet?.title,
      channelTitle: v.snippet?.channelTitle,
      durationMs: toMsFromISO8601(v.contentDetails?.duration),
      addedAt: it.snippet?.publishedAt
    });
  }
  return canon;
}

async function findBestYouTubeForSpotifyTrack(youtube, spItem, { slackSec = 7, verbose = false, log = console.log } = {}) {
  const primaryArtist = spItem.artists?.[0] || '';
  const coreTitle = stripFeaturing(spItem.title);
  const q = `${primaryArtist} ${coreTitle}`.trim();

  if (!hasUsableTokens(q)) {
    if (verbose) log(`    SP→YT guard: unintelligible_query → skip for "${spItem.title}"`);
    return { best: null, reason: 'unintelligible_query', inspected: 0, escalated: false };
  }

  // Two queries: base + "official"-biased. Each returns a different result set from YouTube.
  const q2 = `${q} official`.trim();

  if (verbose) {
    log(`    SP→YT debug:`);
    log(`      track="${spItem.title}"  artist="${primaryArtist}"`);
    log(`      queries: "${q}" | "${q2}"`);
  }

  const seenIds = new Set();
  const order = [];
  for (const query of [q, q2]) {
    const search = await youtube.search.list({
      part: ['snippet'],
      q: query,
      type: ['video'],
      maxResults: 10
    });
    const ids = (search.data.items || []).map(x => x.id?.videoId).filter(Boolean);
    for (const id of ids) {
      if (!seenIds.has(id)) { seenIds.add(id); order.push(id); }
    }
  }
  if (!order.length) return { best: null, reason: 'no_search_results', inspected: 0, escalated: false };

  const details = await youtube.videos.list({
    id: order,
    part: ['contentDetails','snippet','statistics']
  });
  const infosById = new Map();
  (details.data.items || []).forEach(v => infosById.set(v.id, v));

  const toCandidate = (v) => ({
    id: v.id,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    channelTitle: v.snippet?.channelTitle || '',
    categoryId: v.snippet?.categoryId || '',
    durationMs: toMsFromISO8601(v.contentDetails?.duration),
    viewCount: v.statistics?.viewCount ? Number(v.statistics.viewCount) : 0,
    publishedAt: v.snippet?.publishedAt
  });

  const all = order.map(id => infosById.get(id)).filter(Boolean).map(toCandidate);
  if (verbose) log(`      results fetched: ${all.length}`);

  let pool = all.slice(0, 5).filter(c => passesHardFilters(spItem, c, slackSec));
  let escalated = false;
  if (pool.length === 0) {
    pool = all.slice(0, 15).filter(c => passesHardFilters(spItem, c, slackSec));
    escalated = true;
  }

  if (verbose) {
    const inspected = escalated ? all.slice(0, 15) : all.slice(0, 5);
    for (const c of inspected) {
      const reason = filterReason(spItem, c, slackSec);
      if (reason) {
        const durDelta = Math.abs((c.durationMs || 0) - (spItem.durationMs || 0));
        log(`      ✗ "${c.title}" channel="${c.channelTitle}"  Δms=${durDelta}  ← ${reason}`);
      }
    }
    log(`      filtered pool: ${pool.length}${escalated ? ' (escalated to 15)' : ''}`);
  }

  if (pool.length === 0) {
    return { best: null, reason: 'no_candidate_passed_filters', inspected: escalated ? Math.min(15, all.length) : Math.min(5, all.length), escalated };
  }

  const scored = pool
    .map(c => ({ c, s: scoreCandidate(spItem, c, slackSec) }))
    .sort((a, b) => b.s - a.s);

  if (verbose) {
    for (const { c, s } of scored.slice(0, 3)) {
      const durDelta = Math.abs((c.durationMs || 0) - (spItem.durationMs || 0));
      log(`      → cand: "${c.title}" channel="${c.channelTitle}"  Δms=${durDelta}  score=${s.toFixed(2)}`);
    }
  }

  const best = scored[0]?.c || null;
  const bestScore = scored[0]?.s ?? -Infinity;
  return { best, reason: best ? 'ok' : 'no_best', inspected: escalated ? Math.min(15, all.length) : Math.min(5, all.length), escalated, score: bestScore };
}

function relaxedDurationOk(trackMs, candMs) {
  if (!trackMs || !candMs) return false;
  const slackMs = Math.max(12000, Math.floor(0.04 * trackMs)); // max(12s, 4% of track)
  return Math.abs(trackMs - candMs) <= slackMs;
}

function softArtistAlign(primaryArtist, ytTitle, ytChannel) {
  const a = norm(primaryArtist);
  const t = norm(ytTitle);
  const c = norm(ytChannel);
  return t.includes(a) || c.includes(a);
}

function findSoftDupeInPlaylist(spItem, ytPlaylistItems, { jaccardMin = 0.45 } = {}) {
  const primary = spItem.artists?.[0] || '';
  const spTitle = spItem.title || '';
  if (!hasUsableTokens(primary, spTitle)) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const v of ytPlaylistItems) {
    if (!relaxedDurationOk(spItem.durationMs, v.durationMs)) continue;
    if (!softArtistAlign(primary, v.title, v.channelTitle)) continue;
    const titleSim = jaccardTitleLocal(spTitle, v.title);
    if (titleSim < jaccardMin) continue;
    const score = trustScore(primary, v.channelTitle) * 2 + titleSim;
    if (score > bestScore) { best = v; bestScore = score; }
  }
  return best;
}

async function insertIntoPlaylist(youtube, playlistId, videoId) {
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId }
      }
    }
  });
}

module.exports = {
  getYouTubePlaylistItems,
  findBestYouTubeForSpotifyTrack,
  insertIntoPlaylist,
  findSoftDupeInPlaylist,
  toMsFromISO8601
};
