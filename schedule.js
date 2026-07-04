// schedule.js — Schedules feature: table + calendar views of the season
// schedule CSV, team filtering, and coach score entry (Firestore overrides).
import { fetchSchedule, parseGameDate, COL } from './schedule-data.js';
import { getScheduleGame, saveScheduleGame, saveGameComment } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAMS, TEAM_COLORS, TEAM_ADMINS } from './coaches-config.js';

// ── State ──────────────────────────────────────────────────────────────────────
let allGames = [];             // raw CSV rows, augmented with _date (Date|null)
let overrides = {};            // gameNum -> Firestore doc data (or null if fetched & missing)
let currentTeamFilter = '';    // '' = All Teams, else a TEAMS entry
let currentView = 'calendar';  // 'table' | 'calendar'
let calMonth = new Date().getMonth();
let calYear  = new Date().getFullYear();
let activeGameForModal = null; // game object currently open in the score modal

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  try {
    allGames = await fetchSchedule();
    allGames.forEach(g => {
      g._date = parseGameDate(g[COL.DATE], g[COL.TIME]);
      g._gameNum = g[COL.GAME];
    });
  } catch (err) {
    document.getElementById('sched-empty-state').textContent = `Error loading schedule: ${err.message}`;
    console.error(err);
    return;
  }

  // Default calendar month/year to the first game's month, if available,
  // so the calendar opens showing actual season data rather than "today"
  // (the season may not overlap the current month).
  const firstDated = allGames.find(g => g._date);
  if (firstDated) {
    calMonth = firstDated._date.getMonth();
    calYear  = firstDated._date.getFullYear();
  }

  populateTeamSelect();
  wireToolbar();
  wireScoreModal();
  wireCalendarNav();
  wirePopoverDismiss();
  wireStickyHeaderOffset();
  wireCalendarScrollSync();

  document.getElementById('sched-empty-state').classList.add('hidden');
  render();

  document.addEventListener('coachChanged', render);
}

// Measures the real (possibly-responsive) page header height and exposes it
// as a CSS variable, so the calendar's own sticky nav/weekday-labels can
// stack directly beneath the page header instead of overlapping it or
// guessing a fixed pixel offset that would break at the mobile breakpoint.
function updateStickyOffsets() {
  const header = document.querySelector('header');
  const h = header ? header.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty('--page-header-h', `${h}px`);

  // The weekday-labels row stacks directly beneath the calendar's own
  // sticky nav row, so it needs an additional top offset equal to that nav
  // row's real height. This is 0 (wrong) if measured while the calendar
  // view is hidden (`display: none` collapses descendant heights to 0) —
  // callers must re-run this after the calendar wrap becomes visible, not
  // just once at page load.
  const nav = document.querySelector('.sched-cal-nav');
  const navH = nav ? nav.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty('--cal-nav-h', `${navH}px`);
}

function wireStickyHeaderOffset() {
  updateStickyOffsets();
  window.addEventListener('resize', updateStickyOffsets);
}

// The weekday-labels row lives outside .sched-cal-scroll (the grid's own
// horizontal scroll container) so its position:sticky works correctly
// against the real page — see the CSS comment on .sched-calendar-wrap for
// why. That means its horizontal scroll position has to be mirrored in by
// hand whenever the grid scrolls sideways, or the two would drift out of
// column alignment on narrow viewports.
function wireCalendarScrollSync() {
  const scrollWrap = document.getElementById('sched-cal-scroll');
  const weekdays = document.getElementById('sched-cal-weekdays');
  if (!scrollWrap || !weekdays) return;
  scrollWrap.addEventListener('scroll', () => {
    weekdays.scrollLeft = scrollWrap.scrollLeft;
  });
}

