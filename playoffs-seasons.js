// playoffs-seasons.js — registry of every season's Playoffs page, plus the
// "Season" dropdown shown under each page's masthead.
//
// Each finished season keeps its own frozen page (playoffs-{code}.html +
// playoffs-{code}.js) so an old bracket never has to be re-derived from live
// data. playoffs.html is always the CURRENT season — it's what the side
// menu's Playoffs link opens.
//
// ── TO ARCHIVE A SEASON AND START THE NEXT ONE'S BRACKET ─────────────────────
//   1. git mv playoffs.html -> playoffs-{oldcode}.html, playoffs.js ->
//      playoffs-{oldcode}.js; point the html's <script> at the renamed js.
//   2. Pin the renamed js to its own season (see playoffs-26.2.js:
//      teamColorsFor/teamsFor/fetchScheduleForSeason/getAllScheduleGames
//      with an explicit code) — the shared defaults follow whatever season is
//      current and will silently show the NEW season's teams otherwise.
//   3. Build the new playoffs.html/playoffs.js for the new season.
//   4. Update PLAYOFF_PAGES below: new season at the top on playoffs.html,
//      old season pointed at its playoffs-{oldcode}.html.
//   5. Add the renamed files to sw.js's SHELL and bump its CACHE version.
import { getSeason } from './season-config.js';

// Newest first. The first entry is the default Playoffs page.
export const PLAYOFF_PAGES = [
  { code: '26.3', page: 'playoffs.html' },
  { code: '26.2', page: 'playoffs-26.2.html' },
];

/**
 * ?season=26.2 on playoffs.html jumps to that season's archived page, so the
 * same ?season= links the rest of the app uses work here too. Call before
 * rendering; returns true when a redirect is under way.
 */
export function redirectToSeasonPage(currentCode) {
  let q = null;
  try { q = new URLSearchParams(location.search).get('season'); } catch { /* no-op */ }
  if (!q || q === currentCode) return false;
  const entry = PLAYOFF_PAGES.find(p => p.code === q);
  if (!entry) return false;
  location.replace(entry.page);
  return true;
}

/** Fills #pg-season-switch with the dropdown; selecting a season opens its page. */
export function mountPlayoffSeasonSelect(currentCode) {
  const host = document.getElementById('pg-season-switch');
  if (!host) return;
  const options = PLAYOFF_PAGES.map(p => {
    const name = getSeason(p.code).name;
    const label = p === PLAYOFF_PAGES[0] ? `${name} (current)` : name;
    return `<option value="${p.page}" ${p.code === currentCode ? 'selected' : ''}>${label}</option>`;
  }).join('');
  host.innerHTML = `
    <label class="pg-season-label" for="pg-season-select">Season</label>
    <select id="pg-season-select" class="pg-season-select">${options}</select>`;
  host.querySelector('select').addEventListener('change', e => {
    location.href = e.target.value;
  });
}
