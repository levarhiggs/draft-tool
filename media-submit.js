// media-submit.js — the double-click/double-tap trigger and the submit sheet.
//
// ONE module, attached from every page that shows a profile picture. The
// alternative — a copy of this per page — is the drift that produced
// player-list-controls.js's extraction and gotcha #12's three parallel
// win/loss implementations. Don't fork it.
//
// NOT attached on gameboard.html or rotations.html: both already bind their
// own double-click behaviour (gameboard.js:2142, rotations.js:389), and the
// feature request excludes them for exactly that reason.
//
// ── ONE TRIGGER, TWO GESTURES ────────────────────────────────────────────────
// Desktop: double-click. Touch: LONG-PRESS (~500ms), not double-tap.
//
// Double-tap was the original design and it works, but on a phone it fights
// the browser: double-tap on an image is the native zoom gesture, so the
// handler has to suppress it, and it only resolves after the browser's ~300ms
// tap-disambiguation delay. Long-press has no such competition, matches what
// press-and-hold already means on an image everywhere else on a phone (save /
// share / copy — submitting a photo is the same family of action), and can
// show a filling progress ring so someone who presses and hesitates DISCOVERS
// the gesture. For a trigger that is otherwise invisible, that last point is
// what decided it.
//
// The desktop path still needs the debounce gameboard.js:2142 documents: a
// native double-click fires click, click, dblclick on the SAME element, so an
// existing single-click action (the bio modal in player.js, the draft-board
// lightbox) would run before the double ever registers. The single-click
// action is therefore held behind a 250ms timer that a second click cancels.
//
// On TOUCH there is no such delay — a tap runs its single-click action
// immediately, because long-press is a different gesture entirely rather than
// a second tap that has to be waited for.

import {
  MAX_CAPTION_CHARS, MAX_VIDEO_SECONDS, mediaConfigured,
  formatDuration, formatBytes,
} from './media-config.js';
import { validateFile, uploadToCloudinary, durationWithinLimit, readImagePreview }
  from './media-upload.js';
import { createSubmission, getPlayerCounts, canSubmit } from './media-data.js';
import { renderGallery } from './media-gallery.js';

const DBLCLICK_MS  = 250;  // how long a single click waits to see if a second lands
const LONGPRESS_MS = 500;  // press duration that opens the sheet on touch
const MOVE_TOLERANCE = 10; // px of finger drift that still counts as a press, not a scroll

let sheetEl = null;        // the one sheet element, lazily built and reused
let activeState = null;

/**
 * Attach the submit trigger to a profile picture.
 *
 * @param {HTMLElement} el          the photo element
 * @param {object}      player      the roster record
 * @param {object}      opts
 * @param {Function}    opts.onSingleClick  existing single-click action, if any.
 *        Passing it here (rather than binding it separately) is what lets the
 *        debounce cancel it when the interaction turns out to be a double.
 */
