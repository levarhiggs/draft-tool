// app.js — player directory: data loading, grid rendering, favorites wiring.
// Sort/filter/search state and chip-building live in player-list-controls.js,
// shared with player.js (the coach ranking page) so the two never drift into
// separate copies of the same "which players, in what order" logic.
import { getCompositeRank, getPriorComposite } from './firebase.js';
import { getCurrentCoach } from './coach-login.js';
import {
  COL, SHEET_CSV_URL, PHOTOS_FOLDER_ID, VIDEOS_FOLDER_ID, SEASON_CODE,
  fetchPlayers, buildDriveIndex, photoUrl, videoUrl, ageDisplay,
} from './players-data.js';
import { priorSeasons } from './player-identity.js';
import { getSeason } from './season-config.js';
import { contactFor } from './player-contacts.js';
import { personByName, teamNameFor, TEAM_ADMINS } from './coaches-config.js';
import {
  activeFilters, favorites, currentSort, toggleFavorite as toggleFavoriteShared,
  loadFavorites, applySort, applyFilters, renderResultCount,
  initListControls, buildTeamChips, isMissedTryout,
} from './player-list-controls.js';
import { attachMediaSubmit, openMediaSheet } from './media-submit.js';
import { loadPromotions } from './media-promotions.js';

/**
 * Attach the media-submit double-tap to every card photo in the grid.
 *
 * Kept as its own function (rather than inline in renderGrid) because
 * renderGrid runs on every sort, filter, login and Firebase enrichment —
 * attachMediaSubmit is idempotent per element, but the intent is clearer
 * named than as a loop buried in the render path.
 */
function wireMediaSubmit(grid, visible) {
  const byId = new Map(visible.map(p => [String(p[COL.ID]), p]));
  grid.querySelectorAll('.player-card-wrap').forEach(wrap => {
    const thumb = wrap.querySelector('.player-card-thumb');
    const id = wrap.querySelector('.heart-btn')?.dataset.id;
    const player = byId.get(String(id));
    if (!thumb || !player) return;
    attachMediaSubmit(thumb, { id: player[COL.ID], name: player[COL.NAME] });
  });
}

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

let allPlayers  = [];

