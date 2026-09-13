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
  // A failed/rate-limited Drive call resolves to [] (see listDriveFolder's
  // catch) — skip caching in that case so a transient failure can't get
  // permanently "stuck" as an empty index for the rest of the session.
  if (photos.length === 0 && videos.length === 0) return;
  photos.forEach(({ name, id }) => {
    const pid = stripExtension(name);
    if (!driveIndex[pid]) driveIndex[pid] = {};
    driveIndex[pid].photoId = id;
  });
  videos.forEach(({ name, id }) => {
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
  if (icons.length === 0) return; // don't cache a failed/empty fetch
  icons.forEach(({ name, id }) => {
    iconIndex[stripExtension(name)] = id;
  });
  sessionStorage.setItem(CK_ICONS, JSON.stringify(iconIndex));
}

export function iconUrl(colorName) {
  const fileId = iconIndex[colorName];
  return fileId ? driveFileUrl(fileId, 'img') : null;
}

async function listDriveFolder(folderId) {
  const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents`)}&fields=files(id,name)&key=${DRIVE_API_KEY}`;
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch { return []; }
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
