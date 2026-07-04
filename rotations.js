// rotations.js — Rotations feature: team roster grid, rules engine wiring,
// drag-and-drop tile ordering, suggestion generation, localStorage persistence.
import { fetchPlayers, buildDriveIndex, photoUrl, COL } from './players-data.js';
import { getCompositeRank } from './firebase.js';
import { TEAMS } from './coaches-config.js';
import {
  computePlayerStatus, computeQuarterStatus, computeGameStatus,
  countPresent, expectedOnCourt, generateSuggestions, totalQuartersPlayed,
} from './rotations-engine.js';

// ── State ──────────────────────────────────────────────────────────────────────
// state shape:
// {
//   team: string,
//   order: [playerId, ...]            // tile order, top = first
//   players: { [id]: playerRecord }   // roster lookup for the selected team
//   pattern: { [id]: [bool,bool,bool,bool] }
//   absent: [id, ...]
// }

let allPlayers   = [];
let currentTeam  = '';
let order        = [];             // tile order of playerIds for current team
let playersById  = {};             // id -> player record (current team only)
let pattern      = new Map();      // id -> [bool,bool,bool,bool]
let absent       = new Set();
let avatarStyle  = 'photo';        // 'photo' | 'initials'

const INITIALS_COLORS = ['#4f8ef7', '#4ecf87', '#e0a75c', '#e05c5c', '#9b6fe0', '#5cc7e0', '#e05c9e', '#8890a8'];

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  try {
    [allPlayers] = await Promise.all([
      fetchPlayers(),
      buildDriveIndex(),
    ]);
  } catch (err) {
    document.getElementById('rot-empty-state').textContent = `Error loading players: ${err.message}`;
    console.error(err);
    return;
  }

  populateTeamSelect();
  wireToolbar();
  wireGenerate();
  wirePopoverDismiss();

  // Restore last-viewed team, if any, from a small "last team" pointer key
  const lastTeam = localStorage.getItem('rotations_lastTeam');
  if (lastTeam && TEAMS.includes(lastTeam)) {
    document.getElementById('rot-team-select').value = lastTeam;
    await loadTeam(lastTeam);
  }
}

function populateTeamSelect() {
  const select = document.getElementById('rot-team-select');
  select.innerHTML = '<option value="">— choose a team —</option>' +
    TEAMS.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
}

function wireToolbar() {
  document.getElementById('rot-team-select').addEventListener('change', async e => {
    const team = e.target.value;
    if (!team) {
      currentTeam = '';
      document.getElementById('rot-grid-wrap').classList.add('hidden');
      document.getElementById('rot-empty-state').classList.remove('hidden');
      document.getElementById('rot-status-banner').classList.add('hidden');
      return;
    }
    localStorage.setItem('rotations_lastTeam', team);
    await loadTeam(team);
  });

  document.querySelectorAll('.avatar-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      avatarStyle = btn.dataset.style;
      renderGrid();
    });
  });
}

// ── Team loading ───────────────────────────────────────────────────────────────

async function loadTeam(team) {
  currentTeam = team;

  // Effective team = Firestore team override if set, else the sheet's TEAM
  // column — same precedence app.js uses, so Rotations agrees with the
  // Player Directory's team assignment (which coaches can override).
  await Promise.all(allPlayers.map(async p => {
    if (p._composite === undefined) {
      const data = await getCompositeRank(p[COL.ID]);
      p._composite = data.composite;
      p._teamFB    = data.team || '';
    }
  }));

  const roster = allPlayers.filter(p => (p._teamFB || p[COL.TEAM] || '') === team);

  playersById = {};
  roster.forEach(p => { playersById[String(p[COL.ID])] = p; });

  const defaultOrder = [...roster]
    .sort((a, b) => {
      const ra = a._composite != null ? a._composite : 99;
      const rb = b._composite != null ? b._composite : 99;
      return ra - rb;
    })
    .map(p => String(p[COL.ID]));

  const saved = loadState(team);
  if (saved && saved.order && saved.order.every(id => playersById[id])) {
    order   = saved.order;
    pattern = new Map(Object.entries(saved.pattern || {}));
    absent  = new Set(saved.absent || []);
    // Append any roster players missing from saved order (e.g. roster changed)
    defaultOrder.forEach(id => { if (!order.includes(id)) order.push(id); });
  } else {
    order   = defaultOrder;
    pattern = new Map(order.map(id => [id, [false, false, false, false]]));
    absent  = new Set();
  }

  // Ensure every player in order has a pattern entry
  order.forEach(id => { if (!pattern.has(id)) pattern.set(id, [false, false, false, false]); });

  document.getElementById('rot-empty-state').classList.add('hidden');
  document.getElementById('rot-grid-wrap').classList.remove('hidden');
  renderGrid();
}

