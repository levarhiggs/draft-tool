// player.js — profile page: renders player data, coach panel, ranking modal
import { photoUrl, videoUrl, escHtml, COL, SHEET_CSV_URL } from './app.js';
import { subscribePlayer, getCompositeRank, saveRanking, saveNote, saveTeam } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_ADMINS } from './coaches-config.js';

let playerId   = null;
let playerData = null;
let liveData   = null;
let unsubscribe = null;

async function init() {
  const params = new URLSearchParams(window.location.search);
  playerId = params.get('id');

  if (!playerId) { showError('No player ID specified.'); return; }

  try {
    playerData = await fetchPlayer(playerId);
    if (!playerData) { showError('Player not found.'); return; }
  } catch (err) {
    showError(`Could not load player data: ${err.message}`);
    return;
  }

  document.title = `${playerData[COL.NAME]} — Draft Tool`;

  // Render shell immediately — no Firebase wait
  liveData = { composite: null, count: 0, rankings: {}, notes: {}, team: '' };
  renderShell();
  renderLiveStats();
  renderCoachPanel();

  // Fetch Firebase data in background, update only live sections
  getCompositeRank(playerId).then(data => {
    liveData = data;
    renderLiveStats();
  });

  // Live subscription updates stats + notes instantly on any save
  unsubscribe = subscribePlayer(playerId, data => {
    liveData = data;
    renderLiveStats();
  });

  document.addEventListener('coachChanged', () => renderCoachPanel());
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchPlayer(id) {
  let players;
  const cached = sessionStorage.getItem('playerSheet');
  if (cached) {
    players = JSON.parse(cached);
  } else {
    const res = await fetch(SHEET_CSV_URL);
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const text = await res.text();
    players = parseCSV(text);
    sessionStorage.setItem('playerSheet', JSON.stringify(players));
  }
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

// ── Render: static shell (video + layout, rendered once) ─────────────────────

function renderShell() {
  const p = playerData;
  const video = videoUrl(p);
  const photo = photoUrl(p);

  const videoHtml = video
    ? `<iframe class="profile-video" src="${video}" allowfullscreen allow="autoplay"></iframe>`
    : `<div class="profile-video no-video">No video available</div>`;

  const photoTileHtml = photo
    ? `<div class="stat-box stat-box-photo">
         <img src="${photo}" alt="${escHtml(p[COL.NAME])}" class="stat-photo-img" />
       </div>`
    : `<div class="stat-box stat-box-photo stat-photo-placeholder">🏀</div>`;

  const main = document.getElementById('player-main');
  main.innerHTML = `
    <div class="profile-video-row">${videoHtml}</div>

    <div class="profile-details">
      <div>
        <div class="profile-name">${escHtml(p[COL.NAME])}</div>
        <div class="profile-id">Player ID: ${escHtml(p[COL.ID])}</div>
      </div>

      <div class="stats-grid">
        ${photoTileHtml}
        <div class="stat-box">
          <div class="stat-label">Age</div>
          <div class="stat-value">${escHtml(p[COL.AGE] || '—')}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Grade</div>
          <div class="stat-value">${escHtml(p[COL.GRADE] || '—')}</div>
        </div>
        <div class="stat-box clickable" id="composite-rank-box" title="Click to see breakdown">
          <div class="stat-label">Composite Seed</div>
          <div class="stat-value" id="composite-seed-value">—</div>
        </div>
        <div class="stat-box" id="team-stat-box"></div>
      </div>

      <div id="coach-panel-container"></div>
      <div id="notes-section"></div>
    </div>
  `;

  document.getElementById('composite-rank-box')
    .addEventListener('click', () => openRankingsModal(liveData));

  wireRankingsModal();
}

// ── Render: live sections only (no form reset) ────────────────────────────────

function renderLiveStats() {
  const live = liveData || { composite: null, rankings: {}, notes: {}, team: '' };
  const coach = getCurrentCoach();
  const isTeamAdmin = coach && TEAM_ADMINS.includes(coach.name);

  // Composite seed value
  const seedEl = document.getElementById('composite-seed-value');
  if (seedEl) seedEl.textContent = live.composite !== null ? live.composite.toFixed(1) : '—';

  // Team tile — only for admins
  const teamBox = document.getElementById('team-stat-box');
  if (teamBox) {
    if (isTeamAdmin) {
      teamBox.innerHTML = `
        <div class="stat-label">Team</div>
        <div class="stat-value team-display">${escHtml(live.team || playerData[COL.TEAM] || '—')}</div>`;
      teamBox.classList.remove('hidden');
    } else {
      teamBox.classList.add('hidden');
    }
  }

  // Notes section
  const notesSection = document.getElementById('notes-section');
  if (notesSection) notesSection.innerHTML = buildNotesHtml(live.notes);
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

// ── Coach Panel ───────────────────────────────────────────────────────────────

function renderCoachPanel() {
  const container = document.getElementById('coach-panel-container');
  if (!container) return;
  const coach = getCurrentCoach();

  if (!coach) {
    container.innerHTML = `
      <div class="coach-panel-locked">
        Log in as a coach to submit your seed, notes, and team assignment.
      </div>`;
    return;
  }

  const live        = liveData || { rankings: {}, notes: {}, team: '' };
  const myRank      = live.rankings[coach.name] ?? null;
  const myNote      = live.notes[coach.name] ?? '';
  const teamVal     = live.team || '';
  const isTeamAdmin = TEAM_ADMINS.includes(coach.name);

  const seedButtons = [1,2,3,4,5,6,7,8].map(n => `
    <button class="seed-btn${myRank === n ? ' selected' : ''}" data-seed="${n}">${n}</button>
  `).join('');

  const teamHtml = isTeamAdmin ? `
    <label>Team Assignment
      <select id="input-team">
        <option value="">— not assigned —</option>
        ${TEAMS.map(t =>
          `<option value="${escHtml(t)}" ${teamVal === t ? 'selected' : ''}>${escHtml(t)}</option>`
        ).join('')}
      </select>
    </label>` : '';

  container.innerHTML = `
    <div class="coach-panel">
      <h3>Your Input — ${escHtml(coach.name)}</h3>

      <div class="seed-section">
        <div class="seed-label">Seed</div>
        <div class="seed-buttons">${seedButtons}</div>
      </div>

      <label>Your Notes <span class="notes-hint">(be respectful)</span>
        <textarea id="input-note" placeholder="Observations, strengths, concerns…">${escHtml(myNote)}</textarea>
      </label>
      <button class="btn-link" id="btn-show-notes">View all coach notes ↓</button>

      ${teamHtml}

      <button class="btn-primary" id="btn-save-coach">Save</button>
      <div class="save-status" id="save-status"></div>
    </div>`;

  // Track selected seed locally so form isn't reset on re-render
  let selectedSeed = myRank;
  container.querySelectorAll('.seed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedSeed = parseInt(btn.dataset.seed);
      container.querySelectorAll('.seed-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  document.getElementById('btn-show-notes').addEventListener('click', () => {
    const existing = document.getElementById('inline-notes');
    if (existing) { existing.remove(); return; }
    const live = liveData || { notes: {} };
    const div = document.createElement('div');
    div.id = 'inline-notes';
    div.innerHTML = buildNotesHtml(live.notes) || '<div class="coach-panel-locked">No notes yet.</div>';
    document.getElementById('btn-show-notes').insertAdjacentElement('afterend', div);
  });

  document.getElementById('btn-save-coach').addEventListener('click', async () => {
    const noteVal = document.getElementById('input-note').value.trim();
    const teamVal = isTeamAdmin ? document.getElementById('input-team')?.value : null;
    const status  = document.getElementById('save-status');

    const saves = [];
    if (selectedSeed !== null) saves.push(saveRanking(playerId, coach.name, selectedSeed));
    if (noteVal !== '')        saves.push(saveNote(playerId, coach.name, noteVal));
    if (teamVal)               saves.push(saveTeam(playerId, teamVal));

    if (saves.length === 0) {
      status.style.color = 'var(--clr-danger)';
      status.textContent = 'Select a seed or enter a note first.';
      return;
    }

    status.style.color = 'var(--clr-muted)';
    status.textContent = 'Saving…';

    try {
      await Promise.all(saves);
      status.style.color = 'var(--clr-success)';
      status.textContent = 'Saved!';
      setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (err) {
      status.style.color = 'var(--clr-danger)';
      status.textContent = err.message;
    }
  });
}

// ── Rankings Modal ────────────────────────────────────────────────────────────

function wireRankingsModal() {
  document.getElementById('btn-rankings-close')
    ?.addEventListener('click', closeRankingsModal);
  document.getElementById('modal-rankings')
    ?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeRankingsModal();
    });
}

function openRankingsModal(live) {
  const modal   = document.getElementById('modal-rankings');
  const display = document.getElementById('rank-composite-display');
  const tbody   = document.getElementById('rank-table-body');
  const footer  = document.getElementById('rank-footer');

  const rankings = live.rankings || {};
  const entries  = Object.entries(rankings)
    .map(([coach, val]) => ({ coach, val: parseFloat(val) }))
    .filter(e => !isNaN(e.val))
    .sort((a, b) => b.val - a.val);

  const count     = entries.length;
  const composite = count ? entries.reduce((s, e) => s + e.val, 0) / count : null;

  display.textContent = composite !== null
    ? `Composite Seed: ${composite.toFixed(1)}`
    : 'No seeds submitted yet';

  tbody.innerHTML = entries.length
    ? entries.map(e =>
        `<tr><td>${escHtml(e.coach)}</td><td>${e.val.toFixed(0)}</td></tr>`
      ).join('')
    : `<tr><td colspan="2" class="no-rankings-msg">No seeds submitted yet.</td></tr>`;

  const footerLines = [`Average of ${count} seed${count !== 1 ? 's' : ''}`];
  if (count >= 2) {
    const min = Math.min(...entries.map(e => e.val));
    const max = Math.max(...entries.map(e => e.val));
    footerLines.push(`Range: ${min.toFixed(0)} – ${max.toFixed(0)}`);
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
