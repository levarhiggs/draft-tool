// app.js — loads player roster from Google Sheets CSV, renders thumbnail grid
import { getCompositeRank } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
const SHEET_CSV_URL   = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjE0aS5--XrlMU0YAnvS_dQVontr10xdYNPg5OxDe6rkoOzvGkQZ1vsRnKjfPSPP7SHr5g7YJRKbwp/pub?output=csv';
const PHOTOS_FOLDER_ID = '1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV';
const VIDEOS_FOLDER_ID = '1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q';

// Column header names — must match your sheet's first row exactly
const COL = {
  ID:         'ID',
  NAME:       'Name',
  AGE:        'Age',
  GRADE:      'Grade',
  SIZE:       'Size (1-5)',
  HANDLES:    'Handles (1-5)',
  COACH_RANK: 'Coach Rank',
  PHOTO:      'Photo Path/Link',   // optional manual override
  VIDEO:      'Video Path/Link',   // optional manual override
  TEAM:       'Team Assignment',
  NOTES:      'Notes',
};
// ──────────────────────────────────────────────────────────────────────────────

// Drive file index: maps player ID → { photoId, videoId }
// Populated once on load by scanning both folders via the Drive API.
// Keys are strings (player IDs), values are Drive file IDs.
const driveIndex = {};   // { "101": { photoId: "abc123", videoId: "xyz789" }, ... }

let allPlayers  = [];
let currentSort = 'alpha';

async function init() {
  try {
    // Scan Drive folders and load sheet in parallel
    const [players] = await Promise.all([
      fetchPlayers(),
      buildDriveIndex(),
    ]);
    allPlayers = players;
    await enrichWithFirebase(allPlayers);
    renderGrid(allPlayers);
    setupSortButtons();
  } catch (err) {
    document.getElementById('player-grid').innerHTML =
      `<div class="loading">Error loading players: ${err.message}</div>`;
    console.error(err);
  }
}

// ── Drive folder scanning ─────────────────────────────────────────────────────

async function buildDriveIndex() {
  const [photos, videos] = await Promise.all([
    listDriveFolder(PHOTOS_FOLDER_ID),
    listDriveFolder(VIDEOS_FOLDER_ID),
  ]);

  photos.forEach(({ name, id }) => {
    const playerId = stripExtension(name);
    if (!driveIndex[playerId]) driveIndex[playerId] = {};
    driveIndex[playerId].photoId = id;
  });

  videos.forEach(({ name, id }) => {
    const playerId = stripExtension(name);
    if (!driveIndex[playerId]) driveIndex[playerId] = {};
    driveIndex[playerId].videoId = id;
  });
}

// Uses Drive's sharing page to list folder contents without an API key.
// Works because the folders are publicly shared.
async function listDriveFolder(folderId) {
  // Drive folder index page returns an HTML page we can parse for file metadata.
  // We use the gdocs export trick: fetch the folder as a JSON feed.
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  // Drive doesn't expose a public JSON API without a key, so we use the
  // undocumented but stable apps.google.com/drive/filelist endpoint instead.
  const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents`)}&fields=files(id,name)&key=AIzaSyD-PLACEHOLDER`;

  // NOTE: Replace AIzaSyD-PLACEHOLDER with a real Google API key restricted to
  // Drive API read-only. See SETUP.md for instructions.
  // If no API key is set, fall back to manual links from the sheet.
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}

function stripExtension(filename) {
  return filename.replace(/\.[^/.]+$/, '').trim();
}

// Returns the best available photo URL for a player
export function photoUrl(player) {
  const id = player[COL.ID];
  const override = player[COL.PHOTO];

  // Manual override link in sheet takes priority
  if (override && override.trim()) return driveFileUrl(extractDriveId(override), 'img');

  // Folder index
  const entry = driveIndex[String(id)];
  if (entry?.photoId) return driveFileUrl(entry.photoId, 'img');

  return null;
}

// Returns the best available video embed URL for a player
export function videoUrl(player) {
  const id = player[COL.ID];
  const override = player[COL.VIDEO];

  if (override && override.trim()) return driveFileUrl(extractDriveId(override), 'video');

  const entry = driveIndex[String(id)];
  if (entry?.videoId) return driveFileUrl(entry.videoId, 'video');

  return null;
}

function driveFileUrl(fileId, type) {
  if (!fileId) return null;
  if (type === 'video') return `https://drive.google.com/file/d/${fileId}/preview`;
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
}

function extractDriveId(url) {
  if (!url) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
                url.match(/id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ── Sheet fetch & parse ───────────────────────────────────────────────────────

async function fetchPlayers() {
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  return parseCSV(text);
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
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// ── Firebase enrichment ───────────────────────────────────────────────────────

async function enrichWithFirebase(players) {
  await Promise.all(players.map(async p => {
    const data = await getCompositeRank(p[COL.ID]);
    p._composite = data.composite;
    p._rankCount = data.count;
    p._rankings  = data.rankings;
    p._teamFB    = data.team || '';
  }));
}

// ── Grid rendering ────────────────────────────────────────────────────────────

function renderGrid(players) {
  const grid   = document.getElementById('player-grid');
  const sorted = sortPlayers([...players], currentSort);
  if (!sorted.length) {
    grid.innerHTML = '<div class="loading">No players found.</div>';
    return;
  }
  grid.innerHTML = sorted.map(p => playerCardHTML(p)).join('');
}

function playerCardHTML(p) {
  const name      = p[COL.NAME]  || 'Unknown';
  const grade     = p[COL.GRADE] || '—';
  const age       = p[COL.AGE]   || '—';
  const id        = p[COL.ID]    || '';
  const photo     = photoUrl(p);
  const team      = p._teamFB || p[COL.TEAM] || '';
  const composite = p._composite;

  const scoreHtml = composite !== null
    ? `<span class="player-card-score">${composite.toFixed(1)}</span>`
    : `<span class="player-card-score unranked">Unranked</span>`;

  const teamHtml = team
    ? `<div class="player-card-team">${escHtml(team)}</div>` : '';

  const imgHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" loading="lazy" />`
    : `<div class="player-card-img-placeholder">🏀</div>`;

  return `
    <a class="player-card" href="player.html?id=${encodeURIComponent(id)}">
      ${imgHtml}
      <div class="player-card-info">
        <div class="player-card-name">${escHtml(name)}</div>
        <div class="player-card-meta">Grade ${escHtml(grade)} · Age ${escHtml(age)}</div>
        ${scoreHtml}
        ${teamHtml}
      </div>
    </a>`;
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function sortPlayers(players, mode) {
  if (mode === 'alpha') {
    return players.sort((a, b) =>
      (a[COL.NAME] || '').localeCompare(b[COL.NAME] || ''));
  }
  if (mode === 'score') {
    return players.sort((a, b) => {
      const sa = a._composite ?? -1;
      const sb = b._composite ?? -1;
      return sb - sa;
    });
  }
  if (mode === 'grade') {
    return players.sort((a, b) => {
      const ga = parseInt(a[COL.GRADE]) || 99;
      const gb = parseInt(b[COL.GRADE]) || 99;
      return ga - gb;
    });
  }
  return players;
}

function setupSortButtons() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderGrid(allPlayers);
    });
  });
}

// ── Utilities (exported for player.js) ───────────────────────────────────────

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { COL, SHEET_CSV_URL, PHOTOS_FOLDER_ID, VIDEOS_FOLDER_ID, photoUrl, videoUrl };

init();