// ── Persistence ────────────────────────────────────────────────────────────────

function saveState() {
  if (!currentTeam) return;
  const data = {
    order,
    pattern: Object.fromEntries(pattern.entries()),
    absent: [...absent],
  };
  localStorage.setItem(`rotations_${currentTeam}`, JSON.stringify(data));
}

function loadState(team) {
  try {
    const raw = localStorage.getItem(`rotations_${team}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById('rot-grid');
  const N = countPresent(order, absent);
  const expected = expectedOnCourt(N);
  const gameStatus = computeGameStatus(pattern, absent, order);

  const headerRow = `
    <div class="rot-row rot-header-row">
      <div class="rot-cell-grip"></div>
      <div class="rot-cell-avatar"></div>
      <div class="rot-cell-name"></div>
      <div class="rot-cell-dot"></div>
      <div class="rot-cell-initials-ref"></div>
      ${[0, 1, 2, 3].map(q => quarterHeaderHTML(q, pattern, absent, order)).join('')}
    </div>`;

  const rows = order.map((id, idx) => playerRowHTML(id, idx, N)).join('');

  grid.innerHTML = headerRow + rows;

  renderStatusBanner(gameStatus, N, expected);
  wireGridInteractions();
}

function quarterHeaderHTML(q, pattern, absent, order) {
  const status = computeQuarterStatus(pattern, absent, order, q);
  const errClass = status.ok ? '' : ' rot-quarter-error';
  const countLine = status.ok
    ? ''
    : `<div class="rot-quarter-count">${status.count} on court</div>`;
  return `
    <button class="rot-cell-quarter-header${errClass}" data-quarter="${q}" type="button">
      Q${q + 1}${countLine}
    </button>`;
}

function playerRowHTML(id, idx, N) {
  const p = playersById[id];
  if (!p) return '';
  const name = p[COL.NAME] || 'Unknown';
  const isAbsent = absent.has(id);
  const status = computePlayerStatus(pattern, absent, id, N);
  const photo = photoUrl(p);

  const dotClass = isAbsent ? 'rot-dot-absent' : status.state === 'error' ? 'rot-dot-error' : 'rot-dot-valid';

  const rowAvatarHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" class="rot-row-avatar-img" />`
    : `<div class="rot-row-avatar-img rot-row-avatar-placeholder">🏀</div>`;

  const patternArr = pattern.get(id) || [false, false, false, false];
  const cellsHtml = [0, 1, 2, 3].map(q => quarterCellHTML(id, q, patternArr[q], isAbsent, p)).join('');

  return `
    <div class="rot-row${isAbsent ? ' rot-row-absent' : ''}" data-id="${escHtml(id)}">
      <div class="rot-cell-grip" data-action="drag-handle" aria-label="Drag to reorder">
        <span></span><span></span><span></span>
      </div>
      <div class="rot-cell-avatar rot-row-avatar${isAbsent ? ' rot-avatar-absent' : ''}" data-action="toggle-absent">
        ${rowAvatarHtml}
      </div>
      <button class="rot-cell-name" data-action="show-status" type="button">${escHtml(name)}</button>
      <div class="rot-cell-dot"><span class="rot-status-dot ${dotClass}"></span></div>
      <div class="rot-cell-initials-ref${avatarStyle === 'initials' ? ' rot-cell-ref-name-mode' : ''}">${refColumnHtml(p)}</div>
      ${cellsHtml}
    </div>`;
}

// Reference column just before Q1 — mirrors the Cell avatars toggle: shows
// a colored initials badge in "Photo" mode, or the player's first name in
// "Initials" mode (so the reference always echoes the *other* identifier,
// giving a second way to confirm tile order regardless of toggle state).
function refColumnHtml(player) {
  return avatarStyle === 'photo' ? initialsRefBadge(player) : firstNameRefLabel(player);
}

function initialsRefBadge(player) {
  const name = player[COL.NAME] || '?';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const color = playerColor(player);
  return `<div class="rot-initials-ref-badge" style="background:${color}">${escHtml(initials)}</div>`;
}

function firstNameRefLabel(player) {
  const name = player[COL.NAME] || '?';
  const firstName = name.split(/\s+/)[0] || name;
  const short = firstName.slice(0, 5).toUpperCase();
  return `<div class="rot-firstname-ref">${escHtml(short)}</div>`;
}

function playerColor(player) {
  const id = String(player[COL.ID] || '0');
  const colorIdx = [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0) % INITIALS_COLORS.length;
  return INITIALS_COLORS[colorIdx];
}

function quarterCellHTML(id, q, on, isAbsent, player) {
  if (isAbsent) {
    return `<div class="rot-cell-quarter rot-cell-disabled" data-quarter="${q}"></div>`;
  }
  let avatarHtml = '';
  if (on) {
    avatarHtml = avatarStyle === 'photo'
      ? cellPhotoAvatar(player)
      : cellInitialsAvatar(player);
  }
  return `<div class="rot-cell-quarter${on ? ' rot-cell-on' : ''}" data-id="${escHtml(id)}" data-quarter="${q}">${avatarHtml}</div>`;
}

function cellPhotoAvatar(player) {
  const photo = photoUrl(player);
  const name = player[COL.NAME] || '';
  return photo
    ? `<img src="${photo}" alt="${escHtml(name)}" class="rot-cell-avatar-img" />`
    : cellInitialsAvatar(player);
}

function cellInitialsAvatar(player) {
  const name = player[COL.NAME] || '?';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const color = playerColor(player);
  return `<div class="rot-cell-avatar-initials" style="background:${color}">${escHtml(initials)}</div>`;
}

function renderStatusBanner(gameStatus, N, expected) {
  const banner = document.getElementById('rot-status-banner');
  if (N === 0) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  if (gameStatus.valid) {
    banner.className = 'rot-status-banner rot-status-valid';
    banner.textContent = `Valid rotation — ${N} player${N === 1 ? '' : 's'} present, ${expected} on court each quarter.`;
  } else {
    banner.className = 'rot-status-banner rot-status-error';
    const parts = [];
    if (gameStatus.playerErrors) parts.push(`${gameStatus.playerErrors} player error${gameStatus.playerErrors === 1 ? '' : 's'}`);
    if (gameStatus.quarterErrors) parts.push(`${gameStatus.quarterErrors} quarter error${gameStatus.quarterErrors === 1 ? '' : 's'}`);
    banner.textContent = `Not valid — ${parts.join(', ')}. Tap a name or quarter header for details.`;
  }
}

// ── Grid interactions ────────────────────────────────────────────────────────

function wireGridInteractions() {
  const grid = document.getElementById('rot-grid');

  // Quarter cell tap = toggle on/off
  grid.querySelectorAll('.rot-cell-quarter:not(.rot-cell-disabled)').forEach(cell => {
    cell.addEventListener('click', () => {
      const id = cell.dataset.id;
      const q = parseInt(cell.dataset.quarter, 10);
      const p = pattern.get(id) || [false, false, false, false];
      p[q] = !p[q];
      pattern.set(id, p);
      saveState();
      renderGrid();
    });
  });

  // Quarter header tap = popover
  grid.querySelectorAll('.rot-cell-quarter-header').forEach(btn => {
    btn.addEventListener('click', e => {
      const q = parseInt(btn.dataset.quarter, 10);
      showQuarterPopover(btn, q);
      e.stopPropagation();
    });
  });

  // Row avatar double-tap = toggle absent
  grid.querySelectorAll('[data-action="toggle-absent"]').forEach(el => {
    let lastTap = 0;
    const trigger = () => {
      const row = el.closest('.rot-row');
      const id = row.dataset.id;
      if (absent.has(id)) absent.delete(id); else absent.add(id);
      saveState();
      renderGrid();
    };
    el.addEventListener('dblclick', trigger);
    el.addEventListener('touchend', e => {
      const now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        trigger();
      }
      lastTap = now;
    });
  });

  // Player name tap = status popover
  grid.querySelectorAll('[data-action="show-status"]').forEach(btn => {
    btn.addEventListener('click', e => {
      const row = btn.closest('.rot-row');
      const id = row.dataset.id;
      showPlayerPopover(btn, id);
      e.stopPropagation();
    });
  });

  // Row reordering via a dedicated grip handle, driven by Pointer Events so
  // it works identically for mouse and touch (native HTML5 drag-and-drop has
  // no reliable touch support on mobile browsers).
  grid.querySelectorAll('[data-action="drag-handle"]').forEach(handle => {
    handle.addEventListener('pointerdown', onGripPointerDown);
  });
}

function onGripPointerDown(e) {
  const grid = document.getElementById('rot-grid');
  const startRow = e.currentTarget.closest('.rot-row');
  const rows = Array.from(grid.querySelectorAll('.rot-row:not(.rot-header-row)'));
  let srcIdx = rows.indexOf(startRow);
  if (srcIdx === -1) return;

  e.preventDefault();
  // Pointer capture isn't used here: the dragged row is a different DOM
  // element after every renderGrid() call (innerHTML rebuild), so capture
  // set on the original element wouldn't follow the reordering row anyway.
  // document-level listeners work regardless of which element is under the
  // pointer, which is what we actually need while the row keeps swapping.
  startRow.classList.add('rot-row-dragging');

  const rowHeight = startRow.getBoundingClientRect().height;
  const startY = e.clientY;
  let currentIdx = srcIdx;

  function onMove(moveEvt) {
    const deltaY = moveEvt.clientY - startY;
    const rowsNow = Array.from(grid.querySelectorAll('.rot-row:not(.rot-header-row)'));
    const steps = Math.round(deltaY / rowHeight);
    const targetIdx = Math.max(0, Math.min(rowsNow.length - 1, srcIdx + steps));

    if (targetIdx !== currentIdx) {
      // Live-reorder the underlying `order` array and re-render, so the
      // dragged row visually swaps position as you move past a row's midpoint.
      const [moved] = order.splice(currentIdx, 1);
      order.splice(targetIdx, 0, moved);
      currentIdx = targetIdx;
      renderGrid();
      // renderGrid() rebuilds the DOM; re-acquire the dragged row and keep
      // showing the drag affordance on it, and re-arm pointer capture logic
      // via the new element (capture itself survives across re-renders only
      // if the element persists, which it doesn't after innerHTML rebuild —
      // so we track state by id instead of by element from here on).
      const newRow = grid.querySelector(`.rot-row[data-id="${CSS.escape(startRow.dataset.id)}"]`);
      if (newRow) newRow.classList.add('rot-row-dragging');
    }
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    saveState();
    renderGrid();
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

// ── Popovers ───────────────────────────────────────────────────────────────────

function wirePopoverDismiss() {
  document.addEventListener('click', () => {
    hidePopover('rot-popover');
    hidePopover('rot-quarter-popover');
  });
}

function hidePopover(id) {
  document.getElementById(id).classList.add('hidden');
}

function positionPopover(popoverEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
  popoverEl.classList.remove('hidden');
  // Clamp within viewport after showing (needs layout)
  requestAnimationFrame(() => {
    const pw = popoverEl.offsetWidth;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 8;
    if (left > maxLeft) popoverEl.style.left = `${Math.max(8, maxLeft)}px`;
  });
}

function showPlayerPopover(anchorEl, id) {
  const N = countPresent(order, absent);
  const status = computePlayerStatus(pattern, absent, id, N);
  const popover = document.getElementById('rot-popover');

  const titleClass = status.state === 'valid' ? 'rot-popover-valid'
    : status.state === 'error' ? 'rot-popover-error' : 'rot-popover-absent';
  const titleText = status.state === 'valid' ? 'Valid'
    : status.state === 'error' ? 'Error' : 'Absent';

  popover.innerHTML = `
    <div class="rot-popover-title ${titleClass}">${titleText}</div>
    <div class="rot-popover-body">${escHtml(status.reason)}</div>`;

  positionPopover(popover, anchorEl);
}

function showQuarterPopover(anchorEl, q) {
  const status = computeQuarterStatus(pattern, absent, order, q);
  const popover = document.getElementById('rot-quarter-popover');

  let body;
  if (status.ok) {
    body = `Exactly ${status.expected} on court — this quarter is set.`;
  } else {
    const diff = status.count - status.expected;
    body = diff > 0
      ? `${status.count} on court, needs ${status.expected} — remove ${diff} player${diff === 1 ? '' : 's'} from Q${q + 1}.`
      : `${status.count} on court, needs ${status.expected} — add ${-diff} player${-diff === 1 ? '' : 's'} to Q${q + 1}.`;
  }

  popover.innerHTML = `
    <div class="rot-popover-title ${status.ok ? 'rot-popover-valid' : 'rot-popover-error'}">Q${q + 1}</div>
    <div class="rot-popover-body">${escHtml(body)}</div>`;

  positionPopover(popover, anchorEl);
}

// ── Generate Options ───────────────────────────────────────────────────────────

const BATCH_SIZE = 10;
let shownSuggestions = [];   // accumulated across "see N more" clicks
let suggestionsPresentOrder = [];

function wireGenerate() {
  document.getElementById('btn-generate').addEventListener('click', () => {
    const presentOrder = order.filter(id => !absent.has(id));
    if (presentOrder.length === 0) {
      alert('No present players to generate a rotation for.');
      return;
    }
    suggestionsPresentOrder = presentOrder;
    shownSuggestions = generateSuggestions(presentOrder, BATCH_SIZE, 0);
    showSuggestionsModal();
  });

  document.getElementById('btn-suggestions-close').addEventListener('click', closeSuggestionsModal);
  document.getElementById('modal-suggestions').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSuggestionsModal();
  });
}

function showSuggestionsModal() {
  const list = document.getElementById('suggestions-list');
  renderSuggestionsList();
  document.getElementById('modal-suggestions').classList.remove('hidden');
  list.scrollTop = 0;
}

function renderSuggestionsList() {
  const list = document.getElementById('suggestions-list');
  const presentOrder = suggestionsPresentOrder;

  if (!shownSuggestions.length) {
    list.innerHTML = '<div class="loading">No legal rotation could be generated for the current roster.</div>';
    return;
  }

  const cards = shownSuggestions.map((grid, i) => suggestionCardHTML(grid, presentOrder, i)).join('');
  list.innerHTML = cards + `<button id="btn-more-suggestions" class="suggestions-more-link" type="button">See ${BATCH_SIZE} more options</button>`;

  list.querySelectorAll('.btn-apply-suggestion').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      applySuggestion(shownSuggestions[i], presentOrder);
      closeSuggestionsModal();
    });
  });

  document.getElementById('btn-more-suggestions').addEventListener('click', () => {
    const more = generateSuggestions(presentOrder, BATCH_SIZE, shownSuggestions.length);
    if (!more.length) {
      const link = document.getElementById('btn-more-suggestions');
      link.textContent = 'No more options available';
      link.disabled = true;
      return;
    }
    shownSuggestions = shownSuggestions.concat(more);
    renderSuggestionsList();
  });
}

function suggestionCardHTML(grid, presentOrder, i) {
  const miniRows = presentOrder.map(id => {
    const p = playersById[id];
    const name = (p?.[COL.NAME] || id).split(/\s+/)[0];
    const pat = grid.get(id) || [false, false, false, false];
    const cells = pat.map(on => `<span class="rot-mini-cell${on ? ' rot-mini-on' : ''}"></span>`).join('');
    const total = totalQuartersPlayed(grid, id);
    return `<div class="rot-mini-row"><span class="rot-mini-name">${escHtml(name)}</span>${cells}<span class="rot-mini-total">${total}q</span></div>`;
  }).join('');

  return `
    <div class="suggestion-card">
      <div class="suggestion-card-header">
        <span>Option ${i + 1}</span>
        <button class="btn-primary btn-apply-suggestion" type="button">Apply</button>
      </div>
      <div class="rot-mini-grid">${miniRows}</div>
    </div>`;
}

function applySuggestion(grid, presentOrder) {
  presentOrder.forEach(id => {
    pattern.set(id, (grid.get(id) || [false, false, false, false]).slice());
  });
  saveState();
  renderGrid();
}

function closeSuggestionsModal() {
  document.getElementById('modal-suggestions').classList.add('hidden');
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
