// media-gallery.js — rendering approved media for viewers.
//
// Two surfaces, one renderer:
//   1. inside the submit sheet (media-submit.js), so a long-press shows what
//      is already there before offering to add more
//   2. media-gallery.html — a full public page per player, shareable by link
//
// PUBLIC on purpose. The same people who can submit can view: a parent who
// sends in a clip has to be able to see it appear, or the feature dies after
// the novelty does. Everything rendered here has already passed admin
// approval, so nothing reaches this module that wasn't deliberately cleared.
//
// Ranking data is never shown here — see PRODUCT_SPEC "Rankings are never
// stated publicly". A gallery is about the kid, not their seed.

import {
  getApprovedMedia, getAllPromotions, isPromoted, removeSubmission, promote,
} from './media-data.js';
import {
  thumbUrl, fullUrl, videoUrl, videoPosterUrl, formatDuration,
} from './media-config.js';
import { canRemoveFor, canPromote } from './media-permissions.js';
import { refreshPromotions } from './media-promotions.js';
import { getCurrentCoach } from './coach-login.js';

/**
 * Render a player's approved media into `container`.
 *
 * @param {HTMLElement} container
 * @param {string|number} playerId
 * @param {object} opts
 * @param {string} opts.playerName   for the empty state's copy
 * @param {boolean} opts.compact     true inside the submit sheet (smaller grid)
 * @param {Function} opts.onEmpty    called when there is nothing to show, so
 *                                   the caller can hide a heading it drew
 * @param {string}  opts.tryoutVideo Drive URL of the league's own tryout clip.
 *                  Pinned as the FIRST tile and never removable or reorderable:
 *                  it lives in Google Drive, not Cloudinary, so the app has no
 *                  delete path for it, and it is league-captured footage rather
 *                  than a submission.
 * @param {object}  opts.player      roster record, for the remove permission check
 */
export async function renderGallery(container, playerId, opts = {}) {
  const { playerName = 'this player', compact = false, onEmpty,
          tryoutVideo = null, player = null } = opts;
  if (!container) return { count: 0 };

  container.innerHTML = `<div class="media-gal-loading">Loading…</div>`;

  let items = [], promotions = {};
  try {
    [items, promotions] = await Promise.all([
      getApprovedMedia(playerId),
      getAllPromotions(),
    ]);
  } catch (err) {
    // A gallery failure must never take the page (or the submit sheet) with
    // it — the rest of the sheet still has to work so someone can submit.
    console.warn('media: gallery load failed', err);
    container.innerHTML = `<div class="media-gal-empty-b">Couldn't load media right now.</div>`;
    return { count: 0, error: err };
  }

  if (!items.length && !tryoutVideo) {
    onEmpty?.();
    container.innerHTML = emptyHTML(playerName, compact);
    return { count: 0 };
  }

  const perm = canRemoveFor(player);
  const tiles = [];

  // Tryout video leads, when one exists. Synthesised as a pseudo-item so the
  // lightbox can page through it alongside real submissions — it is flagged
  // isTryout so nothing offers to remove or promote it.
  if (tryoutVideo) {
    tiles.push({
      id: '__tryout', isTryout: true, kind: 'video',
      driveUrl: tryoutVideo, playerId, playerName,
      caption: 'Tryout video', submitterName: '',
    });
  }
  tiles.push(...items);

  container.innerHTML = `
    <div class="media-gal-grid${compact ? ' compact' : ''}">
      ${tiles.map(s => itemHTML(s, promotions, perm, compact)).join('')}
    </div>`;

  wireLightbox(container, tiles);
  wireControls(container, tiles, playerId, () => renderGallery(container, playerId, opts));
  return { count: tiles.length };
}

function emptyHTML(playerName, compact) {
  // The empty state is the ONLY place this feature announces itself — the
  // long-press trigger is invisible by nature. Worth real copy, not a dash.
  return `
    <div class="media-gal-empty">
      <div class="media-gal-empty-t">No photos or clips yet</div>
      <div class="media-gal-empty-b">
        ${compact
          ? `Be the first to add one for ${escHtml(playerName)}.`
          : `Got a photo or highlight clip of ${escHtml(playerName)}? Press and hold
             their picture anywhere in the app to send one. An admin reviews every
             submission before it appears here.`}
      </div>
    </div>`;
}

