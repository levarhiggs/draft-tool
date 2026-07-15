// gameboard.js — Gameboard page: Game/Board view toggle + Board team grid.
// Default view on load: "Game" if a coach is logged in, "Board" otherwise.
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_COLORS } from './coaches-config.js';
import { buildIconIndex, iconUrl, fetchPlayers, buildDriveIndex, photoUrl, COL } from './players-data.js';
import { fetchSchedule, parseGameDate, COL as SCHED_COL } from './schedule-data.js';
import { getCompositeRank, getGameConfig, saveGameConfig, getAllScheduleGames, saveJerseyNumber, clearJerseyNumber, saveLiveStatLog, getLiveStatLog, saveGameLogNotes, getGameLogNotes, saveGameboardGhosts, getGameboardGhosts } from './firebase.js';
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
// and push to change the Board view's layout for all coaches. true = rank 1
// alone in its own full-width band, ranks 2-3 sharing a second band, ranks
// 4-12 in the normal 3-per-row grid, all ordered by True Rank (see
// trueRankFor). false = plain 3-per-row grid, no bands, TEAMS array order.
// Flipped to true once every team had played a game and True Rank's formula
// was decided (the league's own official formula, not a Bayesian one — see
// trueRankFor's comment).
const USE_PODIUM_LAYOUT = true;

// ── Season stats (Points Made/Allowed, Wins/Losses, Scoring Ratio, etc.) ────
// Computed client-side from the schedule sheet's V/H columns (which team
// color played in each game #) cross-referenced with scheduleGames/{gameNum}
// Firestore docs (the actual scores). Recomputed fresh every time Board view
// loads — no caching across page loads, since a score can be saved from a
// different tab/page (Schedules) that this page has no way to be notified
// of live (this app has no cross-tab messaging anywhere).
let teamStats = {}; // team (TEAMS entry, e.g. "Team Blue") -> stats object

function emptyTeamStats() {
  return { pointsMade: 0, pointsAllowed: 0, wins: 0, losses: 0, gamesPlayed: 0 };
}

// Ties are not expected to occur in this league (every game gets a winner
// eventually) — a scheduleGames doc with a null winner is treated as
// not-yet-played (skipped) rather than specially counted, matching how the
// rest of the app already treats missing scores.
async function loadTeamStats() {
  const [games, scheduleGames] = await Promise.all([fetchSchedule(), getAllScheduleGames()]);
  const stats = {};
  TEAMS.filter(t => t !== 'Undrafted').forEach(t => { stats[t] = emptyTeamStats(); });

  games.forEach(game => {
    const result = scheduleGames[game[SCHED_COL.GAME]];
    if (!result || result.vScore == null || result.hScore == null) return;

    const vTeam = teamNameForColor(game[SCHED_COL.V]);
    const hTeam = teamNameForColor(game[SCHED_COL.H]);
    if (vTeam && stats[vTeam]) {
      stats[vTeam].pointsMade += result.vScore;
      stats[vTeam].pointsAllowed += result.hScore;
      stats[vTeam].gamesPlayed += 1;
      if (result.winner === 'V') stats[vTeam].wins += 1;
      else if (result.winner === 'H') stats[vTeam].losses += 1;
    }
    if (hTeam && stats[hTeam]) {
      stats[hTeam].pointsMade += result.hScore;
      stats[hTeam].pointsAllowed += result.vScore;
      stats[hTeam].gamesPlayed += 1;
      if (result.winner === 'H') stats[hTeam].wins += 1;
      else if (result.winner === 'V') stats[hTeam].losses += 1;
    }
  });

  teamStats = stats;
}

function statsFor(team) {
  return teamStats[team] || emptyTeamStats();
}

function scoringRatioFor(team) {
  const s = statsFor(team);
  if (s.pointsAllowed === 0) return s.pointsMade === 0 ? 0 : Infinity;
  return s.pointsMade / s.pointsAllowed;
}

function winLossPctFor(team) {
  const s = statsFor(team);
  return s.gamesPlayed === 0 ? 0 : (s.wins / s.gamesPlayed) * 100;
}

// True Rank = the league's own official standings formula (used in past
// seasons, kept as-is rather than a statistically "nicer" alternative so
// this app's ranking stays in sync with what the league officially
// reports) — Scoring Ratio divided by the full season's game count (10),
// plus Win/Loss %. Win/Loss % dominates (0-100 range vs. Scoring Ratio/10's
// ~0-0.2 range), so this is effectively "rank by win percentage, broken by
// scoring ratio" — any team with at least one win outranks a winless team
// regardless of point differential or games played. Not adjusted for
// strength of schedule or sample size.
function trueRankFor(team) {
  return (scoringRatioFor(team) / 10) + winLossPctFor(team);
}

function tileHtml(team, i) {
  const info = TEAM_COLORS[team];
  const colorName = info?.name || '';
  const icon = iconUrl(colorName);
  const s = statsFor(team);
  const ratio = scoringRatioFor(team);
  const ratioStr = ratio === Infinity ? '—' : ratio.toFixed(2);
  // Squircle background is filled with the team's own color underneath the
  // icon <img> — some phones load these icon images slowly or not at all,
  // so this shows through immediately as a placeholder and stays visible
  // behind the image (harmless) once it does load, rather than leaving a
  // blank space in the meantime.
  const hex = info?.hex || 'transparent';
  const idColor = info?.hex ? readableTextColor(info.hex) : 'var(--clr-muted)';
  return `
    <div class="gb-team-tile" data-team="${team}" role="button" tabindex="0">
      <span class="gb-team-tile-color">${colorName.toUpperCase()}</span>
      <div class="gb-team-tile-icon" style="background:${hex}">
        ${icon
          ? `<img src="${icon}" alt="${colorName}" loading="lazy" />`
          : `<span class="gb-team-tile-id" style="color:${idColor}">${i + 1}</span>`}
      </div>
      <div class="gb-team-tile-label">
        <span class="gb-team-tile-coach">${team}</span>
        <span class="gb-team-tile-stats">W: ${s.wins} - L:${s.losses} - R:${ratioStr}</span>
      </div>
    </div>`;
}

// Board view lists teams ranked by True Rank, highest first (Undrafted
// excluded) — see trueRankFor.
function renderBoardGrid() {
  const top = document.getElementById('gb-board-top');
  const second = document.getElementById('gb-board-second');
  const grid = document.getElementById('gb-board-grid');
  const teams = TEAMS.filter(t => t !== 'Undrafted')
    .sort((a, b) => trueRankFor(b) - trueRankFor(a));

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
// Stats are computed for real from Schedules' scheduleGames Firestore data
// (see loadTeamStats above), including True Rank (see trueRankFor).

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
// what the stat means and how it's calculated.
function statDefsFor(team) {
  const s = statsFor(team);
  const ratio = scoringRatioFor(team);
  const ratioStr = ratio === Infinity ? '—' : ratio.toFixed(2);
  const pct = winLossPctFor(team);
  const trueRank = trueRankFor(team);
  return [
    { key: 'pointsMade',     label: 'Points Made',      value: String(s.pointsMade), blurb: 'Total # of points scored against opponents this entire season; a measure of offensive strength.' },
    { key: 'pointsAllowed',  label: 'Points Allowed',   value: String(s.pointsAllowed), blurb: 'Total # of points scored on this team by opponents this season; a measure of defensive strength.' },
    { key: 'scoringRatio',   label: 'Scoring Ratio',    value: ratioStr, blurb: 'Points Made divided by Points Allowed; the higher the ratio the stronger the performance.' },
    { key: 'wins',           label: 'Wins',             value: String(s.wins) }, // self-explanatory, no tap blurb
    { key: 'losses',         label: 'Losses',           value: String(s.losses) }, // self-explanatory, no tap blurb
    { key: 'gamesPlayed',    label: 'Games Played',     value: String(s.gamesPlayed) }, // self-explanatory, no tap blurb
    { key: 'winLossRatio',   label: 'Win/Loss %',       value: `${pct.toFixed(1)}%`, blurb: 'Wins divided by # of games played so far; the higher percentage of wins, the better.' },
    { key: 'trueRank',       label: 'True Rank',        value: trueRank.toFixed(2), blurb: "(Scoring Ratio ÷ 10) + Win/Loss %; the league's official ranking formula, ranked highest to lowest across all 12 teams." },
  ];
}

// Full-board modal (not a floating per-tile popover) — dims the whole
// Board view grid behind it. Tapping anywhere outside the stat box closes
// it and re-enables the tiles underneath (see wireBoardTileClicks'
// dismiss handler); tapping a stat row toggles its blurb without closing.
function showTeamStatsModal(team) {
  const overlay = document.getElementById('gb-team-stats-modal');
  const box = document.getElementById('gb-team-stats-box');
  const info = TEAM_COLORS[team];
  const displayName = info?.shortName || info?.name || '';
  const hex = info?.hex || '#8890a8';
  const statDefs = statDefsFor(team);

  const rows = statDefs.map(stat => stat.blurb
    ? `<div class="sched-popover-row gb-stat-row" data-stat="${stat.key}" role="button" tabindex="0">
        <span>${escHtml(stat.label)}</span><span>${escHtml(stat.value)}</span>
      </div>`
    : `<div class="sched-popover-row">
        <span>${escHtml(stat.label)}</span><span>${escHtml(stat.value)}</span>
      </div>`
  ).join('');

  box.innerHTML = `
    <div class="sched-popover-title gb-team-stats-title">
      <span class="gb-team-stats-dot" style="background:${hex}"></span>${escHtml(displayName.toUpperCase())} — ${escHtml(team)}
    </div>
    ${rows}
    <div id="gb-stat-blurb" class="sched-popover-hint hidden"></div>
  `;

  box.querySelectorAll('.gb-stat-row').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      const stat = statDefs.find(s => s.key === row.dataset.stat);
      const blurbEl = box.querySelector('#gb-stat-blurb');
      const alreadyShowingThis = !blurbEl.classList.contains('hidden') && blurbEl.dataset.stat === stat.key;
      box.querySelectorAll('.gb-stat-row').forEach(r => r.classList.remove('gb-stat-row-active'));
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

  overlay.classList.remove('hidden');
}

function closeTeamStatsModal() {
  document.getElementById('gb-team-stats-modal').classList.add('hidden');
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
        showTeamStatsModal(tile.dataset.team);
      });
    });

  // Tapping anywhere outside the stat box (the dimmed overlay itself)
  // closes the modal and re-enables the tiles underneath — clicks inside
  // the box (including stat rows) never bubble this far since showTeamStats
  // Modal's own row handler calls stopPropagation.
  document.getElementById('gb-team-stats-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTeamStatsModal();
  });
}

