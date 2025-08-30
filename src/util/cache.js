const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(process.cwd(), '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function cachePath(playlistId) {
  return path.join(CACHE_DIR, `sp2yt_${playlistId}.json`);
}

function loadCache(playlistId) {
  const p = cachePath(playlistId);
  if (!fs.existsSync(p)) return { lastSync: null, seenTrackIds: [], map: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { lastSync: null, seenTrackIds: [], map: {}, ...parsed };
  } catch {
    return { lastSync: null, seenTrackIds: [], map: {} };
  }
}

function saveCache(playlistId, data) {
  const p = cachePath(playlistId);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { loadCache, saveCache };
// Stores per-playlist cache in ./.cache
// {
//   lastSync: ISO string | null,
//   seenTrackIds: string[],
//   map: { [spotifyTrackId: string]: youtubeVideoId }
// }