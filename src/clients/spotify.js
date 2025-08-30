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

module.exports = { getAllPlaylistItems };
