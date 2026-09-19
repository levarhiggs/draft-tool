// player-list-controls.js — shared sort/filter/search/favorites engine for
// the two pages that list every player: directory.html (grid cards, public)
// and player.html (ranking rows, coach-only).
//
// Both pages render players their own way (a grid tile vs. a ranking row),
// but "which players, in what order" was duplicated logic before this file
// existed — the same class of drift already on record for this app's three
// parallel win/loss implementations (see PROJECT_STATUS gotcha #12). This
// module is the one place that decides sort order, filter membership, the
// result count, and the filter-chip DOM, so both pages stay in sync as
// filters are added or changed.
//
// A page wires this up by calling initListControls() with:
//   - getPlayers()   returns the current allPlayers array (fresh each call,
//                    so enrichment that happens after load is picked up)
//   - onChange()     re-render whatever the page renders (grid or rows)
// and then calls applySort/applyFilters itself inside its own render.

import { COL, videoUrl, SEASON_CODE } from './players-data.js';
import { getCurrentCoach } from './coach-login.js';
import { saveFavorites, getFavorites } from './firebase.js';
import { missedTryout } from './tryout-attendance.js';
import { hasVideoSet } from './video-availability.js';

const MISSED_TRYOUT = missedTryout(SEASON_CODE);
// PRE-DRAFT (Fall 2026): powers the Has Video filter/sort while videos are
// still being matched and uploaded. Once every clip is on Drive the Drive
// scan in players-data.js is the source of truth and this can go.
const HAS_VIDEO = hasVideoSet(SEASON_CODE);

// Team is the default for the rest of the season — once the draft is done,
// "who is on my team" is the question a coach opens either page to answer.
// A ?sort= URL param still overrides it.
export let currentSort = 'team';

// Active filters — each is a Set of selected values; empty Set = no filter.
export const activeFilters = {
  grades:    new Set(),   // e.g. {6, 7}
  seeds:     new Set(),   // floor integers 1–8
  teams:     new Set(),   // team name strings
  favorites: false,       // boolean toggle
  noTryout:  false,       // TEMPORARY (Fall 2026 draft): missed tryouts
  hasVideo:  false,       // PRE-DRAFT (Fall 2026): has a tryout video
};

export let searchQuery = '';

// Favorites: Set of player ID strings, shared across both pages via the same
// sessionStorage key so a heart tapped on one page shows on the other.
export let favorites = new Set(JSON.parse(sessionStorage.getItem('favorites') || '[]'));

export function isMissedTryout(id) { return MISSED_TRYOUT.has(String(id)); }
export function isHasVideo(p) { return HAS_VIDEO.has(String(p[COL.ID])) || !!videoUrl(p); }

// ── Favorites ─────────────────────────────────────────────────────────────────

export async function loadFavorites() {
  const coach = getCurrentCoach();
  if (!coach) return;
  try {
    const saved = await getFavorites(coach.name);
    favorites = new Set(saved);
    sessionStorage.setItem('favorites', JSON.stringify([...favorites]));
  } catch { /* fall back to session favorites */ }
}

async function persistFavorites() {
  sessionStorage.setItem('favorites', JSON.stringify([...favorites]));
  const coach = getCurrentCoach();
  if (!coach) return;
  try { await saveFavorites(coach.name, [...favorites]); } catch { /* silent */ }
}

/** Toggle a favorite and persist it. Returns the new state (true = favorited). */
export function toggleFavorite(playerId) {
  if (favorites.has(playerId)) favorites.delete(playerId);
  else favorites.add(playerId);
  persistFavorites();
  return favorites.has(playerId);
}

// ── Sort & Filter ─────────────────────────────────────────────────────────────

