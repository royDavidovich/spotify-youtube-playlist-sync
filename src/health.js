require('dotenv').config();
const SpotifyWebApi = require('spotify-web-api-node');
const CONFIG = require('../config.json');

function requireEnv(name) {
    if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
}

async function main() {
    // 1) Validate env
    ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI', 'SPOTIFY_REFRESH_TOKEN']
        .forEach(requireEnv);
    console.log('✓ .env has required Spotify fields');

    // 2) Refresh access token
    const sp = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    sp.setRefreshToken(process.env.SPOTIFY_REFRESH_TOKEN);

    const t0 = Date.now();
    const tok = await sp.refreshAccessToken();
    sp.setAccessToken(tok.body.access_token);
    console.log(`✓ Refreshed access token in ${Date.now() - t0} ms (expires in ${tok.body.expires_in}s)`);

    // 3) Who am I?
    const me = await sp.getMe();
    console.log(`✓ Authenticated as ${me.body.display_name || me.body.id}`);

    // 4) Sample-read each configured playlist (first 5 items)
    for (const pair of CONFIG.pairs) {
        const id = pair.spotifyPlaylistId;
        if (!id || id === 'SPOTIFY_PLAYLIST_ID') {
            console.log('⚠️  Skipping: set a real spotifyPlaylistId in config.json');
            continue;
        }
        console.log(`→ Checking playlist ${id}`);
        try {
            const res = await sp.getPlaylistTracks(id, { limit: 5, offset: 0 });
            const items = res.body.items || [];
            console.log(`  ✓ Fetched ${items.length} sample tracks`);
            items.forEach((it, i) => {
                const tr = it.track;
                console.log(`   ${i + 1}. ${tr?.artists?.[0]?.name || 'Unknown'} - ${tr?.name}  (added_at ${it.added_at})`);
            });
        } catch (e) {
            console.error(`  ✗ Error fetching playlist ${id}:`, e.body?.error?.message || e.message);
        }
    }

    console.log('✓ Spotify health check completed.');
}

main().catch(err => {
    console.error('✗ Health check failed:', err.message);
    process.exit(1);
});