function wirePopoverDismiss() {
  document.addEventListener('click', e => {
    // Board view's team stats modal has its own dedicated overlay-click
    // dismiss handler (see wireBoardTileClicks) since it's a centered
    // modal, not an anchored popover like the ones below.
    const jerseyPopover = document.getElementById('gb-jersey-popover');
    if (!(jerseyPopover.contains(e.target) || e.target.closest('.gb-inout-tile'))) {
      jerseyPopover.classList.add('hidden');
    }
    const summaryPopover = document.getElementById('gb-livestat-summary-popover');
    if (!(summaryPopover.contains(e.target) || e.target.closest('.gb-gamelog-score-circle'))) {
      summaryPopover.classList.add('hidden');
    }
    // Live Stat panel: any click that reaches here wasn't on the panel
    // itself (its own click handler stops propagation) or on the tile that
    // opened/would toggle it (also stops propagation) — so it's genuinely
    // an "outside" tap and should dismiss the panel, per the user's spec.
    if (liveStatActivePlayer) closeLiveStatPanel();
    // Game Log notes modal has its own dedicated overlay-click dismiss
    // handler (see wireGameLogNotesPanel), same as the team stats modal.
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
let jerseyMode = false;        // Jersey # view toggle — see wireJerseyToggle
let liveStatMode = false;      // LIVE STAT toggle
let liveStatActivePlayer = null; // { side, id } of the tapped/highlighted IN player, or null
// ASST's "2-for-1" sub-flow state: null outside of it, 'pick-scorer' while
// choosing who scored, or { scorerId } once picked and waiting on 2PT/3PT.
// Reset to null whenever the panel itself closes/reopens (see
// closeLiveStatPanel/openLiveStatPanel) so a stale sub-flow never survives
// into a different player's panel.
let liveStatAssistFlow = null;
// Append-only running log for the CURRENT quarter only — cleared whenever
// Live Stat mode is switched off, or the quarter/game/team changes. No
// cross-quarter skip-around or persistence yet; this is deliberately
// scoped to "quarter 1 only, no swapping players, no toggling mode
// off/on" per the user's explicit constraint for this first pass.
// Entry shape: { side, playerId, statKey, favorable, label }
let liveStatLog = [];
// Rudimentary per-quarter notepad on the Game Log panel — { "0": "text",
// "1": "...", ... }, keyed by quarter index as a string (Firestore map
// keys are always strings anyway). Same persistence split used throughout
// this page: Firestore when a coach is logged in (see
// saveGameLogNotes/getGameLogNotes in firebase.js), sessionStorage draft
// when not (see saveLocalGameState/applyLocalGameState for the pattern).
let gameLogNotesByQuarter = {};

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

// Picks the first game whose date is today or later (day-level compare —
// a game earlier today still counts as "next" even if its start time has
// already passed, per the user's spec). Falls back to the team's LAST game
// if every game is already in the past, so the view still lands somewhere
// meaningful post-season rather than snapping back to game 1.
function defaultGameIdxFor(games) {
  if (games.length === 0) return -1;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const idx = games.findIndex(g => {
    const d = parseGameDate(g[SCHED_COL.DATE], g[SCHED_COL.TIME]);
    if (!d) return false;
    d.setHours(0, 0, 0, 0);
    return d >= today;
  });
  return idx !== -1 ? idx : games.length - 1;
}

async function loadGameTeam(team) {
  gameTeam = team;
  activeQuarter = 0;
  liveStatMode = false;
  liveStatActivePlayer = null;
  resetLiveStatLog();
  await ensureGameDataLoaded();

  teamGames = gamesForTeam(team);
  activeGameIdx = defaultGameIdxFor(teamGames);

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
      p._jerseyByCoach = data.jerseyNumbers || {};
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
    // Named "ghost" players (see resolveUnassignedJersey) and not-yet-named
    // placeholder slots (see the Lineup Manager Go button) both get spliced
    // into players/order/pattern just like a real roster player once they
    // exist — this map just tracks which entries in `players` are
    // synthetic, keyed by jersey #, so the Go button can find/reuse the
    // same slot instead of creating duplicates. Ghosts are restored from
    // Firestore/session below; unresolved placeholders are NOT persisted
    // (session-live only — re-running the 5-digit code recreates them).
    ghostsByJersey: {}, // { [jerseyNum]: playerId } — playerId is "ghost:N" or "unresolved:N"
  };
}

// ── Lineup Manager jersey-code precedence (unassigned / absent / ghost) ────
// A jersey # typed into the 5-digit quick-set is treated as ground truth
// that a real body wearing that number is on the court right now — see the
// user's spec: it should never silently fail just because the roster
// doesn't (yet) know who that is, or thinks they're absent.

function ghostSessionKey(team) {
  return `gameboard_ghosts_${team}`;
}

// Restores this coach's NAMED ghosts for the team (Firestore if logged in,
// sessionStorage draft if not — same split used throughout this page).
// Unresolved (not-yet-named) placeholders are intentionally NOT restored;
// they only exist for the live session that created them.
async function restoreGhostsForSide(side) {
  const coach = getCurrentCoach();
  let ghostsByJersey = {};
  if (coach) {
    const saved = await getGameboardGhosts(coach.name, side.team);
    ghostsByJersey = saved?.ghostsByJersey || {};
  } else {
    try {
      const raw = sessionStorage.getItem(ghostSessionKey(side.team));
      ghostsByJersey = raw ? JSON.parse(raw) : {};
    } catch { ghostsByJersey = {}; }
  }
  Object.entries(ghostsByJersey).forEach(([jerseyNum, name]) => {
    addGhostToSide(side, parseInt(jerseyNum, 10), name);
  });
}

async function persistGhostsForSide(side) {
  const ghostsByJersey = {};
  Object.entries(side.ghostsByJersey).forEach(([jerseyNum, id]) => {
    if (id.startsWith('ghost:')) ghostsByJersey[jerseyNum] = side.players[id][COL.NAME];
  });
  const coach = getCurrentCoach();
  if (coach) {
    await saveGameboardGhosts(coach.name, side.team, ghostsByJersey);
  } else {
    try { sessionStorage.setItem(ghostSessionKey(side.team), JSON.stringify(ghostsByJersey)); }
    catch { /* sessionStorage unavailable/full — silently skip, not critical */ }
  }
}

// Splices a named ghost into the side's roster-like structures so every
// existing lookup (side.players[id], side.order, side.pattern) treats it
// exactly like a real player from here on — Live Stat logging, tile
// rendering, everything. `jerseyNum` is baked into the synthetic player so
// jerseyNumberFor() can special-case it below (a ghost has no real
// Firestore player doc to store a jersey number against).
function addGhostToSide(side, jerseyNum, name) {
  const id = `ghost:${jerseyNum}`;
  if (side.players[id]) return id; // already spliced in, don't duplicate
  side.players[id] = { [COL.ID]: id, [COL.NAME]: name, _isGhost: true, _ghostJerseyNum: jerseyNum };
  side.order.push(id);
  side.pattern.set(id, [false, false, false, false]);
  side.ghostsByJersey[jerseyNum] = id;
  return id;
}

// Splices an UNNAMED placeholder in — same mechanics as addGhostToSide, but
// never persisted (see restoreGhostsForSide) and renders/behaves
// differently until named (see playerTileHtml / wireSideTileInteractions).
function addUnresolvedToSide(side, jerseyNum) {
  const id = `unresolved:${jerseyNum}`;
  if (side.players[id]) return id;
  side.players[id] = { [COL.ID]: id, [COL.NAME]: `#${jerseyNum}`, _isUnresolved: true, _ghostJerseyNum: jerseyNum };
  side.order.push(id);
  side.pattern.set(id, [false, false, false, false]);
  side.ghostsByJersey[jerseyNum] = id;
  return id;
}

// Promotes an unresolved placeholder to a named ghost in place — same
// playerId is NOT reused (ghost: vs unresolved: prefixes differ), so this
// removes the old unresolved entry and splices in a fresh named one,
// carrying over whatever pattern/absent state had already accumulated
// under the placeholder (e.g. if it was already marked IN this quarter).
async function promoteUnresolvedToGhost(side, jerseyNum, name) {
  const oldId = `unresolved:${jerseyNum}`;
  const oldPattern = side.pattern.get(oldId);
  const wasAbsent = side.absent.has(oldId);
  side.order = side.order.filter(oid => oid !== oldId);
  side.pattern.delete(oldId);
  side.absent.delete(oldId);
  delete side.players[oldId];

  const newId = addGhostToSide(side, jerseyNum, name);
  if (oldPattern) side.pattern.set(newId, oldPattern);
  if (wasAbsent) side.absent.add(newId);
  await persistGhostsForSide(side);
  return newId;
}

// Reassigns an unresolved placeholder's jersey # to a REAL roster player
// instead of naming a ghost — the placeholder disappears entirely and that
// player's tile takes its place, carrying over the same IN/OUT state.
async function resolveUnassignedToRealPlayer(side, jerseyNum, realPlayerId) {
  const oldId = `unresolved:${jerseyNum}`;
  const oldPattern = side.pattern.get(oldId);
  const wasAbsent = side.absent.has(oldId);
  side.order = side.order.filter(oid => oid !== oldId);
  side.pattern.delete(oldId);
  side.absent.delete(oldId);
  delete side.players[oldId];
  delete side.ghostsByJersey[jerseyNum];

  const player = side.players[realPlayerId];
  await setJerseyNumberFor(player, jerseyNum);
  if (oldPattern) side.pattern.set(realPlayerId, oldPattern);
  side.absent.delete(realPlayerId);
  if (wasAbsent) { /* the placeholder's absence doesn't carry over to a newly-identified real player — they're being actively placed IN */ }
}

// ── Jersey # (per-coach, per-player, not tied to any one game) ──────────────
// Required for every player to play at all, but coaches don't share a
// canonical numbering scheme with each other and don't always know the
// opposing team's numbers — so each coach records their own view of it,
// mirroring rankings/modifiers/notes' existing per-coach Firestore pattern.
// Logged-out: kept in sessionStorage only, same "draft until you log in"
// convention used elsewhere on this page (see saveLocalGameState above).
function sessionJerseyKey(playerId) {
  return `gameboard_jersey_${playerId}`;
}

function jerseyNumberFor(player) {
  // Ghosts/unresolved placeholders carry their number inline — they have no
  // real Firestore player doc to store a per-coach jersey number against.
  if (player._ghostJerseyNum != null) return player._ghostJerseyNum;
  const coach = getCurrentCoach();
  if (coach) {
    const n = player._jerseyByCoach?.[coach.name];
    return n == null ? null : n;
  }
  try {
    const raw = sessionStorage.getItem(sessionJerseyKey(player[COL.ID]));
    return raw == null ? null : parseInt(raw, 10);
  } catch { return null; }
}

async function setJerseyNumberFor(player, number) {
  const coach = getCurrentCoach();
  if (coach) {
    player._jerseyByCoach = { ...(player._jerseyByCoach || {}), [coach.name]: number };
    await saveJerseyNumber(player[COL.ID], coach.name, number);
  } else {
    try { sessionStorage.setItem(sessionJerseyKey(player[COL.ID]), String(number)); }
    catch { /* sessionStorage unavailable/full — silently skip, not critical */ }
  }
}

async function clearJerseyNumberFor(player) {
  const coach = getCurrentCoach();
  if (coach) {
    if (player._jerseyByCoach) delete player._jerseyByCoach[coach.name];
    await clearJerseyNumber(player[COL.ID], coach.name);
  } else {
    try { sessionStorage.removeItem(sessionJerseyKey(player[COL.ID])); }
    catch { /* sessionStorage unavailable/full — silently skip, not critical */ }
  }
}

// Numbers already taken on a team (each coach's own numbering — two coaches
// can't collide with each other since jerseyNumbers is per-coach, but two
// players on the SAME roster, viewed by the SAME coach, must not share a
// number). Returns { [number]: player }.
function takenJerseyNumbers(side) {
  const taken = {};
  side.order.forEach(id => {
    const p = side.players[id];
    const num = jerseyNumberFor(p);
    if (num != null) taken[num] = p;
  });
  return taken;
}

async function loadActiveGame() {
  // A new game rebuilds ownSide/oppSide from scratch below — any panel
  // referencing the OLD side objects would be stale even if the player id
  // happened to coincidentally match. Clear the log as a safe default here;
  // if a coach is logged in and has a saved log for the new team+game, it
  // gets restored below (see restoreLiveStatLog) instead of staying empty.
  liveStatActivePlayer = null;
  liveStatMode = false;
  resetLiveStatLog();

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
  // Ghosts must be spliced into side.order BEFORE the saved lineup config
  // is applied below — that step restores pattern/absent by iterating
  // side.order, so a ghost that was IN in a previously-saved lineup needs
  // to already exist as an entry for its saved state to attach to.
  await Promise.all([
    restoreGhostsForSide(ownSide),
    oppSide ? restoreGhostsForSide(oppSide) : Promise.resolve(),
  ]);

  const coach = getCurrentCoach();
  if (coach) {
    await Promise.all([
      applySavedGameConfig(ownSide, coach.name, gameTeam, sheetGameNum),
      oppSide ? applySavedGameConfig(oppSide, coach.name, oppTeam, sheetGameNum) : Promise.resolve(),
      restoreLiveStatLog(coach.name, gameTeam, sheetGameNum),
      restoreGameLogNotes(gameTeam, sheetGameNum),
    ]);
  } else {
    applyLocalGameState(ownSide, gameTeam, sheetGameNum);
    if (oppSide) applyLocalGameState(oppSide, oppTeam, sheetGameNum);
    resetLiveStatLog(); // no coach logged in -> no saved log to restore
    await restoreGameLogNotes(gameTeam, sheetGameNum);
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
  // Must run BEFORE renderInOutColumns(): it's what decides whether
  // liveStatMode should auto-turn-off for the newly active quarter (if its
  // lineup isn't 5-5), and the tile grid below reads liveStatMode while
  // rendering (OUT tiles disabled, IN tiles open the stat panel, etc.) — if
  // this ran after, tiles would be built against the PREVIOUS quarter's
  // stale mode for one render pass.
  updateLiveStatToggle();
  renderInOutColumns();
  updateSaveButtonVisibility();
}

// # of non-absent players IN for the CURRENTLY ACTIVE quarter on one side —
// same IN/OUT split logic renderSideContainers already uses, factored out
// so the Live Stat toggle can check it without re-rendering tiles.
function countInForActiveQuarter(side) {
  if (!side) return 0;
  return side.order.filter(id => !side.absent.has(id) && (side.pattern.get(id) || [])[activeQuarter]).length;
}

// LIVE STAT toggle bar (see gameboard.html, between the IN and OUT rows) —
// only appears once both sides have EXACTLY 5 IN for the active quarter.
function updateLiveStatToggle() {
  const btn = document.getElementById('gb-livestat-toggle');
  const ready = countInForActiveQuarter(ownSide) === 5 && countInForActiveQuarter(oppSide) === 5;
  btn.classList.toggle('hidden', !ready);
  if (!ready && liveStatMode) liveStatMode = false; // auto-off only — log is NOT cleared, see wireLiveStatToggle
  if (!liveStatMode) liveStatActivePlayer = null; // stale reference guard — mode off means no panel can be open
  btn.classList.toggle('gb-livestat-on', liveStatMode);
  document.getElementById('gb-livestat-state').textContent = liveStatMode ? 'ON' : 'OFF';

  // Indicator #2: Game Log panel covers the mini-grids entirely while Live
  // Stat mode is on. Lines are kept in sync regardless of visibility (not
  // gated on liveStatMode) so the content is never stale from a previous
  // quarter by the time the panel becomes visible again.
  document.getElementById('gb-gamelog-panel').classList.toggle('hidden', !liveStatMode);
  document.getElementById('gb-gamelog-quarter').textContent = String(activeQuarter + 1);
  renderGameLogLines();
  updateGameLogNotesIndicator();
}

// Shows a small 📝 in the Game Log panel's bottom-right corner when the
// CURRENTLY ACTIVE quarter has a saved note — a quiet hint that
// double-clicking will open existing notes (see openGameLogNotesPanel).
function updateGameLogNotesIndicator() {
  const hasNote = !!gameLogNotesByQuarter[String(activeQuarter)];
  document.getElementById('gb-gamelog-notes-indicator').classList.toggle('hidden', !hasNote);
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

  wireMiniGridDeepLinks(row);
}

// Double-clicking either mini-grid jumps to Rotations for that same team,
// pre-selected — Rotations' own team-select already restores that team's
// last-saved rotation config from localStorage (see rotations.js loadState),
// so no config payload needs to be passed through the URL.
function wireMiniGridDeepLinks(row) {
  const wraps = row.querySelectorAll('.gb-matchup-grid-wrap');
  if (wraps[0] && ownSide) {
    wraps[0].addEventListener('dblclick', () => {
      window.location.href = `rotations.html?team=${encodeURIComponent(ownSide.team)}`;
    });
  }
  if (wraps[1] && oppSide) {
    wraps[1].addEventListener('dblclick', () => {
      window.location.href = `rotations.html?team=${encodeURIComponent(oppSide.team)}`;
    });
  }
}

function renderQuarterTabs() {
  const tabs = document.getElementById('gb-quarter-tabs');
  tabs.innerHTML = [0, 1, 2, 3].map(q => `
    <button class="avatar-toggle-btn${q === activeQuarter ? ' active' : ''}" data-quarter="${q}" type="button">Q${q + 1}</button>
  `).join('');

  tabs.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      activeQuarter = parseInt(btn.dataset.quarter, 10);
      // The log stays intact across quarter switches now (see
      // liveStatLog/logLiveStatEntry) — each entry is tagged with the
      // quarter it was logged under, so switching quarters just changes
      // which IN/OUT lineup is being edited, same as normal, without
      // touching the log itself.
      liveStatActivePlayer = null;
      renderQuarterTabs();
      renderGameView();
    });
  });
}

