// player.js — all-players ranking view: every player on one continuously
// scrolling page so a coach can rank on the fly while scrolling instead of
// paging through "Next Player". Each row live-subscribes to its own
// Firestore doc so composite seeds update instantly as any coach saves.
import { escHtml, COL, photoUrl, videoUrl } from './app.js';
import { fetchPlayers, buildDriveIndex, ageDisplay, SEASON_CODE } from './players-data.js';
import { priorSeasons } from './player-identity.js';
import { getSeason } from './season-config.js';
import { missedTryout } from './tryout-attendance.js';
import { subscribePlayer, getPriorPlayerData, saveRanking, deleteRanking, saveNote, deleteNote, decodeRanking, saveFavorites, getFavorites } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { personByName } from './coaches-config.js';

const MISSED_TRYOUT = missedTryout(SEASON_CODE);

/**
 * A note/ranking's stored coach name is whatever that coach was called AT
 * THE TIME — old documents are never rewritten (see PRODUCT_SPEC "Coach
 * identity"). Displaying that raw string can misattribute a comment once a
 * name becomes ambiguous or changes (e.g. two coaches sharing a first name
 * across seasons — "Coach Kevin" from 26.2 is now shown as "Coach Kevin S."
 * once Fall added a second, different Kevin). Always resolve through the
 * current PERSONS list before showing a stored name to a viewer; fall back
 * to the raw string for a coach who's no longer in that list at all.
 */
function displayCoachName(storedName) {
  return personByName(storedName)?.displayNames[0] || storedName;
}

/** Same Drive thumbnail as photoUrl(), just requested at a larger size for
 *  the bio popup — the row photo stays a small w400 thumbnail. */
function biggerPhotoUrl(player) {
  const url = photoUrl(player);
  return url ? url.replace(/sz=w\d+/, 'sz=w800') : null;
}

let allPlayers = [];
// live[id] = latest Firestore doc data for that player (see firebase.js buildComposite)
const live = {};
const unsubs = {};
let pageFavorites = new Set(JSON.parse(sessionStorage.getItem('favorites') || '[]'));

