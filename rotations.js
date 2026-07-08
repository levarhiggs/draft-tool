// rotations.js — Rotations feature: team roster grid, rules engine wiring,
// drag-and-drop tile ordering, suggestion generation, localStorage persistence.
import { fetchPlayers, buildDriveIndex, photoUrl, COL } from './players-data.js';
import {
  getCompositeRank, getRotationConfigs, saveRotationConfig, renameRotationConfig,
  deleteRotationConfig, getGameConfigsForTeam, saveGameConfig,
} from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_COLORS } from './coaches-config.js';
import { fetchSchedule, COL as SCHED_COL } from './schedule-data.js';
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
let activeSavedConfigId = null;    // config id the saved-config popover menu is currently open for

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
  wireExport();
  wireSavedConfigMenu();
  wireApplyGameboardModal();
  wirePopoverDismiss();

  // Deep link support: rotations.html?team=Team+Name (used by Gameboard's
  // mini-grid double-click, see gameboard.js's wireMiniGridDeepLinks) takes
  // precedence over the last-viewed-team pointer below on initial load only.
  const linkedTeam = new URLSearchParams(window.location.search).get('team');
  if (linkedTeam && TEAMS.includes(linkedTeam)) {
    localStorage.setItem('rotations_lastTeam', linkedTeam);
    document.getElementById('rot-team-select').value = linkedTeam;
    await loadTeam(linkedTeam);
  } else {
    // Restore last-viewed team, if any, from a small "last team" pointer key
    const lastTeam = localStorage.getItem('rotations_lastTeam');
    if (lastTeam && TEAMS.includes(lastTeam)) {
      document.getElementById('rot-team-select').value = lastTeam;
      await loadTeam(lastTeam);
    }
  }

  // Logging in/out changes whose saved configs (if any) should be visible.
  document.addEventListener('coachChanged', () => { refreshSavedConfigsGallery(); });
}

function populateTeamSelect() {
  const select = document.getElementById('rot-team-select');
  select.innerHTML = '<option value="">— choose a team —</option>' +
    TEAMS.filter(t => t !== 'Undrafted').map(t => {
      // Same COLOR — Team Coach convention used on the Schedules page —
      // coaches refer to teams by color first once colors are assigned.
      // Uses the short display name (e.g. "Grey" instead of "Grey
      // Concrete") so long names don't overflow the dropdown's fixed
      // width — display-only, the full name is still used everywhere else
      // (e.g. teamHeaderLabel for the export/print header, which has room).
      const displayColor = teamColorDisplayName(t);
      const label = displayColor ? `${displayColor.toUpperCase()} — ${t}` : t;
      return `<option value="${escHtml(t)}">${escHtml(label)}</option>`;
    }).join('');
}

function teamColorName(team) {
  return TEAM_COLORS[team]?.name || null;
}

function teamColorDisplayName(team) {
  const entry = TEAM_COLORS[team];
  return entry ? (entry.shortName || entry.name) : null;
}

