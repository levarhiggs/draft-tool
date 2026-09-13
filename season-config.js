// season-config.js — the season registry.
//
// This is the single source of truth for "what seasons exist, which one is
// current, and where each one's data lives." Every per-season constant that
// used to be hardcoded in players-data.js / schedule-data.js belongs here.
//
// ── SEASON CODE FORMAT ───────────────────────────────────────────────────────
// Last two digits of the year + "." + a FIXED season number:
//   Spring = 1, Summer = 2, Fall = 3, Winter = 4
// The number is fixed by season type regardless of which seasons this league
// actually runs, so the scheme stays stable if a season type is added later.
//   Summer 2026 = 26.2      Fall 2026 = 26.3
//
// ── TO ADD A NEW SEASON ──────────────────────────────────────────────────────
//   1. Add an entry to SEASONS below (code, name, sheet URL, folder IDs)
//   2. Change CURRENT_SEASON to its code
//   3. Mark the previous season status: 'complete'
// That's the whole switch — no other file needs editing.

// ── The season the app defaults to ───────────────────────────────────────────
export const CURRENT_SEASON = '26.3';

// Status values:
//   'active'   — in progress; data is writable
//   'complete' — finished; historical, read-only (scores locked)
//   'setup'    — being built; not yet shown to coaches
export const SEASONS = {
  '26.2': {
    code:        '26.2',
    name:        'Summer 2026',
    longName:    'CSBC SJV Summer 2026',
    status:      'complete',
    sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjE0aS5--XrlMU0YAnvS_dQVontr10xdYNPg5OxDe6rkoOzvGkQZ1vsRnKjfPSPP7SHr5g7YJRKbwp/pub?output=csv',
    scheduleCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTCOk033NnCmR_lgFCWNLkMSdqNSAHbQ7PtldyAsf1qvh9YQdVP6gxntlYRoapaIMfumz0jRoXBeT-1/pub?output=csv',
    photosFolderId: '1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV',
    videosFolderId: '1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q',
    iconsFolderId:  '1vp_UF_Zk3uKiCJ_6I9pCya7nFveR3_II',
  },

  '26.3': {
    code:        '26.3',
    name:        'Fall 2026',
    longName:    'CSBC SJV Fall 2026',
    status:      'active',
    // TODO(fall-intake): paste the PUBLISHED CSV url (File > Share >
    // Publish to web > CSV). A normal share link returns HTML, which the
    // CSV parser will silently turn into garbage rows rather than erroring.
    sheetCsvUrl: '',
    // No Fall schedule yet — released ~1 week before games begin. Until then
    // schedule-driven pages (Schedules/Gameboard/Standings/Playoffs) keep
    // reading 26.2 via SCHEDULE_SEASON below.
    scheduleCsvUrl: '',
    // TODO(fall-intake): new Drive folders, shared "Anyone with link > Viewer"
    photosFolderId: '',
    videosFolderId: '',
    // Fall teams/colors aren't assigned until ~1-2 days before the first game
    // (see SEASON_INTAKE_RECONSTRUCTION.md), so team icons still come from 26.2.
    iconsFolderId:  '1vp_UF_Zk3uKiCJ_6I9pCya7nFveR3_II',
  },
};

// ── Which season the SCHEDULE-driven pages read ──────────────────────────────
// Deliberately separate from CURRENT_SEASON. During tryouts/draft, the roster
// has flipped to the new season but there is no new schedule yet — so
// Schedules/Gameboard/Standings/Playoffs must keep showing the previous
// season's completed games rather than rendering empty.
//
// WHEN THE FALL SCHEDULE IS PUBLISHED: set 26.3's scheduleCsvUrl above, then
// change this to CURRENT_SEASON. That is the only edit required.
export const SCHEDULE_SEASON = '26.2';

// ── Accessors ────────────────────────────────────────────────────────────────

export function getSeason(code) {
  return SEASONS[code] || SEASONS[CURRENT_SEASON];
}

export function currentSeason() {
  return SEASONS[CURRENT_SEASON];
}

export function scheduleSeason() {
  return SEASONS[SCHEDULE_SEASON];
}

/** Season codes, newest first — for a season switcher UI. */
export function allSeasonCodes() {
  return Object.keys(SEASONS).sort().reverse();
}

/**
 * Which season the page should display.
 * Honors a ?season=26.2 URL param so any past season can be linked directly;
 * unknown codes fall back to the current season.
 */
export function resolveSeason() {
  try {
    const q = new URLSearchParams(location.search).get('season');
    if (q && SEASONS[q]) return SEASONS[q];
  } catch { /* no-op: non-browser context */ }
  return currentSeason();
}

/** True when the season is finished — writes must be refused. */
export function isReadOnly(code) {
  const s = SEASONS[code];
  return !s || s.status === 'complete';
}

/**
 * sessionStorage keys MUST be season-scoped. The caches (playerSheet,
 * driveIndex, iconIndex, scheduleSheet) are season-blind by nature: without
 * the code in the key, a coach who used the app last season gets served the
 * previous season's roster from cache until they close the tab.
 */
export function cacheKey(base, code = CURRENT_SEASON) {
  return `${base}:${code}`;
}
