// gameboard.js — Gameboard page: Game/Board view toggle + Board team grid.
// Default view on load: "Game" if a coach is logged in, "Board" otherwise.
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_COLORS } from './coaches-config.js';
import { buildIconIndex, iconUrl, fetchPlayers, buildDriveIndex, photoUrl, COL } from './players-data.js';
import { fetchSchedule, COL as SCHED_COL } from './schedule-data.js';
import { getCompositeRank, getGameConfig, saveGameConfig } from './firebase.js';
import {
  computePlayerStatus, computeQuarterStatus, computeGameStatus, countPresent,
} from './rotations-engine.js';

function setView(view) {
  document.querySelectorAll('.gb-view-toggle .avatar-toggle-btn')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  document.getElementById('gb-view-game').classList.toggle('hidden', view !== 'game');
  document.getElementById('gb-view-board').classList.toggle('hidden', view !== 'board');
}

// Dev-only switch, not exposed anywhere in the app UI — flip this by hand
// and push to change the Board view's layout for all coaches. Intended to
// go from false -> true once every team has played a game (after
// 2026-07-10) and TEAMS order below is replaced with real stat-ranking
// order. true = rank 1 alone in its own full-width band, ranks 2-3 sharing
// a second band, ranks 4-12 in the normal 3-per-row grid. false = plain
// 3-per-row grid, no bands.
const USE_PODIUM_LAYOUT = false;

function tileHtml(team, i) {
  const info = TEAM_COLORS[team];
  const colorName = info?.name || '';
  const icon = iconUrl(colorName);
  return `
    <div class="gb-team-tile" data-team="${team}" role="button" tabindex="0">
      <span class="gb-team-tile-color">${colorName.toUpperCase()}</span>
      <div class="gb-team-tile-icon">
        ${icon
          ? `<img src="${icon}" alt="${colorName}" loading="lazy" />`
          : `<span class="gb-team-tile-id">${i + 1}</span>`}
      </div>
      <div class="gb-team-tile-label">
        <span class="gb-team-tile-coach">${team}</span>
        <span class="gb-team-tile-stats">W: 0 - L:0 - R:0</span>
      </div>
    </div>`;
}

// Board view lists teams by ID number — currently just TEAMS' existing
// order (Undrafted excluded). Will switch to stat-ranking order once every
// team has a game played (after 2026-07-10) — not yet implemented.
function renderBoardGrid() {
  const top = document.getElementById('gb-board-top');
  const second = document.getElementById('gb-board-second');
  const grid = document.getElementById('gb-board-grid');
  const teams = TEAMS.filter(t => t !== 'Undrafted');

  if (USE_PODIUM_LAYOUT) {
    top.classList.add('gb-board-top-active');
    second.classList.add('gb-board-second-active');
    top.innerHTML = tileHtml(teams[0], 0);
    second.innerHTML = teams.slice(1, 3).map((team, i) => tileHtml(team, i + 1)).join('');
    grid.innerHTML = teams.slice(3).map((team, i) => tileHtml(team, i + 3)).join('');
  } else {
    top.classList.remove('gb-board-top-active');
    second.classList.remove('gb-board-second-active');
    top.innerHTML = '';
    second.innerHTML = '';
    grid.innerHTML = teams.map((team, i) => tileHtml(team, i)).join('');
  }
}

// ── Team stats popover (click/tap a Board tile) ─────────────────────────────
// All stats are placeholders until score tracking (Schedules' scheduleGames
// Firestore data) is wired in to compute them for real.

function positionPopover(popoverEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
  popoverEl.classList.remove('hidden');
  requestAnimationFrame(() => {
    const pw = popoverEl.offsetWidth;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 8;
    if (left > maxLeft) popoverEl.style.left = `${Math.max(8, maxLeft)}px`;
  });
}

