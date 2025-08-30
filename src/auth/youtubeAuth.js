require('dotenv').config();
const { google } = require('googleapis');

async function getYouTube() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    process.env.YT_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oAuth2Client });
}

module.exports = { getYouTube };
