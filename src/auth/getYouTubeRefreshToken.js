// One-time helper to mint a YouTube refresh token.
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

// --- Derive host/port/path from YT_REDIRECT_URI to avoid mismatches ---
const REDIRECT = process.env.YT_REDIRECT_URI || 'http://127.0.0.1:8081/callback';
const parsed = new URL(REDIRECT);
const HOST = parsed.hostname || '127.0.0.1';
const PORT = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
const CALLBACK_PATH = parsed.pathname || '/callback';

// --- OAuth client using the same redirect URI as above ---
const oAuth2Client = new google.auth.OAuth2(
  process.env.YT_CLIENT_ID,
  process.env.YT_CLIENT_SECRET,
  REDIRECT
);

// Scopes for managing playlists (read/write)
const scopes = ['https://www.googleapis.com/auth/youtube'];

const authURL = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: scopes
});

console.log('\nOpen this URL in your browser to authorize:\n');
console.log(authURL);
console.log(`\nListening on ${parsed.origin}${CALLBACK_PATH} ...\n`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `${parsed.origin}`);
  if (u.pathname !== CALLBACK_PATH) {
    res.statusCode = 200;
    res.end(`OK — waiting for ${CALLBACK_PATH}`);
    return;
  }

  // If user denied consent, Google may return ?error=access_denied
  const oauthError = u.searchParams.get('error');
  if (oauthError) {
    console.error('Auth error from Google:', oauthError);
    res.statusCode = 400;
    res.end('Auth error from Google. Check terminal logs.');
    return;
  }

  const code = u.searchParams.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end("Missing 'code' param on callback URL.");
    return;
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('\n=== YOUTUBE TOKENS ===');
    console.log('ACCESS_TOKEN =', tokens.access_token);
    console.log('REFRESH_TOKEN =', tokens.refresh_token);
    console.log('EXPIRES_AT   =', tokens.expiry_date);

    // Helpful warning if Google didn't return a refresh token
    if (!tokens.refresh_token) {
      console.warn(
        '\n(!) No REFRESH_TOKEN returned.\n' +
        '    Tips:\n' +
        '    • Ensure access_type=offline and prompt=consent (already set in this script).\n' +
        '    • Revoke the app at https://myaccount.google.com/permissions and try again.\n' +
        '    • Make sure your Google Cloud OAuth consent screen is in Testing and your account is in Test users.\n'
      );
    }

    res.end('Success! Copy REFRESH_TOKEN from the terminal into your .env. You can close this tab.');
    // Close server shortly after responding
    setTimeout(() => server.close(() => process.exit(0)), 100);
  } catch (e) {
    console.error('Auth exchange failed:', e.message || e);
    res.statusCode = 500;
    res.end('Auth exchange failed. Check terminal.');
  }
});

// Bind explicitly to the host from the redirect URI (e.g., 127.0.0.1)
server.listen(PORT, HOST, () => {
  console.log(`Server bound on http://${HOST}:${PORT}${CALLBACK_PATH}`);
});