function populateTeamSelect() {
  const select = document.getElementById('sched-team-select');
  select.innerHTML = '<option value="">All Teams</option>' +
    TEAMS.filter(t => t !== 'Undrafted')
      .map(t => {
        const colorName = teamColorName(t);
        // Coaches refer to teams by color first ("LIME SHOCK") once colors
        // are assigned — lead with that, team name second, matching how
        // the league actually talks about matchups.
        const label = colorName ? `${colorName.toUpperCase()} — ${t}` : t;
        return `<option value="${escHtml(t)}">${escHtml(label)}</option>`;
      }).join('');
}

function wireToolbar() {
  document.getElementById('sched-team-select').addEventListener('change', e => {
    currentTeamFilter = e.target.value;
    render();
  });

  document.querySelectorAll('.avatar-toggle-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-toggle-btn[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      render();
    });
  });
}

// ── Filtering ──────────────────────────────────────────────────────────────────

function teamColorName(team) {
  return TEAM_COLORS[team]?.name || null;
}

function gameMatchesFilter(game) {
  if (!currentTeamFilter) return true;
  const colorName = teamColorName(currentTeamFilter);
  if (!colorName) return true;
  return game[COL.V] === colorName || game[COL.H] === colorName;
}

function filteredGames() {
  return allGames.filter(gameMatchesFilter);
}

// ── Firestore override resolution ───────────────────────────────────────────────

// Effective display values for a game: Firestore override if present, else
// the sheet's own seed values. Overrides are fetched lazily & cached in
// `overrides` keyed by game number, populated by ensureOverridesLoaded().
function effectiveGameData(game) {
  const ov = overrides[game._gameNum];
  if (ov) {
    return {
      vScore: ov.vScore,
      hScore: ov.hScore,
      winner: ov.winner,               // 'V' | 'H' | null
      updatedAt: ov.updatedAt,
      updatedBy: ov.updatedBy,
      comments: ov.comments || [],
      hasOverride: true,
    };
  }
  // Fall back to sheet seed values
  const vScore = game[COL.V_SCORE] !== '' ? Number(game[COL.V_SCORE]) : null;
  const hScore = game[COL.H_SCORE] !== '' ? Number(game[COL.H_SCORE]) : null;
  const sheetWinnerColor = game[COL.WINNER] || '';
  let winner = null;
  if (sheetWinnerColor) {
    if (sheetWinnerColor === game[COL.V]) winner = 'V';
    else if (sheetWinnerColor === game[COL.H]) winner = 'H';
  }
  return {
    vScore, hScore, winner,
    updatedAt: null, updatedBy: null,
    comments: [],
    hasOverride: false,
  };
}

async function ensureOverridesLoaded(games) {
  const toFetch = games.filter(g => !(g._gameNum in overrides));
  await Promise.all(toFetch.map(async g => {
    const data = await getScheduleGame(g._gameNum);
    overrides[g._gameNum] = data; // may be null — cached either way
  }));
}

// ── Rendering ──────────────────────────────────────────────────────────────────

async function render() {
  const games = filteredGames();
  await ensureOverridesLoaded(games);

  const tableWrap = document.getElementById('sched-table-wrap');
  const calWrap = document.getElementById('sched-calendar-wrap');

  if (currentView === 'table') {
    tableWrap.classList.remove('hidden');
    calWrap.classList.add('hidden');
    renderTable(games);
  } else {
    tableWrap.classList.add('hidden');
    calWrap.classList.remove('hidden');
    updateStickyOffsets(); // re-measure now that the calendar wrap is visible
    renderCalendar(games);
  }
}

// ── Table view ─────────────────────────────────────────────────────────────────