// Each stat row is tappable — tapping it shows a short blurb explaining
// what the stat means and how it's calculated. Wording below is placeholder
// text until real copy is written for the rest; the interaction/wiring is final.
const STAT_DEFS = [
  { key: 'pointsMade',     label: 'Points Made',      value: '0', blurb: 'Total # of points scored against opponents this entire season; a measure of offensive strength.' },
  { key: 'pointsAllowed',  label: 'Points Allowed',   value: '0', blurb: 'Total # of points scored on this team by opponents this season; a measure of defensive strength.' },
  { key: 'scoringRatio',   label: 'Scoring Ratio',    value: '0.00', blurb: 'Points Made divided by Points Allowed; the higher the ratio the stronger the performance.' },
  { key: 'wins',           label: 'Wins',             value: '0' }, // self-explanatory, no tap blurb
  { key: 'losses',         label: 'Losses',           value: '0' }, // self-explanatory, no tap blurb
  { key: 'gamesPlayed',    label: 'Games Played',     value: '0' }, // self-explanatory, no tap blurb
  { key: 'winLossRatio',   label: 'Win/Loss %',       value: '0.0%', blurb: 'Wins divided by # of games played so far; the higher percentage of wins, the better.' },
  { key: 'trueRank',       label: 'True Rank',        value: '—', blurb: "Team's score ratio adjusted for actual number of games played so far; ranked highest adjusted score to lowest across all 12 teams; more nuanced than Score Ratio or Win/Loss % ranking alone." },
];

function showTeamPopover(anchorEl, team) {
  const popover = document.getElementById('gb-team-popover');
  const info = TEAM_COLORS[team];
  const displayName = info?.shortName || info?.name || '';

  const rows = STAT_DEFS.map(stat => stat.blurb
    ? `<div class="sched-popover-row gb-stat-row" data-stat="${stat.key}" role="button" tabindex="0">
        <span>${escHtml(stat.label)}</span><span>${escHtml(stat.value)}</span>
      </div>`
    : `<div class="sched-popover-row">
        <span>${escHtml(stat.label)}</span><span>${escHtml(stat.value)}</span>
      </div>`
  ).join('');

  popover.innerHTML = `
    <div class="sched-popover-title">${escHtml(displayName.toUpperCase())} — ${escHtml(team)}</div>
    ${rows}
    <div id="gb-stat-blurb" class="sched-popover-hint hidden"></div>
  `;

  popover.querySelectorAll('.gb-stat-row').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      const stat = STAT_DEFS.find(s => s.key === row.dataset.stat);
      const blurbEl = popover.querySelector('#gb-stat-blurb');
      const alreadyShowingThis = !blurbEl.classList.contains('hidden') && blurbEl.dataset.stat === stat.key;
      popover.querySelectorAll('.gb-stat-row').forEach(r => r.classList.remove('gb-stat-row-active'));
      if (alreadyShowingThis) {
        blurbEl.classList.add('hidden');
        return;
      }
      blurbEl.innerHTML = `<span class="gb-stat-blurb-icon" aria-hidden="true">**</span>${escHtml(stat.blurb)}`;
      blurbEl.dataset.stat = stat.key;
      blurbEl.classList.remove('hidden');
      row.classList.add('gb-stat-row-active');
    });
  });

  positionPopover(popover, anchorEl);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function wireBoardTileClicks() {
  document.querySelectorAll('.gb-board-top, .gb-board-second, .gb-board-grid')
    .forEach(container => {
      container.addEventListener('click', e => {
        const tile = e.target.closest('.gb-team-tile');
        if (!tile) return;
        showTeamPopover(tile, tile.dataset.team);
      });
    });
}

function wirePopoverDismiss() {
  document.addEventListener('click', e => {
    const popover = document.getElementById('gb-team-popover');
    if (popover.contains(e.target) || e.target.closest('.gb-team-tile')) return;
    popover.classList.add('hidden');
  });
}

// ── Game view ────────────────────────────────────────────────────────────────
// A per-game (not per-team-overall) lineup tracker. State shape per side
// (own team / opponent), independently:
//   {
//     team, players: { [id]: playerRecord }, order: [id,...] (composite rank,
//     never reordered here — Rotations owns rank order), pattern: Map<id,
//     [bool,bool,bool,bool]>, absent: Set<id>
//   }
// Quarter cell toggling and absence marking both work identically on either
// side — the "own team" vs "opponent" distinction only matters for which
// side's Save button is shown to whom and which side gameTag.team names.

