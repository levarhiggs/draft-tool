// app.js — player directory: data loading, rendering, sort, filter, favorites
import { getCompositeRank, getPriorComposite, saveFavorites, getFavorites } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import {
  COL, SHEET_CSV_URL, PHOTOS_FOLDER_ID, VIDEOS_FOLDER_ID, SEASON_CODE,
  fetchPlayers, buildDriveIndex, photoUrl, videoUrl, ageDisplay,
} from './players-data.js';
import { priorSeasons } from './player-identity.js';
import { getSeason } from './season-config.js';
import { missedTryout } from './tryout-attendance.js';
import { hasVideoSet } from './video-availability.js';
import { contactFor } from './player-contacts.js';
import { personByName, teamNameFor, TEAM_ADMINS } from './coaches-config.js';

/** True when the logged-in coach is a commissioner/admin. */
function viewerIsAdmin() {
  const c = getCurrentCoach();
  return !!c && TEAM_ADMINS.includes(c.name);
}

/**
 * Parent phone for a player, shown only to that player's own coach.
 *
 * Contact details for minors, so the gate is narrow: the viewer must be
 * logged in, resolve to a person who holds a team, and that team must match
 * the player's. Everyone else gets nothing rendered at all.
 */
function myPlayerPhone(p) {
  const c = getCurrentCoach();
  if (!c) return '';
  const person = personByName(c.name);
  const myTeam = person && teamNameFor(person.id);
  if (!myTeam) return '';
  const team = p._teamFB || p[COL.TEAM] || '';
  if (team !== myTeam) return '';
  return contactFor(SEASON_CODE, String(p[COL.ID]));
}

const MISSED_TRYOUT = missedTryout(SEASON_CODE);
// PRE-DRAFT (Fall 2026): powers the Has Video filter/sort while videos are
// still being matched and uploaded. Once every clip is on Drive the Drive scan
// in players-data.js is the source of truth and this can go.
const HAS_VIDEO = hasVideoSet(SEASON_CODE);

let allPlayers  = [];
// Team is the default for the rest of the season -- once the draft is done,
// "who is on my team" is the question coaches actually open the directory to
// answer. A ?sort= URL param still overrides it.
let currentSort = 'team';

// Active filters — each is a Set of selected values; empty Set = no filter
const activeFilters = {
  grades:    new Set(),   // e.g. {6, 7}
  seeds:     new Set(),   // floor integers 1–8
  teams:     new Set(),   // team name strings
  favorites: false,       // boolean toggle
  noTryout:  false,       // TEMPORARY (Fall 2026 draft): missed tryouts
  hasVideo:  false,       // PRE-DRAFT (Fall 2026): has a tryout video
};

// Favorites: Set of player ID strings
let favorites   = new Set(JSON.parse(sessionStorage.getItem('favorites') || '[]'));
let searchQuery = '';