function renderTable(games) {
  const body = document.getElementById('sched-table-body');
  const sorted = [...games].sort((a, b) => Number(a._gameNum) - Number(b._gameNum));

  // When filtered to a specific team, show that team's own 1-N sequence
  // (matches how coaches actually talk about "our Game 3", not the global
  // season Game #) instead of the raw 1-60 season number. Unfiltered
  // ("All Teams") keeps showing the real season Game #.
  // Header text always just reads "Game #" — the team-filtered 1-N
  // renumbering (see displayGameNum below) is conveyed by the values in the
  // column, not by lengthening the header itself.
  document.getElementById('sched-th-gamenum').textContent = 'Game #';

  body.innerHTML = sorted.map((g, i) => tableRowHTML(g, i + 1)).join('');
  wireGameClicks(
    body.querySelectorAll('tr[data-game]'),
    el => showGamePopover(el, gameForEl(el)),
    el => { const game = gameForEl(el); if (game) tryOpenScoreModal(game); }
  );
}

function gameForEl(el) {
  return allGames.find(g => g._gameNum === el.dataset.game) || null;
}

function tableRowHTML(game, teamSequenceNum) {
  const eff = effectiveGameData(game);
  const winnerHtml = winnerChipHTML(game, eff.winner);
  const finalScoreHtml = finalScoreText(eff);
  const lastUpdatedHtml = lastUpdatedText(eff);
  const displayGameNum = currentTeamFilter ? teamSequenceNum : game._gameNum;

  return `
    <tr data-game="${escHtml(game._gameNum)}">
      <td>${escHtml(game[COL.DESCR] || '')}</td>
      <td>${winnerHtml}</td>
      <td>${escHtml(finalScoreHtml)}</td>
      <td>${escHtml(displayGameNum)}</td>
      <td>${escHtml(formatDateShort(game))}</td>
      <td>${escHtml(game[COL.TIME] || '')}</td>
      <td class="sched-cell-muted sched-last-updated">${escHtml(lastUpdatedHtml)}</td>
    </tr>`;
}

function winnerChipHTML(game, winner) {
  if (!winner) return '<span class="sched-cell-muted">—</span>';
  const colorName = winner === 'V' ? game[COL.V] : game[COL.H];
  const hex = colorHexFor(colorName);
  return `<span class="sched-color-chip">
    <span class="sched-swatch" style="background:${hex}"></span>
    ${escHtml(colorName || '—')}
  </span>`;
}

function colorHexFor(colorName) {
  const entry = Object.values(TEAM_COLORS).find(c => c.name === colorName);
  return entry?.hex || '#8890a8';
}

function finalScoreText(eff) {
  if (eff.vScore == null || eff.hScore == null) return '—';
  return `${eff.vScore}-${eff.hScore}`;
}

function lastUpdatedText(eff) {
  if (!eff.hasOverride || !eff.updatedAt) return '—';
  const d = tsToDate(eff.updatedAt);
  if (!d) return '—';
  const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const coachName = (eff.updatedBy || '').replace(/^(Coach|Director)\s+/, '');
  return `${dateStr} ${timeStr} by ${coachName}`;
}

function tsToDate(ts) {
  // Firestore Timestamp has toDate(); optimistic local updates use a plain Date.
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (ts instanceof Date) return ts;
  return null;
}

function formatDateShort(game) {
  if (game._date) {
    return game._date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) +
      (game[COL.DAY] ? ` ${game[COL.DAY]}` : '');
  }
  return game[COL.DATE] || '';
}

// ── Calendar view ──────────────────────────────────────────────────────────────

// The season runs July 5 - August 31 (same year as the schedule data
// itself, resolved dynamically from the first parsed game date — see
// init() — rather than hardcoded, so this still works if the sheet is ever
// reused for a different year). Calendar navigation is clamped to those two
// months; there is nothing to show before or after the season.
function seasonYear() {
  return calYear; // calYear is seeded from the first game's real parsed year at init
}
function isMonthInSeason(month, year) {
  return year === seasonYear() && (month === 6 || month === 7); // 6 = July, 7 = August (0-indexed)
}

