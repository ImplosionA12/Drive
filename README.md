# Drive Upload Portal

A website **and** a Telegram bot that both drop files into **one** Google Drive
— yours — so the storage is charged to you and never to the person uploading.
They need no Google account and no login.

## The problem this solves

Google bills storage to whoever's account **created** the file. So when a
friend uploads into a folder you shared with them, *they* create the file,
*they* own it, and it eats *their* 15 GB — even though the folder is yours.
Sharing the folder does not change this, and no setting does.

Both front ends here hold **your** credentials and upload on the visitor's
behalf, so every file is created by your account.

## How the hybrid fits together

```
   Website  ──┐                            ┌── Google Drive   (the files)
              ├── authenticates as YOU ────┤
Telegram bot ─┘                            └── Supabase       (who sent what)
```

Two ways in, one Drive, one log. The dashboard shows both sources together.

| | Website | Telegram bot |
|---|---|---|
| Max file size | **512 MB** (configurable) | **20 MB** — Telegram's own cap on bots |
| Bytes travel | browser → Google directly | Telegram → your server → Google |
| Best for | big files, anyone with a link | quick phone photos, people already in Telegram |
| Run with | `npm start` | `npm run bot` |

They are independent processes. Run either, or both — the website does not need
the bot, and the bot does not need the website.

Because the browser uploads straight to Google, your server never handles large
file bodies: no request-size limit, no bandwidth bill. The bot has to relay the
bytes itself, which is why Telegram's 20 MB cap applies there and not on the web.

## Setup

Run `npm run check` at any point — it prints exactly what is configured, what is
missing, and the command to fix each thing.

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Google Drive (required)

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen** (External), and add the scope
   `.../auth/drive`.
3. **Publish the consent screen** (Publishing status → *In production*).
   This matters: while it is in *Testing*, Google expires your refresh token
   after **7 days** and everything breaks weekly. Published-but-unverified is
   fine for personal use — you click past one warning during step 5.
4. Credentials → **Create credentials → OAuth client ID → Web application**,
   with redirect URI `http://localhost:5555/callback`. Put the client ID and
   secret in `.env`.
5. ```bash
   npm run auth      # sign in as the account that should HOLD the files
   ```
   Paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`.

### 3. Supabase (optional — log, dashboard, durable rate limits)

The schema is already applied. You only need the key:

Supabase dashboard → **Project Settings → API → `service_role`** → paste into
`SUPABASE_SERVICE_ROLE_KEY`. The URL is already filled in.

Without this the portal still works; you just lose the upload history and the
rate limiter falls back to allowing everything.

> The `service_role` key bypasses every row-level security rule. Keep it in
> `.env` or your host's secret store — never in client code or a commit.

### 4. Telegram bot (optional)

Message [@BotFather](https://t.me/botfather) → `/newbot` → paste the token into
`TELEGRAM_BOT_TOKEN`, then:

```bash
npm run bot
```

Bot commands: `/start`, `/name <your name>` (labels your uploads in the
dashboard), `/quota`.

### 5. Run

```bash
npm start     # website  -> http://localhost:3000
npm run bot   # bot, in a second terminal
```

## The dashboard

`/dashboard.html`, unlocked with `OWNER_CODE`. Shows Drive usage, totals split
by source, and the last 100 uploads with who sent each one. Refreshes every 15s.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `ACCESS_CODE` | *(blank)* | Visitors must enter this. Blank = anyone with the link can upload. Share as `https://yoursite/?code=xxxx`. |
| `OWNER_CODE` | *(blank)* | Unlocks the dashboard. Blank keeps it disabled. |
| `MAX_FILE_MB` | `512` | Per-file cap (website). |
| `MAX_UPLOADS_PER_HOUR` | `30` | Per-IP cap, enforced in Postgres. |
| `ALLOWED_EXTENSIONS` | *(blank)* | e.g. `pdf,png,jpg`. Blank allows anything. |
| `DRIVE_FOLDER_NAME` | `Shared Uploads` | Folder created in your Drive root. |
| `DRIVE_FOLDER_ID` | *(blank)* | Use an existing folder instead, by ID. |
| `SITE_URL` | *(blank)* | Shown by the bot when a file exceeds 20 MB. |

**Set `ACCESS_CODE` before putting this on the public internet.** Without it,
the page is an open invitation to fill your Drive.

## Database

Everything lives in the `dag-upload` Supabase project.

- `uploads` — one row per attempt: filename, size, who, source (`web` /
  `telegram`), status (`pending` → `uploading` → `completed` / `failed`), and
  the resulting Drive file id. Rows are written *before* the bytes move, so
  abandoned and failed transfers leave a trace too.
- `telegram_users` — Telegram senders and their chosen display name.
- `rate_events` — one row per attempt, backing the per-IP cap. Pruned every
  6 hours by the running server.
- `upload_totals` — view rolling up counts and bytes per source.

RLS is enabled with **no policies** on every table, so the publishable key can
read and write nothing. The server reaches them with the service-role key; the
two rate-limit helpers are executable only by `service_role`.

## Security notes

- `.env` is gitignored. Never commit it.
- If the Google token leaks, revoke at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
  and re-run `npm run auth`. If the Supabase key leaks, rotate it in the
  dashboard.
- The resumable upload URL handed to a browser is a one-shot capability scoped
  to a single file; it grants no other access to the Drive.

## Troubleshooting

**`invalid_grant` / "Could not refresh the owner's Google token"** — usually the
consent screen is still in *Testing* (7-day expiry, see step 2.3). Re-run
`npm run auth`.

**Uploads fail with a CORS error** — the upload session is bound to the origin
that requested it. Reach the site at the same origin the server sees; `trust
proxy` is already enabled for deployments behind a reverse proxy.

**Dashboard says tracking is off** — `SUPABASE_SERVICE_ROLE_KEY` is missing.

**"Not enough free space"** — your Drive is full. Trashed files still count
until the trash is emptied.