let allPlayers = [];
let allGames = [];
let activeQuarter = 0;         // 0-3, single-select
let gameTeam = '';             // currently selected team in Game view
let teamGames = [];            // this team's games, in date order (sequence = index+1)
let activeGameIdx = -1;        // index into teamGames
let activeSheetGameNum = null; // the currently-loaded game's absolute sheet Game # (see loadActiveGame)
let ownSide = null;            // { team, players, order, pattern, absent }
let oppSide = null;            // same shape, opponent

function teamColorNameFor(team) {
  return TEAM_COLORS[team]?.name || null;
}

function teamShortNameFor(team) {
  const info = TEAM_COLORS[team];
  return info ? (info.shortName || info.name) : team;
}

async function ensureGameDataLoaded() {
  if (allPlayers.length && allGames.length) return;
  const [players] = await Promise.all([
    fetchPlayers(),
    buildDriveIndex(),
  ]);
  allPlayers = players;
  allGames = await fetchSchedule();
}

function populateGameTeamSelect() {
  const select = document.getElementById('gb-game-team-select');
  select.innerHTML = '<option value="">— choose a team —</option>' +
    TEAMS.filter(t => t !== 'Undrafted').map(t => {
      const displayColor = teamShortNameFor(t);
      const label = displayColor ? `${displayColor.toUpperCase()} — ${t}` : t;
      return `<option value="${escHtml(t)}">${escHtml(label)}</option>`;
    }).join('');
}

// This team's games, sorted by the schedule's own row order (already
// date-ordered in the sheet) — index+1 becomes "Game 1", "Game 2", etc. for
// this team specifically, distinct from the sheet's absolute Game # column.
function gamesForTeam(team) {
  const colorName = teamColorNameFor(team);
  if (!colorName) return [];
  return allGames.filter(g => g[SCHED_COL.V] === colorName || g[SCHED_COL.H] === colorName);
}

function opponentColorFor(game, ownColorName) {
  return game[SCHED_COL.V] === ownColorName ? game[SCHED_COL.H] : game[SCHED_COL.V];
}

function teamNameForColor(colorName) {
  const entry = Object.entries(TEAM_COLORS).find(([, v]) => v.name === colorName);
  return entry ? entry[0] : null;
}

async function loadGameTeam(team) {
  gameTeam = team;
  activeQuarter = 0;
  await ensureGameDataLoaded();

  teamGames = gamesForTeam(team);
  activeGameIdx = teamGames.length ? 0 : -1;

  document.getElementById('gb-game-empty-state').classList.toggle('hidden', !!team);
  document.getElementById('gb-game-content').classList.toggle('hidden', !team);
  if (!team) return;

  renderGameNumBar();
  await loadActiveGame();
}

function renderGameNumBar() {
  const bar = document.getElementById('gb-gamenum-bar');
  bar.innerHTML = teamGames.map((g, i) => `
    <button class="gb-gamenum-btn${i === activeGameIdx ? ' active' : ''}" data-idx="${i}" type="button">${i + 1}</button>
  `).join('');

  bar.querySelectorAll('.gb-gamenum-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeGameIdx = parseInt(btn.dataset.idx, 10);
      renderGameNumBar(); // move the active highlight immediately, don't wait on the async game load below
      await loadActiveGame();
    });
  });
}

// Builds a side's roster + composite-rank order for a team, independent of
// any saved config (the "blank slate" baseline that a saved config's
// pattern/absent gets layered onto afterward).
async function buildRosterSide(team) {
  await Promise.all(allPlayers.map(async p => {
    if (p._composite === undefined) {
      const data = await getCompositeRank(p[COL.ID]);
      p._composite = data.composite;
      p._teamFB = data.team || '';
    }
  }));

  const roster = allPlayers.filter(p => (p._teamFB || p[COL.TEAM] || '') === team);
  const players = {};
  roster.forEach(p => { players[String(p[COL.ID])] = p; });

  const order = [...roster]
    .sort((a, b) => (a._composite ?? 99) - (b._composite ?? 99))
    .map(p => String(p[COL.ID]));

  return {
    team,
    players,
    order,
    pattern: new Map(order.map(id => [id, [false, false, false, false]])),
    absent: new Set(),
  };
}

