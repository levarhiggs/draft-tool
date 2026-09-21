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

import { getApprovedMedia, getAllPromotions, isPromoted } from './media-data.js';
import {
  thumbUrl, fullUrl, videoUrl, videoPosterUrl, formatDuration,
} from './media-config.js';

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
 */
export async function renderGallery(container, playerId, opts = {}) {
  const { playerName = 'this player', compact = false, onEmpty } = opts;
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

  if (!items.length) {
    onEmpty?.();
    container.innerHTML = emptyHTML(playerName, compact);
    return { count: 0 };
  }

  container.innerHTML = `
    <div class="media-gal-grid${compact ? ' compact' : ''}">
      ${items.map(s => itemHTML(s, promotions)).join('')}
    </div>`;

  wireLightbox(container, items);
  return { count: items.length };
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

function itemHTML(s, promotions) {
  const isPhoto = s.kind === 'photo';
  const thumb = isPhoto ? thumbUrl(s.publicId) : videoPosterUrl(s.publicId);
  const promotedAs = isPromoted(promotions, s.playerId, s.id);

  return `
    <button class="media-gal-item${promotedAs ? ' is-promoted' : ''}"
            data-id="${escHtml(s.id)}"
            aria-label="${escHtml(isPhoto ? 'Photo' : 'Clip')} of ${escHtml(s.playerName)}${
              s.caption ? ': ' + escHtml(s.caption) : ''}">
      ${thumb
        ? `<img src="${thumb}" alt="" loading="lazy" />`
        : `<span class="media-gal-ph">${isPhoto ? '🏀' : '🎬'}</span>`}
      ${promotedAs === 'photo' ? `<span class="media-gal-badge">Profile</span>` : ''}
      ${promotedAs === 'video' ? `<span class="media-gal-badge">Primary</span>` : ''}
      ${!isPhoto ? `<span class="media-gal-play" aria-hidden="true">▶</span>` : ''}
      ${!isPhoto && s.durationSec
        ? `<span class="media-gal-dur">${formatDuration(s.durationSec)}</span>` : ''}
      ${s.submitterName
        ? `<span class="media-gal-by">${escHtml(s.submitterName)}</span>` : ''}
    </button>`;
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
  body.innerHTML = s.kind === 'photo'
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