function renderInOutColumns() {
  renderSideContainers(ownSide, 'gb-own-in', 'gb-own-out', false);
  renderSideContainers(oppSide, 'gb-opp-in', 'gb-opp-out', true);
  renderLiveStatPanel();
}

// Same first-name/first-5-letters/uppercase convention as Rotations'
// firstNameRefLabel, reused here for the stat panel's player crumb.
function fiveLetterName(name) {
  const firstName = (name || '?').split(/\s+/)[0] || name;
  return firstName.slice(0, 5).toUpperCase();
}

// 8 stat buttons: 4 favorable (green outline) left column, 4 unfavorable
// (red outline) right column. `shotValue` (3/2/1) drives both the log
// line's point value and the makes/attempts counter key — ASST/FOUL have
// no shotValue since they're plain running tallies, not a make/miss pair.
const LIVE_STAT_BUTTONS = [
  { key: '3pt-made',  label: '3PT', favorable: true,  shotValue: 3, made: true },
  { key: '3pt-miss',  label: '3PT', favorable: false, shotValue: 3, made: false },
  { key: '2pt-made',  label: '2PT', favorable: true,  shotValue: 2, made: true },
  { key: '2pt-miss',  label: '2PT', favorable: false, shotValue: 2, made: false },
  { key: '1pt-made',  label: '1PT', favorable: true,  shotValue: 1, made: true },
  { key: '1pt-miss',  label: '1PT', favorable: false, shotValue: 1, made: false },
  { key: 'asst',      label: 'ASST', favorable: true },
  { key: 'foul',      label: 'FOUL', favorable: false },
  { key: 'rebound',   label: 'RBND', favorable: true },
  { key: 'turnover',  label: 'TRNOVR', favorable: false },
];

// Makes/attempts counters, per player per shot value, for the CURRENT
// quarter's log only — cleared alongside liveStatLog (see resetLiveStatLog).
// Keyed by `${playerId}-${shotValue}` since jersey # can change mid-game
// (unlikely but not guaranteed unique) while playerId always is.
let liveStatShotCounts = {}; // { "playerId-3": { made, attempts }, ... }
// Plain running counts for the non-shot stats (ASST/FOUL) — same lifetime
// and reset rules as liveStatShotCounts above.
let liveStatSimpleCounts = {}; // { "playerId-asst": 2, "playerId-foul": 1, ... }

function shotCountKey(playerId, shotValue) {
  return `${playerId}-${shotValue}`;
}

function simpleCountKey(playerId, statKey) {
  return `${playerId}-${statKey}`;
}

function resetLiveStatLog() {
  liveStatLog = [];
  liveStatShotCounts = {};
  liveStatSimpleCounts = {};
}

// Highest quarter index (0-3) with any logged activity so far, or null if
// the log is empty. Used to detect "reopening an old quarter" — if the
// coach is viewing a quarter LOWER than this, the game has already moved
// on past it (see openLiveStatPanel's confirm prompt below).
function highestLoggedQuarter() {
  if (liveStatLog.length === 0) return null;
  return liveStatLog.reduce((max, e) => Math.max(max, e.quarter), 0);
}

