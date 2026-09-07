// standings.js — Standings page: live head-to-head matrix for all 12 teams.
// Data comes from the same two sources Gameboard's Board view uses
// (fetchSchedule + getAllScheduleGames), recomputed fresh on every load —
// see loadTeamStats in gameboard.js for the sibling implementation this
// mirrors. Kept as its own module/page rather than a third Gameboard view
// per the user's explicit request for a standalone "Standings" page.
import { TEAMS, TEAM_COLORS } from './coaches-config.js';
import { buildIconIndex, iconUrl } from './players-data.js';
import { fetchSchedule, COL as SCHED_COL } from './schedule-data.js';
import { getAllScheduleGames } from './firebase.js';

const ALL_TEAMS = TEAMS.filter(t => t !== 'Undrafted');

function teamNameForColor(colorName) {
  const entry = Object.entries(TEAM_COLORS).find(([, v]) => v.name === colorName);
  return entry ? entry[0] : null;
}

function emptyStats() {
  return { wins: 0, losses: 0, gamesPlayed: 0 };
}

// h2h[team][opponent] = { played, win, margin, ownScore, oppScore, winnerColorName } | undefined (never scheduled)
async function loadStandingsData() {
  const [games, scheduleGames] = await Promise.all([fetchSchedule(), getAllScheduleGames()]);

  const stats = {};
  const h2h = {};
  const scheduledPairs = new Set(); // "TeamA|TeamB" both directions, for never-scheduled detection
  ALL_TEAMS.forEach(t => { stats[t] = emptyStats(); h2h[t] = {}; });

  games.forEach(game => {
    const vColorName = game[SCHED_COL.V];
    const hColorName = game[SCHED_COL.H];
    const vTeam = teamNameForColor(vColorName);
    const hTeam = teamNameForColor(hColorName);
    if (!vTeam || !hTeam || !stats[vTeam] || !stats[hTeam]) return;

    scheduledPairs.add(vTeam + '|' + hTeam);
    scheduledPairs.add(hTeam + '|' + vTeam);

    const result = scheduleGames[game[SCHED_COL.GAME]];
    if (!result || result.vScore == null || result.hScore == null) return;

    const margin = Math.abs(result.vScore - result.hScore);
    const vWin = result.winner === 'V';
    const hWin = result.winner === 'H';
    const winnerColorName = vWin ? vColorName : (hWin ? hColorName : null);

    stats[vTeam].gamesPlayed += 1;
    stats[hTeam].gamesPlayed += 1;
    if (vWin) { stats[vTeam].wins += 1; stats[hTeam].losses += 1; }
    else if (hWin) { stats[hTeam].wins += 1; stats[vTeam].losses += 1; }

    if (vWin || hWin) {
      h2h[vTeam][hTeam] = { played: true, win: vWin, margin, ownScore: result.vScore, oppScore: result.hScore, winnerColorName };
      h2h[hTeam][vTeam] = { played: true, win: hWin, margin, ownScore: result.hScore, oppScore: result.vScore, winnerColorName };
    }
  });

  return { stats, h2h, scheduledPairs };
}

function winPct(s) {
  return s.gamesPlayed === 0 ? 0 : s.wins / s.gamesPlayed;
}

function initials(team) {
  // "Team Alfred-Levar" -> "ALF" (strip "Team ", take first 3 letters of
  // what remains, ignoring the hyphen).
  const raw = team.replace(/^Team\s+/, '').replace(/[^A-Za-z]/g, '');
  return raw.slice(0, 3).toUpperCase();
}

