// One-time helper to mint a Spotify refresh token.
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const SpotifyWebApi = require('spotify-web-api-node');

const sp = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

// Scopes you’ll need for reading & writing playlists:
const scopes = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read'
];

// Third arg = showDialog=true forces the consent screen (helps ensure we get a refresh token)
const authURL = sp.createAuthorizeURL(scopes, 'sync_state', true);

console.log('\nOpen this URL in your browser to authorize:\n');
console.log(authURL);
console.log('\nListening on http://127.0.0.1:8080/callback ...\n');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8080');
  if (u.pathname !== '/callback') { res.end('OK'); return; }

  const code = u.searchParams.get('code');
  try {
    const data = await sp.authorizationCodeGrant(code);
    console.log('\n=== SPOTIFY TOKENS ===');
    console.log('ACCESS_TOKEN =', data.body.access_token);
    console.log('REFRESH_TOKEN =', data.body.refresh_token);
    console.log('EXPIRES_IN   =', data.body.expires_in, 'seconds');

    res.end('Success! Check your terminal and copy REFRESH_TOKEN into your .env.\nYou can close this tab.');
    process.exit(0);
  } catch (e) {
    console.error('Auth error:', e.body?.error_description || e.message);
    res.statusCode = 500;
    res.end('Auth error. Check terminal.');
  }
}).listen(8080);