function wireCalendarNav() {
  document.getElementById('sched-cal-prev').addEventListener('click', () => {
    const prevMonth = calMonth - 1;
    const prevYear = prevMonth < 0 ? calYear - 1 : calYear;
    if (!isMonthInSeason(prevMonth < 0 ? 11 : prevMonth, prevYear)) return; // clamp: nothing before July
    calMonth = prevMonth < 0 ? 11 : prevMonth;
    calYear = prevYear;
    render();
  });
  document.getElementById('sched-cal-next').addEventListener('click', () => {
    const nextMonth = calMonth + 1;
    const nextYear = nextMonth > 11 ? calYear + 1 : calYear;
    if (!isMonthInSeason(nextMonth > 11 ? 0 : nextMonth, nextYear)) return; // clamp: nothing after August
    calMonth = nextMonth > 11 ? 0 : nextMonth;
    calYear = nextYear;
    render();
  });
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderCalendar(games) {
  document.getElementById('sched-cal-month-label').textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

  const gamesByDay = {}; // day-of-month -> [games]
  games.forEach(g => {
    if (!g._date) return;
    if (g._date.getMonth() !== calMonth || g._date.getFullYear() !== calYear) return;
    const day = g._date.getDate();
    (gamesByDay[day] = gamesByDay[day] || []).push(g);
  });

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  // Season bounds: July 5 - August 31 of the season's actual year (August
  // needs no upper clamp since it naturally ends at 31). July's calendar
  // starts from the 5th, not the 1st — the leading blank cells are sized to
  // July 5th's own weekday, not July 1st's, so the grid opens flush against
  // the weekday-labels row with no dead first week of empty padding.
  const isJuly = calMonth === 6;
  const minDayThisMonth = isJuly ? 5 : 1;
  const startWeekday = new Date(calYear, calMonth, minDayThisMonth).getDay(); // 0 = Sun

  const cells = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push('<div class="sched-cal-cell sched-cal-cell-empty"></div>');
  }
  // Filtered to a single team, a date can hold at most 2 games (that team
  // plays at most once per slot) — shrink cells accordingly. Unfiltered
  // ("All Teams") reverts to the normal height sized for up to 6 games.
  const compact = !!currentTeamFilter;
  for (let day = minDayThisMonth; day <= daysInMonth; day++) {
    const dayGames = (gamesByDay[day] || []).sort((a, b) => (a._date - b._date));
    cells.push(calendarCellHTML(day, dayGames, compact));
  }
  // Pad trailing cells to complete the final week row
  while (cells.length % 7 !== 0) {
    cells.push('<div class="sched-cal-cell sched-cal-cell-empty"></div>');
  }

  const grid = document.getElementById('sched-cal-grid');
  grid.innerHTML = cells.join('');

  wireGameClicks(
    grid.querySelectorAll('.sched-cal-entry'),
    el => showGamePopover(el, gameForEl(el)),
    el => { const game = gameForEl(el); if (game) tryOpenScoreModal(game); }
  );
}

function calendarCellHTML(day, dayGames, compact) {
  const entries = dayGames.map(g => calendarEntryHTML(g)).join('');
  return `
    <div class="sched-cal-cell${compact ? ' sched-cal-cell-compact' : ''}">
      <div class="sched-cal-daynum">${day}</div>
      <div class="sched-cal-entries">${entries}</div>
    </div>`;
}

function calendarEntryHTML(game) {
  const vHex = colorHexFor(game[COL.V]);
  const hHex = colorHexFor(game[COL.H]);
  const eff = effectiveGameData(game);
  const played = eff.vScore != null && eff.hScore != null;
  const scoreSuffix = played ? ` ${eff.vScore}-${eff.hScore}` : '';
  return `
    <div class="sched-cal-entry${played ? ' sched-cal-entry-played' : ''}" data-game="${escHtml(game._gameNum)}">
      <span class="sched-cal-time">${escHtml(shortTime(game[COL.TIME]))}</span>
      <span class="sched-swatch sched-swatch-sm" style="background:${vHex}"></span><span class="sched-swatch sched-swatch-sm" style="background:${hHex}"></span>
      <span class="sched-cal-score">${escHtml(scoreSuffix)}</span>
    </div>`;
}