export function attachMediaSubmit(el, player, { onSingleClick } = {}) {
  if (!el || el.dataset.mediaSubmitBound === '1') return;
  el.dataset.mediaSubmitBound = '1';

  const open = () => openSubmitSheet(player);

  // ── Desktop: double-click ──────────────────────────────────────────────────
  let clickTimer = null;
  // Set by a completed long-press so the synthetic click a touch emits
  // afterwards doesn't also run the single-click action.
  let suppressClick = false;

  // ── Links swallow the double-click ────────────────────────────────────────
  // When this element sits inside an <a href> — which every directory card is
  // once a coach logs in — the FIRST click of a double navigates away before
  // the second ever arrives, so dblclick never fires and the sheet never
  // opens. preventDefault() on the dblclick handler is far too late.
  //
  // So: swallow the navigation at the first click, and re-issue it after the
  // double-click window closes if no second click came. A single click still
  // navigates (250ms later, imperceptible); a double click opens the sheet
  // and never navigates at all.
  const link = el.closest('a[href]');
  let navTimer = null;
  if (link) {
    el.addEventListener('click', e => {
      // Touch never produces a dblclick here (long-press is its gesture), so
      // let the tap navigate immediately rather than sitting on a 250ms delay.
      if (e.pointerType === 'touch' || isTouchLike()) return;
      e.preventDefault();
      e.stopPropagation();
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        navTimer = null;
        window.location.href = link.href;
      }, DBLCLICK_MS);
    });
  }
  const cancelNav = () => { if (navTimer) { clearTimeout(navTimer); navTimer = null; } };

  if (onSingleClick) {
    el.addEventListener('click', e => {
      if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
      // A touch tap needs no debounce — long-press is a separate gesture, not
      // a second tap to wait for — so the action runs immediately there.
      if (e.pointerType === 'touch' || isTouchLike()) { onSingleClick(e); return; }
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clickTimer = null; onSingleClick(e); }, DBLCLICK_MS);
    });
  }

  el.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    cancelNav();          // a double never navigates
    open();
  });

  // ── Touch: long-press ─────────────────────────────────────────────────────
  let pressTimer = null;
  let startX = 0, startY = 0;

  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    el.classList.remove('media-pressing');
  };

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return cancelPress();
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    // The class drives the ring animation in CSS, which is what makes the
    // gesture discoverable: a user who presses and hesitates sees it filling.
    el.classList.add('media-pressing');
    pressTimer = setTimeout(() => {
      pressTimer = null;
      el.classList.remove('media-pressing');
      suppressClick = true;
      cancelNav();
      // Haptic confirmation where supported — the standard "the press took"
      // signal on Android. Silently absent on iOS Safari.
      navigator.vibrate?.(15);
      open();
    }, LONGPRESS_MS);
  }, { passive: true });

  // A finger that travels is a scroll, not a press.
  el.addEventListener('touchmove', e => {
    if (!pressTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - startY) > MOVE_TOLERANCE) cancelPress();
  }, { passive: true });

  el.addEventListener('touchend', cancelPress);
  el.addEventListener('touchcancel', cancelPress);

  // Suppress the native image menu (iOS share sheet / Android "Download
  // image") ONLY on these elements — every other image in the app keeps its
  // normal behaviour. Without this the OS menu races the long-press and both
  // appear. iOS additionally needs -webkit-touch-callout:none, set in CSS on
  // .media-submit-target; the handler alone is not enough there.
  el.addEventListener('contextmenu', e => e.preventDefault());

  // Discoverability: the trigger is otherwise invisible. Only set a title when
  // the element doesn't already carry one from its existing single-click role.
  if (!el.title) el.title = 'Press and hold (or double-click) to add a photo or clip';
  el.classList.add('media-submit-target');
}