async function loadActiveGame() {
  if (activeGameIdx === -1) {
    ownSide = null;
    oppSide = null;
    activeSheetGameNum = null;
    renderGameView();
    return;
  }

  const game = teamGames[activeGameIdx];
  const ownColorName = teamColorNameFor(gameTeam);
  const oppColorName = opponentColorFor(game, ownColorName);
  const oppTeam = teamNameForColor(oppColorName) || oppColorName;

  // The 1-10 button bar shows each team's OWN game sequence (this team's
  // 1st, 2nd, ... game), which is intentionally per-team-relative for
  // display — but the two teams playing each other in the SAME real game
  // will almost never land on the same sequence number (e.g. this might be
  // Lime's "Game 2" while it's Carolina Blue's "Game 1"). Saved Gameboard
  // configs must be keyed by something both teams' coaches agree is "this
  // exact game" regardless of whose schedule view they're looking from —
  // that's the sheet's own absolute Game # column (already a stable,
  // globally-unique id Schedules uses the same way), NOT the per-team
  // sequence index. Using the sequence number here was the root cause of
  // configs not carrying over correctly between the two teams' Game views.
  const sheetGameNum = game[SCHED_COL.GAME];
  activeSheetGameNum = sheetGameNum;

  ownSide = await buildRosterSide(gameTeam);
  oppSide = oppTeam ? await buildRosterSide(oppTeam) : null;

  // Layer saved state on top of the blank roster baseline: a logged-in
  // coach's most-recently-saved Firestore config (per coach+team+
  // sheetGameNum), or — with no coach logged in — this browser tab's own
  // in-progress session draft, if either exists.
  const coach = getCurrentCoach();
  if (coach) {
    await Promise.all([
      applySavedGameConfig(ownSide, coach.name, gameTeam, sheetGameNum),
      oppSide ? applySavedGameConfig(oppSide, coach.name, oppTeam, sheetGameNum) : Promise.resolve(),
    ]);
  } else {
    applyLocalGameState(ownSide, gameTeam, sheetGameNum);
    if (oppSide) applyLocalGameState(oppSide, oppTeam, sheetGameNum);
  }

  renderGameView();
}

// ── Logged-out session-local draft state ────────────────────────────────────
// A logged-out user can still build a rotation on the fly, but has nowhere
// to save it (Save to Gameboard requires a coach login, same as Rotations'
// Save Configuration). Without this, buildRosterSide() always starts from
// a blank slate, so navigating away (switch game, switch team) and back
// silently discarded all their edits — this mirrors that same in-memory
// state into sessionStorage on every edit, and restores it as the baseline
// instead of blank when there's no logged-in coach to load a real saved
// config for. Cleared automatically when the tab closes (sessionStorage's
// normal lifetime) — never touches Firestore, never conflicts with a
// coach's actual saved configs, and is silently superseded by a real login
// at any point (see loadActiveGame — logged-in always takes the Firestore
// path instead, never sessionStorage).
function localGameStateKey(team, sheetGameNum) {
  return `gameboard_draft_${team}_${sheetGameNum}`;
}

function saveLocalGameState(team, sheetGameNum, side) {
  try {
    const data = {
      pattern: Object.fromEntries(side.pattern.entries()),
      absent: [...side.absent],
    };
    sessionStorage.setItem(localGameStateKey(team, sheetGameNum), JSON.stringify(data));
  } catch { /* sessionStorage unavailable/full — silently skip, not critical */ }
}

