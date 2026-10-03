import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResumableUpload, getQuota, ensureFolder } from './google.js';
import {
  dbEnabled, allowUpload, beginUpload, markUploading, saveResumeUrl,
  updateProgress, pendingUploads, resumeTarget,
  completeUpload, failUpload, recentUploads, uploadTotals,
  pruneRateEvents, expireStaleUploads,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const env = process.env;

const PORT = Number(env.PORT || 3000);
const MAX_FILE_BYTES = Number(env.MAX_FILE_MB || 10240) * 1024 * 1024;
const MAX_PER_HOUR = Number(env.MAX_UPLOADS_PER_HOUR || 30);
const ACCESS_CODE = env.ACCESS_CODE || '';
const OWNER_CODE = env.OWNER_CODE || '';

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const ALLOWED = (env.ALLOWED_EXTENSIONS || '')
  .split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);

/** Strip directories and control characters. Never trust a browser filename. */
function safeName(raw) {
  const base = String(raw || 'upload').split(/[\\/]/).pop();
  return base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || 'upload';
}

/** Express gives us an IPv6-mapped form sometimes; Postgres inet wants it clean. */
function clientIp(req) {
  const raw = req.ip || '';
  const cleaned = raw.replace(/^::ffff:/, '');
  return cleaned || null;
}

function checkAccessCode(req, res, next) {
  if (!ACCESS_CODE) return next();
  const supplied = req.get('x-access-code') || req.query.code || req.body?.code;
  if (supplied !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Wrong or missing access code.' });
  }
  next();
}

function ownerOnly(req, res, next) {
  if (!OWNER_CODE) {
    return res.status(404).json({ error: 'Owner view is disabled. Set OWNER_CODE to enable it.' });
  }
  if ((req.get('x-owner-code') || req.query.code) !== OWNER_CODE) {
    return res.status(401).json({ error: 'Wrong or missing owner code.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({
    requiresCode: Boolean(ACCESS_CODE),
    maxFileBytes: MAX_FILE_BYTES,
    allowedExtensions: ALLOWED,
    title: env.SITE_TITLE || 'Upload to my Drive',
    tracking: dbEnabled,
  });
});

/**
 * Validate, log the attempt, and hand back a resumable upload URL. The browser
 * PUTs the bytes straight to Google, so file data never crosses this server.
 */
app.post('/api/upload-url', checkAccessCode, async (req, res) => {
  let uploadId = null;
  try {
    const { name, mimeType, size, uploaderName } = req.body || {};
    const bytes = Number(size);
    const ip = clientIp(req);

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
        return res.status(415).json({ error: `Only these file types are accepted: ${ALLOWED.join(', ')}.` });
      }
    }

    if (!(await allowUpload(ip, MAX_PER_HOUR))) {
      return res.status(429).json({ error: 'Too many uploads from this address. Try again later.' });
    }

    // Fail fast rather than partway through a large transfer.
    const quota = await getQuota(env);
    if (bytes > quota.free) {
      return res.status(507).json({ error: "The owner's Drive does not have enough free space for this file." });
    }

    if (dbEnabled) {
      uploadId = await beginUpload({
        filename,
        filesize: bytes,
        mime_type: mimeType || null,
        uploader_name: uploaderName ? String(uploaderName).slice(0, 100) : null,
        source: 'web',
        client_ip: ip,
      });
    }

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const uploadUrl = await createResumableUpload(env, {
      name: filename, mimeType, size: bytes, origin,
    });

    if (uploadId) {
      await markUploading(uploadId);
      // Persisted so the transfer survives a cleared cache or a dead laptop.
      await saveResumeUrl(uploadId, uploadUrl);
    }
    res.json({ uploadUrl, name: filename, uploadId });
  } catch (err) {
    if (err.status === 502) console.error('[upload-url]', err.message);
    else console.error('[upload-url]', err);
    if (uploadId) await failUpload(uploadId, err.message).catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** The browser reports the outcome so the log reflects reality. */
app.post('/api/complete', checkAccessCode, async (req, res) => {
  if (!dbEnabled) return res.json({ ok: true });
  try {
    const { uploadId, driveFileId, bytes, error } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required.' });

    if (error) {
      await failUpload(uploadId, error);
    } else {
      await completeUpload(uploadId, {
        driveFileId: driveFileId || null,
        driveFolderId: await ensureFolder(env),
        bytes: Number(bytes) || 0,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[complete]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Live byte count for a transfer in flight, so the dashboard is not blind. */
app.post('/api/progress', checkAccessCode, async (req, res) => {
  if (!dbEnabled) return res.json({ ok: true });
  try {
    const { uploadId, bytes } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required.' });
    await updateProgress(uploadId, Number(bytes) || 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Unfinished uploads Google may still accept. No session URIs in this list. */
app.get('/api/pending', checkAccessCode, async (req, res) => {
  if (!dbEnabled) return res.json({ pending: [] });
  try {
    res.json({ pending: await pendingUploads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Recover a session URI. The caller must name the exact file — same filename
 * and byte count — so holding the shared access code alone is not enough to
 * pick up someone else's transfer.
 */
app.post('/api/resume', checkAccessCode, async (req, res) => {
  if (!dbEnabled) return res.status(404).json({ error: 'Resume needs Supabase configured.' });
  try {
    const { uploadId, name, size } = req.body || {};
    if (!uploadId || !name || !size) {
      return res.status(400).json({ error: 'uploadId, name and size are required.' });
    }
    const uploadUrl = await resumeTarget(uploadId, {
      filename: safeName(name), filesize: Number(size),
    });
    if (!uploadUrl) {
      return res.status(404).json({ error: 'No matching resumable upload. Start it again.' });
    }
    res.json({ uploadUrl, uploadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

app.get('/api/quota', ownerOnly, async (req, res) => {
  try { res.json(await getQuota(env)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.get('/api/files', ownerOnly, async (req, res) => {
  try {
    if (!dbEnabled) return res.json({ uploads: [], totals: [], tracking: false });
    const [uploads, totals] = await Promise.all([recentUploads(100), uploadTotals()]);
    res.json({ uploads, totals, tracking: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  console.log(`  Upload tracking: ${dbEnabled ? 'on (Supabase)' : 'off — set SUPABASE_* to enable'}`);
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

// Keep the rate-limit table tidy without a cron job.
if (dbEnabled) {
  const housekeeping = () => {
    pruneRateEvents().catch(() => {});
    expireStaleUploads().catch(() => {});
  };
  setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();
}
