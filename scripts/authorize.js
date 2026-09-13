// One-time setup: turns your Google account's consent into a refresh token.
//
// Run this once on your own machine, sign in as the person whose Drive should
// hold (and pay for) the files, and paste the printed token into .env.

import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { SCOPE } from '../src/google.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.AUTH_PORT || 5555);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.\n' +
    'Create them at https://console.cloud.google.com/apis/credentials\n' +
    '(OAuth client ID -> Web application), and add this redirect URI:\n' +
    `  ${REDIRECT_URI}\n`
  );
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',   // ask for a refresh token
    prompt: 'consent',        // force one even if we consented before
  });

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Authorization failed</h2><p>${error || 'No code returned.'}</p>`);
    console.error(`\nAuthorization failed: ${error || 'no code returned'}\n`);
    server.close();
    process.exit(1);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const token = await tokenRes.json();

  if (!tokenRes.ok || !token.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h2>No refresh token returned</h2><p>Check the terminal.</p>');
    console.error('\nGoogle did not return a refresh token:', token);
    console.error(
      '\nIf you have authorized this app before, revoke it at\n' +
      'https://myaccount.google.com/permissions and run this again.\n'
    );
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    '<h2>Done.</h2><p>Copy the refresh token from your terminal into <code>.env</code>, ' +
    'then close this tab.</p>'
  );

  console.log('\n  Success. Add this line to your .env file:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${token.refresh_token}\n`);
  console.log('  Keep it secret — it grants full access to this Drive account.\n');

  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`\n  Opening Google sign-in. Sign in as the DRIVE OWNER.`);
  console.log(`  If the browser does not open, visit:\n\n${authUrl}\n`);
  openBrowser(authUrl);
});
