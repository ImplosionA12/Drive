# Drive Upload Portal

A public web page where **anyone can upload files into your Google Drive
without signing in** — and the storage is charged to **you**, never to them.

## The problem this solves

Google bills storage to whoever's account **created** the file. So when a
friend uploads into a folder you shared with them, *he* creates the file, *he*
owns it, and it eats *his* 15 GB — even though the folder is yours. Sharing the
folder does not change that, and there is no setting that does.

This portal sidesteps it. The website holds **your** credentials and does the
upload on the visitor's behalf, so every file is created by your account:

```
Friend's browser ──file bytes──> Google Drive API
       │                              ▲
       └──asks for permission──> This server ──authenticates as YOU
```

The visitor needs no Google account. Their Drive is never touched. The bytes go
straight from their browser to Google, so this server stays small and fast even
for large files.

## Setup

### 1. Get Google credentials

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project.
2. Enable the **Google Drive API** (APIs & Services → Library → "Google Drive API").
3. Configure the **OAuth consent screen**. Choose *External*, fill in the
   required fields, and add the scope `.../auth/drive`.
4. **Publish the consent screen** (Publishing status → *In production*).
   This matters: while it is in *Testing*, Google expires your refresh token
   after **7 days** and the site breaks every week. Published-but-unverified is
   fine for personal use — you will just click past an "unverified app" warning
   once, during step 2 below.
5. Credentials → **Create credentials → OAuth client ID → Web application**.
   Add this authorised redirect URI:
   ```
   http://localhost:5555/callback
   ```
6. Copy the client ID and secret.

### 2. Authorise

```bash
npm install
cp .env.example .env
# paste GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET into .env
npm run auth
```

A browser opens. **Sign in as the account whose Drive should hold the files.**
Paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`.

### 3. Run

```bash
npm start
```

Open <http://localhost:3000>. On boot the terminal prints which account it is
storing into and how much space is left — check that it says *your* address.

## Configuration

All optional, all in `.env`:

| Setting | Default | What it does |
|---|---|---|
| `ACCESS_CODE` | *(blank)* | Visitors must enter this to upload. Blank means anyone with the link can. Shareable as `https://yoursite/?code=xxxx`. |
| `OWNER_CODE` | *(blank)* | Unlocks `/api/quota` and `/api/files`. Blank keeps them disabled. |
| `MAX_FILE_MB` | `512` | Per-file size cap. |
| `MAX_UPLOADS_PER_HOUR` | `30` | Per-IP rate limit. |
| `ALLOWED_EXTENSIONS` | *(blank)* | e.g. `pdf,png,jpg`. Blank allows any type. |
| `DRIVE_FOLDER_NAME` | `Shared Uploads` | Folder created in your Drive root on first run. |
| `DRIVE_FOLDER_ID` | *(blank)* | Use an existing folder instead, by ID. |

**Set `ACCESS_CODE` before putting this on the public internet.** Without it,
the page is an open invitation to fill your Drive.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/config` | none | Size cap and whether a code is needed. |
| `POST /api/upload-url` | access code | Issues a one-shot Google upload URL. |
| `GET /api/quota` | owner code | Your storage usage. |
| `GET /api/files` | owner code | Recent uploads. |

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS). Set the same environment
variables there. Two notes:

- The rate limiter keeps state in memory, so it resets on restart and does not
  coordinate across multiple instances. Fine for one small instance.
- Keep `GOOGLE_REFRESH_TOKEN` in the host's secret store. It grants full access
  to your Drive. If it ever leaks, revoke it at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
  and re-run `npm run auth`.

## Troubleshooting

**"Could not refresh the owner's Google token" / `invalid_grant`** — usually the
consent screen is still in *Testing* (7-day token expiry, see step 1.4), or the
authorisation was revoked. Re-run `npm run auth`.

**Uploads fail with a CORS error** — the upload session is tied to the origin
that requested it. Make sure you reach the site at the same origin the server
sees (behind a proxy, `trust proxy` is already enabled).

**"Not enough free space"** — that is your Drive being full, which is the
honest answer. Note that trashed files still count until the trash is emptied.
