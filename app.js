// app.js — player directory: data loading, rendering, sort, filter, favorites
import { getCompositeRank, saveFavorites, getFavorites } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
const SHEET_CSV_URL    = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjE0aS5--XrlMU0YAnvS_dQVontr10xdYNPg5OxDe6rkoOzvGkQZ1vsRnKjfPSPP7SHr5g7YJRKbwp/pub?output=csv';
const PHOTOS_FOLDER_ID = '1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV';
const VIDEOS_FOLDER_ID = '1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q';
const DRIVE_API_KEY    = 'AIzaSyAoIlK4ncTUeJjPeOYJLXuj2GoWnMge3X8';

const COL = {
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
};
// ──────────────────────────────────────────────────────────────────────────────

const driveIndex = {};

let allPlayers  = [];
let currentSort = 'alpha';

// Active filters — each is a Set of selected values; empty Set = no filter
const activeFilters = {
  grades:    new Set(),   // e.g. {6, 7}
  seeds:     new Set(),   // floor integers 1–8
  teams:     new Set(),   // team name strings
  favorites: false,       // boolean toggle
};

// Favorites: Set of player ID strings
let favorites = new Set(JSON.parse(sessionStorage.getItem('favorites') || '[]'));

async function init() {
  try {
    const [players] = await Promise.all([
      fetchPlayers(),
      buildDriveIndex(),
    ]);
    allPlayers = players;

    // Load coach favorites from Firebase if logged in
    await loadFavorites();

    renderGrid();
    setupControls();

    // Enrich with Firebase data then re-render and rebuild team chips
    await enrichWithFirebase(allPlayers);
    buildTeamChips();
    renderGrid();
  } catch (err) {
    const grid = document.getElementById('player-grid');
    if (grid) grid.innerHTML = `<div class="loading">Error loading players: ${err.message}</div>`;
    console.error(err);
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────

async function loadFavorites() {
  const coach = getCurrentCoach();
  if (!coach) return;
  try {
    const saved = await getFavorites(coach.name);
    favorites = new Set(saved);
    sessionStorage.setItem('favorites', JSON.stringify([...favorites]));
  } catch { /* fall back to session favorites */ }
}

async function persistFavorites() {
  sessionStorage.setItem('favorites', JSON.stringify([...favorites]));
  const coach = getCurrentCoach();
  if (!coach) return;
  try { await saveFavorites(coach.name, [...favorites]); } catch { /* silent */ }
}

function toggleFavorite(playerId, e) {
  e.preventDefault();
  e.stopPropagation();
  if (favorites.has(playerId)) {
    favorites.delete(playerId);
  } else {
    favorites.add(playerId);
  }
  persistFavorites();
  // Update just the heart on this card without full re-render
  const btn = document.querySelector(`.heart-btn[data-id="${playerId}"]`);
  if (btn) btn.classList.toggle('active', favorites.has(playerId));
  // If favorites filter is active, re-render to remove/add card
  if (activeFilters.favorites) renderGrid();
}

// ── Drive folder scanning ─────────────────────────────────────────────────────

async function buildDriveIndex() {
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

// ── Sheet fetch ───────────────────────────────────────────────────────────────

async function fetchPlayers() {
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

// ── Sort & Filter ─────────────────────────────────────────────────────────────

function applySort(players) {
  const arr = [...players];
  if (currentSort === 'alpha') {
    return arr.sort((a, b) => (a[COL.NAME] || '').localeCompare(b[COL.NAME] || ''));
  }
  if (currentSort === 'id') {
    return arr.sort((a, b) => parseInt(a[COL.ID] || 0) - parseInt(b[COL.ID] || 0));
  }
  if (currentSort === 'birthday') {
    return arr.sort((a, b) => (a[COL.AGE] || '').localeCompare(b[COL.AGE] || ''));
  }
  if (currentSort === 'team') {
    return arr.sort((a, b) => {
      const ta = a._teamFB || a[COL.TEAM] || 'Unassigned';
      const tb = b._teamFB || b[COL.TEAM] || 'Unassigned';
      if (ta !== tb) return ta.localeCompare(tb);
      // Within a team, sort by seed ascending (unseeded last)
      const sa = a._composite != null ? Math.floor(a._composite) : 99;
      const sb = b._composite != null ? Math.floor(b._composite) : 99;
      return sa - sb;
    });
  }
  return arr;
}

function applyFilters(players) {
  return players.filter(p => {
    // Favorites filter
    if (activeFilters.favorites && !favorites.has(String(p[COL.ID]))) return false;

    // Grade filter
    if (activeFilters.grades.size > 0) {
      const g = parseInt(p[COL.GRADE]);
      if (!activeFilters.grades.has(g)) return false;
    }

    // Seed filter (floor of composite)
    if (activeFilters.seeds.size > 0) {
      const seed = p._composite != null ? Math.floor(p._composite) : null;
      if (seed === null || !activeFilters.seeds.has(seed)) return false;
    }

    // Team filter
    if (activeFilters.teams.size > 0) {
      const team = p._teamFB || p[COL.TEAM] || '';
      if (!activeFilters.teams.has(team)) return false;
    }

    return true;
  });
}

// ── Grid rendering ────────────────────────────────────────────────────────────

function renderGrid() {
  const grid    = document.getElementById('player-grid');
  const coach   = getCurrentCoach();
  const sorted  = applySort(allPlayers);
  const visible = applyFilters(sorted);

  if (!visible.length) {
    grid.innerHTML = '<div class="loading">No players match the current filters.</div>';
    return;
  }

  if (currentSort === 'team') {
    // Group by team — emit a full-width header row before each new team
    let lastTeam = null;
    const parts = [];
    for (const p of visible) {
      const team = p._teamFB || p[COL.TEAM] || 'Unassigned';
      if (team !== lastTeam) {
        parts.push(`<div class="team-group-header">${escHtml(team)}</div>`);
        lastTeam = team;
      }
      parts.push(playerCardHTML(p, !!coach));
    }
    grid.innerHTML = parts.join('');
  } else {
    grid.innerHTML = visible.map(p => playerCardHTML(p, !!coach)).join('');
  }

  // Wire heart buttons (outside the <a> tag, so clicks don't navigate)
  grid.querySelectorAll('.heart-btn').forEach(btn => {
    btn.addEventListener('click', e => toggleFavorite(btn.dataset.id, e));
  });
}

function playerCardHTML(p, isLoggedIn) {
  const name      = p[COL.NAME] || 'Unknown';
  const grade     = p[COL.GRADE] || '—';
  const age       = p[COL.AGE]   || '—';
  const id        = p[COL.ID]    || '';
  const photo     = photoUrl(p);
  const team      = p._teamFB || p[COL.TEAM] || '';
  const composite = p._composite ?? null;
  const isFav     = favorites.has(String(id));

  // Seed only shown when logged in
  let scoreHtml = '';
  if (isLoggedIn) {
    if (composite !== null) {
      const dec = composite % 1;
      const flames = dec < 0.2 ? '🔥🔥🔥' : dec < 0.7 ? '🔥🔥' : '🔥';
      scoreHtml = `<span class="player-card-score">${composite.toFixed(1)}</span><span class="player-card-flames">${flames}</span>`;
    } else {
      scoreHtml = `<span class="player-card-score unranked">Unseeded</span>`;
    }
  }

  const teamHtml = team
    ? `<div class="player-card-team">${escHtml(team)}</div>` : '';

  const imgHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" loading="lazy" />`
    : `<div class="player-card-img-placeholder">🏀</div>`;

  return `
    <div class="player-card-wrap">
      <a class="player-card" href="player.html?id=${encodeURIComponent(id)}">
        ${imgHtml}
        <div class="player-card-info">
          <div class="player-card-name">${escHtml(id)} · ${escHtml(name)}</div>
          <div class="player-card-meta">Grade ${escHtml(grade)} · ${escHtml(age)}</div>
          ${scoreHtml}
          ${teamHtml}
        </div>
      </a>
      <button class="heart-btn${isFav ? ' active' : ''}" data-id="${escHtml(id)}"
              title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
    </div>`;
}

// ── Controls setup ────────────────────────────────────────────────────────────

function setupControls() {
  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderGrid();
    });
  });

  // Build dynamic filter chips from player data
  buildFilterChips();

  // Favorites toggle
  document.getElementById('filter-favorites')?.addEventListener('click', e => {
    activeFilters.favorites = !activeFilters.favorites;
    e.currentTarget.classList.toggle('active', activeFilters.favorites);
    renderGrid();
  });

  // Re-build team chips after Firebase enrichment (called again after enrich)
  document.addEventListener('coachChanged', () => renderGrid());
}

