// YouTube helpers: fetch existing playlist, search candidates, filters + scoring + soft-dupe check.
const { norm, tokens, jaccardTitle } = require('../util/text');

const isoDur = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;

function toMsFromISO8601(iso) {
    if (!iso) return undefined;
    const m = isoDur.exec(iso);
    const h = m?.[1] ? parseInt(m[1], 10) : 0;
    const min = m?.[2] ? parseInt(m[2], 10) : 0;
    const sec = m?.[3] ? parseInt(m[3], 10) : 0;
    return ((h * 60 + min) * 60 + sec) * 1000;
}

function hasAllTitleTokens(spotifyTitle, ytTitle) {
    const need = new Set(tokens(spotifyTitle));
    if (need.size === 0) return true;
    const have = new Set(tokens(ytTitle));
    for (const t of need) if (!have.has(t)) return false;
    return true;
}


function isShortVideo(trackMs, candMs) {
    return trackMs && trackMs > 60000 && candMs && candMs < 60000;
}

const VARIANT_TOKENS = ['live', 'acoustic', 'remix', 'remaster', 'clean', 'explicit', 'radio edit'];
const DISALLOWED_TOKENS = [
    'cover', 'karaoke', 'sped up', 'speed up', 'nightcore', 'slowed', '8d', '8d audio', 'loop', 'extended',
    'reaction', 'compilation', 'mix', 'full album', 'tribute', 'fanmade', 'edit', 'reverb', 'bass boosted'
];

function violatesVersionRules(spotifyTitle, ytTitle, ytDesc) {
    const st = norm(spotifyTitle);
    const yt = `${norm(ytTitle)} ${norm(ytDesc)}`;

    const allowed = new Set();
    for (const v of VARIANT_TOKENS) if (st.includes(v)) allowed.add(v);

    for (const v of VARIANT_TOKENS) {
        if (yt.includes(v) && !allowed.has(v)) return true;
    }
    for (const d of DISALLOWED_TOKENS) {
        if (yt.includes(d) && !st.includes(d)) return true;
    }
    if (yt.includes('lyric') && !st.includes('lyric')) return true;

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

function passesHardFilters(spItem, cand, slackSec) {
    if (durationCloseness(spItem.durationMs, cand.durationMs, slackSec) === 0) return false;
    if (isShortVideo(spItem.durationMs, cand.durationMs)) return false;
    if (violatesVersionRules(spItem.title, cand.title, cand.description || '')) return false;
    const primary = spItem.artists?.[0] || '';
    if (!artistAlignment(primary, cand.title, cand.channelTitle)) return false;
    if (!hasAllTitleTokens(spItem.title, cand.title)) return false;
    return true;
}

function scoreCandidate(spItem, cand, slackSec) {
    const primary = spItem.artists?.[0] || '';
    const sTrust = trustScore(primary, cand.channelTitle);
    const sTitle = jaccardTitle(spItem.title, cand.title);
    const sArtist = artistAlignment(primary, cand.title, cand.channelTitle) ? 1 : 0;
    const sDur = durationCloseness(spItem.durationMs, cand.durationMs, slackSec);
    const sType = contentTypeScore(cand.title, cand.channelTitle);
    const sPop = popularityScore(cand.viewCount, cand.publishedAt);
    const sCat = categoryBonus(cand.categoryId);
    return (sTrust * 2.0) + (sTitle * 1.6) + (sArtist * 1.0) + (sDur * 1.4) + (sType * 0.6) + (sPop * 0.4) + sCat;
}

async function getYouTubePlaylistItems(youtube, playlistId) {
    let items = [];
    let pageToken;
    do {
        const res = await youtube.playlistItems.list({
            part: ['snippet', 'contentDetails'],
            playlistId,
            maxResults: 50,
            pageToken
        });
        items = items.concat(res.data.items || []);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    const ids = items.map(i => i.contentDetails?.videoId).filter(Boolean);
    const batches = [];
    for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));

    const byId = new Map();
    for (const b of batches) {
        const r = await youtube.videos.list({ id: b, part: ['contentDetails', 'snippet', 'statistics'] });
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

async function findBestYouTubeForSpotifyTrack(youtube, spItem, { slackSec = 7 } = {}) {
    const primaryArtist = spItem.artists?.[0] || '';
    const q = `${primaryArtist} ${spItem.title}`.trim();

    const search = await youtube.search.list({
        part: ['snippet'],
        q,
        type: ['video'],
        maxResults: 10
    });
    const order = (search.data.items || []).map(x => x.id?.videoId).filter(Boolean);
    if (!order.length) return { best: null, reason: 'no_search_results', inspected: 0, escalated: false };

    const details = await youtube.videos.list({
        id: order,
        part: ['contentDetails', 'snippet', 'statistics']
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

    let pool = all.slice(0, 5).filter(c => passesHardFilters(spItem, c, slackSec));
    let escalated = false;
    if (pool.length === 0) {
        pool = all.slice(0, 10).filter(c => passesHardFilters(spItem, c, slackSec));
        escalated = true;
    }
    if (pool.length === 0) {
        return { best: null, reason: 'no_candidate_passed_filters', inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length), escalated };
    }

    let best = null, bestScore = -Infinity;
    for (const c of pool) {
        const s = scoreCandidate(spItem, c, slackSec);
        if (s > bestScore) { best = c; bestScore = s; }
    }
    return { best, reason: best ? 'ok' : 'no_best', inspected: escalated ? Math.min(10, all.length) : Math.min(5, all.length), escalated, score: bestScore };
}

// ---------- NEW: Soft duplicate detection in existing YT playlist ----------
function relaxedDurationOk(trackMs, candMs) {
    if (!trackMs || !candMs) return false;
    const slackMs = Math.max(12000, Math.floor(0.04 * trackMs)); // max(12s, 4% of track)
    return Math.abs(trackMs - candMs) <= slackMs;
}

function softArtistAlign(primaryArtist, ytTitle, ytChannel) {
    const a = norm(primaryArtist);
    const t = norm(ytTitle);
    const c = norm(ytChannel);
    return t.includes(a) || c.includes(a); // looser than hard filter
}

function findSoftDupeInPlaylist(spItem, ytPlaylistItems, { jaccardMin = 0.45 } = {}) {
    const primary = spItem.artists?.[0] || '';
    let best = null;
    let bestScore = -Infinity;

    for (const v of ytPlaylistItems) {
        // relaxed duration + loose artist + moderate title overlap
        if (!relaxedDurationOk(spItem.durationMs, v.durationMs)) continue;
        if (!softArtistAlign(primary, v.title, v.channelTitle)) continue;

        const titleSim = jaccardTitle(spItem.title, v.title);
        if (titleSim < jaccardMin) continue;

        // Choose the most trusted among matches
        const score = trustScore(primary, v.channelTitle) * 2 + titleSim;
        if (score > bestScore) { best = v; bestScore = score; }
    }
    return best; // { id, title, channelTitle, ... } or null
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