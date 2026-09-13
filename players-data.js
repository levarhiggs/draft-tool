// players-data.js — shared player roster data: Sheet CSV fetch, CSV parsing,
// Drive photo/video URL resolution. Used by app.js (Player Directory) and
// rotations.js (Rotations feature). Keep this module free of any page-specific
// rendering logic — it only knows how to fetch and shape player records.

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
// Per-season values (sheet URL + Drive folder IDs) now live in season-config.js
// so a new season is onboarded by editing ONE file. The exports below are kept
// as live getters so existing importers keep working unchanged.
import { resolveSeason, cacheKey } from './season-config.js';

const SEASON = resolveSeason();

export const SEASON_CODE      = SEASON.code;
export const SEASON_NAME      = SEASON.name;
export const SHEET_CSV_URL    = SEASON.sheetCsvUrl;
export const PHOTOS_FOLDER_ID = SEASON.photosFolderId;
export const VIDEOS_FOLDER_ID = SEASON.videosFolderId;
export const ICONS_FOLDER_ID  = SEASON.iconsFolderId;
export const DRIVE_API_KEY    = 'AIzaSyAoIlK4ncTUeJjPeOYJLXuj2GoWnMge3X8';

export const COL = {
  ID:         'ID',
  NAME:       'NAME',
  AGE:        'AGE',
  GRADE:      'GRADE',
  SIZE:       'SIZE (1-5)',
  HANDLES:    'HANDLES (1-5)',
  COACH_RANK: 'RANK (1-8)',
  PHOTO:      'PHOTO',
  VIDEO:      'VIDEO',
  TEAM:       'TEAM',
  NOTES:      'NOTES',
  LINKS:      'LINKS',
};
// ──────────────────────────────────────────────────────────────────────────────

// ── Age ───────────────────────────────────────────────────────────────────────
// The roster sheet's AGE column actually holds a BIRTH DATE (e.g. "1/21/2013"),
// which is what the league's registration export provides. Coaches evaluating
// players want the age, not the birthday, so every display path runs it through
// ageFromBirthdate(). Kept here (not per-page) so the directory card, the
// profile tile, and any future page all compute it the same way.

/**
 * Whole years from a M/D/YYYY birth date to today.
 * Returns null for empty/unparseable input so callers can fall back to a dash.
 */
export function ageFromBirthdate(value, today = new Date()) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let y, m, d;
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);   // M/D/YYYY
  const iso   = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);            // YYYY-MM-DD
  if (slash)    { m = +slash[1]; d = +slash[2]; y = +slash[3]; }
  else if (iso) { y = +iso[1];   m = +iso[2];   d = +iso[3];   }
  else {
    const parsed = new Date(raw);
    if (isNaN(parsed)) return null;
    y = parsed.getFullYear(); m = parsed.getMonth() + 1; d = parsed.getDate();
  }
  if (!y || !m || !d || m > 12 || d > 31) return null;

  let age = today.getFullYear() - y;
  // Not had this year's birthday yet? Then they're a year younger.
  const monthDiff = (today.getMonth() + 1) - m;
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d)) age -= 1;

  return age >= 0 && age < 120 ? age : null;
}

/** Display form: "13" (no birth date leaked to the UI), or a dash. */
export function ageDisplay(value) {
  const a = ageFromBirthdate(value);
  return a === null ? '—' : String(a);
}

const driveIndex = {};
const iconIndex = {};

// ── Sheet fetch ───────────────────────────────────────────────────────────────

export async function fetchPlayers() {
  const CK_PLAYERS = cacheKey('playerSheet', SEASON.code);
  const cached = sessionStorage.getItem(CK_PLAYERS);
  if (cached) return JSON.parse(cached);
  if (!SHEET_CSV_URL) {
    throw new Error(
      `No sheetCsvUrl configured for season ${SEASON.code} (${SEASON.name}). ` +
      `Add the published CSV url to season-config.js.`);
  }
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  // A sheet that was shared but never "Publish to web"-ed returns an HTML
  // login/preview page, which parseCSV would happily turn into garbage rows
  // instead of erroring. Catch that here rather than showing a broken roster.
  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    throw new Error(
      `Sheet URL returned HTML, not CSV — the sheet is probably not published. ` +
      `Use File > Share > Publish to web > CSV for season ${SEASON.code}.`);
  }
  const players = parseCSV(text);
  sessionStorage.setItem(CK_PLAYERS, JSON.stringify(players));
  return players;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// ── Drive folder scanning ─────────────────────────────────────────────────────

