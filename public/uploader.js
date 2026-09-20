// Chunked, resumable uploader for Google Drive.
//
// Files are sent to Google in fixed-size chunks rather than one long PUT. That
// matters for multi-gigabyte uploads:
//
//   * a dropped connection costs one chunk, not the whole file
//   * each chunk is retried on its own with backoff
//   * the session is remembered, so closing the tab or losing the network and
//     coming back later resumes where it stopped instead of starting over
//
// Google requires every chunk except the last to be a multiple of 256 KB, and
// answers an incomplete upload with 308 plus the byte range it actually has.
// That range is the source of truth — never our own count — because a chunk
// can be partially received.

const CHUNK_UNIT = 256 * 1024;                 // Google's required granularity
const CHUNK_SIZE = 16 * 1024 * 1024;           // 16 MB (64 units)
const MAX_CHUNK_RETRIES = 6;
const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000; // Google expires sessions at ~7 days

if (CHUNK_SIZE % CHUNK_UNIT !== 0) {
  throw new Error('CHUNK_SIZE must be a multiple of 256 KB.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Identifies a file well enough to match a resumable session to it. */
function sessionKey(file) {
  return `drive-upload:${file.name}:${file.size}:${file.lastModified}`;
}

function loadSession(file) {
  try {
    const raw = localStorage.getItem(sessionKey(file));
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      localStorage.removeItem(sessionKey(file));
      return null;
    }
    return session;
  } catch {
    return null; // private mode, blocked storage, corrupt entry — just start fresh
  }
}

function saveSession(file, session) {
  try {
    localStorage.setItem(sessionKey(file), JSON.stringify(session));
  } catch { /* storage unavailable; uploads still work, just without resume */ }
}

function clearSession(file) {
  try { localStorage.removeItem(sessionKey(file)); } catch { /* ignore */ }
}

/**
 * One chunk. Resolves with the parsed file JSON on the final chunk, or null
 * when Google reports 308 (more to come).
 * Throws { permanent } to mean "do not retry this".
 */
function putChunk(url, blob, start, total, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const end = start + blob.size - 1;

    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${total}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(start + e.loaded);
    };

    xhr.onload = () => {
      // 308 is Google's "resume incomplete", not an HTTP redirect.
      if (xhr.status === 308) return resolve(null);
      if (xhr.status === 200 || xhr.status === 201) {
        try { return resolve(JSON.parse(xhr.responseText)); }
        catch { return resolve({}); } // stored fine even if the body is odd
      }
      if (xhr.status === 404 || xhr.status === 410) {
        return reject(Object.assign(new Error('SESSION_GONE'), { permanent: true }));
      }
      if (xhr.status >= 400 && xhr.status < 500) {
        return reject(Object.assign(
          new Error(`Google rejected the upload (${xhr.status}).`), { permanent: true }));
      }
      reject(new Error(`Upload failed (${xhr.status}).`)); // 5xx: worth retrying
    };

    xhr.onerror = () => reject(new Error('Network error.'));
    xhr.ontimeout = () => reject(new Error('Timed out.'));
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled.'), { permanent: true }));

    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(blob);
  });
}

/**
 * Ask Google how much of the file it actually holds.
 * Returns the next byte offset to send, or -1 if the upload is already done.
 */
function queryOffset(url, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Range', `bytes */${total}`);

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) return resolve(-1);
      if (xhr.status === 404 || xhr.status === 410) {
        return reject(Object.assign(new Error('SESSION_GONE'), { permanent: true }));
      }
      if (xhr.status !== 308) {
        return reject(new Error(`Could not resume (${xhr.status}).`));
      }
      // "bytes=0-1048575" -> next offset is 1048576. Absent means nothing stored.
      const range = xhr.getResponseHeader('Range');
      const match = range && range.match(/bytes=0-(\d+)/);
      resolve(match ? Number(match[1]) + 1 : 0);
    };

    xhr.onerror = () => reject(new Error('Network error while resuming.'));
    xhr.send();
  });
}

/**
 * Upload one file, resuming a previous attempt when possible.
 *
 * `ui` receives: onProgress(sent, total), onStatus(text), onResume(offset).
 */
export async function uploadFile(file, ui, { accessCode, signal, recovered } = {}) {
  // `recovered` comes from /api/resume: the server remembered this session
  // even though this browser did not.
  let session = recovered
    ? { uploadUrl: recovered.uploadUrl, uploadId: recovered.uploadId, createdAt: Date.now() }
    : loadSession(file);
  if (recovered) saveSession(file, session);
  let confirmed = 0;

  // Re-establish an interrupted session, or open a new one.
  if (session) {
    try {
      const offset = await queryOffset(session.uploadUrl, file.size);
      if (offset === -1) {                    // finished while we were away
        clearSession(file);
        ui.onProgress(file.size, file.size);
        return { id: null, uploadId: session.uploadId, resumed: true, alreadyComplete: true };
      }
      confirmed = offset;
      if (offset > 0) ui.onResume(offset);
    } catch {
      clearSession(file);                     // stale or unusable; start over
      session = null;
    }
  }

  if (!session) {
    ui.onStatus('Preparing…');
    const res = await fetch('/api/upload-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessCode ? { 'x-access-code': accessCode } : {}),
      },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        uploaderName: ui.uploaderName || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server said ${res.status}.`);

    session = { uploadUrl: data.uploadUrl, uploadId: data.uploadId, createdAt: Date.now() };
    saveSession(file, session);
    confirmed = 0;
  }

  // Send what is left, one chunk at a time. `failures` counts consecutive
  // failures across chunks, so a stuck upload gives up instead of looping.
  let failures = 0;

  while (confirmed < file.size) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { permanent: true });

    const end = Math.min(confirmed + CHUNK_SIZE, file.size);

    try {
      const result = await putChunk(
        session.uploadUrl, file.slice(confirmed, end), confirmed, file.size,
        (sent) => ui.onProgress(sent, file.size),
        signal
      );

      if (result) {                            // final chunk accepted
        clearSession(file);
        ui.onProgress(file.size, file.size);
        return { id: result.id, uploadId: session.uploadId, resumed: confirmed > 0 };
      }

      confirmed = end;
      failures = 0;
      saveSession(file, { ...session, offset: confirmed });
      ui.onChunkDone?.(session.uploadId, confirmed);
    } catch (err) {
      if (err.message === 'SESSION_GONE') {
        clearSession(file);
        throw new Error('The upload session expired. Try again to start fresh.');
      }
      if (err.permanent) throw err;
      if (++failures > MAX_CHUNK_RETRIES) {
        throw new Error(`${err.message} Gave up after ${MAX_CHUNK_RETRIES} retries.`);
      }

      const wait = Math.min(1000 * 2 ** (failures - 1), 30000);
      ui.onStatus(`Connection problem — retrying in ${Math.round(wait / 1000)}s…`);
      await sleep(wait);

      // Re-ask Google where it really is; a chunk can land partially.
      try {
        const offset = await queryOffset(session.uploadUrl, file.size);
        if (offset === -1) {
          clearSession(file);
          ui.onProgress(file.size, file.size);
          return { id: null, uploadId: session.uploadId, resumed: true };
        }
        confirmed = offset;
      } catch (probeErr) {
        if (probeErr.message === 'SESSION_GONE') {
          clearSession(file);
          throw new Error('The upload session expired. Try again to start fresh.');
        }
        // Otherwise keep the offset we have and retry the same chunk.
      }
    }
  }

  clearSession(file);
  return { id: null, uploadId: session.uploadId, resumed: true };
}

export const chunkSize = CHUNK_SIZE;