// "LIME SHOCK — Team Alfred-Levar" — same convention as the team dropdown
// and the Schedules page, used as the exported/printed header.
function teamHeaderLabel(team) {
  const colorName = teamColorName(team);
  return colorName ? `${colorName.toUpperCase()} — ${team}` : team;
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

  await refreshSavedConfigsGallery();
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
      <div class="rot-cell-avatar rot-header-grid-label">GRID</div>
      <div class="rot-cell-name rot-header-hint">Double-click photo: mark absent. Drag photo: adjust ranking.</div>
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
    hidePopover('rot-export-menu');
    hidePopover('rot-savedconfig-menu');
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

// ── Export Rotation (print / download image) ────────────────────────────────
// "Apply to Gameboard" is intentionally a no-op placeholder until the
// Gameboard page exists — the button is disabled in the markup so there's
// nothing to wire up here yet.

let pendingExportAction = null; // 'print' | 'image', set while the invalid-config warning is showing

function wireExport() {
  document.getElementById('btn-export').addEventListener('click', e => {
    e.stopPropagation();
    positionPopover(document.getElementById('rot-export-menu'), e.currentTarget);
  });
  document.getElementById('rot-export-menu').addEventListener('click', e => e.stopPropagation());

  document.getElementById('btn-export-print').addEventListener('click', () => {
    hidePopover('rot-export-menu');
    startExport('print');
  });
  document.getElementById('btn-export-image').addEventListener('click', () => {
    hidePopover('rot-export-menu');
    startExport('image');
  });

  document.getElementById('btn-export-warning-cancel').addEventListener('click', () => {
    pendingExportAction = null;
    document.getElementById('modal-export-warning').classList.add('hidden');
  });
  document.getElementById('btn-export-warning-continue').addEventListener('click', () => {
    const action = pendingExportAction;
    pendingExportAction = null;
    document.getElementById('modal-export-warning').classList.add('hidden');
    if (action === 'print') runPrintExport();
    else if (action === 'image') runImageExport();
  });
  document.getElementById('modal-export-warning').addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      pendingExportAction = null;
      e.currentTarget.classList.add('hidden');
    }
  });

  // Apply to Gameboard always fires Save Configuration first (so the exact
  // grid state being applied also exists as a freeform saved config, same
  // as Export does) before opening the game-picker modal on the big grid's
  // current order/pattern/absent state.
  document.getElementById('btn-apply-gameboard').addEventListener('click', async () => {
    await trySaveConfiguration();
    openApplyGameboardModal({
      order: [...order],
      pattern: new Map([...pattern.entries()].map(([id, p]) => [id, [...p]])),
      presentIds: order.filter(id => !absent.has(id)),
    });
  });
}

// Menu that opens when a saved-config tile's mini-grid is clicked/tapped —
// "Apply to Grid" replaces the current editable grid's full state (tile
// order, on/off pattern, and who's marked absent) with this saved config's
// data. "Apply to Gameboard" opens the same game-picker modal as the main
// action row's button, but sourced from this specific saved tile's data
// instead of the live editable grid.
function wireSavedConfigMenu() {
  document.getElementById('rot-savedconfig-menu').addEventListener('click', e => e.stopPropagation());

  document.getElementById('btn-savedconfig-apply-grid').addEventListener('click', () => {
    hidePopover('rot-savedconfig-menu');
    applySavedConfigToGrid(activeSavedConfigId);
    activeSavedConfigId = null;
  });

  document.getElementById('btn-savedconfig-apply-gameboard').addEventListener('click', () => {
    hidePopover('rot-savedconfig-menu');
    const cfg = savedConfigsCache.find(c => c.id === activeSavedConfigId);
    activeSavedConfigId = null;
    if (!cfg) return;
    openApplyGameboardModal({
      order: [...cfg.order],
      pattern: new Map(Object.entries(cfg.pattern || {}).map(([id, p]) => [id, [...p]])),
      presentIds: [...(cfg.presentIds || [])],
    });
  });

  // Deep-links to gameboard.html's Game view, pre-filtered to this saved
  // config's team + game number. Only present on game-tagged (Saved
  // Gameboards) tiles — see wireSavedConfigCardInteractions' open handler,
  // which shows/hides this button per-tile before the popover appears.
  document.getElementById('btn-savedconfig-goto-game').addEventListener('click', () => {
    hidePopover('rot-savedconfig-menu');
    const cfg = savedConfigsCache.find(c => c.id === activeSavedConfigId);
    activeSavedConfigId = null;
    if (!cfg?.gameTag) return;
    const params = new URLSearchParams({ team: cfg.gameTag.team, game: String(cfg.gameTag.gameNum) });
    window.location.href = `gameboard.html?${params.toString()}`;
  });
}

// ── Apply to Gameboard ────────────────────────────────────────────────────────
// Copies a source configuration (order/pattern/presentIds — either the live
// editable grid, or one specific saved-config tile, byte-for-byte, no
// recalculation) into one or more of the current team's real scheduled
// games. Each selected game becomes/overwrites that game's single entry in
// "Saved Gameboards" (see firebase.js's saveGameConfig, same one-per-
// coach+team+gameNum upsert Gameboard's Game view already uses).