function applyLocalGameState(side, team, sheetGameNum) {
  let raw;
  try {
    raw = sessionStorage.getItem(localGameStateKey(team, sheetGameNum));
  } catch { return; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const patternMap = new Map(Object.entries(data.pattern || {}));
  side.order.forEach(id => {
    if (patternMap.has(id)) side.pattern.set(id, [...patternMap.get(id)]);
  });
  side.absent = new Set((data.absent || []).filter(id => side.order.includes(id)));
}

// Called from every quarter-toggle / absence-toggle interaction. A
// logged-in coach's edits are only persisted explicitly via the Save to
// Gameboard button (matching Rotations' Save Configuration pattern) — this
// only fires the lightweight sessionStorage draft save for a logged-out
// user, so it's a no-op (not wasted work) once someone logs in.
function autoSaveIfLoggedOut(side) {
  if (getCurrentCoach() || activeSheetGameNum == null) return;
  saveLocalGameState(side.team, activeSheetGameNum, side);
}

async function applySavedGameConfig(side, coachName, team, sheetGameNum) {
  const cfg = await getGameConfig(coachName, team, sheetGameNum);
  if (!cfg) return;
  // Order stays composite-rank (Game view never reorders) — only pattern
  // and absence come from the saved config. Any player present in the
  // roster but absent from the saved config's pattern defaults to all-off.
  const patternMap = new Map(Object.entries(cfg.pattern || {}));
  side.order.forEach(id => {
    if (patternMap.has(id)) side.pattern.set(id, [...patternMap.get(id)]);
  });
  const presentSet = new Set(cfg.presentIds || []);
  side.absent = new Set(side.order.filter(id => !presentSet.has(id) && patternMap.has(id)));
}

function renderGameView() {
  renderMatchupRow();
  renderQuarterTabs();
  renderInOutColumns();
  updateSaveButtonVisibility();
}

function miniGridDot(side) {
  if (!side || side.order.length === 0) return '';
  const status = computeGameStatus(side.pattern, side.absent, side.order);
  return `<span class="gb-minigrid-dot ${status.valid ? 'gb-dot-valid' : 'gb-dot-invalid'}" title="${status.valid ? 'Valid rotation' : 'Not a valid rotation'}"></span>`;
}

// First + last initial, all caps (e.g. "Levar Higgs" -> "LH") — same
// convention as the Rotations page's colored initials badges. Full names
// already appear in order in the IN/OUT containers below, so the mini-grid
// itself only needs a compact per-row identifier.
function initialsFor(name) {
  const parts = (name || '?').split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function miniGridHtml(side) {
  if (!side) return '<div class="rot-mini-grid gb-minigrid-empty gb-minigrid-slim"></div>';
  const rows = side.order.map(id => {
    const p = side.players[id];
    const initials = initialsFor(p?.[COL.NAME] || id);
    const isAbsent = side.absent.has(id);
    const pat = side.pattern.get(id) || [false, false, false, false];
    if (isAbsent) {
      const cells = pat.map(() => '<span class="rot-mini-cell rot-mini-absent"></span>').join('');
      return `<div class="rot-mini-row rot-mini-row-absent"><span class="rot-mini-name">${escHtml(initials)}</span>${cells}<span class="rot-mini-total">—</span></div>`;
    }
    const cells = pat.map(on => `<span class="rot-mini-cell${on ? ' rot-mini-on' : ''}"></span>`).join('');
    const total = pat.filter(Boolean).length;
    return `<div class="rot-mini-row"><span class="rot-mini-name">${escHtml(initials)}</span>${cells}<span class="rot-mini-total">${total}q</span></div>`;
  }).join('');
  return `<div class="rot-mini-grid gb-minigrid-slim">${rows}</div>`;
}

function teamIconHtml(team) {
  const colorName = teamColorNameFor(team) || '';
  const icon = iconUrl(colorName);
  return `
    <div class="gb-matchup-icon">
      ${icon ? `<img src="${icon}" alt="${escHtml(colorName)}" loading="lazy" />` : ''}
    </div>`;
}

function renderMatchupRow() {
  const row = document.getElementById('gb-matchup-row');
  if (activeGameIdx === -1) {
    row.innerHTML = '<div class="loading">This team has no scheduled games yet.</div>';
    return;
  }

  // Team icons live in the IN containers now (see renderSideContainers), not
  // here — this row is just the two mini-grids + VS., kept as slim as
  // possible so it, and the game-number bar above it, never wrap.
  row.innerHTML = `
    <div class="gb-matchup-side">
      <div class="gb-matchup-grid-wrap">
        <div class="gb-matchup-label">${escHtml(teamShortNameFor(gameTeam).toUpperCase())}</div>
        ${miniGridHtml(ownSide)}
        ${miniGridDot(ownSide)}
      </div>
    </div>
    <div class="gb-matchup-vs">VS.</div>
    <div class="gb-matchup-side">
      <div class="gb-matchup-grid-wrap">
        <div class="gb-matchup-label">${escHtml((oppSide ? teamShortNameFor(oppSide.team) : '—').toUpperCase())}</div>
        ${miniGridHtml(oppSide)}
        ${miniGridDot(oppSide)}
      </div>
    </div>
  `;
}

function renderQuarterTabs() {
  const tabs = document.getElementById('gb-quarter-tabs');
  tabs.innerHTML = [0, 1, 2, 3].map(q => `
    <button class="avatar-toggle-btn${q === activeQuarter ? ' active' : ''}" data-quarter="${q}" type="button">Q${q + 1}</button>
  `).join('');

  tabs.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      activeQuarter = parseInt(btn.dataset.quarter, 10);
      renderQuarterTabs();
      renderInOutColumns();
    });
  });
}

