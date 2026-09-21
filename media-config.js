// media-config.js — user-submitted media: service config and the rules that
// govern what gets accepted.
//
// See _local/MEDIA_SUBMISSION_SPEC.md for the full design and
// _local/MEDIA_SETUP_STAGE2.md for the Cloudinary/Firestore setup these
// values depend on.
//
// ── WHY CLOUDINARY AND NOT DRIVE ─────────────────────────────────────────────
// The rest of this app's media lives in Google Drive, read through
// DRIVE_API_KEY in players-data.js. An API key can only READ public files —
// there is no way for a browser to upload to Drive without OAuth and a
// signed-in Google account holding write access to the folder. Since anyone
// (parents included) must be able to submit without logging in, uploads need a
// different home. Firebase Storage was the other candidate and was ruled out
// on cost: the bucket isn't provisioned and provisioning needs a Blaze upgrade.

// ── Cloudinary ───────────────────────────────────────────────────────────────
// Both values are PUBLIC by design — an unsigned upload preset is meant to be
// readable in client JS. The API SECRET is never in this repo; it lives only
// on the admin's machine for _local/archive_media.py.
//
// Cloud name only. The API KEY and API SECRET from Cloudinary's credentials
// screen must NEVER appear in this repo — it is public on GitHub Pages, so
// anything committed here is readable by anyone. The secret's only use is
// _local/archive_media.py (the purge/archive script), which runs on the
// admin's machine and reads it from the environment, never from source.
export const CLOUDINARY_CLOUD_NAME = 'q7zc6s0s';
export const CLOUDINARY_PRESET     = 'csbc_media_inbox';

/** True once the values above are filled in. Callers degrade gracefully. */
export function mediaConfigured() {
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_PRESET);
}

// ── Caps ─────────────────────────────────────────────────────────────────────
// IMPORTANT, and the opposite of the first design: these cap what is LIVE IN
// THE APP, not what can be submitted. Submission is deliberately unbounded so
// the admin always gets the choice — an eleventh photo may be the best one.
// The gate is at APPROVAL time (see canApprove in media-data.js).
export const MAX_APPROVED_PHOTOS = 10;
export const MAX_APPROVED_VIDEOS = 5;

// Abuse circuit-breaker ONLY, unrelated to the display caps above. A real
// parent will never see this: it takes 30 unreviewed items on a single player.
export const MAX_PENDING_PER_PLAYER = 30;

// ── Per-file limits ──────────────────────────────────────────────────────────
export const MAX_VIDEO_SECONDS = 30;
export const MAX_IMAGE_BYTES   = 10 * 1024 * 1024;   // 10 MB
export const MAX_VIDEO_BYTES   = 100 * 1024 * 1024;  // 100 MB

// Mirrors the preset's allowed-formats list. Enforced client-side too so a
// rejection is instant and legible instead of a generic Cloudinary 400.
export const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
export const VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'm4v'];

export const MAX_CAPTION_CHARS = 140;

// ── Delivery transformations ─────────────────────────────────────────────────
// Promoted photos become the player's headshot across every page, so they get
// face-gravity auto-crop: g_face centers the detected face and c_fill
// guarantees the square the squircle tiles expect. With no face detected
// Cloudinary falls back to a center crop — the same framing the photo would
// have gotten anyway, so it degrades quietly rather than failing.
//
// Because this is a URL transformation, the stored asset is never re-cropped
// and this can be retuned later without re-uploading anything.
const T_HEADSHOT = 'c_fill,g_face,w_800,h_800,q_auto,f_auto';
const T_THUMB    = 'c_fill,g_auto,w_400,h_400,q_auto,f_auto';
const T_FULL     = 'c_limit,w_1600,q_auto,f_auto';

function cldBase(kind = 'image') {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/${kind}/upload`;
}

/** Square, face-centered — for a promoted profile picture. */
export function headshotUrl(publicId) {
  return publicId ? `${cldBase()}/${T_HEADSHOT}/${publicId}` : null;
}

/** Square thumbnail for gallery grids and the admin queue. */
export function thumbUrl(publicId) {
  return publicId ? `${cldBase()}/${T_THUMB}/${publicId}` : null;
}

/** Full-size (bounded) image for the lightbox. */
export function fullUrl(publicId) {
  return publicId ? `${cldBase()}/${T_FULL}/${publicId}` : null;
}

/** Playable video URL. */
export function videoUrl(publicId) {
  return publicId ? `${cldBase('video')}/q_auto/${publicId}.mp4` : null;
}

/**
 * Poster frame for a video, taken at 0s.
 * Cloudinary generates this from the video itself — no separate upload.
 */
export function videoPosterUrl(publicId) {
  return publicId ? `${cldBase('video')}/${T_THUMB},so_0/${publicId}.jpg` : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function extOf(filename) {
  const m = String(filename || '').match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** 'photo' | 'video' | null, from the File's type and extension. */
export function kindOf(file) {
  const ext = extOf(file?.name);
  if (file?.type?.startsWith('image/') || IMAGE_FORMATS.includes(ext)) return 'photo';
  if (file?.type?.startsWith('video/') || VIDEO_FORMATS.includes(ext))  return 'video';
  return null;
}

/** "1:12" / "0:22" — matches how durations read in the UI. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "38.1 MB" */
export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