let applyGameboardSource = null; // { order, pattern, presentIds }
let applyGameboardTeamGames = []; // this team's games, index+1 = game number
let allScheduleGames = null; // cached fetchSchedule() result, shared across opens

async function ensureScheduleLoaded() {
  if (!allScheduleGames) allScheduleGames = await fetchSchedule();
  return allScheduleGames;
}

function opponentColorForGame(game, ownColorName) {
  return game[SCHED_COL.V] === ownColorName ? game[SCHED_COL.H] : game[SCHED_COL.V];
}

function teamNameForColorName(colorName) {
  const entry = Object.entries(TEAM_COLORS).find(([, v]) => v.name === colorName);
  return entry ? entry[0] : null;
}

async function openApplyGameboardModal(source) {
  const coach = getCurrentCoach();
  if (!coach) {
    alert('To apply a configuration to the Gameboard, log in');
    return;
  }
  if (!currentTeam) return;

  applyGameboardSource = source;

  const modal = document.getElementById('modal-apply-gameboard');
  const list = document.getElementById('apply-gameboard-list');
  const emptyMsg = document.getElementById('apply-gameboard-empty');

  const games = await ensureScheduleLoaded();
  const ownColorName = teamColorName(currentTeam);
  applyGameboardTeamGames = ownColorName
    ? games.filter(g => g[SCHED_COL.V] === ownColorName || g[SCHED_COL.H] === ownColorName)
    : [];

  if (applyGameboardTeamGames.length === 0) {
    list.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    modal.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  // Firestore key = the sheet's absolute Game # (SCHED_COL.GAME), shared
  // and stable across both teams playing each other — NOT the per-team
  // display sequence (i+1) below, which is only used for the human-facing
  // "Game N" label. Keying by the display sequence was the root cause of a
  // config saved from one team's perspective not showing up correctly from
  // the opponent's — see gameboard.js's loadActiveGame for the matching fix.
  const existingConfigs = await getGameConfigsForTeam(coach.name, currentTeam);
  const configBySheetGameNum = new Map(existingConfigs.map(c => [c.gameTag.gameNum, c]));

  // Pre-check every game that doesn't already have a saved Gameboard —
  // coaches tend to reuse the same rotation across most/all games, so
  // defaulting to "apply everywhere it isn't already set" is less clicking
  // than starting from nothing. Games that DO already have a config start
  // unchecked, since overwriting those is the less common/more deliberate action.
  list.innerHTML = applyGameboardTeamGames.map((game, i) => {
    const displayNum = i + 1;
    const sheetGameNum = game[SCHED_COL.GAME];
    const oppColorName = opponentColorForGame(game, ownColorName);
    const oppTeam = teamNameForColorName(oppColorName);
    const oppLabel = oppTeam ? teamColorDisplayName(oppTeam) : oppColorName;
    const existing = configBySheetGameNum.get(sheetGameNum);

    // No existing config -> reserve the same layout space with an empty
    // placeholder rather than a gray dot, so checkbox/label columns still
    // line up across rows without implying "there's something here to see."
    let dotHtml = '<span class="apply-gameboard-dot"></span>';
    if (existing) {
      const dotClass = existing.isValid ? 'apply-gameboard-dot-valid' : 'apply-gameboard-dot-invalid';
      const dotTitle = existing.isValid ? 'Existing configuration is valid' : 'Existing configuration is not valid';
      dotHtml = `<span class="apply-gameboard-dot ${dotClass}" title="${dotTitle}"></span>`;
    }

    return `
      <label class="apply-gameboard-row">
        ${dotHtml}
        <input type="checkbox" data-sheet-gamenum="${escHtml(sheetGameNum)}" data-display-num="${displayNum}" ${existing ? '' : 'checked'} />
        <span class="apply-gameboard-row-label">Game ${displayNum} — vs. ${escHtml((oppLabel || '?').toUpperCase())}</span>
      </label>`;
  }).join('');

  updateApplyGameboardSelectAllLabel();
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateApplyGameboardSelectAllLabel);
  });

  modal.classList.remove('hidden');
}