function renderInOutColumns() {
  renderSideContainers(ownSide, 'gb-own-in', 'gb-own-out', false);
  renderSideContainers(oppSide, 'gb-opp-in', 'gb-opp-out', true);
}

// Tiles mirror across the two columns so thumbnails always sit nearest the
// center gap, facing the opposing side's thumbnails: own team (left column)
// = name, then thumbnail on the right; opponent (right column) = thumbnail
// on the left, then name. `mirrored` flips the tile's own internal order.
function playerTileHtml(side, id, mirrored) {
  const p = side.players[id];
  const fullName = p?.[COL.NAME] || 'Unknown';
  const firstName = fullName.split(/\s+/)[0] || fullName;
  const isAbsent = side.absent.has(id);
  const photo = photoUrl(p);
  const avatarHtml = photo
    ? `<img src="${photo}" alt="${escHtml(fullName)}" class="gb-inout-avatar-img" />`
    : `<div class="gb-inout-avatar-img gb-inout-avatar-placeholder">🏀</div>`;
  const nameHtml = `<span class="gb-inout-name">${escHtml(firstName)}</span>`;
  const avatarWrapHtml = `<div class="gb-inout-avatar">${avatarHtml}</div>`;
  return `
    <div class="gb-inout-tile${isAbsent ? ' gb-inout-tile-absent' : ''}" data-id="${escHtml(id)}" role="button" tabindex="0">
      ${mirrored ? avatarWrapHtml + nameHtml : nameHtml + avatarWrapHtml}
    </div>`;
}

function teamIconInlineHtml(team) {
  const colorName = teamColorNameFor(team) || '';
  const icon = iconUrl(colorName);
  if (!icon) return '';
  return `<div class="gb-inout-team-icon"><img src="${icon}" alt="${escHtml(colorName)}" loading="lazy" /></div>`;
}

// mirrored=false for the own-team column (name left, thumbnail right —
// nearest the center gap from the left side), mirrored=true for the
// opponent column (thumbnail left, name right — nearest the center gap
// from the right side).
function renderSideContainers(side, inId, outId, mirrored) {
  const inEl = document.getElementById(inId);
  const outEl = document.getElementById(outId);
  if (!side) {
    inEl.innerHTML = '<div class="gb-inout-header">IN</div>';
    outEl.innerHTML = '<div class="gb-inout-header">OUT</div>';
    return;
  }

  const inIds = [];
  const outIds = [];
  side.order.forEach(id => {
    const isAbsent = side.absent.has(id);
    const pat = side.pattern.get(id) || [false, false, false, false];
    if (!isAbsent && pat[activeQuarter]) inIds.push(id);
    else outIds.push(id);
  });

  // Headers mirror the same left/right convention as the player tiles
  // below, so IN/OUT read as centered on the whole side-by-side comparison
  // rather than each column hugging its own outer page edge: own side
  // (mirrored=false) pushes toward the right, nearest the center gap;
  // opponent side (mirrored=true) pushes toward the left, also nearest the
  // center gap (icon-then-text order flips too, so the icon still sits
  // between the label and the gap on both sides).
  const icon = teamIconInlineHtml(side.team);
  const inHeaderInner = mirrored
    ? `${icon}<div class="gb-inout-header">IN</div>`
    : `<div class="gb-inout-header">IN</div>${icon}`;
  const inHeaderHtml = `<div class="gb-inout-in-header${mirrored ? ' gb-inout-in-header-left' : ''}">${inHeaderInner}</div>`;
  const outHeaderClass = mirrored ? '' : ' gb-inout-header-right';

  inEl.innerHTML = `${inHeaderHtml}${inIds.map(id => playerTileHtml(side, id, mirrored)).join('')}`;
  outEl.innerHTML = `<div class="gb-inout-header${outHeaderClass}">OUT</div>${outIds.map(id => playerTileHtml(side, id, mirrored)).join('')}`;

  wireSideTileInteractions(inEl, side);
  wireSideTileInteractions(outEl, side);
}