function shortTime(timeStr) {
  if (!timeStr) return '';
  // "6:30 PM" -> "6:30p"
  const m = String(timeStr).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return timeStr;
  const ampm = m[3] ? m[3][0].toLowerCase() : '';
  return `${m[1]}:${m[2]}${ampm}`;
}

// ── Click (popover) / double-click (score entry) gesture ────────────────────
// Single click/tap -> game-info popover. Double click/tap -> score modal.
// A bare `click` listener would fire on every click of a double-click too
// (browsers fire click, click, dblclick in sequence), which would flash the
// popover open right before the score modal — so the single-click action is
// delayed briefly to see whether a second click/tap follows; if it does,
// the delayed single-click is cancelled and only the double-click action
// runs. Same 350ms window as the double-tap timer for touch devices.
const DOUBLE_CLICK_WINDOW = 350;

function wireGameClicks(elements, onSingle, onDouble) {
  elements.forEach(el => {
    let pendingTimer = null;
    let lastTap = 0;

    el.addEventListener('click', () => {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        onSingle(el);
      }, DOUBLE_CLICK_WINDOW);
    });
    el.addEventListener('dblclick', () => {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      onDouble(el);
    });

    // Touch devices: click/dblclick don't reliably fire together the same
    // way, so mirror the same delayed-single/cancel-on-double pattern using
    // a manual touchend timer (matches the app's existing double-tap pattern
    // used elsewhere, e.g. rotations.js's double-tap-to-absent).
    el.addEventListener('touchend', e => {
      const now = Date.now();
      if (now - lastTap < DOUBLE_CLICK_WINDOW) {
        e.preventDefault();
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        onDouble(el);
        lastTap = 0; // consume, so a 3rd tap doesn't chain into another double
      } else {
        lastTap = now;
      }
    });
  });
}

// ── Permissions: coach ↔ team resolution ────────────────────────────────────────
//
// ASSUMPTION (flagged for verification): there is no explicit coach->team
// mapping stored anywhere in the codebase. TEAMS entries are of the form
// "Team <Suffix>" (e.g. "Team Alfred-Levar") and COACHES entries are of the
// form "Coach <Suffix>" or "Director <Suffix>" (e.g. "Coach Alfred-Levar").
// We resolve a logged-in coach's team by stripping the leading "Team "/
// "Coach "/"Director " prefix from both sides and matching the remaining
// suffix string exactly. This holds for every current entry in
// coaches-config.js (Humberto, Alex, Jeff, Daven-Josiah, Ben, Tati, Sedat,
// Andre, Alfred-Levar, Kevin, Mike C., Chris), but is NOT an explicit,
// declared mapping — if a coach's team name and coach name ever diverge in
// naming (e.g. a coach coaching a team not named after them), this lookup
// silently returns no team and that coach loses edit access. Worth adding an
// explicit COACH_TEAM map to coaches-config.js if that ever happens.
function suffixOf(fullName) {
  return fullName.replace(/^(Team|Coach|Director)\s+/, '').trim();
}

function currentCoachTeam() {
  const coach = getCurrentCoach();
  if (!coach) return null;
  const coachSuffix = suffixOf(coach.name);
  return TEAMS.find(t => suffixOf(t) === coachSuffix) || null;
}

function canEditGame(game) {
  const coach = getCurrentCoach();
  if (!coach) return false;
  if (TEAM_ADMINS.includes(coach.name)) return true;

  const team = currentCoachTeam();
  if (!team) return false;
  const colorName = teamColorName(team);
  if (!colorName) return false;
  return game[COL.V] === colorName || game[COL.H] === colorName;
}

