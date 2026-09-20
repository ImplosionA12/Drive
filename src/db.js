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

export async function completeUpload(id, { driveFileId, driveFolderId, bytes }) {
  const { error } = await required()
    .from('uploads')
    .update({
      status: 'completed',
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