// Opens the stat panel for a player (id) or the anonymous team (id: null)
// on the given side — the single entry point both a tile tap and the team
// icon tap funnel through, so the "you're about to append to an older
// quarter" confirmation only needs to live in one place. Only warns when
// the quarter being appended to ALREADY HAS entries and a later quarter
// also has entries (i.e. genuinely reopening finished work) — logging
// fresh into whatever the highest quarter already is never prompts.
function openLiveStatPanel(side, id) {
  const highest = highestLoggedQuarter();
  const hasEntriesThisQuarter = liveStatLog.some(e => e.quarter === activeQuarter);
  if (highest != null && activeQuarter < highest && hasEntriesThisQuarter) {
    const label = `Q${activeQuarter + 1}`;
    const ok = confirm(`${label}'s log is from an earlier point in the game. Continue appending to ${label}'s log anyway?`);
    if (!ok) return;
  }
  liveStatActivePlayer = { side, id };
  liveStatAssistFlow = null;
  renderInOutColumns();
}

// Rebuilds liveStatShotCounts/liveStatSimpleCounts from a full entry list
// (used after restoring a saved log — see restoreLiveStatLog) so undo and
// future log-line "N of M attempts" math keep working correctly on
// restored data, not just entries logged fresh this session.
function rebuildLiveStatCounts() {
  liveStatShotCounts = {};
  liveStatSimpleCounts = {};
  liveStatLog.forEach(entry => {
    if (entry.shotValue != null) {
      const key = shotCountKey(entry.playerId, entry.shotValue);
      const counts = liveStatShotCounts[key] || { made: 0, attempts: 0 };
      counts.attempts += 1;
      if (entry.made) counts.made += 1;
      liveStatShotCounts[key] = counts;
    } else {
      const key = simpleCountKey(entry.playerId, entry.statKey);
      liveStatSimpleCounts[key] = (liveStatSimpleCounts[key] || 0) + 1;
    }
  });
}

// Loads a coach's previously-saved log for this team+game from Firestore
// (see saveLiveStatLog/getLiveStatLog in firebase.js) and restores it into
// liveStatLog — Firestore entries store 'own'/'opp' as a plain string
// (side objects aren't serializable), so this re-attaches the live
// ownSide/oppSide object reference each entry needs for rendering/undo.
async function restoreLiveStatLog(coachName, team, sheetGameNum) {
  const saved = await getLiveStatLog(coachName, team, sheetGameNum);
  if (!saved || !Array.isArray(saved.entries) || saved.entries.length === 0) {
    resetLiveStatLog();
    return;
  }
  liveStatLog = saved.entries.map(e => ({
    ...e,
    side: e.side === 'own' ? ownSide : oppSide,
  }));
  rebuildLiveStatCounts();
}

function gameLogNotesSessionKey(team, sheetGameNum) {
  return `gameboard_gamelog_notes_${team}_${sheetGameNum}`;
}

// Restores this coach's Game Log notes for the given team+game (Firestore
// if logged in, sessionStorage draft if not) — same split as
// restoreLiveStatLog/applyLocalGameState above.
async function restoreGameLogNotes(team, sheetGameNum) {
  const coach = getCurrentCoach();
  if (coach) {
    const saved = await getGameLogNotes(coach.name, team, sheetGameNum);
    gameLogNotesByQuarter = saved?.notesByQuarter || {};
    return;
  }
  try {
    const raw = sessionStorage.getItem(gameLogNotesSessionKey(team, sheetGameNum));
    gameLogNotesByQuarter = raw ? JSON.parse(raw) : {};
  } catch { gameLogNotesByQuarter = {}; }
}

async function saveGameLogNotesFor(team, sheetGameNum) {
  const coach = getCurrentCoach();
  if (coach) {
    await saveGameLogNotes(coach.name, team, sheetGameNum, gameLogNotesByQuarter);
  } else {
    try { sessionStorage.setItem(gameLogNotesSessionKey(team, sheetGameNum), JSON.stringify(gameLogNotesByQuarter)); }
    catch { /* sessionStorage unavailable/full — silently skip, not critical */ }
  }
}

// Builds the human-readable log line for one entry AT THE TIME IT WAS
// LOGGED — attempts/makes counts are baked into the entry itself (not
// recomputed later), so undo can cleanly roll the counter back by exactly
// one without needing to replay the whole log. Returns { before, verb,
// after } instead of a flat string so renderGameLogLines can wrap `verb`
// in its own green/red bold-caps span — team identity is conveyed by the
// leading dot (see renderGameLogLines), not text color, so the rest of the
// line is plain text. Leads with a "Q1"/"Q2" tag since a coach can reopen
// an earlier quarter's log later (see confirmOldQuarterAppend) — keeping
// it as a sanity check even though each quarter's log now displays
// separately.
function liveStatLogLineParts(entry) {
  const who = entry.isAnonymous
    ? `Q${entry.quarter + 1} ${entry.playerName}`
    : `Q${entry.quarter + 1} ${entry.jerseyNum == null ? '—' : `#${entry.jerseyNum}`} ${(entry.playerName || '?').split(/\s+/)[0] || entry.playerName}`;

  if (entry.shotValue != null) {
    return {
      before: who,
      verb: entry.made ? 'SCORES' : 'MISSES',
      favorable: entry.made,
      after: `${entry.shotValue}. (${entry.madeAfter}-${entry.attemptsAfter})`,
    };
  }
  if (entry.statKey === 'asst') {
    // Paired via the 2-for-1 flow: "Levar ASSISTS Nicholas. (1)" — the
    // scorer's name reads as the object of the verb. Bypassed/standalone:
    // "Levar ASSIST. (1)", no object to name.
    return entry.scoredByName
      ? { before: who, verb: 'ASSISTS', favorable: true, after: `${entry.scoredByName}. (${entry.countAfter})` }
      : { before: who, verb: 'ASSIST', favorable: true, after: `. (${entry.countAfter})` };
  }
  if (entry.statKey === 'foul') return { before: who, verb: 'FOUL', favorable: false, after: `. (${entry.countAfter})` };
  if (entry.statKey === 'rebound') return { before: who, verb: 'REBOUNDS', favorable: true, after: `the ball (${entry.countAfter})` };
  if (entry.statKey === 'turnover') return { before: who, verb: 'TURNS OVER', favorable: false, after: `the ball (${entry.countAfter})` };
  return { before: who, verb: '', favorable: true, after: '' };
}

// Synthetic "player" for team-anonymous stat attribution (tap the team
// icon itself while Live Stat is on, instead of a specific roster player)
// — lets a coach credit a team when the action happened too fast to catch
// who actually did it. `id: null` is the sentinel wireSideTileInteractions/
// liveStatActivePlayer use to recognize this isn't a real roster player.
function anonymousTeamPlayer(side) {
  const shortName = teamShortNameFor(side.team).toUpperCase();
  return { [COL.ID]: null, [COL.NAME]: shortName, _isTeamAnonymous: true };
}

// Stat-entry panel: appears when a player (or, via the team icon, the team
// itself anonymously) is tapped in the IN column while Live Stat mode is
// on, covering the OPPOSITE side's entire IN container (see LIVE_STATS
// mockup discussion — tap a White player, panel covers Lime's IN column,
// not White's own). `liveStatActivePlayer` tracks which side + id (null
// for the anonymous-team case) triggered it; null means no panel showing.
function renderLiveStatPanel() {
  // Always clear any previously-injected panel first — renderSideContainers
  // already rebuilt both IN containers' innerHTML from scratch this render
  // pass, so there's nothing stale to remove, but this keeps the function
  // safe to call even if that assumption ever changes.
  document.querySelectorAll('.gb-livestat-panel').forEach(el => el.remove());

  if (!liveStatActivePlayer || !liveStatMode) return;
  const { side, id } = liveStatActivePlayer;
  const player = id == null ? anonymousTeamPlayer(side) : side.players[id];
  if (!player) return;

  // Opposite container: own side's player -> panel covers opponent's IN
  // column, and vice versa.
  const targetId = side === ownSide ? 'gb-opp-in' : 'gb-own-in';
  const target = document.getElementById(targetId);
  if (!target) return;

  const jerseyLabel = player._isTeamAnonymous ? '—' : (jerseyNumberFor(player) == null ? '—' : String(jerseyNumberFor(player)));
  const nameLabel = player._isTeamAnonymous ? player[COL.NAME] : fiveLetterName(player[COL.NAME]);

  const panel = document.createElement('div');
  panel.className = 'gb-livestat-panel';
  panel.innerHTML = `
    <div class="gb-livestat-panel-header">
      <span>Player<br><span class="gb-livestat-panel-name">${escHtml(nameLabel)}</span></span>
      <span>Jersey #<br><span class="gb-livestat-panel-name">${escHtml(jerseyLabel)}</span></span>
    </div>
    <div id="gb-livestat-panel-body"></div>
  `;

  renderLiveStatPanelBody(panel, side, player, id);

  panel.addEventListener('click', e => {
    e.stopPropagation();
    handleLiveStatPanelClick(e, panel, side, player, id);
  });

  target.appendChild(panel);
}

// Renders whichever sub-view the panel is currently on into its body slot:
// the normal 8-button grid, or (mid-ASST-flow) the scorer picker / 2PT-3PT
// picker. Kept separate from renderLiveStatPanel itself so switching
// sub-views (see handleLiveStatPanelClick) doesn't have to rebuild the
// whole panel shell (header/undo button) each time.
function renderLiveStatPanelBody(panel, side, player, id) {
  const body = panel.querySelector('#gb-livestat-panel-body');

  if (liveStatAssistFlow === 'pick-scorer') {
    // Teammates only — an assist can't be credited to an opponent, and a
    // player can't assist themselves (id == null, the anonymous-team case,
    // has no "self" to exclude, so every IN player on the team is eligible).
    const teammateIds = side.order.filter(pid =>
      !side.absent.has(pid) &&
      (side.pattern.get(pid) || [])[activeQuarter] &&
      pid !== id
    );
    const namesHtml = teammateIds.map(pid => {
      const p = side.players[pid];
      const jerseyNum = jerseyNumberFor(p);
      const jerseyLabel = jerseyNum == null ? '—' : String(jerseyNum);
      return `<button class="gb-livestat-scorer-btn" data-scorer-id="${escHtml(pid)}" type="button">
        <span class="gb-livestat-scorer-jersey">${escHtml(jerseyLabel)}</span>
        <span class="gb-livestat-scorer-name">${escHtml(fiveLetterName(p?.[COL.NAME]))}</span>
      </button>`;
    }).join('');
    body.innerHTML = `
      <div class="gb-livestat-flow-title">Select which player scored</div>
      <div class="gb-livestat-scorer-grid">${namesHtml}</div>
      <button class="gb-livestat-bypass-btn" type="button">Bypass Score</button>
    `;
    return;
  }

  if (liveStatAssistFlow?.scorerId != null) {
    const scorer = side.players[liveStatAssistFlow.scorerId];
    body.innerHTML = `
      <div class="gb-livestat-flow-title">${escHtml(fiveLetterName(scorer?.[COL.NAME]))} scored how many?</div>
      <div class="gb-livestat-scorer-grid">
        <button class="gb-livestat-stat-btn" data-points="2" type="button">2PT</button>
        <button class="gb-livestat-stat-btn" data-points="3" type="button">3PT</button>
      </div>
      <button class="gb-livestat-back-btn" type="button">← Back</button>
    `;
    return;
  }

  const buttonsHtml = LIVE_STAT_BUTTONS.map(b => `
    <button class="gb-livestat-stat-btn${b.favorable ? '' : ' gb-livestat-stat-unfavorable'}" data-key="${b.key}" type="button">${b.label}</button>
  `).join('');
  body.innerHTML = `<div class="gb-livestat-panel-grid">${buttonsHtml}</div>`;
}

