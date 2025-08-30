require('dotenv').config();
const SpotifyWebApi = require('spotify-web-api-node');

async function getSpotify() {
    const sp = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    sp.setRefreshToken(process.env.SPOTIFY_REFRESH_TOKEN);
    const tok = await sp.refreshAccessToken();
    sp.setAccessToken(tok.body.access_token);
    return sp;
}

module.exports = { getSpotify };