async function init() {
  try {
    const [players] = await Promise.all([fetchPlayers(), buildDriveIndex()]);
    allPlayers = players.slice().sort((a, b) => {
      const na = parseFloat(a[COL.ID]), nb = parseFloat(b[COL.ID]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return 0;
    });

    const coach = getCurrentCoach();
    if (coach) {
      try {
        const saved = await getFavorites(coach.name);
        pageFavorites = new Set(saved);
        sessionStorage.setItem('favorites', JSON.stringify([...pageFavorites]));
      } catch { /* fall back to session */ }
    }

    // Prior-season data (composite + per-coach rankings/notes), per returning
    // player. Composite feeds the directory-style badge (app.js has the same
    // one); the full rankings/notes are shown read-only in the notes modal —
    // see PRODUCT_SPEC "Coach identity": old coach names are never migrated
    // or merged into this season's data, only displayed as history.
    await Promise.all(allPlayers.map(async p => {
      const prev = priorSeasons(p[COL.NAME], SEASON_CODE);
      if (prev.length) {
        const last = prev[prev.length - 1];
        const data = await getPriorPlayerData(last.season, last.id);
        if (data) {
          p._priorRank = data.composite != null ? { composite: data.composite, count: data.count, season: data.season } : null;
          p._priorData = data;
        }
      }
    }));

    renderList();
    wireModals();
    subscribeAll();

    document.addEventListener('coachChanged', () => {
      renderList();
      subscribeAll();
    });

    scrollToRequestedPlayer();
  } catch (err) {
    document.getElementById('player-list').innerHTML =
      `<div class="loading">Could not load players: ${escHtml(err.message)}</div>`;
    console.error(err);
  }
}

function scrollToRequestedPlayer() {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) return;
  const row = document.getElementById(`player-row-${cssId(id)}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('player-row-highlight');
  setTimeout(() => row.classList.remove('player-row-highlight'), 2000);
}

function cssId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// ── Live Firestore subscriptions — one per player, all at once ────────────────

function subscribeAll() {
  allPlayers.forEach(p => {
    const id = String(p[COL.ID]);
    if (unsubs[id]) return; // already subscribed
    unsubs[id] = subscribePlayer(id, data => {
      live[id] = data;
      renderRowLive(id);
    });
  });
}

// ── Render: full list shell (built once; live bits patched in separately) ────

function renderList() {
  const container = document.getElementById('player-list');
  const coach = getCurrentCoach();
  container.innerHTML = allPlayers.map(p => rowHTML(p, !!coach)).join('');

  allPlayers.forEach(p => wireRow(p));
}

function rowHTML(p, isLoggedIn) {
  const id    = String(p[COL.ID]);
  const name  = p[COL.NAME] || 'Unknown';
  const photo = photoUrl(p);
  const video = videoUrl(p);
  const isFav = pageFavorites.has(id);

  const photoHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" loading="lazy" class="rank-row-photo-img" />`
    : `<div class="rank-row-photo-placeholder">🏀</div>`;

  const videoIconHtml = video
    ? `<button class="rank-row-video-btn" data-action="video" title="Watch tryout video">▶<span>VIDEO</span></button>`
    : `<button class="rank-row-video-btn disabled" disabled title="No video available">▶<span>NO VIDEO</span></button>`;

  const rankingHtml = isLoggedIn ? rankingMechanismHTML(p) : `
    <div class="coach-panel-locked rank-row-locked">
      Log in as a coach to submit rankings and notes.
    </div>`;

  return `
    <div class="rank-row" id="player-row-${cssId(id)}" data-id="${escHtml(id)}">
      <div class="rank-row-photo stat-box-photo-wrap" data-action="bio" title="Tap for age, birthday, grade &amp; badges">
        ${photoHtml}
        <button class="profile-heart-btn${isFav ? ' active' : ''}" data-action="favorite"
                title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
      </div>

      <div class="rank-row-main">
        <div class="rank-row-headline">
          <div class="rank-row-name">${escHtml(id)} ${escHtml(name)}</div>
        </div>

        <div class="rank-row-mechanism" data-role="mechanism">${rankingHtml}</div>
      </div>

      <div class="rank-row-side">
        <div class="stat-box clickable rank-row-composite${isLoggedIn ? '' : ' hidden'}"
             data-action="composite" title="Click to see breakdown">
          <div class="stat-label">Composite Seed</div>
          <div class="stat-value" data-role="composite-value">—</div>
        </div>
        ${videoIconHtml}
      </div>
    </div>`;
}

function rankingMechanismHTML(p) {
  const id    = String(p[COL.ID]);
  const coach = getCurrentCoach();
  if (!coach) return '';

  const data = live[id] || { rankings: {}, modifiers: {}, notes: {}, team: '' };
  const { seed: savedSeed, modifier: savedModifier } = decodeRanking(
    data.rankings[coach.name] ?? null, data.modifiers, coach.name
  );
  const myNote = data.notes[coach.name] ?? '';

  const seedButtons = [1,2,3,4,5,6,7,8].map(n => `
    <button class="seed-btn${savedSeed === n ? ' selected' : ''}" data-seed="${n}">${n}</button>
  `).join('');
  const modifierButtons = ['Strong', 'Mid', 'Low'].map(m => `
    <button class="mod-btn${savedModifier === m ? ' selected' : ''}" data-mod="${m}">${m}</button>
  `).join('');

  return `
    <div class="seed-section">
      <div class="seed-label">Seed</div>
      <div class="seed-buttons">
        ${seedButtons}
        <div class="mod-divider"></div>
        ${modifierButtons}
        ${savedSeed !== null ? `<button class="btn-link seed-clear-btn" data-role="clear-seed">Clear my seed</button>` : ''}
      </div>
    </div>
    <label class="rank-row-notes-field">Your Notes <span class="notes-hint">(be respectful in your public commentary)</span>
      <textarea data-role="note-input" placeholder="Observations, strengths, concerns…">${escHtml(myNote)}</textarea>
    </label>
    <button class="btn-link rank-row-notes-link" data-action="notes">View all coach notes ↓</button>
    <div class="save-status" data-role="save-status"></div>`;
}

// ── Row wiring (event handlers) — bound once per row at render time ──────────

function wireRow(p) {
  const id  = String(p[COL.ID]);
  const row = document.getElementById(`player-row-${cssId(id)}`);
  if (!row) return;

  row.querySelector('[data-action="favorite"]')
    ?.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleFavorite(id); });

  row.querySelector('[data-action="bio"]')
    ?.addEventListener('click', () => openBioModal(p));

  row.querySelector('[data-action="composite"]')
    ?.addEventListener('click', () => openRankingsModal(id));

  row.querySelector('[data-action="video"]')
    ?.addEventListener('click', () => openVideoModal(p));

  wireMechanism(p);
}