function handleLiveStatPanelClick(e, panel, side, player, id) {
  const backBtn = e.target.closest('.gb-livestat-back-btn');
  if (backBtn) {
    liveStatAssistFlow = liveStatAssistFlow?.scorerId != null ? 'pick-scorer' : null;
    renderLiveStatPanelBody(panel, side, player, id);
    return;
  }

  const bypassBtn = e.target.closest('.gb-livestat-bypass-btn');
  if (bypassBtn) {
    logLiveStatEntry(side, player, 'asst');
    closeLiveStatPanel();
    return;
  }

  const scorerBtn = e.target.closest('.gb-livestat-scorer-btn');
  if (scorerBtn) {
    liveStatAssistFlow = { scorerId: scorerBtn.dataset.scorerId };
    renderLiveStatPanelBody(panel, side, player, id);
    return;
  }

  const pointsBtn = e.target.closest('.gb-livestat-stat-btn[data-points]');
  if (pointsBtn && liveStatAssistFlow?.scorerId != null) {
    const scorer = side.players[liveStatAssistFlow.scorerId];
    const points = pointsBtn.dataset.points;
    // Two entries, assist first then the made shot — see logLiveStatEntry's
    // per-entry quarter/attempt bookkeeping, unaffected by logging two in a
    // row like this since each call is a self-contained push. The assist
    // entry carries the scorer's first name (see liveStatLogLineParts).
    const scorerFirstName = (scorer?.[COL.NAME] || '?').split(/\s+/)[0] || scorer?.[COL.NAME];
    logLiveStatEntry(side, player, 'asst', scorerFirstName);
    logLiveStatEntry(side, scorer, `${points}pt-made`);
    closeLiveStatPanel();
    return;
  }

  const statBtn = e.target.closest('.gb-livestat-stat-btn[data-key]');
  if (statBtn) {
    if (statBtn.dataset.key === 'asst') {
      liveStatAssistFlow = 'pick-scorer';
      renderLiveStatPanelBody(panel, side, player, id);
      return;
    }
    logLiveStatEntry(side, player, statBtn.dataset.key);
    closeLiveStatPanel();
  }
}

function logLiveStatEntry(side, player, statKey, scoredByName) {
  const def = LIVE_STAT_BUTTONS.find(b => b.key === statKey);
  if (!def) return;

  // Anonymous team attribution (tapped the team icon, not a roster player)
  // uses a synthetic negative-ish id per side so its running shot/simple
  // counters don't collide with any real playerId, and skips jersey lookup
  // entirely (there is no real player to look one up for).
  const isAnonymous = !!player._isTeamAnonymous;
  const entry = {
    side, statKey,
    quarter: activeQuarter, // 0-3 — the log spans all quarters now, tagged per-entry rather than reset on switch
    playerId: isAnonymous ? `team:${side.team}` : player[COL.ID],
    playerName: player[COL.NAME] || 'Unknown',
    jerseyNum: isAnonymous ? null : jerseyNumberFor(player),
    isAnonymous,
    // Only set for an ASST entry paired with a scorer via the 2-for-1 flow
    // (see handleLiveStatPanelClick) — "Bypass Score" assists have none.
    scoredByName: scoredByName || null,
    favorable: def.favorable,
    shotValue: def.shotValue ?? null,
    made: def.made ?? null,
  };

  if (def.shotValue != null) {
    const key = shotCountKey(entry.playerId, def.shotValue);
    const counts = liveStatShotCounts[key] || { made: 0, attempts: 0 };
    counts.attempts += 1;
    if (def.made) counts.made += 1;
    liveStatShotCounts[key] = counts;
    entry.madeAfter = counts.made;
    entry.attemptsAfter = counts.attempts;
  } else {
    const key = simpleCountKey(entry.playerId, statKey);
    const count = (liveStatSimpleCounts[key] || 0) + 1;
    liveStatSimpleCounts[key] = count;
    entry.countAfter = count;
  }

  liveStatLog.push(entry);
  renderGameLogLines();
  scheduleLiveStatAutoSave();
}

// Removes the most recent entry belonging to the CURRENTLY ACTIVE quarter
// specifically — not necessarily the last entry in the whole log, since
// each quarter now behaves as its own independent list (see per-quarter
// display in renderGameLogLines). Splices that one entry out of the middle
// of liveStatLog if a later quarter's entries come after it chronologically.
function undoLastLiveStatEntry() {
  let idx = -1;
  for (let i = liveStatLog.length - 1; i >= 0; i--) {
    if (liveStatLog[i].quarter === activeQuarter) { idx = i; break; }
  }
  if (idx === -1) return;
  const [entry] = liveStatLog.splice(idx, 1);
  if (entry.shotValue != null) {
    const key = shotCountKey(entry.playerId, entry.shotValue);
    const counts = liveStatShotCounts[key];
    if (counts) {
      counts.attempts -= 1;
      if (entry.made) counts.made -= 1;
    }
  } else {
    const key = simpleCountKey(entry.playerId, entry.statKey);
    if (liveStatSimpleCounts[key] != null) liveStatSimpleCounts[key] -= 1;
  }
  renderGameLogLines();
  updateScoreCircles();
  scheduleLiveStatAutoSave();
}

// Only this quarter's entries — each quarter is its own independent log
// now (numbering restarts at 1, separate from any other quarter's list).
function entriesForActiveQuarter() {
  return liveStatLog.filter(e => e.quarter === activeQuarter);
}

function renderGameLogLines() {
  const el = document.getElementById('gb-gamelog-lines');
  if (!el) return;
  const entries = entriesForActiveQuarter();
  if (entries.length === 0) {
    el.innerHTML = '<div class="gb-gamelog-empty">No stats logged yet this quarter.</div>';
    return;
  }
  // Each line: a small dot in the entry's own team color (in addition to —
  // not instead of — coloring the line's text that same color), a 1-based
  // entry number scoped to THIS quarter only, then the line itself with
  // its action verb (SCORES/MISSES/ASSIST/FOUL) bolded in green (favorable)
  // or red (unfavorable), all caps.
  el.innerHTML = entries.map((entry, i) => {
    const hex = TEAM_COLORS[entry.side.team]?.hex || 'inherit';
    const parts = liveStatLogLineParts(entry);
    const verbClass = parts.favorable ? 'gb-gamelog-verb-favorable' : 'gb-gamelog-verb-unfavorable';
    const verbHtml = parts.verb ? ` <span class="${verbClass}">${escHtml(parts.verb)}</span>` : '';
    return `<div class="gb-gamelog-line" style="color:${hex}">
      <span class="gb-gamelog-dot" style="background:${hex}"></span>${i + 1}. ${escHtml(parts.before)}${verbHtml} ${escHtml(parts.after)}
    </div>`;
  }).join('');
  // Newest entry (last in DOM order) must stay in view as the log grows —
  // scroll the container to its bottom every time a line is added/removed.
  el.scrollTop = el.scrollHeight;
}

// Opens the notes panel pre-filled with whatever's already saved for the
// CURRENTLY ACTIVE quarter — double-clicking the Game Log panel anywhere
// except Undo/Save Log (see wireGameLogNotesPanel) triggers this. Same
// dim-overlay/centered-modal treatment as Board view's team stats modal —
// header reads "Notes - Left vs Right (Q1)" using each side's short name.
function openGameLogNotesPanel() {
  const ownName = ownSide ? teamShortNameFor(ownSide.team) : '?';
  const oppName = oppSide ? teamShortNameFor(oppSide.team) : '?';
  document.getElementById('gb-gamelog-notes-title').textContent =
    `Notes - ${ownName} vs ${oppName} (Q${activeQuarter + 1})`;
  const textarea = document.getElementById('gb-gamelog-notes-textarea');
  textarea.value = gameLogNotesByQuarter[String(activeQuarter)] || '';
  document.getElementById('gb-gamelog-notes-modal').classList.remove('hidden');
  textarea.focus();
}

// Saves whatever's currently in the textarea and closes the modal — tapping
// the dimmed backdrop outside the box triggers this (see wireGameLogNotesPanel).
function closeGameLogNotesPanel() {
  const textarea = document.getElementById('gb-gamelog-notes-textarea');
  const text = textarea.value.trim();
  if (text) gameLogNotesByQuarter[String(activeQuarter)] = text;
  else delete gameLogNotesByQuarter[String(activeQuarter)];
  document.getElementById('gb-gamelog-notes-modal').classList.add('hidden');
  updateGameLogNotesIndicator();
  if (gameTeam && activeSheetGameNum != null) {
    saveGameLogNotesFor(gameTeam, activeSheetGameNum);
  }
}

function wireGameLogNotesPanel() {
  const panel = document.getElementById('gb-gamelog-panel');
  panel.addEventListener('dblclick', e => {
    if (e.target.closest('.gb-gamelog-undo-btn') || e.target.closest('.gb-gamelog-save-btn')) return;
    e.stopPropagation();
    openGameLogNotesPanel();
  });
  // Tapping the dimmed backdrop (not the box itself) saves + closes — same
  // "click directly on the overlay" check Board view's team stats modal
  // uses (see wireBoardTileClicks).
  document.getElementById('gb-gamelog-notes-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeGameLogNotesPanel();
  });
}

// Updates the score circles' displayed value in place, WITHOUT rebuilding
// the IN/OUT tile grid — used by Undo specifically, since the stat panel
// (anchored inside one of those tiles) must stay open across an undo per
// the user's spec, ruling out the full renderInOutColumns() a normal stat
// tap uses (see closeLiveStatPanel).
function updateScoreCircles() {
  document.querySelectorAll('.gb-gamelog-score-circle').forEach(el => {
    const team = el.dataset.scoreTeam;
    const side = ownSide?.team === team ? ownSide : (oppSide?.team === team ? oppSide : null);
    if (side) el.textContent = String(teamPointsFromLog(side));
  });
}