// Button reads "Select All" when at least one row is unchecked, "Deselect
// All" only once every row is already checked — so it always describes
// what clicking it will do next, not a fixed label.
function updateApplyGameboardSelectAllLabel() {
  const btn = document.getElementById('btn-apply-gameboard-select-all');
  const boxes = document.querySelectorAll('#apply-gameboard-list input[type="checkbox"]');
  const allChecked = boxes.length > 0 && [...boxes].every(cb => cb.checked);
  btn.textContent = allChecked ? 'Deselect All' : 'Select All';
}

function wireApplyGameboardModal() {
  const modal = document.getElementById('modal-apply-gameboard');
  const warningModal = document.getElementById('modal-apply-gameboard-warning');

  document.getElementById('btn-apply-gameboard-cancel').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', e => {
    if (e.target === e.currentTarget) modal.classList.add('hidden');
  });

  document.getElementById('btn-apply-gameboard-select-all').addEventListener('click', () => {
    const boxes = document.querySelectorAll('#apply-gameboard-list input[type="checkbox"]');
    const allChecked = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => { cb.checked = !allChecked; });
    updateApplyGameboardSelectAllLabel();
  });

  document.getElementById('btn-apply-gameboard-confirm').addEventListener('click', async () => {
    // Sheet Game # is the actual Firestore key (see openApplyGameboardModal's
    // comment) — carry both it and the display sequence number together so
    // downstream code never has to re-derive one from the other.
    const checked = [...document.querySelectorAll('#apply-gameboard-list input[type="checkbox"]:checked')]
      .map(el => ({ sheetGameNum: el.dataset.sheetGamenum, displayNum: parseInt(el.dataset.displayNum, 10) }));
    if (checked.length === 0) {
      alert('Select at least one game.');
      return;
    }

    const coach = getCurrentCoach();
    const existingConfigs = await getGameConfigsForTeam(coach.name, currentTeam);
    const configuredGameNums = new Set(existingConfigs.map(c => c.gameTag.gameNum));
    const overwriteCount = checked.filter(c => configuredGameNums.has(c.sheetGameNum)).length;

    if (overwriteCount > 0) {
      document.getElementById('apply-gameboard-warning-text').textContent =
        `${overwriteCount} of your ${checked.length} selected game${checked.length === 1 ? '' : 's'} already ${overwriteCount === 1 ? 'has' : 'have'} a saved configuration — overwrite ${overwriteCount === 1 ? 'it' : 'them'}?`;
      modal.classList.add('hidden');
      warningModal.classList.remove('hidden');
      warningModal.dataset.pendingGames = JSON.stringify(checked);
      return;
    }

    modal.classList.add('hidden');
    await applyToGames(checked);
  });

  document.getElementById('btn-apply-gameboard-warning-cancel').addEventListener('click', () => {
    warningModal.classList.add('hidden');
  });
  document.getElementById('btn-apply-gameboard-warning-continue').addEventListener('click', async () => {
    const games = JSON.parse(warningModal.dataset.pendingGames || '[]');
    warningModal.classList.add('hidden');
    await applyToGames(games);
  });
  warningModal.addEventListener('click', e => {
    if (e.target === e.currentTarget) warningModal.classList.add('hidden');
  });
}

