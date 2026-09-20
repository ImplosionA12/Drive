// Telegram companion bot.
//
// Same idea as the website: the bot holds the OWNER's Google credentials, so
// anything anyone sends it is created by the owner's account and charged to
// the owner's Drive. Senders need no Google account.
//
// Telegram caps what a bot may download at 20 MB. Bigger files are refused
// with a pointer to the website, which has no such limit.

import 'dotenv/config';
import { uploadBytes, getQuota } from './google.js';
import {
  dbEnabled, upsertTelegramUser, setTelegramName,
  beginUpload, completeUpload, failUpload, allowUpload,
} from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;
const SITE_URL = process.env.SITE_URL || '';
const MAX_PER_HOUR = Number(process.env.MAX_UPLOADS_PER_HOUR || 30);

if (!TOKEN) {
  console.error('\nTELEGRAM_BOT_TOKEN is not set. Get one from @BotFather, put it in .env.\n');
  process.exit(1);
}

async function call(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const send = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

/** Pull the file descriptor out of whichever message shape Telegram sent. */
function extractFile(msg) {
  if (msg.document) {
    return { id: msg.document.file_id, name: msg.document.file_name, size: msg.document.file_size, mime: msg.document.mime_type };
  }
  if (msg.video) {
    return { id: msg.video.file_id, name: msg.video.file_name || `video-${msg.message_id}.mp4`, size: msg.video.file_size, mime: msg.video.mime_type };
  }
  if (msg.audio) {
    return { id: msg.audio.file_id, name: msg.audio.file_name || `audio-${msg.message_id}.mp3`, size: msg.audio.file_size, mime: msg.audio.mime_type };
  }
  if (msg.voice) {
    return { id: msg.voice.file_id, name: `voice-${msg.message_id}.ogg`, size: msg.voice.file_size, mime: msg.voice.mime_type };
  }
  if (msg.photo?.length) {
    const best = msg.photo[msg.photo.length - 1]; // last entry is the largest
    return { id: best.file_id, name: `photo-${msg.message_id}.jpg`, size: best.file_size, mime: 'image/jpeg' };
  }
  return null;
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function handleFile(msg, user) {
  const chatId = msg.chat.id;
  const file = extractFile(msg);
  if (!file) return;

  if (file.size > TELEGRAM_MAX_BYTES) {
    const where = SITE_URL ? `\n\nUse the website instead: ${SITE_URL}` : '';
    return send(chatId,
      `That file is ${human(file.size)}. Telegram only lets bots download up to ` +
      `${human(TELEGRAM_MAX_BYTES)}.${where}`);
  }

  if (!(await allowUpload(null, MAX_PER_HOUR))) {
    return send(chatId, 'Too many uploads right now. Try again a bit later.');
  }

  const status = await send(chatId, `Uploading <b>${file.name}</b>…`);
  let uploadId = null;

  try {
    if (dbEnabled) {
      uploadId = await beginUpload({
        filename: file.name,
        filesize: file.size ?? 0,
        mime_type: file.mime ?? null,
        uploader_name: user?.uploader_name ?? null,
        source: 'telegram',
        telegram_user_id: msg.from.id,
        telegram_message_id: msg.message_id,
        status: 'uploading',
      });
    }

    // Telegram hands back a short-lived path, then we fetch the actual bytes.
    const meta = await call('getFile', { file_id: file.id });
    const res = await fetch(`${FILE_API}/${meta.file_path}`);
    if (!res.ok) throw new Error(`Telegram download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const saved = await uploadBytes(process.env, {
      name: file.name, mimeType: file.mime, bytes,
    });

    if (uploadId) {
      await completeUpload(uploadId, {
        driveFileId: saved.id, driveFolderId: saved.folderId, bytes: bytes.length,
      });
    }

    await call('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      parse_mode: 'HTML',
      text: `Saved <b>${saved.name}</b> (${human(bytes.length)}) to Drive.`,
    });
  } catch (err) {
    console.error('[bot] upload failed:', err);
    if (uploadId) await failUpload(uploadId, err.message).catch(() => {});
    await call('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: `Upload failed: ${err.message}`,
    }).catch(() => {});
  }
}

async function handleMessage(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  let user = null;
  if (dbEnabled) {
    try {
      user = await upsertTelegramUser(msg.from);
      if (user.blocked) return;
    } catch (err) {
      console.error('[bot] could not record user:', err.message);
    }
  }

  if (text === '/start') {
    return send(chatId,
      'Send me any file and I will put it straight into the owner\'s Google Drive.\n\n' +
      'You do not need a Google account, and nothing is stored on your side.\n\n' +
      'Files up to 20 MB here — use the website for anything larger.\n\n' +
      'Tell me your name with /name so the owner knows who sent what.');
  }

  if (text === '/quota') {
    try {
      const q = await getQuota(process.env);
      return send(chatId, q.limit === null
        ? `Drive is using ${human(q.usage)} (unlimited plan).`
        : `Drive: ${human(q.usage)} of ${human(q.limit)} used, <b>${human(q.free)}</b> free.`);
    } catch (err) {
      return send(chatId, `Could not read the quota: ${err.message}`);
    }
  }

  if (text.startsWith('/name')) {
    const name = text.slice(5).trim();
    if (!name) return send(chatId, 'Send it like: <code>/name Rahul</code>');
    if (dbEnabled) await setTelegramName(msg.from.id, name.slice(0, 100));
    return send(chatId, `Noted — uploads from you will be labelled <b>${name}</b>.`);
  }

  if (extractFile(msg)) return handleFile(msg, user);

  if (text.startsWith('/')) return send(chatId, 'Commands: /start, /name, /quota');
  return send(chatId, 'Send me a file and I will save it to Drive.');
}

// --- long polling ---------------------------------------------------------

let offset = 0;
let running = true;

async function poll() {
  while (running) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((err) => console.error('[bot]', err));
        }
      }
    } catch (err) {
      console.error('[bot] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000)); // back off, then keep going
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { running = false; process.exit(0); });
}

const me = await call('getMe');
console.log(`\n  Telegram bot running as @${me.username}`);
console.log(`  Upload tracking: ${dbEnabled ? 'on (Supabase)' : 'off'}`);
console.log(`  Telegram caps bot downloads at ${human(TELEGRAM_MAX_BYTES)}\n`);
poll();