function closeLiveStatPanel() {
  liveStatActivePlayer = null;
  liveStatAssistFlow = null;
  // Re-renders both the highlighted-tile ring (applied inline at render
  // time in wireSideTileInteractions) and the panel itself — a light touch
  // (skips the matchup row / quarter tabs / toggle bar, all unaffected)
  // rather than the full renderGameView().
  renderInOutColumns();
}

// Standard relative-luminance check (WCAG-style) to auto-pick readable
// black/white text over any team's hex — avoids hand-maintaining a
// light/dark lookup per team as colors get added/changed.
function readableTextColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

// Tiles mirror across the two columns so thumbnails always sit nearest the
// center gap, facing the opposing side's thumbnails: own team (left column)
// = name, then thumbnail on the right; opponent (right column) = thumbnail
// on the left, then name. `mirrored` flips the tile's own internal order.
// `isIn` outlines the thumbnail in this team's own color, ONLY for IN tiles
// AND only while Live Stat mode is on — one of the three visual indicators
// that Live Stat mode is active (see updateLiveStatToggle), reverts to a
// plain thumbnail the moment it's switched off.
function playerTileHtml(side, id, mirrored, isIn) {
  const p = side.players[id];
  const fullName = p?.[COL.NAME] || 'Unknown';
  const firstName = fullName.split(/\s+/)[0] || fullName;
  const isAbsent = side.absent.has(id);
  let avatarHtml;
  // Unresolved placeholders (a jersey # typed via the Lineup Manager that
  // doesn't match any known player) always render as a numbered thumbnail,
  // regardless of Jersey # tile-view mode — there's no photo to show, and
  // the number itself is the whole point until it's resolved. Named ghosts
  // render the same numbered-thumbnail style too (no real photo exists for
  // them either), but participate in Jersey mode's own on/off toggle like
  // a normal player otherwise.
  if (p?._isUnresolved) {
    avatarHtml = `<div class="gb-jersey-avatar gb-jersey-unresolved">${jerseyNumberFor(p)}</div>`;
  } else if (p?._isGhost) {
    // Named ghosts have no real photo, so they always show as a numbered
    // thumbnail (same team-colored styling Jersey mode uses) whether or
    // not Jersey # tile-view mode happens to be on.
    const hex = TEAM_COLORS[side.team]?.hex || '#000000';
    const style = `background:${hex};color:${readableTextColor(hex)};border-color:${hex}`;
    avatarHtml = `<div class="gb-jersey-avatar" style="${style}">${jerseyNumberFor(p)}</div>`;
  } else if (jerseyMode) {
    const num = jerseyNumberFor(p);
    if (num == null) {
      avatarHtml = `<div class="gb-jersey-avatar gb-jersey-unset">#</div>`;
    } else {
      const hex = TEAM_COLORS[side.team]?.hex || '#000000';
      const style = `background:${hex};color:${readableTextColor(hex)};border-color:${hex}`;
      avatarHtml = `<div class="gb-jersey-avatar" style="${style}">${num}</div>`;
    }
  } else {
    const photo = photoUrl(p);
    avatarHtml = photo
      ? `<img src="${photo}" alt="${escHtml(fullName)}" class="gb-inout-avatar-img" />`
      : `<div class="gb-inout-avatar-img gb-inout-avatar-placeholder">🏀</div>`;
  }
  const nameHtml = `<span class="gb-inout-name">${escHtml(firstName)}</span>`;
  const avatarStyle = (isIn && liveStatMode) ? ` style="border:2px solid ${TEAM_COLORS[side.team]?.hex || 'transparent'}"` : '';
  const avatarWrapHtml = `<div class="gb-inout-avatar"${avatarStyle}>${avatarHtml}</div>`;
  return `
    <div class="gb-inout-tile${isAbsent ? ' gb-inout-tile-absent' : ''}" data-id="${escHtml(id)}" role="button" tabindex="0">
      ${mirrored ? avatarWrapHtml + nameHtml : nameHtml + avatarWrapHtml}
    </div>`;
}

// Sum of made shots' point values, this side, across the WHOLE game's log
// (every quarter logged so far, not just the currently active one).
function teamPointsFromLog(side) {
  return liveStatLog.reduce((sum, e) => sum + (e.side === side && e.made && e.shotValue ? e.shotValue : 0), 0);
}

// Always-visible team-colored circle at the IN header's outer edge,
// showing this team's cumulative game point total so far — a coach landing
// on this page wants the running score at a glance, whether or not Live
// Stat mode happens to be on right now. Tapping it opens the per-player
// stat summary (see showLiveStatSummary), or — if nothing's been logged
// yet — a prompt to turn Live Stat on (see renderSideContainers).
function gameLogScoreCircleHtml(side) {
  const hex = TEAM_COLORS[side.team]?.hex || '#8890a8';
  const style = `background:${hex};color:${readableTextColor(hex)}`;
  return `<div class="gb-gamelog-score-circle" style="${style}" data-score-team="${escHtml(side.team)}">${teamPointsFromLog(side)}</div>`;
}

// Per-player Points/Assists/Fouls for this side, this quarter's log only —
// only players who actually have a log entry are included (a coach hasn't
// logged anything for the other 3-4 IN players yet, no point listing them
// as all-zero rows). Same source-of-truth reduce as teamPointsFromLog,
// just broken out per player instead of summed across the team.
function playerStatTotals(side) {
  const totals = {}; // playerId -> { points, assists, fouls }
  liveStatLog.forEach(e => {
    if (e.side !== side) return;
    const t = totals[e.playerId] || { points: 0, assists: 0, fouls: 0 };
    if (e.made && e.shotValue) t.points += e.shotValue;
    if (e.statKey === 'asst') t.assists += 1;
    if (e.statKey === 'foul') t.fouls += 1;
    totals[e.playerId] = t;
  });
  return totals;
}

// Read-only per-player CUMULATIVE GAME summary (tap a team's score circle
// while Live Stat is on) — no editable fields, no quickset entry/Go row,
// just Points/Assists/Fouls across every quarter logged so far (the log
// spans the whole game now, not just one quarter — see logLiveStatEntry's
// `quarter` field). Reuses the Lineup Manager's popover styling but a
// dedicated element (#gb-livestat-summary-popover) since the two are
// conceptually different popovers that could in principle both have
// content queued.
function showLiveStatSummary(anchorEl, side) {
  const popover = document.getElementById('gb-livestat-summary-popover');
  const totals = playerStatTotals(side);

  // Anonymous team-credited stats (see anonymousTeamPlayer) get their own
  // row, keyed by the same "team:{team}" playerId used when logging them —
  // side.order only has real roster ids, so that pseudo-id needs surfacing
  // separately rather than being silently dropped by the roster filter.
  const anonKey = `team:${side.team}`;
  const playerIds = side.order.filter(id => totals[id]);
  const rowIds = totals[anonKey] ? [...playerIds, anonKey] : playerIds;

  const rows = rowIds.length === 0
    ? '<div class="sched-popover-hint">No stats logged yet.</div>'
    : `
      <div class="gb-livestat-summary-row gb-livestat-summary-header">
        <span></span><span>Points</span><span>Assists</span><span>Fouls</span>
      </div>
      ${rowIds.map(id => {
        const name = id === anonKey
          ? teamShortNameFor(side.team).toUpperCase()
          : fiveLetterName(side.players[id]?.[COL.NAME]);
        const t = totals[id];
        return `
          <div class="gb-livestat-summary-row">
            <span>${escHtml(name)}</span>
            <span>${t.points}</span>
            <span>${t.assists}</span>
            <span>${t.fouls}</span>
          </div>`;
      }).join('')}
    `;

  const colorName = TEAM_COLORS[side.team]?.name || side.team;
  popover.innerHTML = `
    <div class="sched-popover-title">Team ${escHtml(colorName)}</div>
    ${rows}
  `;

  positionPopover(popover, anchorEl);
}

function teamIconInlineHtml(team) {
  const colorName = teamColorNameFor(team) || '';
  const icon = iconUrl(colorName);
  if (!icon) return '';
  // This icon opens the Lineup Manager (see showLineupManager) — jersey
  // assignment, quick 5-digit lineup entry for the active quarter — except
  // while Live Stat mode is on, where the icon is purely the team-color
  // indicator (see below) and tapping it does nothing; the Lineup Manager
  // doesn't make sense mid-live-tracking since IN/OUT membership is locked
  // to stat-panel taps only in that mode (see wireSideTileInteractions).
  const clickableClass = liveStatMode ? '' : ' gb-inout-team-icon-clickable';
  // The team-color border is a third Live Stat mode indicator (alongside
  // the score circle and IN-tile outlines) — only appears while
  // liveStatMode is on, same as those.
  const hex = TEAM_COLORS[team]?.hex || 'transparent';
  const style = liveStatMode ? ` style="border:2px solid ${hex}"` : '';
  return `<div class="gb-inout-team-icon${clickableClass}" data-jersey-roster-team="${escHtml(team)}"${style}><img src="${icon}" alt="${escHtml(colorName)}" loading="lazy" /></div>`;
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
  // Score circle sits at the row's TRUE outer edge (far left for the
  // own/left side, far right for the opponent/right side) — the opposite
  // extreme from the IN label + team icon, which stay put nearest the
  // center gap. Always visible now (not gated on Live Stat mode) — a coach
  // landing on this page wants the running score at a glance regardless of
  // whether they're actively logging right now (see gameLogScoreCircleHtml).
  const scoreCircle = gameLogScoreCircleHtml(side);
  const inHeaderHtml = mirrored
    ? `<div class="gb-inout-in-header">${inHeaderInner}${scoreCircle}</div>`
    : `<div class="gb-inout-in-header">${scoreCircle}${inHeaderInner}</div>`;
  const outHeaderClass = mirrored ? '' : ' gb-inout-header-right';

  inEl.innerHTML = `${inHeaderHtml}${inIds.map(id => playerTileHtml(side, id, mirrored, true)).join('')}`;
  outEl.innerHTML = `<div class="gb-inout-header${outHeaderClass}">OUT</div>${outIds.map(id => playerTileHtml(side, id, mirrored, false)).join('')}`;

  wireSideTileInteractions(inEl, side, true);
  wireSideTileInteractions(outEl, side, false);

  const teamIcon = inEl.querySelector('.gb-inout-team-icon');
  if (teamIcon) {
    if (liveStatMode) {
      // Team-anonymous stat attribution — same panel a real player tap
      // opens, but credits the team itself (see anonymousTeamPlayer) for
      // when the play happened too fast to attribute to a specific player.
      // Same toggle-to-close semantics as a player tile (see
      // wireSideTileInteractions' liveStatMode branch).
      const isActive = liveStatActivePlayer?.side === side && liveStatActivePlayer?.id === null;
      if (isActive) teamIcon.classList.add('gb-inout-tile-livestat-active');
      teamIcon.addEventListener('click', e => {
        e.stopPropagation();
        if (isActive) { liveStatActivePlayer = null; renderInOutColumns(); }
        else openLiveStatPanel(side, null);
      });
    } else {
      teamIcon.addEventListener('click', e => {
        e.stopPropagation();
        showLineupManager(teamIcon, side);
      });
    }
  }

  const scoreCircleEl = inEl.querySelector('.gb-gamelog-score-circle');
  if (scoreCircleEl) {
    scoreCircleEl.addEventListener('click', e => {
      e.stopPropagation();
      // Nothing to summarize yet — point at the toggle instead of opening
      // an empty popover (the circle is always visible now, even before a
      // coach has ever turned Live Stat on for this game).
      if (teamPointsFromLog(side) === 0) {
        alert('Enable Live Stat to begin logging points for this game. 5 players from each team must be assigned as IN to enable this feature.');
        return;
      }
      showLiveStatSummary(scoreCircleEl, side);
    });
  }
}