async function applyToGames(games) {
  const coach = getCurrentCoach();
  if (!coach || !applyGameboardSource) return;

  const { order: srcOrder, pattern: srcPattern, presentIds } = applyGameboardSource;
  const isValid = computeGameStatus(srcPattern, new Set(srcOrder.filter(id => !presentIds.includes(id))), srcOrder).valid;

  await Promise.all(games.map(async ({ sheetGameNum, displayNum }) => {
    const game = applyGameboardTeamGames.find(g => g[SCHED_COL.GAME] === sheetGameNum);
    const ownColorName = teamColorName(currentTeam);
    const oppColorName = opponentColorForGame(game, ownColorName);
    const oppTeam = teamNameForColorName(oppColorName);

    const config = {
      team: currentTeam,
      order: [...srcOrder],
      pattern: Object.fromEntries(srcPattern.entries()),
      presentIds: [...presentIds],
      isValid,
      title: `Game ${displayNum} vs. ${teamColorDisplayName(oppTeam || '') || oppColorName || '?'}`,
      // Firestore key is the sheet's absolute Game # (shared across both
      // teams in this matchup) — see openApplyGameboardModal's comment.
      gameTag: { team: currentTeam, opponentTeam: oppTeam || null, gameNum: sheetGameNum },
    };
    await saveGameConfig(coach.name, currentTeam, sheetGameNum, config);
  }));

  await refreshSavedConfigsGallery();

  // "First game" = earliest by this team's own display sequence, not
  // checkbox/DOM order (defensive — the modal happens to list them
  // chronologically already, but sorting here doesn't rely on that holding).
  const firstGame = [...games].sort((a, b) => a.displayNum - b.displayNum)[0];
  if (firstGame && confirm('Go to Gameboard now?')) {
    const params = new URLSearchParams({ team: currentTeam, game: String(firstGame.sheetGameNum) });
    window.location.href = `gameboard.html?${params.toString()}`;
  }
}

function applySavedConfigToGrid(configId) {
  const cfg = savedConfigsCache.find(c => c.id === configId);
  if (!cfg) return;

  order = [...cfg.order];
  pattern = new Map(Object.entries(cfg.pattern || {}).map(([id, pat]) => [id, [...pat]]));
  const presentSet = new Set(cfg.presentIds || []);
  absent = new Set(order.filter(id => !presentSet.has(id)));

  saveState();
  renderGrid();
}

async function startExport(action) {
  // Save Configuration always fires first, before the export itself — see
  // trySaveConfiguration() for the full login/dedup/create flow. It never
  // blocks the export from proceeding (log-in prompt or silent dedup are
  // both non-blocking outcomes), it just may add a new gallery tile first.
  await trySaveConfiguration();

  const gameStatus = computeGameStatus(pattern, absent, order);
  if (!gameStatus.valid) {
    pendingExportAction = action;
    document.getElementById('modal-export-warning').classList.remove('hidden');
    return;
  }
  if (action === 'print') runPrintExport();
  else runImageExport();
}

function runPrintExport() {
  // Same reasoning as runImageExport: Drive-hosted photos can't reliably
  // print either (and definitely can't be captured by html2canvas for the
  // image path) — force initials mode for the print output too, restoring
  // the user's actual preference once the print dialog closes.
  const originalAvatarStyle = avatarStyle;
  avatarStyle = 'initials';
  renderGrid();

  const headerEl = document.getElementById('rot-export-header');
  const timestampEl = document.getElementById('rot-export-timestamp');
  const creditEl = document.getElementById('rot-export-credit');
  headerEl.textContent = teamHeaderLabel(currentTeam);
  headerEl.classList.remove('hidden');
  timestampEl.textContent = formatExportTimestamp(new Date());
  timestampEl.classList.remove('hidden');
  creditEl.classList.remove('hidden');

  const restore = () => {
    avatarStyle = originalAvatarStyle;
    headerEl.classList.add('hidden');
    timestampEl.classList.add('hidden');
    creditEl.classList.add('hidden');
    renderGrid();
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);

  // A dedicated print stylesheet (see style.css @media print rules) hides
  // everything except #rot-grid-wrap (including its own action buttons)
  // and renders it in a clean, light, ink-friendly layout, with the
  // timestamp shown in the buttons' place — window.print() picks all of
  // this up automatically via the @media print rules in style.css.
  window.print();
}