async function init() {
  try {
    // Read URL params set by team tile links on player profile pages
    const params = new URLSearchParams(window.location.search);
    const urlTeam = params.get('team');
    const urlSort = params.get('sort');
    if (urlTeam) activeFilters.teams.add(urlTeam);
    if (urlSort) currentSort = urlSort;

    const [players] = await Promise.all([
      fetchPlayers(),
      buildDriveIndex(),
    ]);
    allPlayers = players;

    // Load coach favorites from Firebase if logged in
    await loadFavorites();

    renderGrid();
    setupControls();
    wirePlayerModal();

    // Enrich with Firebase data then re-render and rebuild team chips
    await enrichWithFirebase(allPlayers);
    buildTeamChips();
    renderGrid();
  } catch (err) {
    const grid = document.getElementById('player-grid');
    if (grid) grid.innerHTML = `<div class="loading">Error loading players: ${err.message}</div>`;
    console.error(err);
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────

async function loadFavorites() {
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

function toggleFavorite(playerId, e) {
  e.preventDefault();
  e.stopPropagation();
  if (favorites.has(playerId)) {
    favorites.delete(playerId);
  } else {
    favorites.add(playerId);
  }
  persistFavorites();
  // Update just the heart on this card without full re-render
  const btn = document.querySelector(`.heart-btn[data-id="${playerId}"]`);
  if (btn) btn.classList.toggle('active', favorites.has(playerId));
  // If favorites filter is active, re-render to remove/add card
  if (activeFilters.favorites) renderGrid();
}

/**
 * "32 results" above the grid, so it's obvious how much a filter narrowed
 * things. Says "All 87 players" when nothing is filtering, since a bare count
 * there reads as if something were applied.
 */
function renderResultCount(shown, total) {
  const el = document.getElementById('result-count');
  if (!el) return;
  const filtering = shown !== total;
  el.textContent = filtering
    ? `${shown} result${shown === 1 ? '' : 's'} of ${total}`
    : `All ${total} players`;
  el.classList.toggle('filtered', filtering);
  el.classList.remove('hidden');
}

// ── Firebase enrichment ───────────────────────────────────────────────────────

async function enrichWithFirebase(players) {
  await Promise.all(players.map(async p => {
    const data = await getCompositeRank(p[COL.ID]);
    p._composite = data.composite;
    p._rankCount = data.count;
    p._rankings  = data.rankings;
    p._teamFB    = data.team   || '';
    p._noShow    = data.noShow || false;

    // Prior-season composite for returning players. Ids are season-scoped, so
    // this has to go through the identity link to find last season's id.
    // Shown in front of the login gate this season: coach pins aren't
    // distributed yet, and coaches need this to evaluate immediately.
    const prev = priorSeasons(p[COL.NAME], SEASON_CODE);
    if (prev.length) {
      const last = prev[prev.length - 1];
      p._priorRank = await getPriorComposite(last.season, last.id);
    }
  }));
}

// ── Sort & Filter ─────────────────────────────────────────────────────────────

function applySort(players) {
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
    const has = p => (HAS_VIDEO.has(String(p[COL.ID])) || videoUrl(p)) ? 0 : 1;
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

function applyFilters(players) {
  return players.filter(p => {
    // Search filter
    if (searchQuery) {
      const name = (p[COL.NAME] || '').toLowerCase();
      if (!name.includes(searchQuery)) return false;
    }

    // Favorites filter
    if (activeFilters.favorites && !favorites.has(String(p[COL.ID]))) return false;

    // TEMPORARY (Fall 2026 draft): missed-tryout filter. Replaced the old
    // admin-only "No Shows" chip -- this is attendance, derived from whether
    // a tryout photo was captured, rather than a hand-set flag. Remove with
    // the chip after the draft.
    if (activeFilters.noTryout && !MISSED_TRYOUT.has(String(p[COL.ID]))) return false;

    // PRE-DRAFT (Fall 2026): has-video filter. Checks the known list first,
    // then the Drive index, so it stays correct as clips finish uploading.
    if (activeFilters.hasVideo &&
        !(HAS_VIDEO.has(String(p[COL.ID])) || videoUrl(p))) return false;

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

// ── Grid rendering ────────────────────────────────────────────────────────────

function renderGrid() {
  const grid    = document.getElementById('player-grid');
  const coach   = getCurrentCoach();
  const sorted  = applySort(allPlayers);
  const visible = applyFilters(sorted);

  renderResultCount(visible.length, allPlayers.length);

  if (!visible.length) {
    grid.innerHTML = '<div class="loading">No players match the current filters.</div>';
    return;
  }

  if (currentSort === 'team') {
    // Group by team — emit a full-width header row before each new team
    let lastTeam = null;
    const parts = [];
    for (const p of visible) {
      const team = p._teamFB || p[COL.TEAM] || 'Unassigned';
      if (team !== lastTeam) {
        parts.push(`<div class="team-group-header">${escHtml(team)}</div>`);
        lastTeam = team;
      }
      parts.push(playerCardHTML(p, !!coach));
    }
    grid.innerHTML = parts.join('');
  } else {
    grid.innerHTML = visible.map(p => playerCardHTML(p, !!coach)).join('');
  }

  // Wire heart buttons (outside the <a> tag, so clicks don't navigate)
  grid.querySelectorAll('.heart-btn').forEach(btn => {
    btn.addEventListener('click', e => toggleFavorite(btn.dataset.id, e));
  });

  // Logged-out cards are plain divs (see playerCardHTML) — tapping one plays
  // that player's tryout video.
  grid.querySelectorAll('[data-action="open-video"]').forEach(el => {
    const open = () => {
      const p = allPlayers.find(pl => String(pl[COL.ID]) === String(el.dataset.id));
      const url = p && videoUrl(p);
      if (!url) return toast(`No tryout video for ${p ? p[COL.NAME] : 'this player'}`);
      openVideoModal(url, p[COL.NAME]);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// ── Public (logged-out) single-player profile popup ───────────────────────────

function openVideoModal(video, name = '') {
  if (!video) return;
  const title = document.getElementById('video-modal-title');
  if (title) title.textContent = name;
  document.getElementById('video-modal-body').innerHTML =
    `<iframe class="profile-video" src="${video}" allowfullscreen allow="autoplay"></iframe>`;
  document.getElementById('modal-video').classList.remove('hidden');
}

function closeVideoModal() {
  document.getElementById('modal-video')?.classList.add('hidden');
  document.getElementById('video-modal-body').innerHTML = ''; // stop playback
}

/** Brief message for the no-video case, so a tap never feels like a dead end. */
let dirToastTimer = null;
function toast(msg) {
  const host = document.getElementById('dir-toast');
  if (!host) return;
  host.textContent = msg;
  host.classList.add('show');
  clearTimeout(dirToastTimer);
  dirToastTimer = setTimeout(() => host.classList.remove('show'), 2200);
}

function wirePlayerModal() {
  document.getElementById('btn-video-close')?.addEventListener('click', closeVideoModal);
  document.getElementById('modal-video')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVideoModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVideoModal(); });
}

function playerCardHTML(p, isLoggedIn) {
  const name      = p[COL.NAME] || 'Unknown';
  const grade     = p[COL.GRADE] || '—';
  // AGE column holds a birth date; coaches want the age.
  const age       = ageDisplay(p[COL.AGE]);
  const id        = p[COL.ID]    || '';
  const photo     = photoUrl(p);
  const team      = p._teamFB || p[COL.TEAM] || '';
  const composite = p._composite ?? null;
  const isFav     = favorites.has(String(id));

  // Composite seed is ADMIN-ONLY for now.
  //
  // One coach ranked by the order he intended to draft players rather than by
  // ability, so his 1s aren't 1s and the average is badly skewed. The number
  // is still computed and still visible to the commissioner; it's just not
  // put in front of coaches as if it meant what it used to.
  //
  // Revisit once there's a way to handle this properly — a commissioner
  // override, or excluding an outlier ballot from the average.
  let scoreHtml = '';
  if (isLoggedIn && viewerIsAdmin()) {
    if (composite !== null) {
      const dec = composite % 1;
      const flames = dec < 0.2 ? '🔥🔥🔥' : dec < 0.7 ? '🔥🔥' : '🔥';
      scoreHtml = `<span class="player-card-score">${composite.toFixed(1)}</span><span class="player-card-flames">${flames}</span>`;
    } else {
      scoreHtml = `<span class="player-card-score unranked">Unseeded</span>`;
    }
  }

  const teamHtml = team
    ? `<div class="player-card-team">${escHtml(team)}</div>` : '';

  // Badge row. All of this sits IN FRONT of the login gate this season --
  // coach pins aren't distributed yet, so coaches need to evaluate from the
  // public link. Move it back behind getCurrentCoach() once pins go out.
  //
  // Returning-player badge: ids are season-scoped and change every season, so
  // "has this kid played before" comes from the cross-season identity link
  // (player-identity.js), never from the id itself.
  const prior = priorSeasons(name, SEASON_CODE);
  const badges = [];
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
  // Missed-tryout badge: no Fall photo was taken, which is how attendance was
  // determined (see _local/PENDING_ROSTER_CHANGES.md).
  if (MISSED_TRYOUT.has(String(id))) {
    badges.push('<span class="player-card-missed" title="Did not attend Fall 2026 tryouts">✕ Missed Tryout</span>');
  }
  const priorHtml = badges.length
    ? `<div class="player-card-badges">${badges.join('')}</div>` : '';

  const imgHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" loading="lazy" />`
    : `<div class="player-card-img-placeholder">🏀</div>`;

  // Video badge on the thumbnail, same red/grey treatment as the ranking
  // page and draft board so "has footage" reads identically everywhere.
  const video = videoUrl(p);
  const videoBadge = video
    ? `<span class="card-video-badge" title="Watch tryout video">▶</span>`
    : `<span class="card-video-badge disabled" title="No video available">▶</span>`;

  // Phone straight on the tile for a coach's own players — reaching a parent
  // shouldn't cost two taps through a popup. stopPropagation keeps a tap on
  // the number from also navigating the card behind it.
  const phone = myPlayerPhone(p);
  const phoneHtml = phone
    ? `<a class="player-card-phone" href="tel:${escHtml(phone.replace(/[^0-9]/g, ''))}"
          onclick="event.stopPropagation()" title="Call ${escHtml(phone)}">${escHtml(phone)}</a>`
    : '';

  const cardInner = `
    <span class="player-card-thumb">${imgHtml}${videoBadge}</span>
    <div class="player-card-info">
      <div class="player-card-name"><span class="pc-id">${escHtml(id)}</span><span class="pc-sep"> · </span>${escHtml(name)}</div>
      <div class="player-card-meta">Grade ${escHtml(grade)} · Age ${escHtml(age)}</div>
      ${phoneHtml}
      ${priorHtml}
      ${scoreHtml}
      ${teamHtml}
    </div>`;

  // Coaches go straight into the full ranking page. For the public, tapping
  // the card opens the player's video directly — that's the thing a parent
  // or coach actually wants from a face, and it saves a hop through a popup
  // that only repeated what the card already showed.
  const card = isLoggedIn
    ? `<a class="player-card" href="player.html?id=${encodeURIComponent(id)}">${cardInner}</a>`
    : `<div class="player-card${video ? '' : ' pc-novideo'}" data-action="open-video"
            data-id="${escHtml(id)}" role="button" tabindex="0">${cardInner}</div>`;

  return `
    <div class="player-card-wrap">
      ${card}
      <button class="heart-btn${isFav ? ' active' : ''}" data-id="${escHtml(id)}"
              title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
    </div>`;
}

// ── Controls setup ────────────────────────────────────────────────────────────

function setupControls() {
  // Sort buttons — sync active state with currentSort (may be pre-set from URL)
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderGrid();
    });
  });

  // Build dynamic filter chips from player data
  buildFilterChips();

  // Favorites toggle
  document.getElementById('filter-favorites')?.addEventListener('click', e => {
    activeFilters.favorites = !activeFilters.favorites;
    e.currentTarget.classList.toggle('active', activeFilters.favorites);
    renderGrid();
  });

  // TEMPORARY (Fall 2026 draft): missed-tryout toggle. Public -- no login
  // gate, unlike the admin no-shows chip. Remove after the draft.
  document.getElementById('filter-notryout')?.addEventListener('click', e => {
    activeFilters.noTryout = !activeFilters.noTryout;
    e.currentTarget.classList.toggle('active', activeFilters.noTryout);
    renderGrid();
  });

  // PRE-DRAFT (Fall 2026): has-video toggle.
  document.getElementById('filter-hasvideo')?.addEventListener('click', e => {
    activeFilters.hasVideo = !activeFilters.hasVideo;
    e.currentTarget.classList.toggle('active', activeFilters.hasVideo);
    renderGrid();
  });

  // Search input
  document.getElementById('player-search')?.addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderGrid();
  });

  // Cards swap between a link (coach) and a tap-to-play div (public), so a
  // login change has to re-render the grid.
  document.addEventListener('coachChanged', () => renderGrid());
}

function buildFilterChips() {
  buildGradeChips();
  buildSeedChips();
  buildTeamChips();
}

function buildGradeChips() {
  const container = document.getElementById('filter-grades');
  if (!container) return;
  const grades = [...new Set(allPlayers.map(p => parseInt(p[COL.GRADE])).filter(Boolean))].sort((a,b)=>a-b);
  container.innerHTML = grades.map(g => `
    <button class="filter-chip" data-type="grade" data-value="${g}">Grade ${g}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.grades.has(val) ? activeFilters.grades.delete(val) : activeFilters.grades.add(val);
      btn.classList.toggle('active', activeFilters.grades.has(val));
      renderGrid();
    });
  });
}

function buildSeedChips() {
  const container = document.getElementById('filter-seeds');
  if (!container) return;
  container.innerHTML = [1,2,3,4,5,6,7,8].map(n => `
    <button class="filter-chip" data-type="seed" data-value="${n}">${n}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value);
      activeFilters.seeds.has(val) ? activeFilters.seeds.delete(val) : activeFilters.seeds.add(val);
      btn.classList.toggle('active', activeFilters.seeds.has(val));
      renderGrid();
    });
  });
}