// ── Game info popover (single click/tap) ────────────────────────────────────
// Shows matchup, date/time, current score/winner, and last-updated info.
// A placeholder section is left for future additions (results by quarter,
// team rankings, etc.) per the spec — currently just the hint line about
// double-clicking to enter a score, shown only when the viewer could
// actually do that.

function wirePopoverDismiss() {
  document.addEventListener('click', e => {
    const popover = document.getElementById('sched-popover');
    if (popover.contains(e.target)) return;
    popover.classList.add('hidden');
  });
}

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

function showGamePopover(anchorEl, game) {
  if (!game) return;
  const popover = document.getElementById('sched-popover');
  const eff = effectiveGameData(game);

  const scoreText = eff.vScore != null && eff.hScore != null
    ? `${eff.vScore} - ${eff.hScore}`
    : 'Not yet played';
  const winnerText = eff.winner
    ? (eff.winner === 'V' ? game[COL.V] : game[COL.H]).toUpperCase()
    : (eff.vScore != null && eff.hScore != null ? 'Tie' : '—');
  const lastUpdated = eff.hasOverride ? lastUpdatedText(eff) : '—';

  const canEdit = canEditGame(game);
  const hint = getCurrentCoach()
    ? (canEdit ? 'Double-click/tap to enter or update the score.' : 'Double-click/tap to leave a comment (score is view-only for you).')
    : 'Log in to leave a comment or enter a score.';

  const comments = (eff.comments || [])
    .map(c => `<div class="sched-popover-comment"><b>${escHtml(coachDisplayName(c.coachName))}:</b> ${escHtml(c.text)}</div>`)
    .join('');
  const commentsHtml = comments
    ? `<div class="sched-popover-comments">${comments}</div>`
    : '';

  popover.innerHTML = `
    <div class="sched-popover-title">${escHtml(game[COL.DESCR] || `Game #${game._gameNum}`)}</div>
    <div class="sched-popover-row"><span>Date</span><span>${escHtml(formatDateShort(game))}</span></div>
    <div class="sched-popover-row"><span>Time</span><span>${escHtml(game[COL.TIME] || '—')}</span></div>
    <div class="sched-popover-row"><span>Location</span><span>${escHtml(game[COL.LOCATION] || '—')}</span></div>
    <div class="sched-popover-row"><span>Score</span><span>${escHtml(scoreText)}</span></div>
    <div class="sched-popover-row"><span>Winner</span><span>${escHtml(winnerText)}</span></div>
    <div class="sched-popover-row"><span>Last updated</span><span class="sched-last-updated">${escHtml(lastUpdated)}</span></div>
    ${commentsHtml}
    ${hint ? `<div class="sched-popover-hint">${escHtml(hint)}</div>` : ''}
  `;

  positionPopover(popover, anchorEl);
}

function coachDisplayName(coachName) {
  return (coachName || '').replace(/^(Coach|Director)\s+/, '');
}

// ── Score entry modal ────────────────────────────────────────────────────────

function tryOpenScoreModal(game) {
  // Any logged-in coach may open this modal to leave a comment; only a
  // participating coach (or TEAM_ADMIN) can actually edit the score — that
  // permission is enforced by disabling the score inputs below, not by
  // blocking the modal itself.
  if (!getCurrentCoach()) return; // quiet no-op, per spec — must be logged in at all
  openScoreModal(game);
}

function openScoreModal(game) {
  activeGameForModal = game;
  const eff = effectiveGameData(game);
  const canEditScore = canEditGame(game);

  document.getElementById('score-modal-matchup').textContent = game[COL.DESCR] || `Game #${game._gameNum}`;
  document.getElementById('score-visitor-label-text').textContent = `Visitor score (${game[COL.V] || 'Visitor'})`;
  document.getElementById('score-home-label-text').textContent = `Home score (${game[COL.H] || 'Home'})`;
  const vInput = document.getElementById('score-visitor-input');
  const hInput = document.getElementById('score-home-input');
  vInput.value = eff.vScore != null ? eff.vScore : '';
  hInput.value = eff.hScore != null ? eff.hScore : '';
  vInput.disabled = !canEditScore;
  hInput.disabled = !canEditScore;
  document.getElementById('score-comment-input').value = '';
  document.getElementById('score-error').classList.add('hidden');
  document.getElementById('score-permission-note').classList.toggle('hidden', canEditScore);

  document.getElementById('modal-score').classList.remove('hidden');
  setTimeout(() => (canEditScore ? vInput : document.getElementById('score-comment-input')).focus(), 50);
}

