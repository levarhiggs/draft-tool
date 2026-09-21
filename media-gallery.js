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
          headshotPhoto = null, tryoutVideo = null, player = null } = opts;
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

  if (!items.length && !tryoutVideo && !headshotPhoto) {
    onEmpty?.();
    container.innerHTML = emptyHTML(playerName, compact);
    return { count: 0 };
  }

  const perm = canRemoveFor(player);
  const tiles = [];

  // The player's own headshot leads the gallery as tile 1 of N — same
  // treatment as the tryout video below, and for the same reason: it's
  // already the first thing every other page shows for this player, so the
  // gallery should read as "everything about this player's media", not just
  // "what's been submitted". Synthesised as a pseudo-item (isHeadshot) so
  // nothing offers to remove or promote it — removing the app's own default
  // photo isn't a thing, and "promote to profile picture" doesn't make sense
  // applied to the photo that's already serving that role.
  if (headshotPhoto) {
    tiles.push({
      id: '__headshot', isHeadshot: true, kind: 'photo',
      driveUrl: headshotPhoto, playerId, playerName,
      caption: 'Profile photo', submitterName: '',
    });
  }
  // Tryout video comes next. Synthesised as a pseudo-item so the lightbox can
  // page through it alongside real submissions — it is flagged isTryout so
  // nothing offers to remove or promote it.
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
  const isPinned = s.isHeadshot || s.isTryout;

  // The headshot and tryout clip are Drive files, not Cloudinary assets — no
  // transform URLs, so their own driveUrl is used directly as the thumbnail.
  // Drive gives no poster frame for video, so the tryout tile still falls
  // back to a film glyph.
  const thumb = s.isHeadshot ? s.driveUrl
    : s.isTryout ? null
    : (isPhoto ? thumbUrl(s.publicId) : videoPosterUrl(s.publicId));
  const promotedAs = isPinned ? null : isPromoted(promotions, s.playerId, s.id);

  // Controls are never offered on the headshot or the tryout video: neither
  // can be removed (both live in Drive, not Cloudinary) and "promote to
  // profile picture" doesn't apply to the photo already serving that role.
  const showRemove  = !isPinned && perm?.ok && !compact;
  const showPromote = !isPinned && isPhoto && canPromote() && !compact && !promotedAs;

  const controls = (showRemove || showPromote) ? `
      <span class="media-gal-ctl">
        ${showPromote ? `<button class="media-gal-btn promote" data-act="promote"
                  data-id="${escHtml(s.id)}" title="Use as profile picture">★</button>` : ''}
        ${showRemove ? `<button class="media-gal-btn remove" data-act="remove"
                  data-id="${escHtml(s.id)}" title="Remove from the app">✕</button>` : ''}
      </span>` : '';

  return `
    <div class="media-gal-cell">
      <button class="media-gal-item${promotedAs ? ' is-promoted' : ''}${isPinned ? ' is-pinned' : ''}${s.isTryout ? ' is-tryout' : ''}${s.isHeadshot ? ' is-headshot' : ''}"
              data-id="${escHtml(s.id)}"
              aria-label="${escHtml(s.isHeadshot ? 'Profile photo' : s.isTryout ? 'Tryout video' : (isPhoto ? 'Photo' : 'Clip'))} of ${escHtml(s.playerName)}${
                s.caption ? ': ' + escHtml(s.caption) : ''}">
        ${thumb
          ? `<img src="${thumb}" alt="" loading="lazy" />`
          : `<span class="media-gal-ph">${isPhoto ? '🏀' : '🎬'}</span>`}
        ${s.isHeadshot ? `<span class="media-gal-badge tryout">Profile</span>` : ''}
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
  //
  // The headshot's driveUrl is a plain thumbnail URL (sz=w400/w1200 or a
  // Cloudinary-promoted override) — a normal <img src>, same as any approved
  // photo, just pointed at the roster's own photoUrl() instead of a
  // Cloudinary publicId. This is deliberately the SAME full-size treatment
  // draft-board.js's own lightbox gives a headshot (bigPhotoUrl there is
  // just photoUrl() with the Drive size bumped to w1200) — one lightbox,
  // reused, rather than a second one for this page.
  //
  // The tryout clip is a Drive PREVIEW url, which only plays in an iframe —
  // it is not a direct media file, so a <video> tag would show nothing.
  body.innerHTML = s.isHeadshot
    ? `<img src="${escHtml(s.driveUrl)}" alt="${escHtml(s.playerName)}" />`
    : s.isTryout
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