function buildTeamChips() {
  const container = document.getElementById('filter-teams');
  if (!container) return;
  const teams = [...new Set(
    allPlayers.map(p => p._teamFB || p[COL.TEAM] || '').filter(Boolean)
  )].sort();
  if (!teams.length) { container.innerHTML = '<span class="filter-empty">No teams assigned yet</span>'; return; }
  container.innerHTML = teams.map(t => `
    <button class="filter-chip" data-type="team" data-value="${escHtml(t)}">${escHtml(t)}</button>
  `).join('');
  container.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      activeFilters.teams.has(val) ? activeFilters.teams.delete(val) : activeFilters.teams.add(val);
      btn.classList.toggle('active', activeFilters.teams.has(val));
      renderGrid();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { COL, SHEET_CSV_URL, PHOTOS_FOLDER_ID, VIDEOS_FOLDER_ID, photoUrl, videoUrl };

// player.js and draft-board.js import escHtml/COL/photoUrl from here, which
// used to drag the directory's whole bootstrap along with them — fetching the
// roster a second time and then throwing on the missing #player-grid. Only
// run it on the page that actually owns that grid.
if (document.getElementById('player-grid')) init();

// ── Mobile drawer ─────────────────────────────────────────────────────────────
(function wireDrawer() {
  const toggle = document.getElementById('btn-drawer-toggle');
  const drawer = document.getElementById('header-drawer');
  if (!toggle || !drawer) return;

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    toggle.classList.toggle('active', open);
    document.getElementById('drawer-toggle-icon').textContent = open ? '▴ Filters' : '▾ Filters';
  }

  toggle.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));

  // Auto-collapse on scroll down, restore on scroll up
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastY + 10 && drawer.classList.contains('open')) setOpen(false);
    lastY = y;
  }, { passive: true });
})();