function closeScoreModal() {
  document.getElementById('modal-score').classList.add('hidden');
  activeGameForModal = null;
}

function wireScoreModal() {
  document.getElementById('btn-score-cancel').addEventListener('click', closeScoreModal);
  document.getElementById('modal-score').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeScoreModal();
  });
  document.getElementById('btn-score-save').addEventListener('click', saveScoreFromModal);
}

async function saveScoreFromModal() {
  if (!activeGameForModal) return;
  const game = activeGameForModal;
  const errEl = document.getElementById('score-error');
  const commentText = document.getElementById('score-comment-input').value.trim();

  const coach = getCurrentCoach();
  if (!coach) {
    // Session expired between opening the modal and saving — fail closed, quietly.
    closeScoreModal();
    return;
  }

  const canEditScore = canEditGame(game);
  const existing = effectiveGameData(game);
  let scoreResult = null;

  if (canEditScore) {
    const vRaw = document.getElementById('score-visitor-input').value;
    const hRaw = document.getElementById('score-home-input').value;

    // A participating coach must fill in both scores to save a score change.
    // If they left both blank and only entered a comment, skip score
    // validation entirely — a comment-only save is still valid for them too.
    const scoreFieldsTouched = vRaw !== '' || hRaw !== '';
    if (scoreFieldsTouched) {
      if (vRaw === '' || hRaw === '') {
        errEl.textContent = 'Enter both scores.';
        errEl.classList.remove('hidden');
        return;
      }
      const vScore = Number(vRaw);
      const hScore = Number(hRaw);
      if (Number.isNaN(vScore) || Number.isNaN(hScore) || vScore < 0 || hScore < 0) {
        errEl.textContent = 'Scores must be non-negative numbers.';
        errEl.classList.remove('hidden');
        return;
      }
      try {
        scoreResult = await saveScheduleGame(game._gameNum, vScore, hScore, coach.name);
      } catch (err) {
        errEl.textContent = 'Save failed — please try again.';
        errEl.classList.remove('hidden');
        console.error(err);
        return;
      }
    }
  }

  let commentEntry = null;
  if (commentText) {
    try {
      commentEntry = await saveGameComment(game._gameNum, commentText, coach.name);
    } catch (err) {
      errEl.textContent = 'Save failed — please try again.';
      errEl.classList.remove('hidden');
      console.error(err);
      return;
    }
  }

  if (!scoreResult && !commentEntry) {
    // Nothing was entered at all — nothing to save, just close.
    closeScoreModal();
    return;
  }

  // Optimistic UI update: reflect the just-saved value(s) immediately,
  // without waiting on a Firestore round-trip re-fetch. Preserve whichever
  // half (score vs. comments) wasn't touched by this particular save.
  overrides[game._gameNum] = {
    vScore: scoreResult ? scoreResult.vScore : existing.vScore,
    hScore: scoreResult ? scoreResult.hScore : existing.hScore,
    winner: scoreResult ? scoreResult.winner : existing.winner,
    updatedAt: scoreResult ? new Date() : (existing.hasOverride ? existing.updatedAt : null),
    updatedBy: scoreResult ? coach.name : existing.updatedBy,
    comments: commentEntry ? [...(existing.comments || []), commentEntry] : (existing.comments || []),
  };

  closeScoreModal();
  render();
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