function wireMechanism(p) {
  const id  = String(p[COL.ID]);
  const row = document.getElementById(`player-row-${cssId(id)}`);
  const mech = row?.querySelector('[data-role="mechanism"]');
  const coach = getCurrentCoach();
  if (!mech || !coach) return;

  const data = live[id] || { rankings: {}, modifiers: {} };
  let { seed: selectedSeed, modifier: selectedModifier } = decodeRanking(
    data.rankings[coach.name] ?? null, data.modifiers, coach.name
  );

  mech.querySelector('[data-action="notes"]')
    ?.addEventListener('click', () => openNotesModal(p));

  const status = mech.querySelector('[data-role="save-status"]');

  const commitRanking = async () => {
    if (selectedSeed === null) return;
    status.style.color = 'var(--clr-muted)';
    status.textContent = 'Saving…';
    try {
      await saveRanking(id, coach.name, selectedSeed, selectedModifier);
      status.style.color = 'var(--clr-success)';
      status.textContent = 'Saved!';
      setTimeout(() => { if (status.textContent === 'Saved!') status.textContent = ''; }, 2000);
    } catch (err) {
      status.style.color = 'var(--clr-danger)';
      status.textContent = err.message;
    }
  };

  mech.querySelectorAll('.seed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedSeed = parseInt(btn.dataset.seed);
      mech.querySelectorAll('.seed-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      commitRanking();
    });
  });

  mech.querySelectorAll('.mod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedModifier = selectedModifier === btn.dataset.mod ? null : btn.dataset.mod;
      mech.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('selected'));
      if (selectedModifier) btn.classList.add('selected');
      commitRanking();
    });
  });

  mech.querySelector('[data-role="clear-seed"]')?.addEventListener('click', async () => {
    selectedSeed = null;
    selectedModifier = null;
    status.style.color = 'var(--clr-muted)';
    status.textContent = 'Clearing…';
    try {
      await deleteRanking(id, coach.name);
      status.style.color = 'var(--clr-success)';
      status.textContent = 'Cleared';
      setTimeout(() => { if (status.textContent === 'Cleared') status.textContent = ''; }, 2000);
    } catch (err) {
      status.style.color = 'var(--clr-danger)';
      status.textContent = err.message;
    }
  });

  const noteInput = mech.querySelector('[data-role="note-input"]');
  if (noteInput) {
    let saveTimer = null;
    noteInput.addEventListener('input', () => {
      clearTimeout(saveTimer);
      status.style.color = 'var(--clr-muted)';
      status.textContent = 'Typing…';
      saveTimer = setTimeout(async () => {
        const text = noteInput.value.trim();
        try {
          if (text) await saveNote(id, coach.name, text);
          else await deleteNote(id, coach.name);
          status.style.color = 'var(--clr-success)';
          status.textContent = 'Saved!';
          setTimeout(() => { if (status.textContent === 'Saved!') status.textContent = ''; }, 2000);
        } catch (err) {
          status.style.color = 'var(--clr-danger)';
          status.textContent = err.message;
        }
      }, 800);
    });
  }

}

// ── Live patch: composite seed value + re-render mechanism on external change ─