function renderMatrix(stats, h2h, scheduledPairs) {
  // Rows: best record top to worst bottom. Columns: the reverse (worst
  // left, best right) — see the memory'd rationale in
  // project_season_standings_dashboard.md, replicated here for the live
  // version: lets each row read as a rough gradient without the labels
  // themselves editorializing who's "weak."
  const ranked = [...ALL_TEAMS].sort((a, b) => winPct(stats[b]) - winPct(stats[a]));
  const rows = ranked;
  const cols = [...ranked].reverse();

  const table = document.getElementById('stand-matrix');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  cols.forEach(team => {
    const th = document.createElement('th');
    th.className = 'stand-col-head';
    const info = TEAM_COLORS[team];
    const icon = iconUrl(info?.name);
    th.innerHTML = `
      <div class="stand-col-head-inner">
        ${icon ? `<img src="${icon}" alt="" class="stand-col-swatch-icon" />` : `<span class="stand-col-swatch" style="background:${info?.hex || '#888'}"></span>`}
        <span class="stand-col-initials">${initials(team)}</span>
      </div>`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(rowTeam => {
    const tr = document.createElement('tr');
    const rowHead = document.createElement('th');
    rowHead.className = 'stand-row-head';
    const rInfo = TEAM_COLORS[rowTeam];
    const rIcon = iconUrl(rInfo?.name);
    rowHead.innerHTML = `
      <div class="stand-row-head-inner">
        ${rIcon ? `<img src="${rIcon}" alt="" class="stand-row-swatch-icon" />` : `<span class="stand-col-swatch" style="background:${rInfo?.hex || '#888'}"></span>`}
        <span class="stand-row-name">${rInfo?.shortName || rInfo?.name || ''}</span>
      </div>`;
    tr.appendChild(rowHead);

    cols.forEach(colTeam => {
      const td = document.createElement('td');
      if (colTeam === rowTeam) {
        td.className = 'stand-cell stand-cell-self';
        td.textContent = '—';
      } else if (h2h[rowTeam][colTeam]) {
        const r = h2h[rowTeam][colTeam];
        const alpha = Math.min(0.25 + r.margin / 40, 0.85);
        td.className = 'stand-cell ' + (r.win ? 'stand-cell-win' : 'stand-cell-loss');
        td.style.setProperty('--cell-alpha', alpha.toFixed(2));
        td.innerHTML = `<span class="stand-wl-letter">${r.win ? 'W' : 'L'}</span>`;
        td.dataset.tooltip = `Final Score: ${r.ownScore}-${r.oppScore} › ${r.winnerColorName}`;
      } else if (scheduledPairs.has(rowTeam + '|' + colTeam)) {
        td.className = 'stand-cell stand-cell-pending';
        td.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--clr-accent)"/></svg>';
      } else {
        td.className = 'stand-cell stand-cell-never';
        td.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><line x1="2" y1="2" x2="12" y2="12" stroke="var(--clr-muted)" stroke-width="2"/><line x1="12" y1="2" x2="2" y2="12" stroke="var(--clr-muted)" stroke-width="2"/></svg>';
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

// Delegated on the table itself (cells are torn down/rebuilt on every
// render, so binding per-cell would leak listeners) — one shared tooltip
// element, fixed-positioned to the pointer so the table's own overflow
// scroll container never clips it.
function wireCellTooltip() {
  const table = document.getElementById('stand-matrix');
  const tooltip = document.getElementById('stand-tooltip');
  if (!table || !tooltip) return;

  function positionTooltip(x, y) {
    // Offset from the cursor, then nudge back on-screen if it would
    // overflow the right/bottom edge (the matrix runs edge-to-edge on
    // narrow phones, so this matters more here than on a typical layout).
    const OFFSET = 14;
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    let left = x + OFFSET;
    let top = y + OFFSET;
    if (left + w > window.innerWidth - 8) left = x - w - OFFSET;
    if (top + h > window.innerHeight - 8) top = y - h - OFFSET;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  table.addEventListener('mouseover', e => {
    const td = e.target.closest('td[data-tooltip]');
    if (!td) return;
    tooltip.textContent = td.dataset.tooltip;
    tooltip.classList.remove('hidden');
  });
  table.addEventListener('mousemove', e => {
    const td = e.target.closest('td[data-tooltip]');
    if (!td) { tooltip.classList.add('hidden'); return; }
    positionTooltip(e.clientX, e.clientY);
  });
  table.addEventListener('mouseout', e => {
    // Only hide when actually leaving a tooltip cell, not when moving
    // between child nodes inside the same cell.
    const td = e.target.closest('td[data-tooltip]');
    if (td && !td.contains(e.relatedTarget)) tooltip.classList.add('hidden');
  });
}

async function init() {
  await buildIconIndex();
  const { stats, h2h, scheduledPairs } = await loadStandingsData();

  const gamesPlayed = Object.values(stats).reduce((sum, s) => sum + s.gamesPlayed, 0) / 2;
  document.getElementById('stand-snapshot').textContent =
    `Standings as of ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, through ${gamesPlayed} game${gamesPlayed === 1 ? '' : 's'}.`;

  renderMatrix(stats, h2h, scheduledPairs);
  wireCellTooltip();

  document.getElementById('stand-empty-state').classList.add('hidden');
  document.getElementById('stand-matrix-wrap').classList.remove('hidden');
}

init();
