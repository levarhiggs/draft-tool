// players-data.js — shared player roster data: Sheet CSV fetch, CSV parsing,
// Drive photo/video URL resolution. Used by app.js (Player Directory) and
// rotations.js (Rotations feature). Keep this module free of any page-specific
// rendering logic — it only knows how to fetch and shape player records.

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
export const SHEET_CSV_URL    = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjE0aS5--XrlMU0YAnvS_dQVontr10xdYNPg5OxDe6rkoOzvGkQZ1vsRnKjfPSPP7SHr5g7YJRKbwp/pub?output=csv';
export const PHOTOS_FOLDER_ID = '1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV';
export const VIDEOS_FOLDER_ID = '1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q';
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

// ── Sheet fetch ───────────────────────────────────────────────────────────────

export async function fetchPlayers() {
  const cached = sessionStorage.getItem('playerSheet');
  if (cached) return JSON.parse(cached);
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  const players = parseCSV(text);
  sessionStorage.setItem('playerSheet', JSON.stringify(players));
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
  const cached = sessionStorage.getItem('driveIndex');
  if (cached) { Object.assign(driveIndex, JSON.parse(cached)); return; }

  const [photos, videos] = await Promise.all([
    listDriveFolder(PHOTOS_FOLDER_ID),
    listDriveFolder(VIDEOS_FOLDER_ID),
  ]);
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
  sessionStorage.setItem('driveIndex', JSON.stringify(driveIndex));
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
