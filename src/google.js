// Thin Google Drive client.
//
// Every request here is authenticated as the DRIVE OWNER, never as the visitor
// uploading the file. That is the whole point of this project: Google bills
// storage to the account that creates a file, so creating it with the owner's
// token puts the bytes on the owner's quota and leaves the visitor's Drive
// (if they even have one) untouched.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export const SCOPE = 'https://www.googleapis.com/auth/drive';

let cachedToken = null; // { accessToken, expiresAt }

/**
 * Exchange the owner's long-lived refresh token for a short-lived access token.
 * Cached until 60s before expiry so we are not hitting Google on every upload.
 */
export async function getAccessToken(env) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant almost always means the refresh token was revoked or the
    // OAuth app is still in "Testing" mode, where tokens die after 7 days.
    throw new Error(
      `Could not refresh the owner's Google token (${res.status} ${body.error || ''}). ` +
      `Re-run "npm run auth". If this keeps happening every week, publish your ` +
      `OAuth consent screen to "In production" — refresh tokens expire after 7 ` +
      `days while it is in "Testing".`
    );
  }

  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.accessToken;
}

async function driveFetch(env, path, options = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `Drive API error ${res.status}`);
  }
  return body;
}

/**
 * The owner's storage situation. `limit` is absent on unlimited accounts.
 */
export async function getQuota(env) {
  const about = await driveFetch(env, '/about?fields=storageQuota,user');
  const q = about.storageQuota || {};
  const limit = q.limit ? Number(q.limit) : null;
  const usage = Number(q.usage || 0);
  return {
    email: about.user?.emailAddress ?? null,
    usage,
    limit,
    free: limit === null ? Infinity : Math.max(0, limit - usage),
  };
}

/**
 * Resolve the destination folder, creating it on first run if needed.
 * Cached in module scope; the folder id is stable for the life of the process.
 */
let cachedFolderId = null;
export async function ensureFolder(env) {
  if (cachedFolderId) return cachedFolderId;

  if (env.DRIVE_FOLDER_ID) {
    cachedFolderId = env.DRIVE_FOLDER_ID;
    return cachedFolderId;
  }

  const name = env.DRIVE_FOLDER_NAME || 'Shared Uploads';
  const query = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    "'root' in parents",
  ].join(' and ');

  const found = await driveFetch(
    env,
    `/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`
  );

  if (found.files?.length) {
    cachedFolderId = found.files[0].id;
    return cachedFolderId;
  }

  const created = await driveFetch(env, '/files?fields=id', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  cachedFolderId = created.id;
  return cachedFolderId;
}

/**
 * Open a resumable upload session and hand back the session URI.
 *
 * The browser PUTs the actual bytes straight to this URI, so file data never
 * passes through our server — no request size limit, no bandwidth cost, and
 * big files work fine. The URI is a one-shot capability: it can only write
 * this single file, and it carries no access to the rest of the Drive.
 *
 * `origin` must be the browser's origin or Google will reject the later
 * cross-origin PUT.
 */
export async function createResumableUpload(env, { name, mimeType, size, origin }) {
  const token = await getAccessToken(env);
  const folderId = await ensureFolder(env);

  const res = await fetch(`${UPLOAD_API}?uploadType=resumable&fields=id,name,size`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
      Origin: origin,
    },
    body: JSON.stringify({ name, parents: [folderId] }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Could not start upload session (${res.status}): ${text.slice(0, 300)}`);
  }

  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) {
    throw new Error('Google did not return an upload session URL.');
  }
  return uploadUrl;
}

/** Most recent uploads, for the owner-facing listing. */
export async function listRecent(env, limit = 50) {
  const folderId = await ensureFolder(env);
  const query = `'${folderId}' in parents and trashed = false`;
  const body = await driveFetch(
    env,
    `/files?q=${encodeURIComponent(query)}` +
      `&orderBy=createdTime desc&pageSize=${limit}` +
      `&fields=files(id,name,size,mimeType,createdTime,webViewLink)`
  );
  return body.files || [];
}