// Formats like "July 4, 2026 @ 10:32 AM" — used to stamp exported images
// with when they were generated, in place of the (hidden-during-capture)
// action buttons.
function formatExportTimestamp(date) {
  const datePart = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const timePart = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Generated ${datePart} @ ${timePart}`;
}

function runImageExport() {
  const target = document.getElementById('rot-grid-wrap');
  if (typeof html2canvas !== 'function') {
    alert('Image export is unavailable right now — please try again in a moment.');
    return;
  }

  // Player photos are served from Google Drive (a cross-origin host with no
  // CORS headers), which html2canvas cannot read pixel data from — the
  // browser blocks it as a "tainted canvas" security measure, not something
  // fixable via html2canvas options. Force the initials avatar style (pure
  // CSS/text, no external images) for the duration of the capture so the
  // export never has blank/missing photo cells, then restore whatever the
  // user actually had selected once the capture completes.
  const originalAvatarStyle = avatarStyle;
  avatarStyle = 'initials';
  renderGrid();

  // A bold "COLOR — Team Coach" header identifies whose rotation this is,
  // and the action buttons (Generate Options / Export Rotation / Apply to
  // Gameboard) don't belong in a shareable snapshot — swap them out for a
  // "Generated <date> @ <time>" stamp (plus a small app-credit line) for
  // the duration of the capture only.
  const headerEl = document.getElementById('rot-export-header');
  const timestampEl = document.getElementById('rot-export-timestamp');
  const creditEl = document.getElementById('rot-export-credit');
  headerEl.textContent = teamHeaderLabel(currentTeam);
  headerEl.classList.remove('hidden');
  timestampEl.textContent = formatExportTimestamp(new Date());
  timestampEl.classList.remove('hidden');
  creditEl.classList.remove('hidden');

  // Same column scoping as print (dot + initials chip + Q1-Q4 only, no
  // grip/avatar/name) is applied via a temporary class rather than
  // duplicating the print media-query rules — html2canvas snapshots
  // whatever is actually on screen at capture time, so the DOM has to be
  // visually narrowed first, then restored right after. A double
  // requestAnimationFrame ensures the browser has actually reflowed the
  // narrower layout before html2canvas reads it (a synchronous class-add
  // is sometimes still captured pre-layout otherwise).
  target.classList.add('rot-export-scoped');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    html2canvas(target, { backgroundColor: null, scale: 2 }).then(canvas => {
      const link = document.createElement('a');
      const teamSlug = (currentTeam || 'rotation').replace(/\s+/g, '-').toLowerCase();
      link.download = `${teamSlug}-rotation.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();

      // Desktop-only convenience: also copy the image to the clipboard so
      // it can be pasted straight into a text/chat app without digging
      // through Downloads. Requires the async Clipboard API with
      // ClipboardItem support (Chrome/Edge desktop; Firefox desktop behind
      // a permission prompt) — unsupported on effectively all mobile
      // browsers, where this silently does nothing and the download above
      // is the only outcome, which is fine.
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        canvas.toBlob(blob => {
          if (!blob) return;
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            .catch(err => console.warn('Clipboard copy skipped:', err));
        }, 'image/png');
      }
    }).catch(err => {
      console.error('Image export failed:', err);
      alert('Image export failed — please try again.');
    }).finally(() => {
      target.classList.remove('rot-export-scoped');
      headerEl.classList.add('hidden');
      timestampEl.classList.add('hidden');
      creditEl.classList.add('hidden');
      avatarStyle = originalAvatarStyle;
      renderGrid();
    });
  }));
}

// ── Save Configuration ───────────────────────────────────────────────────────
// Fires before Export Rotation and (eventually) Apply to Gameboard. Never
// blocks the calling action:
//   - not logged in -> info alert, then returns
//   - logged in, exact duplicate already saved -> silently returns
//   - logged in, new configuration -> saves it, appends a gallery tile
let savedConfigsCache = []; // current team's saved configs, refreshed on team load / after a save