// Simple jersey silhouette (collar notch + short sleeves), fill color set
// per-call so it can match the tapped player's own team color rather than
// a fixed emoji glyph (emoji can't be recolored via CSS).
function jerseyIconSvg(hex) {
  return `<svg class="gb-jersey-icon" viewBox="0 0 24 24" fill="${hex}" aria-hidden="true">
    <path d="M8 2 L2 6 L4.5 9.5 L7 8 L7 21 L17 21 L17 8 L19.5 9.5 L22 6 L16 2 L14 4 Q12 5.5 10 4 Z" />
  </svg>`;
}

// One-tap 1-8 picker popover (tapping a bare "#" tile in Jersey # mode) —
// a text prompt + Enter was too many steps for something used constantly
// during a live game. Reuses the same positionPopover helper as the Board
// view team-stats popover. Numbers already assigned to someone else on this
// same roster render dimmed — tapping one unassigns it from its current
// owner (freeing it up) rather than reassigning it to this player, so a
// duplicate is never created even for a moment.
function showJerseyPicker(anchorEl, player, side) {
  const popover = document.getElementById('gb-jersey-popover');
  const name = player[COL.NAME] || 'Player';
  const hex = TEAM_COLORS[side.team]?.hex || '#8890a8';
  const icon = jerseyIconSvg(hex);

  // Renders the button grid in place without touching the rest of the page
  // (renderGameView() would tear down and rebuild every tile, including the
  // one this popover is anchored to). Unassigning a taken number just frees
  // it up and re-renders this same grid — so a coach can immediately tap it
  // again to actually assign it, instead of the popover closing and forcing
  // them to reopen it on the same tile. Only a real assignment (tapping a
  // free number) is the terminal action that closes the popover.
  function renderButtons() {
    const taken = takenJerseyNumbers(side);
    const buttons = Array.from({ length: 8 }, (_, i) => i + 1)
      .map(n => {
        const owner = taken[n];
        const cls = owner ? ' gb-jersey-pick-taken' : '';
        const title = owner ? ` title="Assigned to ${escHtml(owner[COL.NAME] || 'another player')} — tap to unassign"` : '';
        return `<button class="gb-jersey-pick-btn${cls}" data-num="${n}"${title} type="button">${icon}<span>${n}</span></button>`;
      })
      .join('');

    popover.innerHTML = `
      <div class="sched-popover-title">${escHtml(name)} — Jersey #</div>
      <div class="gb-jersey-pick-grid">${buttons}</div>
    `;

    popover.querySelectorAll('.gb-jersey-pick-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const num = parseInt(btn.dataset.num, 10);
        const owner = taken[num];
        if (owner) {
          await clearJerseyNumberFor(owner);
          renderButtons();
        } else {
          await setJerseyNumberFor(player, num);
          popover.classList.add('hidden');
          renderGameView();
        }
      });
    });
  }

  renderButtons();
  positionPopover(popover, anchorEl);
}

// Resolve popover for an unresolved jersey placeholder (see
// addUnresolvedToSide) — a jersey # typed via the Lineup Manager's 5-digit
// quick-set that didn't match anyone. Lists every real roster player who
// doesn't have a jersey # yet (their profile photo + name — picking one
// assigns them this number), plus an always-present custom-name option
// that promotes this slot to a permanent "ghost" player instead.
function showUnresolvedJerseyPopover(anchorEl, side, unresolvedId) {
  const popover = document.getElementById('gb-jersey-popover');
  const jerseyNum = side.players[unresolvedId]._ghostJerseyNum;

  const unassignedIds = side.order.filter(id =>
    id !== unresolvedId &&
    !side.players[id]._isGhost &&
    !side.players[id]._isUnresolved &&
    jerseyNumberFor(side.players[id]) == null
  );

  const playerRows = unassignedIds.map(id => {
    const p = side.players[id];
    const photo = photoUrl(p);
    const avatarHtml = photo
      ? `<img src="${photo}" alt="${escHtml(p[COL.NAME] || '')}" class="gb-unresolved-pick-avatar-img" />`
      : `<div class="gb-unresolved-pick-avatar-img gb-unresolved-pick-avatar-placeholder">🏀</div>`;
    return `
      <button class="gb-unresolved-pick-row" data-player-id="${escHtml(id)}" type="button">
        <div class="gb-unresolved-pick-avatar">${avatarHtml}</div>
        <span>${escHtml(p[COL.NAME] || 'Unknown')}</span>
      </button>`;
  }).join('');

  const emptyMsg = unassignedIds.length === 0
    ? '<div class="sched-popover-hint">Every roster player already has a jersey #.</div>'
    : '';

  popover.innerHTML = `
    <div class="sched-popover-title">Who is #${jerseyNum}?</div>
    <div class="gb-unresolved-pick-list">${playerRows}${emptyMsg}</div>
    <div class="gb-unresolved-custom-row">
      <input id="gb-unresolved-custom-input" type="text" maxlength="24" placeholder="Or type a name…" />
      <button id="gb-unresolved-custom-go" type="button">Set</button>
    </div>
  `;

  popover.querySelectorAll('.gb-unresolved-pick-row').forEach(row => {
    row.addEventListener('click', async e => {
      e.stopPropagation();
      await resolveUnassignedToRealPlayer(side, jerseyNum, row.dataset.playerId);
      popover.classList.add('hidden');
      renderGameView();
    });
  });

  const customInput = popover.querySelector('#gb-unresolved-custom-input');
  const commitCustomName = async () => {
    const name = customInput.value.trim();
    if (!name) return;
    await promoteUnresolvedToGhost(side, jerseyNum, name);
    popover.classList.add('hidden');
    renderGameView();
  };
  popover.querySelector('#gb-unresolved-custom-go').addEventListener('click', e => {
    e.stopPropagation();
    commitCustomName();
  });
  customInput.addEventListener('click', e => e.stopPropagation());
  customInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitCustomName();
  });

  positionPopover(popover, anchorEl);
  customInput.focus();
}

// Roster-wide jersey list (tapping a team's icon in Jersey # mode) — lets a
// coach see every player's number at once and unassign any one of them,
// rather than hunting for the specific tile that has a wrong number.
// "Lineup Manager" — the team roster/lineup settings popover (tap either
// side's team icon, any time — not gated on Jersey # tile-view mode). Two
// jobs in one place:
// 1. View/edit every player's jersey # (inline input, auto-advances to the
//    next row on entry; entering a number already taken by a teammate
//    silently clears it from that teammate first — same "last write wins,
//    no duplicates" rule the tap-picker already enforces, just triggered by
//    typing here instead of tapping).
// 2. A 5-digit quick-lineup field: enter the jersey #s of the 5 players who
//    should be IN for the CURRENTLY ACTIVE quarter only, tap Go. Digit
//    order never matters — IN/OUT box order is always governed by the
//    existing composite-rank order, never by typing order. A digit is
//    treated as ground truth that someone wearing that number is on the
//    court: it reactivates an absent player wearing that number, and a
//    number nobody has yet gets a placeholder tile (see addUnresolvedToSide)
//    instead of being silently dropped.
function showLineupManager(anchorEl, side) {
  const popover = document.getElementById('gb-jersey-popover');

  // Pre-fill from whichever players are currently IN for the active
  // quarter, sorted ascending by jersey # (not roster order) per the user's
  // spec — a stable, predictable read-out rather than mirroring whatever
  // order the mini-grid happens to list them in.
  const currentInDigits = side.order
    .filter(id => !side.absent.has(id) && (side.pattern.get(id) || [])[activeQuarter])
    .map(id => jerseyNumberFor(side.players[id]))
    .filter(n => n != null)
    .sort((a, b) => a - b)
    .join('');

  function renderRows() {
    // Ghosts/unresolved placeholders don't belong in the real-roster jersey
    // list (they're not real players to assign a number to by hand here —
    // ghosts already have one, unresolved ones get resolved via their own
    // popover, not this list) — filtered out, real roster only.
    const rows = side.order.filter(id => !side.players[id]._isGhost && !side.players[id]._isUnresolved).map(id => {
      const p = side.players[id];
      const num = jerseyNumberFor(p);
      const name = p?.[COL.NAME] || 'Unknown';
      return `
        <div class="sched-popover-row gb-jersey-roster-row">
          <span>${escHtml(name)}</span>
          <input class="gb-jersey-roster-input" type="text" inputmode="numeric" maxlength="1" data-id="${escHtml(id)}" value="${num == null ? '' : num}" placeholder="—" />
        </div>`;
    }).join('');

    // Header reads by team COLOR (what's actually printed on a jersey),
    // not the coach-name-based TEAMS key ("Team Alfred-Levar") — plus the
    // quarter this Lineup Manager instance is currently editing, since the
    // 5-digit Go button below only ever acts on the active quarter.
    const colorName = TEAM_COLORS[side.team]?.name || side.team;
    const headerLabel = `Team ${colorName} (Q${activeQuarter + 1})`;

    popover.innerHTML = `
      <div class="sched-popover-title">${escHtml(headerLabel)}</div>
      <div class="gb-jersey-quickset-row">
        <input id="gb-jersey-quickset-input" type="text" inputmode="numeric" maxlength="5" placeholder="12345" value="${escHtml(currentInDigits)}" />
        <button id="gb-jersey-quickset-go" type="button">Go</button>
      </div>
      ${rows}
    `;

    const rosterInputs = popover.querySelectorAll('.gb-jersey-roster-input');
    rosterInputs.forEach((input, i) => {
      // Restrict keystrokes to 1-8 only (plus editing/navigation keys) —
      // rejected at keydown so an invalid character never even appears,
      // rather than typed-then-stripped.
      input.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
        if (!/^[1-8]$/.test(e.key)) e.preventDefault();
      });

      // 'input' (not 'change'/blur) so a single valid digit acts immediately
      // — that's what makes the auto-advance-on-entry behavior possible.
      // Paste can still slip non-digits past the keydown guard, so this
      // still re-validates rather than trusting the field blindly.
      input.addEventListener('input', async () => {
        const raw = input.value.replace(/[^1-8]/g, '').slice(0, 1);
        input.value = raw;
        const player = side.players[input.dataset.id];

        if (raw === '') {
          await clearJerseyNumberFor(player);
          renderRows();
          return;
        }

        const num = parseInt(raw, 10);
        const taken = takenJerseyNumbers(side);
        const owner = taken[num];
        if (owner && owner[COL.ID] !== player[COL.ID]) {
          await clearJerseyNumberFor(owner);
        }
        await setJerseyNumberFor(player, num);
        renderRows();
        // Auto-advance to the next player's field (wrapping to the first
        // after the last) once a valid single digit is entered — lets a
        // coach move through the whole roster without touching the mouse.
        const nextInputs = popover.querySelectorAll('.gb-jersey-roster-input');
        const next = nextInputs[(i + 1) % nextInputs.length];
        next?.focus();
        next?.select();
      });
    });

    document.getElementById('gb-jersey-quickset-go').addEventListener('click', async () => {
      const digits = document.getElementById('gb-jersey-quickset-input').value.replace(/\D/g, '').split('');
      const matchedIds = new Set();
      // A jersey # typed here is ground truth that a real body wearing it
      // is on the court right now — see the user's spec. This takes
      // precedence over both "no jersey # assigned" and "marked absent"
      // instead of silently skipping those digits like before.
      digits.forEach(d => {
        const num = parseInt(d, 10);
        // 1) A real roster player already wearing this number — ignore
        //    absence entirely, they're being actively placed IN.
        let id = side.order.find(oid => jerseyNumberFor(side.players[oid]) === num && !side.players[oid]._isUnresolved);
        if (id) {
          side.absent.delete(id); // reactivated — cleared for every quarter, not just this one
        } else {
          // 2) No one (real, ghost, or otherwise) has this number yet —
          //    create/reuse an unresolved placeholder tile for it.
          id = addUnresolvedToSide(side, num);
        }
        matchedIds.add(id);
      });
      side.order.forEach(id => {
        if (side.absent.has(id)) return;
        const pat = side.pattern.get(id) || [false, false, false, false];
        pat[activeQuarter] = matchedIds.has(id);
        side.pattern.set(id, pat);
      });
      autoSaveIfLoggedOut(side);
      popover.classList.add('hidden');
      renderGameView();
    });
  }

  renderRows();
  positionPopover(popover, anchorEl);
}