function itemHTML(s, promotions, perm, compact) {
  const isPhoto = s.kind === 'photo';

  // The tryout clip is a Drive file, not a Cloudinary asset — no transform
  // URLs, and Drive gives no poster frame, so the tile shows a film glyph.
  const thumb = s.isTryout ? null
    : (isPhoto ? thumbUrl(s.publicId) : videoPosterUrl(s.publicId));
  const promotedAs = s.isTryout ? null : isPromoted(promotions, s.playerId, s.id);

  // Controls are never offered on the tryout video: it cannot be removed (it
  // lives in Drive) and a video cannot be a profile picture.
  const showRemove  = !s.isTryout && perm?.ok && !compact;
  const showPromote = !s.isTryout && isPhoto && canPromote() && !compact && !promotedAs;

  const controls = (showRemove || showPromote) ? `
      <span class="media-gal-ctl">
        ${showPromote ? `<button class="media-gal-btn promote" data-act="promote"
                  data-id="${escHtml(s.id)}" title="Use as profile picture">★</button>` : ''}
        ${showRemove ? `<button class="media-gal-btn remove" data-act="remove"
                  data-id="${escHtml(s.id)}" title="Remove from the app">✕</button>` : ''}
      </span>` : '';

  return `
    <div class="media-gal-cell">
      <button class="media-gal-item${promotedAs ? ' is-promoted' : ''}${s.isTryout ? ' is-tryout' : ''}"
              data-id="${escHtml(s.id)}"
              aria-label="${escHtml(s.isTryout ? 'Tryout video' : (isPhoto ? 'Photo' : 'Clip'))} of ${escHtml(s.playerName)}${
                s.caption ? ': ' + escHtml(s.caption) : ''}">
        ${thumb
          ? `<img src="${thumb}" alt="" loading="lazy" />`
          : `<span class="media-gal-ph">${isPhoto ? '🏀' : '🎬'}</span>`}
        ${s.isTryout ? `<span class="media-gal-badge tryout">Tryout</span>` : ''}
        ${promotedAs === 'photo' ? `<span class="media-gal-badge">Profile</span>` : ''}
        ${promotedAs === 'video' ? `<span class="media-gal-badge">Primary</span>` : ''}
        ${!isPhoto ? `<span class="media-gal-play" aria-hidden="true">▶</span>` : ''}
        ${!isPhoto && s.durationSec
          ? `<span class="media-gal-dur">${formatDuration(s.durationSec)}</span>` : ''}
        ${s.submitterName
          ? `<span class="media-gal-by">${escHtml(s.submitterName)}</span>` : ''}
      </button>
      ${controls}
    </div>`;
}

// ── Remove / promote ─────────────────────────────────────────────────────────

function wireControls(container, tiles, playerId, rerender) {
  container.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const sub = tiles.find(t => t.id === btn.dataset.id);
    if (!sub || sub.isTryout) return;
    const actor = getCurrentCoach()?.name || 'admin';

    if (btn.dataset.act === 'remove') {
      const perm = canRemoveFor({ _teamFB: sub.playerTeam, name: sub.playerName });
      // Re-check at click time, not just at render: a logout between the two
      // would otherwise leave a live button behind.
      const allowed = perm.ok || canPromote();
      if (!allowed) { alert(perm.reason || 'You cannot remove this.'); return; }
      if (!confirm('Remove this from the app? An admin can restore it later — nothing is deleted.')) return;
      btn.disabled = true;
      try {
        await removeSubmission(sub.id, actor, perm.role || 'admin');
        await rerender();
      } catch (err) { alert(`Could not remove that: ${err.message}`); btn.disabled = false; }
    }

    if (btn.dataset.act === 'promote') {
      if (!canPromote()) { alert('Only a league admin can set the profile picture.'); return; }
      btn.disabled = true;
      try {
        await promote(playerId, 'photo', sub, actor);
        // The promotion map is cached for the session — without this the new
        // headshot would not appear elsewhere until the tab was closed.
        await refreshPromotions();
        await rerender();
      } catch (err) { alert(`Could not set the profile picture: ${err.message}`); btn.disabled = false; }
    }
  });
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
// One overlay per document, created lazily and reused. Appended to <body>
// rather than inside the container so it is never clipped by the submit
// sheet's own overflow:auto.