async function trySaveConfiguration() {
  const coach = getCurrentCoach();
  if (!coach) {
    alert('To save custom rotations to your coach account, log in');
    return;
  }
  if (!currentTeam) return;

  const presentOrder = order.filter(id => !absent.has(id));
  const fingerprint = fingerprintConfig(currentTeam, order, presentOrder, pattern);

  // Dedup match: Account (implicit — configs are stored per-coach) + Team +
  // Player Rank Order + # of Available Players + Quarters configuration.
  const alreadySaved = savedConfigsCache.some(c => c._fingerprint === fingerprint);
  if (alreadySaved) return;

  const isValid = computeGameStatus(pattern, absent, order).valid;
  const title = generateConfigTitle(presentOrder.length);

  const configToSave = {
    team: currentTeam,
    order: [...order],
    pattern: Object.fromEntries(pattern.entries()),
    presentIds: presentOrder,
    isValid,
    title,
  };

  try {
    const id = await saveRotationConfig(coach.name, configToSave);
    savedConfigsCache.push({ id, ...configToSave, _fingerprint: fingerprint });
    renderSavedConfigsGallery();
  } catch (err) {
    console.error('Save Configuration failed:', err);
    // Deliberately silent beyond the console — a failed background save
    // shouldn't block the export/apply action the coach actually clicked.
  }
}

// Comparable string uniquely identifying "this exact rotation" for dedup
// purposes: team + sorted present-player-id set (# available, order-
// independent) + full rank order (captures a pure reordering with the same
// on/off pattern as a distinct save) + serialized on/off pattern per player.
function fingerprintConfig(team, fullOrder, presentOrder, patternMap) {
  const presentKey = [...presentOrder].sort().join(',');
  const orderKey = fullOrder.join(',');
  const patternKey = fullOrder
    .map(id => `${id}:${(patternMap.get(id) || []).map(b => (b ? 1 : 0)).join('')}`)
    .join('|');
  return `${team}::${presentKey}::${orderKey}::${patternKey}`;
}

// "8-man - Config 3" — N reflects how many players were present/available
// at save time; the trailing number is a single global sequence across all
// of this coach's saved configs for the team (not per-N-group), matching
// however many configs already exist.
function generateConfigTitle(presentCount) {
  const nextNum = savedConfigsCache.length + 1;
  return `${presentCount}-man - Config ${nextNum}`;
}

async function refreshSavedConfigsGallery() {
  const coach = getCurrentCoach();
  const wrap = document.getElementById('rot-saved-configs-wrap');
  if (!coach || !currentTeam) {
    wrap.classList.add('hidden');
    savedConfigsCache = [];
    return;
  }

  const configs = await getRotationConfigs(coach.name, currentTeam);
  savedConfigsCache = configs.map(c => ({
    ...c,
    _fingerprint: fingerprintConfig(c.team, c.order, c.presentIds, new Map(Object.entries(c.pattern || {}))),
  }));
  renderSavedConfigsGallery();
}

function renderSavedConfigsGallery() {
  const wrap = document.getElementById('rot-saved-configs-wrap');
  const gameboardsSection = document.getElementById('rot-saved-gameboards-section');
  const gameboardsGrid = document.getElementById('rot-saved-gameboards-grid');
  const grid = document.getElementById('rot-saved-configs-grid');
  const coach = getCurrentCoach();

  if (!coach || !currentTeam || savedConfigsCache.length === 0) {
    wrap.classList.add('hidden');
    return;
  }

  wrap.classList.remove('hidden');

  // Game-tagged saves (from the Gameboard's Game view) render in their own
  // "Saved Gameboards" stack above the freeform ones — sorted by game
  // number so they read in season order, not save order.
  const gameboardConfigs = savedConfigsCache
    .filter(c => c.gameTag)
    .sort((a, b) => (a.gameTag.gameNum || 0) - (b.gameTag.gameNum || 0));
  const freeformConfigs = savedConfigsCache.filter(c => !c.gameTag);

  gameboardsSection.classList.toggle('hidden', gameboardConfigs.length === 0);
  gameboardsGrid.innerHTML = gameboardConfigs.map(savedConfigCardHTML).join('');
  grid.innerHTML = freeformConfigs.map(savedConfigCardHTML).join('');

  wireSavedConfigCardInteractions(gameboardsGrid, coach);
  wireSavedConfigCardInteractions(grid, coach);
}