/** Coarse pointer / no hover — i.e. a touch device rather than a mouse. */
function isTouchLike() {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

/** Convenience: attach to every element matching a selector within root. */
export function attachMediaSubmitAll(root, selector, resolvePlayer, opts = {}) {
  root?.querySelectorAll(selector).forEach(el => {
    const player = resolvePlayer(el);
    if (player) attachMediaSubmit(el, player, opts);
  });
}

// ── The sheet ────────────────────────────────────────────────────────────────

function buildSheet() {
  const el = document.createElement('div');
  el.id = 'media-sheet';
  el.className = 'media-sheet-overlay hidden';
  el.innerHTML = `
    <div class="media-sheet" role="dialog" aria-modal="true" aria-labelledby="media-sheet-title">
      <div class="media-sheet-head">
        <div class="media-sheet-ava" id="media-sheet-ava"></div>
        <div>
          <div class="media-sheet-title" id="media-sheet-title"></div>
          <div class="media-sheet-sub">Add a photo or highlight clip</div>
        </div>
        <button class="media-sheet-x" id="media-sheet-close" aria-label="Close">×</button>
      </div>
      <div class="media-sheet-body" id="media-sheet-body"></div>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener('click', e => { if (e.target === el) closeSheet(); });
  el.querySelector('#media-sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.classList.contains('hidden')) closeSheet();
  });
  return el;
}

function closeSheet() {
  // Never strand an in-flight upload silently: abort it so the user isn't
  // left believing a submission landed.
  activeState?.abort?.abort();
  activeState = null;
  sheetEl?.classList.add('hidden');
}

async function openSubmitSheet(player) {
  const id   = String(player.id ?? player.ID ?? '');
  const name = player.name ?? player.NAME ?? 'this player';

  sheetEl = sheetEl || buildSheet();
  activeState = { player, id, name, file: null, kind: null, durationSec: null,
                  abort: new AbortController() };

  sheetEl.querySelector('#media-sheet-title').innerHTML =
    `<span class="pid">${escape(id)}</span> ${escape(name)}`;
  sheetEl.querySelector('#media-sheet-ava').textContent = initials(name);
  sheetEl.classList.remove('hidden');

  if (!mediaConfigured()) {
    renderBody(`<p class="media-err">Media uploads aren't set up yet.</p>
                <p class="media-hint">See <code>_local/MEDIA_SETUP_STAGE2.md</code>.</p>`);
    return;
  }

  renderBody('<p class="media-hint">Loading…</p>');
  let counts, gate;
  try {
    [counts, gate] = await Promise.all([getPlayerCounts(id), canSubmit(id)]);
  } catch (err) {
    renderBody(`<p class="media-err">Couldn't load this player's media. ${escape(err.message)}</p>`);
    return;
  }

  if (!gate.ok) { renderBody(`<p class="media-err">${escape(gate.reason)}</p>`); return; }
  renderPicker(counts);
}

function renderBody(html) {
  sheetEl.querySelector('#media-sheet-body').innerHTML = html;
}

function renderPicker(counts) {
  const photosFull = counts.approvedPhotos >= counts.maxPhotos;
  const videosFull = counts.approvedVideos >= counts.maxVideos;
  // Full slots never BLOCK submission — the admin decides what displaces what.
  const fullNote = (photosFull || videosFull)
    ? `<p class="media-quota-foot">${
        photosFull && videosFull ? 'All photo and clip slots are full'
        : photosFull ? 'Photo slots are full' : 'Clip slots are full'
      } — you can still send one, and an admin decides whether it replaces another.</p>`
    : '';

  renderBody(`
    <div class="media-gal-section" id="media-sheet-gallery-wrap">
      <div class="media-gal-head">
        <span class="media-gal-h">In the app</span>
        <a class="media-gal-more" id="media-sheet-more" href="#">See all →</a>
      </div>
      <div id="media-sheet-gallery"></div>
    </div>

    <div class="media-review-note">
      <span aria-hidden="true">🛡️</span>
      <div>
        <div class="media-review-t">An admin reviews this before it appears</div>
        <div class="media-review-b">Nothing you send shows up in the app right away.</div>
      </div>
    </div>

    <div class="media-quota-lab">Currently in the app</div>
    <div class="media-quota-row">
      ${quotaTile('Photos', counts.approvedPhotos, counts.maxPhotos)}
      ${quotaTile('Clips',  counts.approvedVideos, counts.maxVideos)}
    </div>
    ${fullNote}

    <div class="media-pick-row">
      <button class="media-pick" id="media-pick-photo">
        <span class="media-pick-ico" aria-hidden="true">📷</span>
        <span class="media-pick-lab">Photo</span>
        <span class="media-pick-hint">Camera or gallery</span>
      </button>
      <button class="media-pick" id="media-pick-video">
        <span class="media-pick-ico" aria-hidden="true">🎬</span>
        <span class="media-pick-lab">Clip</span>
        <span class="media-pick-hint">${MAX_VIDEO_SECONDS} seconds max</span>
      </button>
    </div>

    <input type="file" id="media-file-photo" accept="image/*" hidden />
    <input type="file" id="media-file-video" accept="video/*" hidden />`);

  // Gallery of what's already approved. Rendered AFTER the body exists, and
  // deliberately not awaited — the pickers must be usable immediately even on
  // a slow connection, rather than the whole sheet waiting on Firestore.
  const galWrap = sheetEl.querySelector('#media-sheet-gallery-wrap');
  const moreLink = sheetEl.querySelector('#media-sheet-more');
  if (moreLink) {
    moreLink.href = `media-gallery.html?id=${encodeURIComponent(activeState.id)}`;
  }
  renderGallery(sheetEl.querySelector('#media-sheet-gallery'), activeState.id, {
    playerName: activeState.name,
    compact: true,
    // Nothing approved yet? Drop the heading and the "See all" link — the
    // gallery's own empty state says it better than a header over a blank box.
    onEmpty: () => galWrap?.querySelector('.media-gal-head')?.remove(),
  }).catch(() => {});

  const photoInput = sheetEl.querySelector('#media-file-photo');
  const videoInput = sheetEl.querySelector('#media-file-video');
  sheetEl.querySelector('#media-pick-photo').addEventListener('click', () => photoInput.click());
  sheetEl.querySelector('#media-pick-video').addEventListener('click', () => videoInput.click());
  photoInput.addEventListener('change', () => onFileChosen(photoInput.files[0], counts));
  videoInput.addEventListener('change', () => onFileChosen(videoInput.files[0], counts));
}

function quotaTile(label, used, max) {
  const full = used >= max;
  const pct  = Math.min(100, Math.round((used / max) * 100));
  return `<div class="media-quota${full ? ' full' : ''}">
    <div class="media-quota-k">${label}</div>
    <div class="media-quota-v"><span class="used">${used}</span><span class="cap"> of ${max}</span></div>
    <div class="media-quota-bar"><i style="width:${pct}%"></i></div>
  </div>`;
}

async function onFileChosen(file, counts) {
  if (!file) return;
  renderBody('<p class="media-hint">Checking the file…</p>');

  const result = await validateFile(file);
  if (!result.ok) {
    renderBody(`
      <div class="media-reject">
        <div class="media-reject-t">Can't use this file</div>
        <div class="media-reject-b">${escape(result.error)}</div>
      </div>
      <div class="media-actions">
        <button class="btn" id="media-back">Choose another</button>
      </div>`);
    sheetEl.querySelector('#media-back').addEventListener('click', () => renderPicker(counts));
    return;
  }

  activeState.file = file;
  activeState.kind = result.kind;
  activeState.durationSec = result.durationSec;

  const preview = result.kind === 'photo' ? await readImagePreview(file) : null;
  renderForm(preview, counts);
}

function renderForm(preview, counts) {
  const { file, kind, durationSec } = activeState;
  const facts = [
    kind === 'video' && durationSec !== null ? formatDuration(durationSec) : null,
    formatBytes(file.size),
  ].filter(Boolean).join(' · ');

  renderBody(`
    <div class="media-chosen">
      ${preview
        ? `<img class="media-chosen-thumb" src="${preview}" alt="" />`
        : `<div class="media-chosen-thumb">${kind === 'video' ? '🎬' : '🏀'}</div>`}
      <div class="media-chosen-meta">
        <div class="media-chosen-name">${escape(file.name)}</div>
        <div class="media-chosen-facts">${escape(facts)}</div>
      </div>
    </div>

    <div class="media-field">
      <label for="media-name">Your name</label>
      <input id="media-name" type="text" maxlength="60" placeholder="So an admin knows who sent it" />
    </div>
    <div class="media-field">
      <label for="media-phone">Phone <span class="media-optional">— optional</span></label>
      <input id="media-phone" type="tel" maxlength="24" placeholder="Only if you want to be reached" />
    </div>
    <div class="media-field">
      <label for="media-caption">Caption <span class="media-optional">— optional</span></label>
      <textarea id="media-caption" maxlength="${MAX_CAPTION_CHARS}"
                placeholder="Game 4 — corner three at the buzzer"></textarea>
    </div>

    <div class="media-review-note" style="margin-top:14px">
      <span aria-hidden="true">🛡️</span>
      <div>
        <div class="media-review-t">Goes to an admin, not straight to the app</div>
        <div class="media-review-b">You'll see it once it's approved.</div>
      </div>
    </div>

    <div class="media-prog" id="media-prog" hidden>
      <div class="media-prog-top"><span>Uploading…</span><span class="media-prog-pct" id="media-pct">0%</span></div>
      <div class="media-prog-track"><div class="media-prog-fill" id="media-fill"></div></div>
      <p class="media-hint">Keep this page open — this can take a minute on slow wifi.</p>
    </div>
    <p class="media-err" id="media-error" hidden></p>

    <div class="media-actions" id="media-actions">
      <button class="btn" id="media-cancel">Cancel</button>
      <button class="btn btn-primary" id="media-send">Send for review</button>
    </div>`);

  // Remember the submitter's name between submissions in one session — a
  // parent sending three clips shouldn't retype it each time.
  const nameInput = sheetEl.querySelector('#media-name');
  try { nameInput.value = sessionStorage.getItem('media_submitter_name') || ''; } catch {}

  sheetEl.querySelector('#media-cancel').addEventListener('click', () => renderPicker(counts));
  sheetEl.querySelector('#media-send').addEventListener('click', () => doUpload(counts));
}

async function doUpload(counts) {
  const nameInput = sheetEl.querySelector('#media-name');
  const submitterName = nameInput.value.trim();
  const errEl = sheetEl.querySelector('#media-error');

  if (!submitterName) {
    errEl.textContent = 'Please add your name so an admin knows who sent this.';
    errEl.hidden = false;
    nameInput.focus();
    return;
  }
  errEl.hidden = true;
  try { sessionStorage.setItem('media_submitter_name', submitterName); } catch {}

  const submitterPhone = sheetEl.querySelector('#media-phone').value.trim();
  const caption        = sheetEl.querySelector('#media-caption').value.trim();
  const { file, kind, id, name } = activeState;

  const sendBtn = sheetEl.querySelector('#media-send');
  const progEl  = sheetEl.querySelector('#media-prog');
  const fillEl  = sheetEl.querySelector('#media-fill');
  const pctEl   = sheetEl.querySelector('#media-pct');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Uploading…';
  progEl.hidden = false;

  try {
    const uploaded = await uploadToCloudinary(file, kind, {
      signal: activeState.abort.signal,
      onProgress: p => {
        const pct = Math.round(p * 100);
        fillEl.style.width = pct + '%';
        pctEl.textContent  = pct + '%';
      },
    });

    // Authoritative duration check. A clip that fails here is already in
    // Cloudinary — deliberately NOT recorded in Firestore, leaving an orphan
    // asset that _local/preflight.py flags, rather than a live over-length clip.
    if (kind === 'video' && !durationWithinLimit(uploaded)) {
      throw new Error(
        `That clip is ${formatDuration(uploaded.duration)} once processed — the limit is ${MAX_VIDEO_SECONDS} seconds. Please trim it and try again.`);
    }

    await createSubmission({
      playerId: id, playerName: name, kind,
      publicId: uploaded.public_id,
      url:      uploaded.secure_url,
      thumbUrl: uploaded.secure_url,
      width:    uploaded.width,
      height:   uploaded.height,
      durationSec: uploaded.duration ?? activeState.durationSec ?? null,
      bytes:    uploaded.bytes,
      format:   uploaded.format,
      submitterName, submitterPhone, caption,
    });

    renderDone(name);
  } catch (err) {
    progEl.hidden = true;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send for review';
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

function renderDone(playerName) {
  renderBody(`
    <div class="media-done">
      <div class="media-done-ico" aria-hidden="true">✓</div>
      <div class="media-done-t">Sent for review</div>
      <div class="media-done-b">
        This is <b>not visible in the app yet</b>. A league admin reviews every
        submission — once it's approved, it appears on ${escape(playerName)}'s profile.
      </div>
    </div>
    <div class="media-actions"><button class="btn btn-primary" id="media-done-btn">Done</button></div>`);
  sheetEl.querySelector('#media-done-btn').addEventListener('click', closeSheet);
}

// ── Utils ────────────────────────────────────────────────────────────────────

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]?.toUpperCase() || '').join('');
}