function wireSideTileInteractions(container, side) {
  container.querySelectorAll('.gb-inout-tile').forEach(tile => {
    const id = tile.dataset.id;
    let lastTap = 0;
    // A native double-click fires click, click, dblclick on the SAME
    // element (unlike Rotations' grid, where toggle-absent and
    // show-status live on two different sub-elements so click/dblclick
    // never compete). Here both actions share one tile, so a plain click
    // listener would double-toggle the quarter cell before dblclick ever
    // fires. Debounce: a click schedules toggleQuarter after a short
    // delay; if a second click arrives first (i.e. this becomes a real
    // double-click), the pending single-click action is cancelled instead
    // of running twice.
    let clickTimer = null;

    const toggleQuarter = () => {
      if (side.absent.has(id)) return; // absent players can't be toggled in
      const pat = side.pattern.get(id) || [false, false, false, false];
      pat[activeQuarter] = !pat[activeQuarter];
      side.pattern.set(id, pat);
      autoSaveIfLoggedOut(side);
      renderGameView();
    };

    const toggleAbsent = () => {
      if (side.absent.has(id)) side.absent.delete(id);
      else side.absent.add(id);
      autoSaveIfLoggedOut(side);
      renderGameView();
    };

    tile.addEventListener('click', () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        toggleQuarter();
      }, 250);
    });
    tile.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      toggleAbsent();
    });
    // Touch double-tap, same pattern used on the Rotations grid — mobile
    // browsers don't reliably fire `dblclick` on tap, so double-tap is
    // detected manually via timestamps instead. touchend also fires a
    // synthetic click afterward on most mobile browsers, which the same
    // debounce above absorbs/cancels when the second tap lands in time.
    tile.addEventListener('touchend', e => {
      const now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        toggleAbsent();
      }
      lastTap = now;
    });
  });
}

function updateSaveButtonVisibility() {
  const btn = document.getElementById('btn-save-game-config');
  const canSave = !!getCurrentCoach() && activeGameIdx !== -1;
  btn.classList.toggle('hidden', !canSave);
}

async function saveActiveGameConfig() {
  const coach = getCurrentCoach();
  if (!coach || activeGameIdx === -1) return;

  // Firestore key: the sheet's absolute Game # (shared, stable across both
  // teams playing each other) — NOT the per-team sequence number, which
  // was the root cause of a config saved from one team's Game view not
  // showing up correctly from the opponent's Game view (see loadActiveGame).
  const game = teamGames[activeGameIdx];
  const sheetGameNum = game[SCHED_COL.GAME];
  // Display-only: each side's OWN per-team sequence number, used in the
  // human-readable title so "Game 2" in the title still means what a coach
  // sees on that team's button bar.
  const ownDisplayNum = activeGameIdx + 1;
  const oppDisplayNum = oppSide ? gamesForTeam(oppSide.team).findIndex(g => g[SCHED_COL.GAME] === sheetGameNum) + 1 : null;

  const tasks = [];
  if (ownSide) tasks.push(saveOneSideConfig(coach.name, ownSide, sheetGameNum, ownDisplayNum, oppSide?.team));
  if (oppSide) tasks.push(saveOneSideConfig(coach.name, oppSide, sheetGameNum, oppDisplayNum, ownSide?.team));

  const btn = document.getElementById('btn-save-game-config');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await Promise.all(tasks);
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = '💾 Save to Gameboard'; btn.disabled = false; }, 1500);
  } catch (err) {
    console.error('Save to Gameboard failed:', err);
    alert('Save failed — please try again.');
    btn.textContent = '💾 Save to Gameboard';
    btn.disabled = false;
  }
}

