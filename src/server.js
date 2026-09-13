import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResumableUpload, getQuota, listRecent, ensureFolder } from './google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const env = process.env;

const PORT = Number(env.PORT || 3000);
const MAX_FILE_BYTES = Number(env.MAX_FILE_MB || 512) * 1024 * 1024;
const ACCESS_CODE = env.ACCESS_CODE || '';
const OWNER_CODE = env.OWNER_CODE || '';

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// ---------------------------------------------------------------------------
// Abuse control. This endpoint is deliberately open to people with no Google
// account, which also means it is open to the internet. These three limits are
// what stand between "my friend can upload" and "someone filled my 15 GB".
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_UPLOADS = Number(env.MAX_UPLOADS_PER_HOUR || 30);
const hits = new Map(); // ip -> number[] of timestamps

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_MAX_UPLOADS) {
    return res.status(429).json({
      error: `Too many uploads from this address. Try again later.`,
    });
  }

  recent.push(now);
  hits.set(ip, recent);

  // Opportunistic cleanup so the map does not grow without bound.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  next();
}

function checkAccessCode(req, res, next) {
  if (!ACCESS_CODE) return next();
  const supplied = req.get('x-access-code') || req.query.code || req.body?.code;
  if (supplied !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Wrong or missing access code.' });
  }
  next();
}

const ALLOWED = (env.ALLOWED_EXTENSIONS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
  .filter(Boolean);

/**
 * Strip directory components and characters that confuse Drive or the UI.
 * Never trust a filename that came from a browser.
 */
function safeName(raw) {
  const base = String(raw || 'upload').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
  return cleaned || 'upload';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Tells the front end whether to show the access-code box, and the size cap.
app.get('/api/config', (req, res) => {
  res.json({
    requiresCode: Boolean(ACCESS_CODE),
    maxFileBytes: MAX_FILE_BYTES,
    allowedExtensions: ALLOWED,
    title: env.SITE_TITLE || 'Upload to my Drive',
  });
});

/**
 * Hand back a resumable upload URL. The browser then PUTs the bytes directly
 * to Google, so nothing large ever touches this server.
 */
app.post('/api/upload-url', rateLimit, checkAccessCode, async (req, res) => {
  try {
    const { name, mimeType, size } = req.body || {};
    const bytes = Number(size);

    if (!Number.isFinite(bytes) || bytes <= 0) {
      return res.status(400).json({ error: 'A valid file size is required.' });
    }
    if (bytes > MAX_FILE_BYTES) {
      return res.status(413).json({
        error: `That file is larger than the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit.`,
      });
    }

    const filename = safeName(name);
    if (ALLOWED.length) {
      const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
      if (!ALLOWED.includes(ext)) {
        return res.status(415).json({
          error: `Only these file types are accepted: ${ALLOWED.join(', ')}.`,
        });
      }
    }

    // Refuse before Google does, so the visitor gets a clear message rather
    // than a failed PUT halfway through a large upload.
    const quota = await getQuota(env);
    if (bytes > quota.free) {
      return res.status(507).json({
        error: "The owner's Drive does not have enough free space for this file.",
      });
    }

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const uploadUrl = await createResumableUpload(env, {
      name: filename,
      mimeType,
      size: bytes,
      origin,
    });

    res.json({ uploadUrl, name: filename });
  } catch (err) {
    console.error('[upload-url]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Owner-only views
// ---------------------------------------------------------------------------

function ownerOnly(req, res, next) {
  if (!OWNER_CODE) {
    return res.status(404).json({ error: 'Owner view is disabled. Set OWNER_CODE to enable it.' });
  }
  if ((req.get('x-owner-code') || req.query.code) !== OWNER_CODE) {
    return res.status(401).json({ error: 'Wrong or missing owner code.' });
  }
  next();
}

app.get('/api/quota', ownerOnly, async (req, res) => {
  try {
    res.json(await getQuota(env));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files', ownerOnly, async (req, res) => {
  try {
    res.json({ files: await listRecent(env) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const missing = REQUIRED.filter((k) => !env[k]);

if (missing.length) {
  console.error(`\nMissing required settings: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env, then run: npm run auth\n');
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`\n  Upload portal running at http://localhost:${PORT}`);
  try {
    const quota = await getQuota(env);
    const folderId = await ensureFolder(env);
    const gb = (n) => (n / 1024 ** 3).toFixed(2);
    console.log(`  Storing into Drive of: ${quota.email}`);
    console.log(`  Destination folder id: ${folderId}`);
    console.log(
      quota.limit === null
        ? `  Storage: ${gb(quota.usage)} GB used (unlimited)\n`
        : `  Storage: ${gb(quota.usage)} / ${gb(quota.limit)} GB used, ${gb(quota.free)} GB free\n`
    );
  } catch (err) {
    console.error(`  Warning: could not reach Google Drive — ${err.message}\n`);
  }
});
