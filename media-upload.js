// media-upload.js — file validation and the Cloudinary upload itself.
//
// Validation runs TWICE on purpose:
//   1. here, before upload — so a 94 MB 72-second clip is rejected instantly
//      on the phone instead of after a long upload over gym wifi
//   2. after upload, against Cloudinary's own returned duration — that value
//      is authoritative; the client-side read is a UX shortcut, not truth
//
// Nothing here writes to Firestore. The caller records the submission only
// after a successful upload, so a failed upload leaves no dangling record.

import {
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_PRESET, mediaConfigured,
  MAX_VIDEO_SECONDS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES,
  IMAGE_FORMATS, VIDEO_FORMATS,
  kindOf, extOf, formatDuration, formatBytes,
} from './media-config.js';

/**
 * Read a video's duration without uploading it.
 *
 * Resolves null rather than rejecting when the browser can't decode the file
 * (HEVC .mov from an iPhone is the common case). The post-upload check against
 * Cloudinary's duration is the backstop, so an undecodable file is allowed
 * through here rather than blocking a legitimate submission.
 */
export function readVideoDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    // Some mobile browsers won't load metadata unless the element is muted
    // and marked playsinline.
    v.muted = true;
    v.playsInline = true;

    const done = value => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(value); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    // Don't hang the UI on a file the browser silently refuses to decode.
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

/** A still frame for the picker preview, so the user sees what they chose. */
export function readImagePreview(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Validate before upload.
 * Returns { ok, kind, durationSec, error } — `error` is written for a parent,
 * not a developer: what's wrong and what to do about it.
 */
export async function validateFile(file) {
  if (!file) return { ok: false, error: 'No file selected.' };

  const kind = kindOf(file);
  if (!kind) {
    return { ok: false, error: `That file type isn't supported. Use a photo (${IMAGE_FORMATS.slice(0, 4).join(', ')}) or a video (${VIDEO_FORMATS.slice(0, 3).join(', ')}).` };
  }

  const ext = extOf(file.name);
  const allowed = kind === 'photo' ? IMAGE_FORMATS : VIDEO_FORMATS;
  if (ext && !allowed.includes(ext)) {
    return { ok: false, kind, error: `.${ext} files aren't supported. Use ${allowed.slice(0, 3).join(', ')}.` };
  }

  const maxBytes = kind === 'photo' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return { ok: false, kind,
      error: `This ${kind === 'photo' ? 'photo' : 'clip'} is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.` };
  }

  if (kind === 'video') {
    const durationSec = await readVideoDuration(file);
    if (durationSec !== null && durationSec > MAX_VIDEO_SECONDS + 0.5) {
      return { ok: false, kind, durationSec,
        error: `Clip is ${formatDuration(durationSec)} — the limit is ${MAX_VIDEO_SECONDS} seconds. Trim it in your phone's photo app, then try again. Nothing was uploaded.` };
    }
    return { ok: true, kind, durationSec };
  }

  return { ok: true, kind, durationSec: null };
}

/**
 * Upload to Cloudinary with real progress.
 *
 * XMLHttpRequest, not fetch(), specifically for upload progress events —
 * fetch() still can't report them. A spinner alone reads as broken when a
 * 38 MB clip takes a minute on gym wifi, which is the normal case here.
 */
export function uploadToCloudinary(file, kind, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!mediaConfigured()) {
      reject(new Error('Media uploads are not configured yet. See _local/MEDIA_SETUP_STAGE2.md.'));
      return;
    }

    const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${kind === 'video' ? 'video' : 'image'}/upload`;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUDINARY_PRESET);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint, true);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data);
      } else {
        // Cloudinary's own message is the useful one (bad preset, file too
        // large, format not allowed) — surface it rather than a bare status.
        reject(new Error(data?.error?.message || `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror   = () => reject(new Error('Upload failed — check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. On a slow connection, try a shorter clip.'));
    xhr.onabort   = () => reject(new Error('Upload cancelled.'));
    xhr.timeout   = 10 * 60 * 1000;   // 10 min: a 100 MB clip on gym wifi is slow but valid

    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(fd);
  });
}

/**
 * Authoritative duration check, run against what Cloudinary actually measured.
 *
 * The client-side read can be null (undecodable file) or wrong; this is the
 * value of record. A clip that fails here was already uploaded, so the caller
 * must NOT write a Firestore record for it — leaving an orphan asset that
 * _local/preflight.py will flag.
 */
export function durationWithinLimit(cloudinaryResult) {
  const d = Number(cloudinaryResult?.duration);
  if (!Number.isFinite(d)) return true;       // images, or no duration reported
  return d <= MAX_VIDEO_SECONDS + 0.5;
}
