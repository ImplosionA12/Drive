// Supabase access layer.
//
// The server talks to Postgres with the service-role key, so it bypasses RLS.
// Every table has RLS on with no policies, which means the publishable key can
// read and write nothing — the only way in is through this file.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const dbEnabled = Boolean(url && key);

export const db = dbEnabled
  ? createClient(url, key, { auth: { persistSession: false } })
  : null;

function required() {
  if (!dbEnabled) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return db;
}

/**
 * Per-IP hourly cap, enforced in Postgres so it survives restarts and holds
 * across multiple server instances. Returns true when the caller may proceed.
 */
export async function allowUpload(ip, maxPerHour) {
  if (!dbEnabled) return true; // no database configured: fail open, limit is advisory
  const { data, error } = await db.rpc('check_and_record_rate', {
    p_ip: ip,
    p_max: maxPerHour,
  });
  if (error) {
    console.error('[rate] check failed, allowing:', error.message);
    return true; // never let a database blip block a legitimate upload
  }
  return data === true;
}

/**
 * Record an upload before the bytes move, so an abandoned or failed transfer
 * still leaves a trace. Returns the row id used to complete it later.
 */
export async function beginUpload(row) {
  const { data, error } = await required()
    .from('uploads')
    .insert({ status: 'pending', ...row })
    .select('id')
    .single();
  if (error) throw new Error(`Could not record upload: ${error.message}`);
  return data.id;
}

export async function markUploading(id) {
  await required().from('uploads').update({ status: 'uploading' }).eq('id', id);
}

/**
 * Persist the Google session URI so an upload survives losing the browser.
 * Google keeps a resumable session alive for about a week.
 */
export async function saveResumeUrl(id, resumeUrl) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await required()
    .from('uploads')
    .update({ resume_url: resumeUrl, resume_expires_at: expires })
    .eq('id', id);
}

/** Live byte count, so the dashboard can show a transfer in flight. */
export async function updateProgress(id, bytes) {
  await required().from('uploads').update({ bytes_uploaded: bytes }).eq('id', id);
}

/**
 * Unfinished uploads that Google may still accept. The session URI is
 * deliberately withheld here — see resumeTarget().
 */
export async function pendingUploads(limit = 20) {
  const { data, error } = await required()
    .from('uploads')
    .select('id,filename,filesize,bytes_uploaded,created_at,source')
    .in('status', ['pending', 'uploading'])
    .not('resume_url', 'is', null)
    .gt('resume_expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Hand back a session URI only to a caller that already knows exactly which
 * file it is — same name, same byte count. Stops one uploader idly resuming
 * somebody else's transfer just by holding the shared access code.
 */
export async function resumeTarget(id, { filename, filesize }) {
  const { data, error } = await required()
    .from('uploads')
    .select('id,filename,filesize,resume_url,resume_expires_at,status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.resume_url) return null;
  if (data.filename !== filename || Number(data.filesize) !== Number(filesize)) return null;
  if (new Date(data.resume_expires_at) < new Date()) return null;
  return data.resume_url;
}

export async function completeUpload(id, { driveFileId, driveFolderId, bytes }) {
  const { error } = await required()
    .from('uploads')
    .update({
      status: 'completed',
      resume_url: null,
      drive_file_id: driveFileId,
      drive_folder_id: driveFolderId,
      bytes_uploaded: bytes,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`Could not finalise upload: ${error.message}`);
}

export async function failUpload(id, message) {
  await required()
    .from('uploads')
    .update({ status: 'failed', error_message: String(message).slice(0, 500) })
    .eq('id', id);
}

export async function recentUploads(limit = 50) {
  const { data, error } = await required()
    .from('uploads')
    .select('id,filename,filesize,mime_type,uploader_name,source,status,created_at,drive_file_id,error_message')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

export async function uploadTotals() {
  const { data, error } = await required().from('upload_totals').select('*');
  if (error) throw new Error(error.message);
  return data;
}

// --- Telegram -------------------------------------------------------------

export async function upsertTelegramUser(user) {
  const { data, error } = await required()
    .from('telegram_users')
    .upsert(
      {
        telegram_user_id: user.id,
        username: user.username ?? null,
        display_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
      },
      { onConflict: 'telegram_user_id' }
    )
    .select('telegram_user_id,uploader_name,blocked,state')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function setTelegramName(telegramUserId, name) {
  await required()
    .from('telegram_users')
    .update({ uploader_name: name, state: 'ready' })
    .eq('telegram_user_id', telegramUserId);
}

/** Drop rate-limit rows older than a day. Cheap, called on an interval. */
export async function pruneRateEvents() {
  if (!dbEnabled) return 0;
  const { data, error } = await db.rpc('prune_rate_events');
  if (error) return 0;
  return data ?? 0;
}

/** Mark uploads whose Google session has aged out as failed. */
export async function expireStaleUploads() {
  if (!dbEnabled) return 0;
  const { data, error } = await db.rpc('expire_stale_uploads');
  if (error) return 0;
  return data ?? 0;
}