export function applySort(players) {
  const arr = [...players];
  if (currentSort === 'alpha') {
    return arr.sort((a, b) => (a[COL.NAME] || '').localeCompare(b[COL.NAME] || ''));
  }
  if (currentSort === 'id') {
    return arr.sort((a, b) => parseInt(a[COL.ID] || 0) - parseInt(b[COL.ID] || 0));
  }
  if (currentSort === 'birthday') {
    return arr.sort((a, b) => {
      const parse = s => { const [m, d, y] = (s || '').split('/'); return new Date(y, m - 1, d); };
      return parse(a[COL.AGE]) - parse(b[COL.AGE]);
    });
  }
  // PRE-DRAFT (Fall 2026): players with a tryout video first, then by id.
  if (currentSort === 'hasvideo') {
    const has = p => isHasVideo(p) ? 0 : 1;
    return arr.sort((a, b) =>
      has(a) - has(b) || parseInt(a[COL.ID] || 0) - parseInt(b[COL.ID] || 0));
  }
  if (currentSort === 'rank') {
    return arr.sort((a, b) => {
      const ra = a._composite != null ? a._composite : 99;
      const rb = b._composite != null ? b._composite : 99;
      return ra - rb;
    });
  }
  if (currentSort === 'team') {
    return arr.sort((a, b) => {
      const ta = a._teamFB || a[COL.TEAM] || 'Unassigned';
      const tb = b._teamFB || b[COL.TEAM] || 'Unassigned';
      if (ta !== tb) return ta.localeCompare(tb);
      // Within a team, sort by seed ascending (unseeded last)
      const sa = a._composite != null ? Math.floor(a._composite) : 99;
      const sb = b._composite != null ? Math.floor(b._composite) : 99;
      return sa - sb;
    });
  }
  return arr;
}

export function applyFilters(players) {
  return players.filter(p => {
    // Search filter
    if (searchQuery) {
      const name = (p[COL.NAME] || '').toLowerCase();
      if (!name.includes(searchQuery)) return false;
    }

    // Favorites filter
    if (activeFilters.favorites && !favorites.has(String(p[COL.ID]))) return false;

    // TEMPORARY (Fall 2026 draft): missed-tryout filter. This is attendance,
    // derived from whether a tryout photo was captured, rather than a
    // hand-set flag. Remove with the chip after the draft.
    if (activeFilters.noTryout && !isMissedTryout(p[COL.ID])) return false;

    // PRE-DRAFT (Fall 2026): has-video filter. Checks the known list first,
    // then the Drive index, so it stays correct as clips finish uploading.
    if (activeFilters.hasVideo && !isHasVideo(p)) return false;

    // Grade filter
    if (activeFilters.grades.size > 0) {
      const g = parseInt(p[COL.GRADE]);
      if (!activeFilters.grades.has(g)) return false;
    }

    // Seed filter (floor of composite)
    if (activeFilters.seeds.size > 0) {
      const seed = p._composite != null ? Math.floor(p._composite) : null;
      if (seed === null || !activeFilters.seeds.has(seed)) return false;
    }

    // Team filter
    if (activeFilters.teams.size > 0) {
      const team = p._teamFB || p[COL.TEAM] || '';
      if (!activeFilters.teams.has(team)) return false;
    }

    return true;
  });
}

/**
 * "32 results" above the list, so it's obvious how much a filter narrowed
 * things. Says "All 87 players" when nothing is filtering, since a bare count
 * there reads as if something were applied.
 */
export function renderResultCount(shown, total) {
  const el = document.getElementById('result-count');
  if (!el) return;
  const filtering = shown !== total;
  el.textContent = filtering
    ? `${shown} result${shown === 1 ? '' : 's'} of ${total}`
    : `All ${total} players`;
  el.classList.toggle('filtered', filtering);
  el.classList.remove('hidden');
}

// ── Controls wiring ───────────────────────────────────────────────────────────

/**
 * Wires the shared sort bar / search box / favorites+noTryout+hasVideo chips
 * and builds the dynamic grade/seed/team chips, on whichever page includes
 * the shared filter-bar markup (see directory.html / player.html).
 *
 * getPlayers()  () => allPlayers, called fresh so chip-building reflects
 *               whatever has loaded so far.
 * onChange()    re-render the page's own list (grid or rows) plus the
 *               result count; called after every control interaction.
 */
