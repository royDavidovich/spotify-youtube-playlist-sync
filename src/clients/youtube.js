// YouTube helpers: fetch existing playlist, search candidates, insert new video.
const isoDur = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;

function toMsFromISO8601(iso) {
  if (!iso) return undefined;
  const m = isoDur.exec(iso);
  const h = m?.[1] ? parseInt(m[1], 10) : 0;
  const min = m?.[2] ? parseInt(m[2], 10) : 0;
  const sec = m?.[3] ? parseInt(m[3], 10) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000;
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
    const r = await youtube.videos.list({ id: b, part: ['contentDetails','snippet'] });
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

async function searchYouTubeBest(youtube, q, durationMs, slackSec = 7) {
  const search = await youtube.search.list({
    part: ['snippet'],
    q,
    type: ['video'],
    maxResults: 8
  });
  const vids = (search.data.items || []).map(x => x.id.videoId).filter(Boolean);
  if (!vids.length) return null;

  const r = await youtube.videos.list({ id: vids, part: ['contentDetails','snippet'] });
  const items = (r.data.items || []).map(v => ({
    id: v.id,
    title: v.snippet?.title || '',
    channelTitle: v.snippet?.channelTitle || '',
    durationMs: toMsFromISO8601(v.contentDetails?.duration)
  }));

  // Prefer those within duration window; pick closest
  const slack = slackSec * 1000;
  let best = null, bestDelta = Infinity;
  for (const it of items) {
    if (!durationMs || !it.durationMs) continue;
    const d = Math.abs(it.durationMs - durationMs);
    if (d <= slack && d < bestDelta) { best = it; bestDelta = d; }
  }
  if (best) return best;

  // Else fallback to first search result
  return items[0] || null;
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

module.exports = { getYouTubePlaylistItems, searchYouTubeBest, insertIntoPlaylist };
