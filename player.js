// player.js — profile page: renders player data, coach panel, ranking modal
import { photoUrl, videoUrl, escHtml, COL, SHEET_CSV_URL } from './app.js';
import { subscribePlayer, saveRanking, saveNote, saveTeam } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAMS } from './coaches-config.js';

let playerId   = null;
let playerData = null;       // row from Google Sheet
let liveData   = null;       // latest from Firebase
let unsubscribe = null;

async function init() {
  const params = new URLSearchParams(window.location.search);
  playerId = params.get('id');

  if (!playerId) {
    showError('No player ID specified.');
    return;
  }

  try {
    playerData = await fetchPlayer(playerId);
    if (!playerData) { showError('Player not found.'); return; }
  } catch (err) {
    showError(`Could not load player data: ${err.message}`);
    return;
  }

  document.title = `${playerData[COL.NAME]} — Draft Tool`;

  // Subscribe to live Firebase data (re-renders coach panel & stats on change)
  unsubscribe = subscribePlayer(playerId, data => {
    liveData = data;
    renderProfile();
  });

  // Re-render coach panel when login state changes
  document.addEventListener('coachChanged', () => renderCoachPanel());
}

async function fetchPlayer(id) {
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  const players = parseCSV(text);
  return players.find(p => String(p[COL.ID]).trim() === String(id).trim()) || null;
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

// ── Render ───────────────────────────────────────────────────────────────────

function renderProfile() {
  const p    = playerData;
  const live = liveData || { composite: null, count: 0, rankings: {}, notes: {}, team: '' };

  const photo = photoUrl(p);
  const video = videoUrl(p);

  const photoHtml = photo
    ? `<img class="profile-photo" src="${photo}" alt="${escHtml(p[COL.NAME])}" />`
    : `<div class="profile-photo-placeholder">🏀</div>`;

  const videoHtml = video
    ? `<iframe class="profile-video" src="${video}" allowfullscreen allow="autoplay"></iframe>`
    : `<div class="profile-video no-video">No video available</div>`;

  const compositeDisplay = live.composite !== null
    ? live.composite.toFixed(1)
    : '—';

  const team = live.team || p[COL.TEAM] || '—';

  // Notes from all coaches (read-only display)
  const notesHtml = buildNotesHtml(live.notes);

  const main = document.getElementById('player-main');
  main.innerHTML = `
    <div class="profile-video-row">
      ${videoHtml}
    </div>

    <div class="profile-media">
      ${photoHtml}
    </div>

    <div class="profile-details">
      <div>
        <div class="profile-name">${escHtml(p[COL.NAME])}</div>
        <div class="profile-id">Player ID: ${escHtml(p[COL.ID])}</div>
      </div>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Age</div>
          <div class="stat-value">${escHtml(p[COL.AGE] || '—')}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Grade</div>
          <div class="stat-value">${escHtml(p[COL.GRADE] || '—')}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Size</div>
          <div class="stat-value">${escHtml(p[COL.SIZE] || '—')}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Handles</div>
          <div class="stat-value">${escHtml(p[COL.HANDLES] || '—')}</div>
        </div>
        <div class="stat-box clickable" id="composite-rank-box" title="Click to see breakdown">
          <div class="stat-label">Composite Rank</div>
          <div class="stat-value" id="composite-rank-value">${compositeDisplay}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Team</div>
          <div class="stat-value" style="font-size:1rem">${escHtml(team)}</div>
        </div>
      </div>

      <div id="coach-panel-container"></div>

      ${notesHtml}
    </div>
  `;

  // Wire ranking modal trigger
  document.getElementById('composite-rank-box')
    .addEventListener('click', () => openRankingsModal(live));

  renderCoachPanel();
  wireRankingsModal();
}

function buildNotesHtml(notes) {
  const entries = Object.entries(notes).filter(([, v]) => v && v.trim());
  if (!entries.length) return '';
  return `
    <div>
      <div class="section-title">Coach Notes</div>
      <div class="notes-list">
        ${entries.map(([coach, note]) => `
          <div class="note-item">
            <div class="note-coach">${escHtml(coach)}</div>
            <div class="note-text">${escHtml(note)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderCoachPanel() {
  const container = document.getElementById('coach-panel-container');
  if (!container) return;
  const coach = getCurrentCoach();

  if (!coach) {
    container.innerHTML = `
      <div class="coach-panel-locked">
        Log in as a coach to submit your ranking, notes, and team assignment.
      </div>`;
    return;
  }

  const live     = liveData || { rankings: {}, notes: {}, team: '' };
  const myRank   = live.rankings[coach.name] ?? '';
  const myNote   = live.notes[coach.name]    ?? '';
  const teamVal  = live.team || '';

  const teamOptions = TEAMS.map(t =>
    `<option value="${escHtml(t)}" ${teamVal === t ? 'selected' : ''}>${escHtml(t)}</option>`
  ).join('');

  container.innerHTML = `
    <div class="coach-panel">
      <h3>Your Input — ${escHtml(coach.name)}</h3>

      <label>Your Ranking (1.0 – 8.0)
        <input type="number" id="input-rank" min="1" max="8" step="0.1"
               value="${myRank}" placeholder="e.g. 6.5" />
      </label>

      <label>Your Notes
        <textarea id="input-note" placeholder="Observations, strengths, concerns…">${escHtml(myNote)}</textarea>
      </label>

      <label>Team Assignment
        <select id="input-team">
          <option value="">— not assigned —</option>
          ${teamOptions}
        </select>
      </label>

      <button class="btn-primary" id="btn-save-coach">Save</button>
      <div class="save-status" id="save-status"></div>
    </div>`;

  document.getElementById('btn-save-coach')
    .addEventListener('click', handleSave);
}

async function handleSave() {
  const coach    = getCurrentCoach();
  if (!coach) return;

  const rankVal  = document.getElementById('input-rank').value.trim();
  const noteVal  = document.getElementById('input-note').value.trim();
  const teamVal  = document.getElementById('input-team').value;
  const status   = document.getElementById('save-status');

  status.style.color = 'var(--clr-muted)';
  status.textContent = 'Saving…';

  try {
    const saves = [];
    if (rankVal !== '') saves.push(saveRanking(playerId, coach.name, rankVal));
    if (noteVal !== '') saves.push(saveNote(playerId, coach.name, noteVal));
    if (teamVal !== '') saves.push(saveTeam(playerId, teamVal));
    await Promise.all(saves);
    status.style.color = 'var(--clr-success)';
    status.textContent = 'Saved!';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (err) {
    status.style.color = 'var(--clr-danger)';
    status.textContent = err.message;
  }
}

// ── Rankings Breakdown Modal ─────────────────────────────────────────────────

function wireRankingsModal() {
  document.getElementById('btn-rankings-close')
    ?.addEventListener('click', closeRankingsModal);
  document.getElementById('modal-rankings')
    ?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeRankingsModal();
    });
}

function openRankingsModal(live) {
  const modal    = document.getElementById('modal-rankings');
  const display  = document.getElementById('rank-composite-display');
  const tbody    = document.getElementById('rank-table-body');
  const footer   = document.getElementById('rank-footer');

  const rankings = live.rankings || {};
  const entries  = Object.entries(rankings)
    .map(([coach, val]) => ({ coach, val: parseFloat(val) }))
    .filter(e => !isNaN(e.val))
    .sort((a, b) => b.val - a.val);

  const count = entries.length;
  const composite = count
    ? entries.reduce((s, e) => s + e.val, 0) / count
    : null;

  display.textContent = composite !== null
    ? `Composite Rank: ${composite.toFixed(1)}`
    : 'No rankings yet';

  tbody.innerHTML = entries.length
    ? entries.map(e =>
        `<tr><td>${escHtml(e.coach)}</td><td>${e.val.toFixed(1)}</td></tr>`
      ).join('')
    : `<tr><td colspan="2" style="color:var(--clr-muted)">No rankings submitted yet.</td></tr>`;

  const footerLines = [`Average of ${count} ranking${count !== 1 ? 's' : ''}`];
  if (count >= 2) {
    const min = Math.min(...entries.map(e => e.val));
    const max = Math.max(...entries.map(e => e.val));
    footerLines.push(`Range: ${min.toFixed(1)} – ${max.toFixed(1)}`);
  }
  footer.innerHTML = footerLines.map(l => `<div>${l}</div>`).join('');

  modal.classList.remove('hidden');
}

function closeRankingsModal() {
  document.getElementById('modal-rankings')?.classList.add('hidden');
}

function showError(msg) {
  document.getElementById('player-main').innerHTML =
    `<div class="loading">${escHtml(msg)}</div>`;
}

init();
