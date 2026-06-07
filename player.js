// player.js — profile page: renders player data, coach panel, ranking modal
import { photoUrl, videoUrl, escHtml, COL, SHEET_CSV_URL } from './app.js';
import { subscribePlayer, getCompositeRank, saveRanking, saveNote, saveTeam, deleteNote, decodeRanking, saveFavorites, getFavorites } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_ADMINS } from './coaches-config.js';

let playerId   = null;
let playerData = null;
let liveData   = null;
let unsubscribe = null;
let pageFavorites = new Set(JSON.parse(sessionStorage.getItem('favorites') || '[]'));

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

  // Sync favorites from Firebase if logged in
  const coach = getCurrentCoach();
  if (coach) {
    try {
      const saved = await getFavorites(coach.name);
      pageFavorites = new Set(saved);
      sessionStorage.setItem('favorites', JSON.stringify([...pageFavorites]));
    } catch { /* fall back to session */ }
  }

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

  const isFav = pageFavorites.has(String(p[COL.ID]));
  const photoTileHtml = photo
    ? `<div class="stat-box stat-box-photo stat-box-photo-wrap">
         <img src="${photo}" alt="${escHtml(p[COL.NAME])}" class="stat-photo-img" />
         <button class="profile-heart-btn${isFav ? ' active' : ''}" id="profile-heart" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
       </div>`
    : `<div class="stat-box stat-box-photo stat-photo-placeholder stat-box-photo-wrap">
         🏀
         <button class="profile-heart-btn${isFav ? ' active' : ''}" id="profile-heart" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
       </div>`;

  const linksRaw = (p[COL.LINKS] || '').trim();
  const ytLinks  = linksRaw ? linksRaw.split(';').map(u => u.trim()).filter(Boolean) : [];

  // If no Drive video, try embedding the first YouTube link
  let embedHtml = videoHtml;
  if (!video && ytLinks.length > 0) {
    const ytSrc = youTubeEmbedUrl(ytLinks[0]);
    if (ytSrc) {
      embedHtml = `<iframe class="profile-video" src="${ytSrc}"
        allowfullscreen allow="autoplay"></iframe>`;
    }
  }

  // Remaining YouTube links shown as buttons (skip first if it's being embedded)
  const buttonLinks = (!video && ytLinks.length > 0) ? ytLinks.slice(1) : ytLinks;
  const linksHtml = buttonLinks.length
    ? `<div class="profile-links">
        ${buttonLinks.map((url, i) => `
          <a class="profile-link-btn" href="${escHtml(url)}" target="_blank" rel="noopener">
            ▶ Video Clip ${i + 1}
          </a>`).join('')}
       </div>`
    : '';

  const main = document.getElementById('player-main');
  main.innerHTML = `
    <div class="profile-video-row">${embedHtml}</div>
    ${linksHtml}

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
          <div class="stat-sublabel">Grade ${escHtml(p[COL.GRADE] || '—')}</div>
        </div>
        <div class="stat-box clickable" id="composite-rank-box" title="Click to see breakdown">
          <div class="stat-label">Composite Seed</div>
          <div class="stat-value" id="composite-seed-value">—</div>
          <div id="your-ranking-section" class="hidden">
            <div class="stat-label your-ranking-label">Your Ranking</div>
            <div class="your-ranking-value" id="your-ranking-value"></div>
          </div>
        </div>
        <div class="stat-box" id="team-stat-box"></div>
      </div>

      <div id="coach-panel-container"></div>

      <div class="save-nav-row player-nav-standalone">
        <button class="btn-secondary btn-sm-nav" id="btn-prev-player">← Prev Player</button>
        <button class="btn-secondary btn-sm-nav" id="btn-next-player">Next Player →</button>
      </div>
    </div>
  `;

  document.getElementById('composite-rank-box')
    .addEventListener('click', () => openRankingsModal(liveData));

  document.getElementById('profile-heart')
    .addEventListener('click', toggleProfileFavorite);

  wireRankingsModal();
  wirePlayerNav();
}

async function toggleProfileFavorite() {
  const id  = String(playerData[COL.ID]);
  const btn = document.getElementById('profile-heart');
  if (pageFavorites.has(id)) {
    pageFavorites.delete(id);
  } else {
    pageFavorites.add(id);
  }
  const isFav = pageFavorites.has(id);
  btn.classList.toggle('active', isFav);
  btn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  sessionStorage.setItem('favorites', JSON.stringify([...pageFavorites]));
  const coach = getCurrentCoach();
  if (coach) {
    try { await saveFavorites(coach.name, [...pageFavorites]); } catch { /* silent */ }
  }
}

// ── Render: live sections only (no form reset) ────────────────────────────────