async function saveOneSideConfig(coachName, side, sheetGameNum, displayNum, opponentTeam) {
  const presentOrder = side.order.filter(id => !side.absent.has(id));
  const isValid = computeGameStatus(side.pattern, side.absent, side.order).valid;
  const config = {
    team: side.team,
    order: [...side.order],
    pattern: Object.fromEntries(side.pattern.entries()),
    presentIds: presentOrder,
    isValid,
    title: `Game ${displayNum ?? '?'} vs. ${teamShortNameFor(opponentTeam || '?')}`,
    gameTag: { team: side.team, opponentTeam: opponentTeam || null, gameNum: sheetGameNum },
  };
  await saveGameConfig(coachName, side.team, sheetGameNum, config);
}

function wireGameTeamSelect() {
  document.getElementById('gb-game-team-select').addEventListener('change', async e => {
    await loadGameTeam(e.target.value);
  });
}

function wireSaveGameConfigButton() {
  document.getElementById('btn-save-game-config').addEventListener('click', saveActiveGameConfig);
}

// Coach's own team, derived the same way Rotations/Schedules already do:
// string-matching the suffix after "Coach "/"Director " in COACHES against
// "Team " in TEAMS. No explicit stored mapping exists (documented gotcha).
function coachDefaultTeam(coach) {
  if (!coach) return '';
  const suffix = coach.name.replace(/^(Coach|Director)\s+/, '');
  return TEAMS.find(t => t.replace(/^Team\s+/, '') === suffix) || '';
}

// Deep link support: gameboard.html?team=Team+Name&game=3 (used by the
// Rotations page's "Go to Game" saved-config option) selects the Game view,
// a specific team, and a specific game number in one navigation — takes
// precedence over the logged-in coach's default team on initial load only.
// `game` in the URL is the sheet's absolute Game # (see rotations.js's "Go
// to Game" link, and gameboard.js's own gameTag keys) — NOT a per-team
// display index — so it must be resolved by finding which of the linked
// team's games has that sheet number, not used as a direct array offset.
function deepLinkParams() {
  const params = new URLSearchParams(window.location.search);
  const team = params.get('team');
  const sheetGameNum = params.get('game');
  return {
    team: team && TEAMS.includes(team) ? team : null,
    sheetGameNum: sheetGameNum || null,
  };
}

async function initGameView() {
  populateGameTeamSelect();
  wireGameTeamSelect();
  wireSaveGameConfigButton();

  const { team: linkedTeam, sheetGameNum: linkedSheetGameNum } = deepLinkParams();
  if (linkedTeam) {
    setView('game');
    document.getElementById('gb-game-team-select').value = linkedTeam;
    await loadGameTeam(linkedTeam);
    if (linkedSheetGameNum) {
      const idx = teamGames.findIndex(g => g[SCHED_COL.GAME] === linkedSheetGameNum);
      if (idx !== -1) {
        activeGameIdx = idx;
        renderGameNumBar();
        await loadActiveGame();
      }
    }
    return;
  }

  const coach = getCurrentCoach();
  const defaultTeam = coachDefaultTeam(coach);
  if (defaultTeam) {
    document.getElementById('gb-game-team-select').value = defaultTeam;
    await loadGameTeam(defaultTeam);
  }

  // Login can happen after this page has already loaded (the coach-login
  // modal is available from every page's header) — re-derive the default
  // team at that point too, but only if the coach hasn't already picked a
  // team of their own, so logging in mid-session doesn't yank the view
  // away from whatever they were actively looking at. Logging out doesn't
  // change the team selection either way, but does hide the Save button
  // and drop any saved-config overlay (handled inside loadActiveGame /
  // updateSaveButtonVisibility, both re-run via loadGameTeam here).
  document.addEventListener('coachChanged', async () => {
    const c = getCurrentCoach();
    if (c && !gameTeam) {
      const team = coachDefaultTeam(c);
      if (team) {
        document.getElementById('gb-game-team-select').value = team;
        await loadGameTeam(team);
        return;
      }
    }
    if (gameTeam) await loadActiveGame(); // re-check saved config / Save button visibility either way
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setView(getCurrentCoach() ? 'game' : 'board');
  renderBoardGrid();
  buildIconIndex().then(renderBoardGrid);
  wireBoardTileClicks();
  wirePopoverDismiss();
  initGameView();

  document.querySelectorAll('.gb-view-toggle .avatar-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
});