async function init() {
  try {
    const [players] = await Promise.all([
      fetchPlayers(),
      buildDriveIndex(),
      // Promoted media overrides the Drive headshot in photoUrl()/videoUrl().
      // Must resolve BEFORE the first render or promoted photos would flash
      // the Drive original first. Never throws — see media-promotions.js.
      loadPromotions(),
    ]);
    allPlayers = players;

    // Load coach favorites from Firebase if logged in
    await loadFavorites();

    renderGrid();
    initListControls(() => allPlayers, renderGrid);
    wirePlayerModal();

    // Enrich with Firebase data then re-render and rebuild team chips
    await enrichWithFirebase(allPlayers);
    buildTeamChips(() => allPlayers, renderGrid);
    renderGrid();
  } catch (err) {
    const grid = document.getElementById('player-grid');
    if (grid) grid.innerHTML = `<div class="loading">Error loading players: ${err.message}</div>`;
    console.error(err);
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────

function toggleFavorite(playerId, e) {
  e.preventDefault();
  e.stopPropagation();
  const isFav = toggleFavoriteShared(playerId);
  // Update just the heart on this card without full re-render
  const btn = document.querySelector(`.heart-btn[data-id="${playerId}"]`);
  if (btn) btn.classList.toggle('active', isFav);
  // If favorites filter is active, re-render to remove/add card
  if (activeFilters.favorites) renderGrid();
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

// ── Grid rendering ────────────────────────────────────────────────────────────
// applySort/applyFilters/renderResultCount now live in player-list-controls.js.

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

  // Long-press on a card photo opens the media sheet on TOUCH. Desktop's
  // double-click was removed entirely (2026-09-21): it fought the logged-in
  // card's own <a href>, needed a navigation-swallowing workaround, and a
  // single click does the job better.
  wireMediaSubmit(grid, visible);

  // Everything that opens the media gallery/upload sheet: a logged-out card,
  // and the video badge in both states.
  grid.querySelectorAll('[data-action="open-media"]').forEach(el => {
    const open = e => {
      e?.preventDefault();
      e?.stopPropagation();   // the badge sits inside the logged-in card's <a>
      const p = allPlayers.find(pl => String(pl[COL.ID]) === String(el.dataset.id));
      if (p) openMediaSheet({ id: p[COL.ID], name: p[COL.NAME] });
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
    });
  });
}

// ── Public (logged-out) single-player profile popup ───────────────────────────

// UNUSED as of 2026-09-21 — every video entry point now opens the media
// gallery/upload sheet instead, which leads with the tryout clip. Kept
// (not deleted) because the modal markup it drives still exists in the
// HTML and a future 'play just the tryout video' path may want it. Delete
// both together if that never materialises.
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

  // Badge row.
  //
  // NO RANKING DATA IS EVER STATED PUBLICLY. Nothing that names or numbers a
  // seed, rank or composite renders outside the coach login gate — not the
  // current composite (handled above), and not a prior season's. A non-coach
  // can still infer plenty from the draft board or who ended up on which team;
  // that inference is fine. Publishing a number about a specific child is not.
  //
  // "Returning" stays public: it states that a kid played before, which is a
  // fact about participation, not an evaluation of them.
  //
  // Returning-player badge: ids are season-scoped and change every season, so
  // "has this kid played before" comes from the cross-season identity link
  // (player-identity.js), never from the id itself.
  const prior = priorSeasons(name, SEASON_CODE);
  const badges = [];
  if (prior.length) {
    const seasons = prior.map(e => escHtml(getSeason(e.season).name)).join(', ');
    badges.push(`<span class="player-card-returning" title="Played in ${seasons}">↩ Returning</span>`);
    // Prior-season composite: coach-gated, same as the current-season one.
    const pr = p._priorRank;
    if (isLoggedIn && pr && pr.composite != null) {
      badges.push(`<span class="player-card-prevrank" title="${
        escHtml(getSeason(pr.season).name)} composite seed from ${pr.count} coach${
        pr.count === 1 ? '' : 'es'}">Prev. Rank: ${pr.composite.toFixed(1)}</span>`);
    }
  }
  // Missed-tryout badge: no Fall photo was taken, which is how attendance was
  // determined (see _local/PENDING_ROSTER_CHANGES.md).
  if (isMissedTryout(id)) {
    badges.push('<span class="player-card-missed" title="Did not attend Fall 2026 tryouts">✕ Missed Tryout</span>');
  }
  const priorHtml = badges.length
    ? `<div class="player-card-badges">${badges.join('')}</div>` : '';

  const imgHtml = photo
    ? `<img src="${photo}" alt="${escHtml(name)}" loading="lazy" />`
    : `<div class="player-card-img-placeholder">🏀</div>`;

  // Video badge on the thumbnail, same red/grey treatment as the ranking
  // page and draft board so "has footage" reads identically everywhere.
  // The video badge is now the de facto way into a player's media — it opens
  // the gallery/upload sheet whether or not a tryout video exists, because the
  // gallery is where ALL of a player's media lives now, tryout clip included.
  const video = videoUrl(p);
  const videoBadge = `<span class="card-video-badge${video ? '' : ' disabled'}"
          data-action="open-media" data-id="${escHtml(id)}" role="button" tabindex="0"
          title="${video ? 'Tryout video & photos' : 'Photos & clips'}">▶</span>`;

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

  // Click model (rewritten 2026-09-21 — double-click is GONE, it fought the
  // card's own <a> and was unreliable):
  //   logged out  — a single click on the face opens the media gallery/upload
  //                 sheet. That sheet leads with the tryout video, so nothing
  //                 is lost versus the old tap-to-play-video behaviour.
  //   logged in   — a single click on the face still goes to the ranking page,
  //                 which is what a coach is actually there for. The video
  //                 badge is their route into the gallery.
  const card = isLoggedIn
    ? `<a class="player-card" href="player.html?id=${encodeURIComponent(id)}">${cardInner}</a>`
    : `<div class="player-card" data-action="open-media"
            data-id="${escHtml(id)}" role="button" tabindex="0">${cardInner}</div>`;

  // The heart stays OUTSIDE the card element (a <button> nested in an <a
  // href> is invalid HTML and gets hoisted out by the parser, silently
  // detaching its listener). The video badge does NOT need the same
  // treatment: it is a <span role="button">, which IS valid inside an anchor,
  // so it lives back inside .player-card-thumb where its bottom/left CSS
  // positions correctly against just the photo, not the whole card.
  return `
    <div class="player-card-wrap">
      ${card}
      <button class="heart-btn${isFav ? ' active' : ''}" data-id="${escHtml(id)}"
              title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">♥</button>
    </div>`;
}

// ── Controls setup ────────────────────────────────────────────────────────────
// Sort bar, search, and grade/seed/team/favorites/noTryout/hasVideo chips are
// all wired by initListControls() (player-list-controls.js), called from
// init() above. Only what's specific to the grid stays here.

document.addEventListener('coachChanged', () => {
  // Cards swap between a link (coach) and a tap-to-play div (public), so a
  // login change has to re-render the grid. Guarded: app.js is imported by
  // player.js too (for escHtml/COL/photoUrl/videoUrl), and this listener is
  // registered at module scope regardless of which page loaded it — without
  // the guard, logging in from player.html threw here (#player-grid does
  // not exist on that page) every time this listener fired.
  if (document.getElementById('player-grid')) renderGrid();
});

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
// Mobile drawer (the sort/filter bar's collapse behaviour) is wired inside
// initListControls() now, shared with player.html.