function wireSideTileInteractions(container, side, isIn) {
  container.querySelectorAll('.gb-inout-tile').forEach(tile => {
    const id = tile.dataset.id;
    let lastTap = 0;

    // An unresolved jersey placeholder (see addUnresolvedToSide) MUST be
    // named before it can take on any other tile behavior — highest
    // priority, above even Live Stat mode, per the user's spec. Tapping it
    // opens the resolve popover instead of whatever this tap would
    // otherwise have done.
    if (side.players[id]?._isUnresolved) {
      tile.addEventListener('click', e => {
        e.stopPropagation();
        showUnresolvedJerseyPopover(tile, side, id);
      });
      return;
    }

    // Live Stat mode takes over tile behavior entirely, whenever it's on
    // (highest priority — overrides Jersey # mode too, which is unlikely to
    // be on at the same time but shouldn't fight with this if it is). OUT
    // tiles are fully inert (dimmed, no listeners at all — the only
    // interaction left in this mode is tapping an IN player). IN tiles open
    // the stat panel instead of toggling quarter/absence.
    if (liveStatMode) {
      if (!isIn) {
        tile.classList.add('gb-inout-tile-livestat-disabled');
        return;
      }
      const isActive = liveStatActivePlayer?.side === side && liveStatActivePlayer?.id === id;
      if (isActive) tile.classList.add('gb-inout-tile-livestat-active');
      tile.addEventListener('click', e => {
        e.stopPropagation();
        if (isActive) { liveStatActivePlayer = null; renderInOutColumns(); }
        else openLiveStatPanel(side, id);
      });
      return;
    }

    // Jersey-# mode overrides all normal tap behavior for a player with no
    // saved number yet — tapping prompts for entry instead of moving them
    // between IN/OUT or toggling a quarter cell. Once a number exists, the
    // tile goes back to behaving normally (per the user's spec).
    if (jerseyMode && jerseyNumberFor(side.players[id]) == null) {
      tile.addEventListener('click', e => {
        e.stopPropagation();
        showJerseyPicker(tile, side.players[id], side);
      });
      return;
    }
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
  // Hidden while Live Stat mode is on — this button saves the LINEUP
  // (who's IN/OUT per quarter), completely unrelated to the stat log a
  // coach is looking at in that mode, and sitting right below it read as
  // if it had something to do with saving the log itself.
  const canSave = !!getCurrentCoach() && activeGameIdx !== -1 && !liveStatMode;
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

function wireJerseyToggle() {
  document.getElementById('gb-jersey-toggle').addEventListener('click', e => {
    jerseyMode = !jerseyMode;
    e.currentTarget.classList.toggle('active', jerseyMode);
    e.currentTarget.setAttribute('aria-pressed', String(jerseyMode));
    renderGameView();
  });
}

function wireLiveStatToggle() {
  document.getElementById('gb-livestat-toggle').addEventListener('click', () => {
    liveStatMode = !liveStatMode;
    // Turning the toggle OFF only hides the panel/score-circle UI — the log
    // itself is NOT cleared here. It persists in memory (and stays saved in
    // Firestore if Save Log was used) so re-activating Live Stat later, or
    // switching quarters, doesn't lose anything already logged.
    renderGameView();
  });
}

// Saves the current log (spanning every quarter logged so far) to
// Firestore, keyed by coach + team + this game's sheet Game # — re-saving
// overwrites in place rather than piling up duplicate docs (see
// saveLiveStatLog in firebase.js). Requires a logged-in coach; Firestore
// entries strip the live `side` object reference down to a plain
// 'own'/'opp' string since side objects aren't serializable. Shared by both
// the manual Save Log button and the debounced auto-save (see
// scheduleLiveStatAutoSave) — this is just the Firestore write itself, no
// button-state/alert UI, so both callers can layer their own feedback on
// top without duplicating the entry-serialization logic.
async function persistLiveStatLog() {
  const coach = getCurrentCoach();
  if (!coach || activeSheetGameNum == null || liveStatLog.length === 0) return;

  const entries = liveStatLog.map(e => ({
    quarter: e.quarter,
    side: e.side === ownSide ? 'own' : 'opp',
    team: e.side.team,
    playerId: e.playerId,
    playerName: e.playerName,
    jerseyNum: e.jerseyNum,
    isAnonymous: !!e.isAnonymous,
    statKey: e.statKey,
    favorable: e.favorable,
    shotValue: e.shotValue,
    made: e.made,
    madeAfter: e.madeAfter ?? null,
    attemptsAfter: e.attemptsAfter ?? null,
    countAfter: e.countAfter ?? null,
  }));

  await saveLiveStatLog(coach.name, gameTeam, activeSheetGameNum, entries);
}

// Debounced auto-save: fires ~1.5s after logging/undo activity settles,
// not on every single tap — a full quarter can be dozens of taps, so
// writing on every one would be wasteful. Silent on success (small "Saved"
// flash on the button so a coach glancing at the corner sees confirmation
// without a popup); silent on failure too (no alert spam mid-game — a
// dropped auto-save is recoverable via the manual Save Log button, which
// still fails loudly since that's a coach's explicit request).
let liveStatAutoSaveTimer = null;

function scheduleLiveStatAutoSave() {
  if (!getCurrentCoach() || activeSheetGameNum == null) return;
  if (liveStatAutoSaveTimer) clearTimeout(liveStatAutoSaveTimer);
  liveStatAutoSaveTimer = setTimeout(async () => {
    liveStatAutoSaveTimer = null;
    try {
      await persistLiveStatLog();
      flashSaveLogButton('Saved ✓ (auto)');
    } catch (err) {
      console.error('Auto-save failed:', err);
      // Silent by design — see comment above. The manual button remains a
      // loud, explicit backstop if a coach notices something's off.
    }
  }, 1500);
}

function flashSaveLogButton(text) {
  const btn = document.getElementById('gb-gamelog-save');
  const original = '💾 Save Log';
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1500);
}

async function saveCurrentLiveStatLog() {
  const coach = getCurrentCoach();
  const btn = document.getElementById('gb-gamelog-save');
  if (!coach) {
    alert('Log in to save this log.');
    return;
  }
  if (activeSheetGameNum == null) return;
  if (liveStatLog.length === 0) {
    alert('Nothing logged yet.');
    return;
  }

  // A manual save supersedes any pending auto-save — no need to fire both.
  if (liveStatAutoSaveTimer) { clearTimeout(liveStatAutoSaveTimer); liveStatAutoSaveTimer = null; }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await persistLiveStatLog();
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = '💾 Save Log'; btn.disabled = false; }, 1500);
  } catch (err) {
    console.error('Save Log failed:', err);
    alert('Save failed — please try again.');
    btn.textContent = '💾 Save Log';
    btn.disabled = false;
  }
}

function wireSaveLogButton() {
  document.getElementById('gb-gamelog-save').addEventListener('click', e => {
    e.stopPropagation();
    saveCurrentLiveStatLog();
  });
}

// Undo now lives in the always-visible Game Log panel (above Save Log)
// instead of inside the per-tap stat panel — a coach shouldn't have to
// reopen a specific player's panel just to undo the last thing they
// logged (see undoLastLiveStatEntry, unchanged — still self-contained).
function wireUndoLogButton() {
  document.getElementById('gb-gamelog-undo').addEventListener('click', e => {
    e.stopPropagation();
    undoLastLiveStatEntry();
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
  wireJerseyToggle();
  wireLiveStatToggle();
  wireSaveLogButton();
  wireUndoLogButton();
  wireGameLogNotesPanel();

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
  // ?view=board (used by Schedules' "Click here for Rankings" link) forces
  // Board view on load regardless of login state — a logged-in coach would
  // otherwise default straight to Game view (see the team deep-link comment
  // above), which defeats the point of a one-tap "see who's winning" link.
  const forcedView = new URLSearchParams(window.location.search).get('view');
  setView(forcedView === 'board' ? 'board' : (getCurrentCoach() ? 'game' : 'board'));
  renderBoardGrid();
  buildIconIndex().then(renderBoardGrid);
  loadTeamStats().then(renderBoardGrid);
  wireBoardTileClicks();
  wirePopoverDismiss();
  initGameView();

  document.querySelectorAll('.gb-view-toggle .avatar-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
});