function renderLiveStats() {
  const live = liveData || { composite: null, rankings: {}, notes: {}, team: '' };
  const coach = getCurrentCoach();
  const isTeamAdmin = coach && TEAM_ADMINS.includes(coach.name);

  // Composite seed tile — only visible to logged-in coaches
  const rankBox = document.getElementById('composite-rank-box');
  if (rankBox) rankBox.classList.toggle('hidden', !coach);

  const seedEl = document.getElementById('composite-seed-value');
  if (seedEl) seedEl.textContent = live.composite !== null ? live.composite.toFixed(1) : '—';

  // YOUR RANKING — show coach's own decoded seed + modifier label (to one decimal)
  const yourSection = document.getElementById('your-ranking-section');
  const yourValue   = document.getElementById('your-ranking-value');
  if (yourSection && yourValue && coach) {
    const rawVal = live.rankings[coach.name] ?? null;
    const { seed, modifier } = decodeRanking(rawVal, live.modifiers, coach.name);
    if (seed !== null && rawVal !== null) {
      const label = modifier || 'Reg';
      yourValue.textContent = `${parseFloat(rawVal).toFixed(1)} · ${label}`;
      yourSection.classList.remove('hidden');
    } else {
      yourSection.classList.add('hidden');
    }
  } else if (yourSection) {
    yourSection.classList.add('hidden');
  }

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

}

function buildNotesHtml(notes, currentCoachName = null) {
  const entries = Object.entries(notes).filter(([, v]) => v && v.trim());
  if (!entries.length) return '<div class="coach-panel-locked">No notes yet.</div>';
  return `
    <div>
      <div class="section-title">Coach Notes</div>
      <div class="notes-list">
        ${entries.map(([coachName, note]) => `
          <div class="note-item">
            <div class="note-coach-row">
              <span class="note-coach">${escHtml(coachName)}</span>
              ${coachName === currentCoachName
                ? `<button class="btn-delete-note" data-coach="${escHtml(coachName)}">Delete</button>`
                : ''}
            </div>
            <div class="note-text">${escHtml(note)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderInlineNotes(currentCoachName) {
  const existing = document.getElementById('inline-notes');
  if (existing) existing.remove();

  const live = liveData || { notes: {} };
  const div = document.createElement('div');
  div.id = 'inline-notes';
  div.innerHTML = buildNotesHtml(live.notes, currentCoachName);
  document.getElementById('btn-show-notes').insertAdjacentElement('afterend', div);

  div.querySelectorAll('.btn-delete-note').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await deleteNote(playerId, currentCoachName);
        // Clear the textarea too so it doesn't re-save on next Save click
        const noteInput = document.getElementById('input-note');
        if (noteInput) noteInput.value = '';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        alert('Could not delete note: ' + err.message);
      }
    });
  });
}

// ── Coach Panel ───────────────────────────────────────────────────────────────