let lbEl = null;
let lbItems = [];
let lbIndex = 0;

function ensureLightbox() {
  if (lbEl) return lbEl;
  lbEl = document.createElement('div');
  lbEl.id = 'media-gal-lightbox';
  lbEl.className = 'media-gal-lb hidden';
  lbEl.innerHTML = `
    <div class="media-gal-lb-inner">
      <button class="media-gal-lb-x" aria-label="Close">✕</button>
      <button class="media-gal-lb-nav prev" aria-label="Previous">‹</button>
      <div class="media-gal-lb-body"></div>
      <button class="media-gal-lb-nav next" aria-label="Next">›</button>
      <div class="media-gal-lb-cap"></div>
    </div>`;
  document.body.appendChild(lbEl);

  lbEl.querySelector('.media-gal-lb-x').addEventListener('click', closeLightbox);
  lbEl.addEventListener('click', e => { if (e.target === lbEl) closeLightbox(); });
  lbEl.querySelector('.prev').addEventListener('click', () => step(-1));
  lbEl.querySelector('.next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', e => {
    if (lbEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft')  step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  return lbEl;
}

function wireLightbox(container, items) {
  container.addEventListener('click', e => {
    const btn = e.target.closest('.media-gal-item');
    if (!btn) return;
    // The gallery can live inside the submit sheet, whose own handlers would
    // otherwise see this as a click on the sheet body.
    e.preventDefault();
    e.stopPropagation();
    lbItems = items;
    lbIndex = items.findIndex(s => s.id === btn.dataset.id);
    if (lbIndex < 0) lbIndex = 0;
    showSlide();
  });
}

function step(delta) {
  if (!lbItems.length) return;
  // Wrap, so arrowing past either end keeps working rather than dead-ending.
  lbIndex = (lbIndex + delta + lbItems.length) % lbItems.length;
  showSlide();
}

function showSlide() {
  const el = ensureLightbox();
  const s = lbItems[lbIndex];
  if (!s) return;

  const body = el.querySelector('.media-gal-lb-body');
  // Always replace the node: reusing a <video> across slides leaves the
  // previous clip's audio playing under the new one.
  // The tryout clip is a Drive preview URL, which only plays in an iframe —
  // it is not a direct media file, so a <video> tag would show nothing.
  body.innerHTML = s.isTryout
    ? `<iframe src="${escHtml(s.driveUrl)}" allow="autoplay"
               allowfullscreen class="media-gal-lb-frame"></iframe>`
    : s.kind === 'photo'
      ? `<img src="${fullUrl(s.publicId)}" alt="${escHtml(s.playerName)}" />`
      : `<video src="${videoUrl(s.publicId)}" controls autoplay playsinline
                poster="${videoPosterUrl(s.publicId)}"></video>`;

  const parts = [];
  if (s.caption) parts.push(escHtml(s.caption));
  if (s.submitterName) parts.push(`Added by ${escHtml(s.submitterName)}`);
  if (lbItems.length > 1) parts.push(`${lbIndex + 1} of ${lbItems.length}`);
  el.querySelector('.media-gal-lb-cap').innerHTML = parts.join(' · ');

  el.querySelectorAll('.media-gal-lb-nav').forEach(b =>
    b.classList.toggle('hidden', lbItems.length < 2));
  el.classList.remove('hidden');
}

function closeLightbox() {
  if (!lbEl) return;
  lbEl.classList.add('hidden');
  lbEl.querySelector('.media-gal-lb-body').innerHTML = '';
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