export async function buildDriveIndex() {
  const CK_DRIVE = cacheKey('driveIndex', SEASON.code);
  const cached = sessionStorage.getItem(CK_DRIVE);
  if (cached) { Object.assign(driveIndex, JSON.parse(cached)); return; }

  const [photos, videos] = await Promise.all([
    listDriveFolder(PHOTOS_FOLDER_ID),
    listDriveFolder(VIDEOS_FOLDER_ID),
  ]);

  // listDriveFolder returns null on failure, [] for an empty folder. Only
  // cache when the PHOTOS fetch actually succeeded: caching a failed photo
  // fetch pins a broken index for the whole session, and every affected
  // player silently shows no photo until the tab is closed. An empty VIDEOS
  // folder is legitimate (videos lag photos during intake), so it must not
  // block caching on its own.
  if (photos === null) {
    console.warn('Drive photo listing failed — not caching index this load.');
    return;
  }
  photos.forEach(({ name, id }) => {
    const pid = stripExtension(name);
    if (!driveIndex[pid]) driveIndex[pid] = {};
    driveIndex[pid].photoId = id;
  });
  (videos || []).forEach(({ name, id }) => {
    const pid = stripExtension(name);
    if (!driveIndex[pid]) driveIndex[pid] = {};
    driveIndex[pid].videoId = id;
  });
  sessionStorage.setItem(CK_DRIVE, JSON.stringify(driveIndex));
}

// ── Team icons (filename, minus extension, matches TEAM_COLORS[team].name) ────

export async function buildIconIndex() {
  const CK_ICONS = cacheKey('iconIndex', SEASON.code);
  const cached = sessionStorage.getItem(CK_ICONS);
  if (cached) { Object.assign(iconIndex, JSON.parse(cached)); return; }

  const icons = await listDriveFolder(ICONS_FOLDER_ID);
  // null = fetch failed (see listDriveFolder). Don't cache a failure, and
  // don't cache an empty result either -- there is no legitimate reason for
  // the icons folder to be empty, so empty means something went wrong.
  if (icons === null || icons.length === 0) return;
  icons.forEach(({ name, id }) => {
    iconIndex[stripExtension(name)] = id;
  });
  sessionStorage.setItem(CK_ICONS, JSON.stringify(iconIndex));
}

export function iconUrl(colorName) {
  const fileId = iconIndex[colorName];
  return fileId ? driveFileUrl(fileId, 'img') : null;
}

/**
 * Every file in a Drive folder.
 *
 * Returns null on FAILURE and [] for a genuinely empty folder -- the caller has
 * to tell those apart, because caching a failed fetch as an empty index makes
 * photos silently vanish for the rest of the session.
 *
 * Pages explicitly: Drive's default page size is 100, so a folder that grows
 * past that would otherwise be silently truncated.
 */
async function listDriveFolder(folderId) {
  if (!folderId) return [];
  const out = [];
  let token = '';
  try {
    do {
      const url = `https://www.googleapis.com/drive/v3/files`
        + `?q=${encodeURIComponent(`'${folderId}' in parents`)}`
        + `&fields=files(id,name),nextPageToken&pageSize=1000`
        + `&key=${DRIVE_API_KEY}`
        + (token ? `&pageToken=${token}` : '');
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      out.push(...(data.files || []));
      token = data.nextPageToken || '';
    } while (token);
    return out;
  } catch {
    return null;
  }
}

function stripExtension(f) { return f.replace(/\.[^/.]+$/, '').trim(); }

export function photoUrl(player) {
  const override = player[COL.PHOTO];
  if (override?.trim()) return driveFileUrl(extractDriveId(override), 'img');
  const entry = driveIndex[String(player[COL.ID])];
  if (entry?.photoId) return driveFileUrl(entry.photoId, 'img');
  return null;
}

export function videoUrl(player) {
  const override = player[COL.VIDEO];
  if (override?.trim()) return driveFileUrl(extractDriveId(override), 'video');
  const entry = driveIndex[String(player[COL.ID])];
  if (entry?.videoId) return driveFileUrl(entry.videoId, 'video');
  return null;
}

function driveFileUrl(fileId, type) {
  if (!fileId) return null;
  return type === 'video'
    ? `https://drive.google.com/file/d/${fileId}/preview`
    : `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
}

function extractDriveId(url) {
  if (!url) return null;
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