function renderCoachPanel() {
  const container = document.getElementById('coach-panel-container');
  if (!container) return;
  const coach = getCurrentCoach();

  if (!coach) {
    container.innerHTML = `
      <div class="coach-panel-locked">
        Log in as a coach to submit rankings, player notes and team assignments.
      </div>`;
    return;
  }

  const live        = liveData || { rankings: {}, modifiers: {}, notes: {}, team: '' };
  const myNote      = live.notes[coach.name] ?? '';
  const teamVal     = live.team || '';
  const isTeamAdmin = TEAM_ADMINS.includes(coach.name);

  const { seed: savedSeed, modifier: savedModifier } = decodeRanking(
    live.rankings[coach.name] ?? null,
    live.modifiers,
    coach.name
  );

  const seedButtons = [1,2,3,4,5,6,7,8].map(n => `
    <button class="seed-btn${savedSeed === n ? ' selected' : ''}" data-seed="${n}">${n}</button>
  `).join('');

  const modifierButtons = ['Strong', 'Mid', 'Low'].map(m => `
    <button class="mod-btn${savedModifier === m ? ' selected' : ''}" data-mod="${m}">${m}</button>
  `).join('');

  const currentTeam = teamVal || 'Undrafted';
  const teamHtml = isTeamAdmin ? `
    <label>Team Assignment
      <select id="input-team">
        ${TEAMS.map(t =>
          `<option value="${escHtml(t)}" ${currentTeam === t ? 'selected' : ''}>${escHtml(t)}</option>`
        ).join('')}
      </select>
    </label>` : '';

  container.innerHTML = `
    <div class="coach-panel">
      <h3>Your Input — ${escHtml(coach.name)}</h3>

      <div class="seed-section">
        <div class="seed-label">Seed</div>
        <div class="seed-buttons">
          ${seedButtons}
          <div class="mod-divider"></div>
          ${modifierButtons}
        </div>
      </div>

      <label>Your Notes <span class="notes-hint">(be respectful in your public commentary)</span>
        <textarea id="input-note" placeholder="Observations, strengths, concerns…">${escHtml(myNote)}</textarea>
      </label>
      <button class="btn-link" id="btn-show-notes">View all coach notes ↓</button>

      ${teamHtml}

      <button class="btn-primary" id="btn-save-coach">Save</button>
      <div class="save-status" id="save-status"></div>
    </div>`;

  // Track selected seed + modifier locally so form isn't reset on re-render
  let selectedSeed     = savedSeed;
  let selectedModifier = savedModifier;

  container.querySelectorAll('.seed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedSeed = parseInt(btn.dataset.seed);
      container.querySelectorAll('.seed-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  container.querySelectorAll('.mod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (selectedModifier === btn.dataset.mod) {
        // Toggle off — deselect
        selectedModifier = null;
        btn.classList.remove('selected');
      } else {
        selectedModifier = btn.dataset.mod;
        container.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      }
    });
  });

  document.getElementById('btn-show-notes').addEventListener('click', () => {
    const existing = document.getElementById('inline-notes');
    if (existing) { existing.remove(); return; }
    renderInlineNotes(coach.name);
  });

  document.getElementById('btn-save-coach').addEventListener('click', async () => {
    const noteVal = document.getElementById('input-note').value.trim();
    const teamVal = isTeamAdmin ? document.getElementById('input-team')?.value : null;
    const status  = document.getElementById('save-status');

    const saves = [];
    if (selectedSeed !== null) saves.push(saveRanking(playerId, coach.name, selectedSeed, selectedModifier));
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

async function wirePlayerNav() {
  const cached = sessionStorage.getItem('playerSheet');
  if (!cached) return;
  const all = JSON.parse(cached);

  // Preserve sheet row order, sorting numerically only when both IDs are numbers
  const ids = all
    .map(p => String(p[COL.ID]).trim())
    .filter(id => id)
    .sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return 0; // non-numeric IDs keep sheet order relative to each other
    });

  const currentId = String(playerId).trim();
  const idx = ids.indexOf(currentId);

  const prevId = idx > 0            ? ids[idx - 1] : null;
  const nextId = idx < ids.length - 1 ? ids[idx + 1] : null;

  const prevBtn = document.getElementById('btn-prev-player');
  const nextBtn = document.getElementById('btn-next-player');

  if (prevBtn) {
    if (prevId !== null) {
      prevBtn.addEventListener('click', () => {
        window.location.href = `player.html?id=${prevId}`;
      });
    } else {
      prevBtn.disabled = true;
      prevBtn.style.opacity = '0.35';
    }
  }

  if (nextBtn) {
    if (nextId !== null) {
      nextBtn.addEventListener('click', () => {
        window.location.href = `player.html?id=${nextId}`;
      });
    } else {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.35';
    }
  }
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
        `<tr><td>${escHtml(e.coach)}</td><td>${e.val.toFixed(1)}</td></tr>`
      ).join('')
    : `<tr><td colspan="2" class="no-rankings-msg">No seeds submitted yet.</td></tr>`;

  const footerLines = [`Average of ${count} seed${count !== 1 ? 's' : ''}`];
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

function extractYouTubeId(url) {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function youTubeEmbedUrl(url) {
  const id = extractYouTubeId(url);
  if (!id) return null;
  // Extract timestamp — supports ?t=90, ?t=1m30s, #t=90, &t=90
  const tMatch = url.match(/[?&#]t=([0-9hms]+)/);
  let start = 0;
  if (tMatch) {
    const raw = tMatch[1];
    // Parse combined formats like 1h30m45s or plain seconds
    const h = raw.match(/(\d+)h/);
    const m = raw.match(/(\d+)m/);
    const s = raw.match(/(\d+)s/);
    if (h || m || s) {
      start = (h ? parseInt(h[1]) * 3600 : 0)
            + (m ? parseInt(m[1]) * 60   : 0)
            + (s ? parseInt(s[1])        : 0);
    } else {
      start = parseInt(raw) || 0;
    }
  }
  return `https://www.youtube.com/embed/${id}${start ? `?start=${start}` : ''}`;
}

function showError(msg) {
  document.getElementById('player-main').innerHTML =
    `<div class="loading">${escHtml(msg)}</div>`;
}

// ── Swipe gestures ────────────────────────────────────────────────────────────

function wireSwipe() {
  let startX = 0;
  let startY = 0;

  document.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Only trigger if horizontal swipe is dominant and long enough
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) {
      document.getElementById('btn-next-player')?.click();
    } else {
      document.getElementById('btn-prev-player')?.click();
    }
  }, { passive: true });
}

// ── Service worker registration ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/draft-tool/sw.js');
}

wireSwipe();
init();