function buildFilterChips() {
  buildGradeChips();
  buildSeedChips();
  buildTeamChips();
}

function buildGradeChips() {
  const container = document.getElementById('filter-grades');
  if (!container) return;
  const grades = [...new Set(allPlayers.map(p => parseInt(p[COL.GRADE])).filter(Boolean))].sort((a,b)=>a-b);
  container.innerHTML = grades.map(g => `
    <button class="filter-chip" data-type="grade" data-value="${g}">Grade ${g}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.grades.has(val) ? activeFilters.grades.delete(val) : activeFilters.grades.add(val);
      btn.classList.toggle('active', activeFilters.grades.has(val));
      renderGrid();
    });
  });
}

function buildSeedChips() {
  const container = document.getElementById('filter-seeds');
  if (!container) return;
  container.innerHTML = [1,2,3,4,5,6,7,8].map(n => `
    <button class="filter-chip" data-type="seed" data-value="${n}">${n}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.seeds.has(val) ? activeFilters.seeds.delete(val) : activeFilters.seeds.add(val);
      btn.classList.toggle('active', activeFilters.seeds.has(val));
      renderGrid();
    });
  });
}

function buildTeamChips() {
  const container = document.getElementById('filter-teams');
  if (!container) return;
  const teams = [...new Set(
    allPlayers.map(p => p._teamFB || p[COL.TEAM] || '').filter(Boolean)
  )].sort();
  if (!teams.length) { container.innerHTML = '<span class="filter-empty">No teams assigned yet</span>'; return; }
  container.innerHTML = teams.map(t => `
    <button class="filter-chip" data-type="team" data-value="${escHtml(t)}">${escHtml(t)}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      activeFilters.teams.has(val) ? activeFilters.teams.delete(val) : activeFilters.teams.add(val);
      btn.classList.toggle('active', activeFilters.teams.has(val));
      renderGrid();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { COL, SHEET_CSV_URL, PHOTOS_FOLDER_ID, VIDEOS_FOLDER_ID };

init();