export function initListControls(getPlayers, onChange) {
  // Read URL params set by team-tile links on player profile pages.
  const params = new URLSearchParams(window.location.search);
  const urlTeam = params.get('team');
  const urlSort = params.get('sort');
  if (urlTeam) activeFilters.teams.add(urlTeam);
  if (urlSort) currentSort = urlSort;

  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      onChange();
    });
  });

  buildFilterChips(getPlayers, onChange);

  document.getElementById('filter-favorites')?.addEventListener('click', e => {
    activeFilters.favorites = !activeFilters.favorites;
    e.currentTarget.classList.toggle('active', activeFilters.favorites);
    onChange();
  });

  // TEMPORARY (Fall 2026 draft): missed-tryout toggle. Public on the
  // directory — no login gate, unlike the old admin no-shows chip.
  document.getElementById('filter-notryout')?.addEventListener('click', e => {
    activeFilters.noTryout = !activeFilters.noTryout;
    e.currentTarget.classList.toggle('active', activeFilters.noTryout);
    onChange();
  });

  // PRE-DRAFT (Fall 2026): has-video toggle.
  document.getElementById('filter-hasvideo')?.addEventListener('click', e => {
    activeFilters.hasVideo = !activeFilters.hasVideo;
    e.currentTarget.classList.toggle('active', activeFilters.hasVideo);
    onChange();
  });

  document.getElementById('player-search')?.addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    onChange();
  });

  wireDrawer();
}

function buildFilterChips(getPlayers, onChange) {
  buildGradeChips(getPlayers, onChange);
  buildSeedChips(onChange);
  buildTeamChips(getPlayers, onChange);
}

function buildGradeChips(getPlayers, onChange) {
  const container = document.getElementById('filter-grades');
  if (!container) return;
  const grades = [...new Set(getPlayers().map(p => parseInt(p[COL.GRADE])).filter(Boolean))].sort((a, b) => a - b);
  container.innerHTML = grades.map(g => `
    <button class="filter-chip" data-type="grade" data-value="${g}">Grade ${g}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.grades.has(val) ? activeFilters.grades.delete(val) : activeFilters.grades.add(val);
      btn.classList.toggle('active', activeFilters.grades.has(val));
      onChange();
    });
  });
}

function buildSeedChips(onChange) {
  const container = document.getElementById('filter-seeds');
  if (!container) return;
  container.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `
    <button class="filter-chip" data-type="seed" data-value="${n}">${n}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.seeds.has(val) ? activeFilters.seeds.delete(val) : activeFilters.seeds.add(val);
      btn.classList.toggle('active', activeFilters.seeds.has(val));
      onChange();
    });
  });
}

/**
 * Team chips are built from the players' actual assignments, so they track
 * whatever the draft wrote — no coach list to keep in sync here. Exported
 * separately (not just called from buildFilterChips) because both pages
 * re-call it once team data finishes loading, same as before this file
 * existed.
 */
export function buildTeamChips(getPlayers, onChange) {
  const container = document.getElementById('filter-teams');
  if (!container) return;
  const teams = [...new Set(
    getPlayers().map(p => p._teamFB || p[COL.TEAM] || '').filter(Boolean)
  )].sort();
  if (!teams.length) { container.innerHTML = '<span class="filter-empty">No teams assigned yet</span>'; return; }
  container.innerHTML = teams.map(t => `
    <button class="filter-chip" data-type="team" data-value="${escAttr(t)}">${escAttr(t)}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      activeFilters.teams.has(val) ? activeFilters.teams.delete(val) : activeFilters.teams.add(val);
      btn.classList.toggle('active', activeFilters.teams.has(val));
      onChange();
    });
  });
}

function escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Mobile drawer ─────────────────────────────────────────────────────────────
// Same collapsible drawer behaviour the directory has always had, now shared
// so player.html's header-drawer behaves identically.
function wireDrawer() {
  const toggle = document.getElementById('btn-drawer-toggle');
  const drawer = document.getElementById('header-drawer');
  if (!toggle || !drawer) return;

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    toggle.classList.toggle('active', open);
    const icon = document.getElementById('drawer-toggle-icon');
    if (icon) icon.textContent = open ? '▴ Filters' : '▾ Filters';
  }

  toggle.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));

  // Auto-collapse on scroll down, restore on scroll up.
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastY + 10 && drawer.classList.contains('open')) setOpen(false);
    lastY = y;
  }, { passive: true });
}