function renderRowLive(id) {
  const row = document.getElementById(`player-row-${cssId(id)}`);
  if (!row) return;
  const data = live[id];

  const compositeVal = row.querySelector('[data-role="composite-value"]');
  if (compositeVal) compositeVal.textContent = data.composite !== null ? data.composite.toFixed(1) : '—';

  // Re-render just this row's ranking mechanism so a coach's own saved
  // selection stays reflected, without touching the note textarea
  // mid-keystroke.
  const mech = row.querySelector('[data-role="mechanism"]');
  const noteInput = mech?.querySelector('[data-role="note-input"]');
  const isTyping = document.activeElement === noteInput;
  if (mech && !isTyping) {
    const p = allPlayers.find(pl => String(pl[COL.ID]) === id);
    mech.innerHTML = rankingMechanismHTML(p);
    wireMechanism(p);
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────

async function toggleFavorite(id) {
  if (pageFavorites.has(id)) pageFavorites.delete(id);
  else pageFavorites.add(id);
  const isFav = pageFavorites.has(id);

  const btn = document.querySelector(`#player-row-${cssId(id)} [data-action="favorite"]`);
  if (btn) {
    btn.classList.toggle('active', isFav);
    btn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  }

  sessionStorage.setItem('favorites', JSON.stringify([...pageFavorites]));
  const coach = getCurrentCoach();
  if (coach) {
    try { await saveFavorites(coach.name, [...pageFavorites]); } catch { /* silent */ }
  }
}

// ── Bio modal: Age / Birthday / Grade + badges ─────────────────────────────────

function openBioModal(p) {
  const id = String(p[COL.ID]);
  const name = p[COL.NAME] || 'Unknown';
  document.getElementById('bio-modal-name').textContent = name;

  const age      = ageDisplay(p[COL.AGE]);
  const birthday = String(p[COL.AGE] || '').trim() || '—';
  const grade    = p[COL.GRADE] || '—';
  const coach    = getCurrentCoach();

  const badges = [];
  const prior = priorSeasons(name, SEASON_CODE);
  if (prior.length) {
    const seasons = prior.map(e => escHtml(getSeason(e.season).name)).join(', ');
    badges.push(`<span class="player-card-returning" title="Played in ${seasons}">↩ Returning</span>`);
    const pr = p._priorRank;
    if (pr && pr.composite != null) {
      badges.push(`<span class="player-card-prevrank" title="${
        escHtml(getSeason(pr.season).name)} composite seed from ${pr.count} coach${
        pr.count === 1 ? '' : 'es'}">Prev. Rank: ${pr.composite.toFixed(1)}</span>`);
    }
  }
  if (MISSED_TRYOUT.has(id)) {
    badges.push('<span class="player-card-missed" title="Did not attend Fall 2026 tryouts">✕ Missed Tryout</span>');
  }
  const data = live[id];
  const teamName = (coach && data?.team) || p[COL.TEAM] || '';
  badges.push(teamName
    ? `<span class="player-card-returning" title="Team assignment">${escHtml(teamName)}</span>`
    : `<span class="player-card-missed" title="Not yet drafted to a team">Undrafted</span>`);
  const badgesHtml = badges.length
    ? `<div class="player-card-badges bio-modal-badges">${badges.join('')}</div>` : '';

  const bigPhoto = biggerPhotoUrl(p);
  const photoHtml = bigPhoto
    ? `<img src="${bigPhoto}" alt="${escHtml(name)}" class="bio-modal-photo-img" />`
    : `<div class="bio-modal-photo-placeholder">🏀</div>`;

  const compositeHtml = coach ? `
    <div class="stat-box bio-modal-composite">
      <div class="stat-label">Composite Seed</div>
      <div class="stat-value">${data?.composite != null ? data.composite.toFixed(1) : '—'}</div>
    </div>` : '';

  const video = videoUrl(p);
  const videoTileHtml = video
    ? `<button class="rank-row-video-btn player-modal-video-tile" data-action="video" title="Watch tryout video">▶<span>VIDEO</span></button>`
    : `<button class="rank-row-video-btn player-modal-video-tile disabled" disabled title="No video available">▶<span>NO VIDEO</span></button>`;

  const noteEntries = Object.entries(data?.notes || {}).filter(([, v]) => v && v.trim());
  const notesHtml = noteEntries.length ? `
    <div class="notes-modal-current-header bio-modal-notes-header">Coach Notes</div>
    <div class="notes-list">
      ${noteEntries.map(([coachName, note]) => `
        <div class="note-item">
          <div class="note-coach-row"><span class="note-coach">${escHtml(displayCoachName(coachName))}</span></div>
          <div class="note-text">${escHtml(note)}</div>
        </div>`).join('')}
    </div>` : '';

  document.getElementById('bio-modal-body').innerHTML = `
    <div class="bio-modal-photo">${photoHtml}</div>
    <div class="stats-grid bio-modal-stats">
      <div class="stat-box">
        <div class="stat-label">Age</div>
        <div class="stat-value">${escHtml(age)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Birthday</div>
        <div class="stat-value bio-modal-birthday">${escHtml(birthday)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Grade</div>
        <div class="stat-value">${escHtml(grade)}</div>
      </div>
      ${compositeHtml}
      ${videoTileHtml}
    </div>
    ${badgesHtml}
    ${notesHtml}
  `;

  document.getElementById('bio-modal-body').querySelector('[data-action="video"]')
    ?.addEventListener('click', () => openVideoModal(p));

  document.getElementById('modal-bio').classList.remove('hidden');
}

// ── Notes modal ───────────────────────────────────────────────────────────────

function openNotesModal(p) {
  const id    = String(p[COL.ID]);
  const coach = getCurrentCoach();
  const data  = live[id] || { notes: {} };
  const entries = Object.entries(data.notes || {}).filter(([, v]) => v && v.trim());

  const currentHtml = entries.length ? `
    <div class="notes-list">
      ${entries.map(([coachName, note]) => `
        <div class="note-item">
          <div class="note-coach-row">
            <span class="note-coach">${escHtml(displayCoachName(coachName))}</span>
            ${coach && coachName === coach.name
              ? `<button class="btn-delete-note" data-coach="${escHtml(coachName)}">Delete</button>`
              : ''}
          </div>
          <div class="note-text">${escHtml(note)}</div>
        </div>`).join('')}
    </div>` : '<div class="coach-panel-locked">No notes yet.</div>';

  // Read-only history from a prior season — never written into this
  // season's data (see PRODUCT_SPEC "Coach identity"), just shown for
  // context on a returning player.
  const prior = p._priorData;
  let priorHtml = '';
  if (prior && (Object.keys(prior.rankings || {}).length || Object.keys(prior.notes || {}).length)) {
    const seasonName = escHtml(getSeason(prior.season).name);
    const priorRankings = Object.entries(prior.rankings || {})
      .map(([coachName, val]) => `<div class="note-item prior-note-item">
          <div class="note-coach-row"><span class="note-coach">${escHtml(displayCoachName(coachName))}</span></div>
          <div class="note-text">Seed: ${parseFloat(val).toFixed(1)}</div>
        </div>`).join('');
    const priorNotes = Object.entries(prior.notes || {})
      .filter(([, v]) => v && v.trim())
      .map(([coachName, note]) => `<div class="note-item prior-note-item">
          <div class="note-coach-row"><span class="note-coach">${escHtml(displayCoachName(coachName))}</span></div>
          <div class="note-text">${escHtml(note)}</div>
        </div>`).join('');
    priorHtml = `
      <div class="notes-modal-prior-header">From ${seasonName} (read-only)</div>
      <div class="notes-list">${priorRankings}${priorNotes}</div>`;
  }

  const body = document.getElementById('notes-modal-body');
  body.innerHTML = `
    <div class="notes-modal-current-header">This Season</div>
    ${currentHtml}
    ${priorHtml}
  `;

  body.querySelectorAll('.btn-delete-note').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await deleteNote(id, btn.dataset.coach);
        openNotesModal(p);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        alert('Could not delete note: ' + err.message);
      }
    });
  });

  document.getElementById('modal-notes').classList.remove('hidden');
}