function wireSavedConfigCardInteractions(grid, coach) {
  grid.querySelectorAll('.rot-saved-config-title').forEach(el => {
    el.addEventListener('blur', async () => {
      const id = el.closest('.saved-config-card').dataset.configId;
      const newTitle = el.textContent.trim();
      const cfg = savedConfigsCache.find(c => c.id === id);
      if (!cfg || !newTitle || newTitle === cfg.title) { el.textContent = cfg?.title || ''; return; }
      cfg.title = newTitle;
      try {
        await renameRotationConfig(coach.name, id, newTitle);
      } catch (err) {
        console.error('Rename failed:', err);
      }
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  grid.querySelectorAll('.saved-config-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.saved-config-card').dataset.configId;
      const cfg = savedConfigsCache.find(c => c.id === id);
      if (!cfg) return;
      const confirmed = confirm(`Delete "${cfg.title}"? This cannot be undone.`);
      if (!confirmed) return;
      try {
        await deleteRotationConfig(coach.name, id);
        savedConfigsCache = savedConfigsCache.filter(c => c.id !== id);
        renderSavedConfigsGallery();
      } catch (err) {
        console.error('Delete failed:', err);
        alert('Delete failed — please try again.');
      }
    });
  });

  grid.querySelectorAll('.saved-config-open-menu').forEach(el => {
    const open = e => {
      e.stopPropagation();
      activeSavedConfigId = el.dataset.configId;
      const cfg = savedConfigsCache.find(c => c.id === activeSavedConfigId);
      document.getElementById('btn-savedconfig-goto-game').classList.toggle('hidden', !cfg?.gameTag);
      positionPopover(document.getElementById('rot-savedconfig-menu'), el);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
    });
  });
}

function savedConfigCardHTML(cfg) {
  const patternMap = new Map(Object.entries(cfg.pattern || {}));
  const presentSet = new Set(cfg.presentIds || []);
  // Absent players still get a row (not omitted) so the tile reflects the
  // full roster at save time — struck-through name, black quarter squares
  // instead of the usual on/off blue, and no quarter count (they didn't play).
  const miniRows = cfg.order.map(id => {
    const p = playersById[id];
    const name = (p?.[COL.NAME] || id).split(/\s+/)[0];
    const isAbsent = !presentSet.has(id);
    const pat = patternMap.get(id) || [false, false, false, false];
    if (isAbsent) {
      const cells = pat.map(() => '<span class="rot-mini-cell rot-mini-absent"></span>').join('');
      return `<div class="rot-mini-row rot-mini-row-absent"><span class="rot-mini-name">${escHtml(name)}</span>${cells}<span class="rot-mini-total">—</span></div>`;
    }
    const cells = pat.map(on => `<span class="rot-mini-cell${on ? ' rot-mini-on' : ''}"></span>`).join('');
    const total = pat.filter(Boolean).length;
    return `<div class="rot-mini-row"><span class="rot-mini-name">${escHtml(name)}</span>${cells}<span class="rot-mini-total">${total}q</span></div>`;
  }).join('');

  const validityCircle = cfg.isValid
    ? '<span class="saved-config-validity valid" title="Valid rotation">✓</span>'
    : '<span class="saved-config-validity invalid" title="Invalid rotation">✕</span>';

  return `
    <div class="saved-config-card" data-config-id="${escHtml(cfg.id)}">
      <button class="saved-config-delete" type="button" title="Delete this configuration" aria-label="Delete this configuration">🗑️</button>
      <div class="rot-mini-grid saved-config-open-menu" role="button" tabindex="0" data-config-id="${escHtml(cfg.id)}" aria-label="Configuration options">${miniRows}</div>
      <div class="rot-saved-config-footer">
        ${validityCircle}
        <div class="rot-saved-config-title" contenteditable="true" spellcheck="false">${escHtml(cfg.title)}</div>
      </div>
    </div>`;
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