// ── Rankings breakdown modal ───────────────────────────────────────────────────

function openRankingsModal(id) {
  const data = live[id] || { rankings: {} };
  const display = document.getElementById('rank-composite-display');
  const tbody    = document.getElementById('rank-table-body');
  const footer   = document.getElementById('rank-footer');

  const entries = Object.entries(data.rankings || {})
    .map(([coach, val]) => ({ coach: displayCoachName(coach), val: parseFloat(val) }))
    .filter(e => !isNaN(e.val))
    .sort((a, b) => b.val - a.val);

  const count = entries.length;
  const composite = count ? entries.reduce((s, e) => s + e.val, 0) / count : null;

  display.textContent = composite !== null
    ? `Composite Seed: ${composite.toFixed(1)}`
    : 'No seeds submitted yet';

  tbody.innerHTML = entries.length
    ? entries.map(e => `<tr><td>${escHtml(e.coach)}</td><td>${e.val.toFixed(1)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="no-rankings-msg">No seeds submitted yet.</td></tr>`;

  const footerLines = [`Average of ${count} seed${count !== 1 ? '' : ''}`];
  if (count >= 2) {
    const min = Math.min(...entries.map(e => e.val));
    const max = Math.max(...entries.map(e => e.val));
    footerLines.push(`Range: ${min.toFixed(1)} – ${max.toFixed(1)}`);
  }
  footer.innerHTML = footerLines.map(l => `<div>${l}</div>`).join('');

  document.getElementById('modal-rankings').classList.remove('hidden');
}

// ── Video modal ───────────────────────────────────────────────────────────────

function openVideoModal(p) {
  const video = videoUrl(p);
  if (!video) return;
  document.getElementById('video-modal-body').innerHTML =
    `<iframe class="profile-video" src="${video}" allowfullscreen allow="autoplay"></iframe>`;
  document.getElementById('modal-video').classList.remove('hidden');
}

function closeVideoModal() {
  document.getElementById('modal-video').classList.add('hidden');
  document.getElementById('video-modal-body').innerHTML = ''; // stop playback
}

// ── Modal wiring (close buttons + backdrop click) ─────────────────────────────

function wireModals() {
  const closers = [
    ['modal-bio',      'btn-bio-close'],
    ['modal-notes',    'btn-notes-close'],
    ['modal-rankings', 'btn-rankings-close'],
  ];
  closers.forEach(([modalId, btnId]) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      document.getElementById(modalId).classList.add('hidden');
    });
    document.getElementById(modalId)?.addEventListener('click', e => {
      if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
    });
  });

  document.getElementById('btn-video-close')?.addEventListener('click', closeVideoModal);
  document.getElementById('modal-video')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVideoModal();
  });
}

// ── Service worker registration ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/draft-tool/sw.js');
}

init();
