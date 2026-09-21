// media-admin.js — the admin review inbox for user-submitted media.
//
// Gated to TEAM_ADMINS. Three things happen here:
//   1. approve / reject / undo        — what goes live
//   2. promote / revert               — which item is the headshot or primary video
//   3. drag-reorder                   — what order the gallery shows
//
// ── WHERE THE CAP BITES ──────────────────────────────────────────────────────
// The 10-photo / 5-clip cap limits what is LIVE IN THE APP, not what parents
// can send. Submission is deliberately unbounded, so Approve is what gets
// disabled at the cap — never the submit sheet. See media-config.js.

import { getCurrentCoach } from './coach-login.js';
import { TEAM_ADMINS } from './coaches-config.js';
import {
  subscribeSubmissions, approveSubmission, rejectSubmission, unreviewSubmission,
  saveSortOrder, getApprovedMedia, promote, unpromote, getAllPromotions, isPromoted,
  subscribeMessages, markMessageHandled,
} from './media-data.js';
import { removalLabel } from './media-permissions.js';
import { fetchPlayers, buildDriveIndex, videoUrl as tryoutVideoUrl, COL } from './players-data.js';
import { refreshPromotions } from './media-promotions.js';
import {
  thumbUrl, fullUrl, videoUrl, videoPosterUrl,
  formatDuration, formatBytes, mediaConfigured,
  MAX_APPROVED_PHOTOS, MAX_APPROVED_VIDEOS,
} from './media-config.js';

let submissions = [];
let messages    = [];
let promotions  = {};
// Player id -> has a Drive tryout video. The tryout clip occupies one of the
// 6 clip slots (see media-config.js/media-data.js) even though it never
// appears in `submissions` — it lives in Drive, not Firestore. Without this,
// the cap check here would let an admin approve a 6th real clip on a player
// who effectively already has 6 (5 approved + the tryout video).
let tryoutById  = {};
let filter      = 'pending';
let unsubscribe = null;
let msgUnsub    = null;
let orderPlayerId = null;

// ── Gate ─────────────────────────────────────────────────────────────────────

function viewerIsAdmin() {
  const c = getCurrentCoach();
  return !!c && TEAM_ADMINS.includes(c.name);
}

function applyGate() {
  const gate = document.getElementById('media-gate');
  const main = document.getElementById('media-admin-main');
  const ok   = viewerIsAdmin();

  gate.classList.toggle('hidden', ok);
  main.classList.toggle('hidden', !ok);

  if (!ok) {
    document.getElementById('media-gate-msg').textContent = getCurrentCoach()
      ? 'This page is limited to league admins.'
      : 'Log in as a league admin to review submitted media.';
    // Stop listening while locked out — no reason to hold a live subscription
    // open for someone who can't see any of it.
    unsubscribe?.(); unsubscribe = null;
    msgUnsub?.(); msgUnsub = null;
    return;
  }
  if (!unsubscribe) start();
}

// ── Load ─────────────────────────────────────────────────────────────────────

async function start() {
  if (!mediaConfigured()) {
    document.getElementById('media-queue').innerHTML =
      `<div class="loading">Media uploads aren't configured yet — see
       <code>_local/MEDIA_SETUP_STAGE2.md</code>.</div>`;
    return;
  }
  promotions = await getAllPromotions();
  try {
    const [players] = await Promise.all([fetchPlayers(), buildDriveIndex()]);
    tryoutById = Object.fromEntries(players.map(p => [String(p[COL.ID]), !!tryoutVideoUrl(p)]));
  } catch (err) {
    // Never let this block the inbox from loading — worst case the cap check
    // undercounts by the tryout video, same as before this fix existed.
    console.warn('media: could not load tryout-video index', err);
  }
  unsubscribe = subscribeSubmissions(list => {
    submissions = list;
    renderCounts();
    renderQueue();
    if (orderPlayerId) renderOrderList(orderPlayerId);
  });
  msgUnsub = subscribeMessages(list => {
    messages = list;
    renderCounts();
    if (filter === 'messages') renderQueue();
  });

  // Deep link from the header badge: media-admin.html?tab=messages
  if (new URLSearchParams(location.search).get('tab') === 'messages') {
    const chip = document.querySelector('.media-filter[data-status="messages"]');
    chip?.click();
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderCounts() {
  const by = s => submissions.filter(x => x.status === s).length;
  document.getElementById('n-pending').textContent  = by('pending');
  document.getElementById('n-approved').textContent = by('approved');
  document.getElementById('n-rejected').textContent = by('rejected');

  const unread = messages.filter(m => m.status === 'unread').length;
  const msgEl = document.getElementById('n-messages');
  if (msgEl) msgEl.textContent = unread;

  if (filter === 'messages') {
    document.getElementById('media-adm-count').textContent =
      unread === 0 ? 'No unread messages' : `${unread} unread`;
    return;
  }
  const n = by(filter);
  document.getElementById('media-adm-count').textContent =
    filter === 'pending'
      ? (n === 0 ? 'Queue clear' : `${n} awaiting review`)
      : `${n} ${filter}`;
}

/**
 * How many approved photos/videos this player already has live.
 * Computed from the same subscription the queue renders from, so the cap
 * state updates the instant an approval lands — no refetch.
 */
function approvedCounts(playerId) {
  const mine = submissions.filter(s =>
    String(s.playerId) === String(playerId) && s.status === 'approved');
  return {
    photos: mine.filter(s => s.kind === 'photo').length
      + (headshotById[String(playerId)] ? 1 : 0),
    videos: mine.filter(s => s.kind === 'video').length
      + (tryoutById[String(playerId)] ? 1 : 0),
  };
}

function renderQueue() {
  const el = document.getElementById('media-queue');
  if (filter === 'messages') return renderMessages(el);
  const list = submissions.filter(s => s.status === filter);

  if (!list.length) {
    el.innerHTML = `<div class="loading">${
      filter === 'pending' ? 'Nothing waiting for review.' : `No ${filter} media.`}</div>`;
    return;
  }
  el.innerHTML = list.map(itemHTML).join('');
  wireQueue(el);
}

function itemHTML(s) {
  const isPhoto = s.kind === 'photo';
  const thumb = isPhoto ? thumbUrl(s.publicId) : videoPosterUrl(s.publicId);
  const counts = approvedCounts(s.playerId);
  const used = isPhoto ? counts.photos : counts.videos;
  const max  = isPhoto ? MAX_APPROVED_PHOTOS : MAX_APPROVED_VIDEOS;
  const atCap = s.status === 'pending' && used >= max;
  const promotedAs = isPromoted(promotions, s.playerId, s.id);

  const facts = [
    escHtml(s.submitterName || 'anonymous'),
    s.submitterPhone ? escHtml(s.submitterPhone) : 'no phone given',
    timeAgo(s.submittedAt),
    escHtml(s.format || ''),
    s.bytes ? formatBytes(s.bytes) : '',
    s.durationSec ? formatDuration(s.durationSec) : '',
  ].filter(Boolean).join(' · ');

  const pills = [`<span class="pill pill-${s.status}">${s.status}</span>`];
  if (promotedAs) {
    pills.push(`<span class="pill pill-promoted">${
      promotedAs === 'photo' ? 'Profile picture' : 'Primary video'}</span>`);
  }

  // Actions depend on state. Approve is the ONLY thing the cap disables.
  const acts = [];
  if (s.status === 'pending') {
    acts.push(atCap
      ? `<button class="btn btn-sm" disabled>✓ Approve</button>`
      : `<button class="btn btn-sm btn-ok" data-act="approve">✓ Approve</button>`);
    acts.push(`<button class="btn btn-sm btn-no" data-act="reject">✕ Reject</button>`);
  } else {
    acts.push(`<button class="btn btn-sm" data-act="undo">↩ Undo</button>`);
  }
  if (s.status === 'approved') {
    acts.push(promotedAs
      ? `<button class="btn btn-sm" data-act="unpromote" data-kind="${promotedAs}">Revert to original</button>`
      : `<button class="btn btn-sm btn-promote" data-act="promote" data-kind="${isPhoto ? 'photo' : 'video'}">★ Make ${isPhoto ? 'profile picture' : 'primary video'}</button>`);
    acts.push(`<button class="btn btn-sm" data-act="order">⇅ Order</button>`);
  }
  acts.push(`<a class="btn btn-sm" href="${isPhoto ? fullUrl(s.publicId) : videoUrl(s.publicId)}"
                download target="_blank" rel="noopener" title="Save this file to your device">⤓</a>`);

  const capNote = atCap
    ? `<p class="media-cap-block">All ${max} ${isPhoto ? 'photo' : 'clip'} slots are full for
       this player. Reject one that's live, or undo it from the Approved tab, to free a slot.</p>`
    : '';

  return `
    <article class="media-q-item" data-id="${escHtml(s.id)}"
             data-player="${escHtml(s.playerId)}" data-kind="${escHtml(s.kind)}">
      <div class="media-q-thumb" data-act="view">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : (isPhoto ? '🏀' : '🎬')}
        ${!isPhoto ? `<span class="media-q-dur">${s.durationSec ? formatDuration(s.durationSec) : '▶'}</span>` : ''}
      </div>
      <div class="media-q-body">
        <div class="media-q-top">
          <span class="media-q-player"><span class="pid">${escHtml(s.playerId)}</span> ${escHtml(s.playerName)}</span>
          ${pills.join('')}
        </div>
        <div class="media-q-meta">${facts}</div>
        ${s.caption ? `<div class="media-q-cap">"${escHtml(s.caption)}"</div>` : ''}
        ${s.adminNote ? `<div class="media-q-note"><b>Note to admin:</b> ${escHtml(s.adminNote)}</div>` : ''}
        ${s.status === 'rejected' ? `<div class="media-q-meta">${escHtml(removalLabel(s))}</div>` : ''}
        ${s.rejectReason ? `<div class="media-q-meta">Reason: ${escHtml(s.rejectReason)}</div>` : ''}
        <div class="media-q-acts">${acts.join('')}</div>
        ${capNote}
      </div>
    </article>`;
}

function wireQueue(root) {
  root.addEventListener('click', onQueueClick);
}

async function onQueueClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = btn.closest('.media-q-item');
  if (!item) return;

  const id  = item.dataset.id;
  const sub = submissions.find(s => s.id === id);
  if (!sub) return;
  const admin = getCurrentCoach()?.name || 'admin';
  const act = btn.dataset.act;

  // A download link is a real <a> — let the browser handle it.
  if (btn.tagName === 'A') return;

  try {
    switch (act) {
      case 'view':
        openLightbox(sub);
        return;
      case 'approve':
        await approveSubmission(id, admin);
        break;
      case 'reject': {
        const reason = prompt('Reason for rejecting? (optional — the file is kept either way)') ?? null;
        await rejectSubmission(id, admin, reason || null);
        break;
      }
      case 'undo':
        await unreviewSubmission(id);
        break;
      case 'promote':
        await promote(sub.playerId, btn.dataset.kind, sub, admin);
        promotions = await getAllPromotions();
        // The promotion map is cached for the session — without this the new
        // headshot wouldn't appear on other pages until the tab was closed.
        await refreshPromotions();
        renderQueue();
        break;
      case 'unpromote':
        await unpromote(sub.playerId, btn.dataset.kind);
        promotions = await getAllPromotions();
        await refreshPromotions();
        renderQueue();
        break;
      case 'order':
        orderPlayerId = sub.playerId;
        renderOrderList(sub.playerId);
        break;
    }
  } catch (err) {
    alert(`That didn't work: ${err.message}`);
  }
}


// -- Messages ---------------------------------------------------------------

function renderMessages(el) {
  if (!messages.length) {
    el.innerHTML = `<div class="loading">No messages yet.</div>`;
    return;
  }
  el.innerHTML = messages.map(m => `
    <article class="media-q-item media-msg-item${m.status === 'unread' ? ' is-unread' : ''}"
             data-msg="${escHtml(m.id)}">
      <div class="media-q-body">
        <div class="media-q-top">
          <span class="media-q-player">${m.playerName
            ? `<span class="pid">${escHtml(m.playerId)}</span> ${escHtml(m.playerName)}`
            : 'General'}</span>
          <span class="pill ${m.kind === 'removal' ? 'pill-rejected' : 'pill-pending'}">${
            m.kind === 'removal' ? 'Removal request' : 'Question'}</span>
          ${m.status === 'unread' ? '<span class="pill pill-promoted">Unread</span>' : ''}
        </div>
        <div class="media-q-meta">
          <b>${escHtml(m.fromName || 'anonymous')}</b>${
            m.fromContact ? ' \u00b7 ' + escHtml(m.fromContact) : ''} \u00b7 ${timeAgo(m.createdAt)}
        </div>
        <div class="media-q-cap">${escHtml(m.body)}</div>
        <div class="media-q-acts">
          <button class="btn btn-sm ${m.status === 'unread' ? 'btn-ok' : ''}"
                  data-msg-act="${m.status === 'unread' ? 'handled' : 'unread'}">
            ${m.status === 'unread' ? '\u2713 Mark handled' : '\u21a9 Mark unread'}
          </button>
          ${m.playerId ? `<a class="btn btn-sm" href="media-gallery.html?id=${encodeURIComponent(m.playerId)}"
                             target="_blank" rel="noopener">Open media page</a>` : ''}
        </div>
      </div>
    </article>`).join('');

  el.onclick = async e => {
    const btn = e.target.closest('[data-msg-act]');
    if (!btn) return;
    const id = btn.closest('[data-msg]')?.dataset.msg;
    if (!id) return;
    btn.disabled = true;
    try {
      await markMessageHandled(id, getCurrentCoach()?.name || 'admin',
                               btn.dataset.msgAct === 'handled');
    } catch (err) {
      alert(`That did not work: ${err.message}`);
      btn.disabled = false;
    }
  };
}

// -- Reorder ----------------------------------------------------------------

async function renderOrderList(playerId) {
  const section = document.getElementById('media-order-section');
  const list    = document.getElementById('media-order-list');
  const approved = await getApprovedMedia(playerId);

  const name = approved[0]?.playerName || submissions.find(s =>
    String(s.playerId) === String(playerId))?.playerName || '';
  document.getElementById('media-ord-title').innerHTML =
    `Order · <span style="color:var(--clr-accent)">${escHtml(playerId)}</span> ${escHtml(name)}`;

  section.classList.remove('hidden');
  if (!approved.length) {
    list.innerHTML = '<div class="loading">Nothing approved for this player yet.</div>';
    return;
  }

  list.innerHTML = approved.map((s, i) => {
    const isPhoto = s.kind === 'photo';
    const thumb = isPhoto ? thumbUrl(s.publicId) : videoPosterUrl(s.publicId);
    const promotedAs = isPromoted(promotions, s.playerId, s.id);
    return `
      <div class="media-ord-row" draggable="true" data-id="${escHtml(s.id)}">
        <span class="media-ord-grip" aria-hidden="true">⠿</span>
        <span class="media-ord-n">${i + 1}</span>
        <span class="media-ord-th">${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : (isPhoto ? '🏀' : '🎬')}</span>
        <span class="media-ord-name">${escHtml(s.caption || (isPhoto ? 'Photo' : 'Clip'))}
          <small>${escHtml(s.submitterName || 'anonymous')} · ${isPhoto ? 'photo' : 'clip'}${
            s.durationSec ? ' · ' + formatDuration(s.durationSec) : ''}</small></span>
        ${promotedAs ? `<span class="pill pill-promoted">${promotedAs === 'photo' ? 'Profile' : 'Primary'}</span>` : ''}
      </div>`;
  }).join('');

  wireDrag(list);
}

function wireDrag(list) {
  let dragged = null;
  list.addEventListener('dragstart', e => {
    dragged = e.target.closest('.media-ord-row');
    dragged?.classList.add('dragging');
  });
  list.addEventListener('dragend', async () => {
    dragged?.classList.remove('dragging');
    list.querySelectorAll('.drop-ok').forEach(r => r.classList.remove('drop-ok'));
    dragged = null;
    renumber(list);
    // Persist immediately: an admin who reorders and navigates away expects it
    // to have stuck. No save button to forget.
    try {
      await saveSortOrder([...list.querySelectorAll('.media-ord-row')].map(r => r.dataset.id));
    } catch (err) {
      alert(`Order not saved: ${err.message}`);
    }
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('.media-ord-row');
    if (!row || row === dragged || !dragged) return;
    list.querySelectorAll('.drop-ok').forEach(r => r.classList.remove('drop-ok'));
    row.classList.add('drop-ok');
    const rect = row.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > rect.top + rect.height / 2 ? row.nextSibling : row);
  });
}

function renumber(list) {
  [...list.querySelectorAll('.media-ord-row')].forEach((r, i) => {
    r.querySelector('.media-ord-n').textContent = i + 1;
  });
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

function openLightbox(s) {
  const box  = document.getElementById('media-lightbox');
  const body = document.getElementById('media-lightbox-body');
  body.innerHTML = s.kind === 'photo'
    ? `<img src="${fullUrl(s.publicId)}" alt="${escHtml(s.playerName)}" />`
    : `<video src="${videoUrl(s.publicId)}" controls autoplay playsinline></video>`;
  document.getElementById('media-lightbox-cap').textContent =
    `${s.playerId} ${s.playerName}${s.caption ? ' — ' + s.caption : ''}`;
  box.classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('media-lightbox').classList.add('hidden');
  // Stop playback — a video left running behind a closed overlay keeps audio going.
  document.getElementById('media-lightbox-body').innerHTML = '';
}

// ── CSV export ───────────────────────────────────────────────────────────────
// Metadata and direct links only — no media bytes. Deliberately not a zip:
// zipping means fetching every asset through the page, which is slow and
// memory-hungry, and worst on the phone where review actually happens. Bulk
// media movement belongs to _local/archive_media.py.

function exportCsv() {
  const rows = submissions.filter(s => s.status === filter);
  const cols = ['playerId', 'playerName', 'kind', 'status', 'submitterName',
                'submitterPhone', 'caption', 'durationSec', 'bytes', 'format',
                'publicId', 'url', 'reviewedBy', 'rejectReason'];
  const csv = [cols.join(',')].concat(rows.map(r =>
    cols.map(c => csvCell(r[c])).join(','))).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `media-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Utils ────────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ts) {
  if (!ts?.seconds) return 'just now';
  const mins = Math.floor((Date.now() / 1000 - ts.seconds) / 60);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  applyGate();

  document.querySelectorAll('.media-filter').forEach(chip => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.status;
      document.querySelectorAll('.media-filter').forEach(c =>
        c.setAttribute('aria-pressed', String(c === chip)));
      renderCounts();
      renderQueue();
    });
  });

  document.getElementById('btn-export-csv')?.addEventListener('click', exportCsv);
  document.getElementById('btn-close-order')?.addEventListener('click', () => {
    orderPlayerId = null;
    document.getElementById('media-order-section').classList.add('hidden');
  });

  document.getElementById('media-lightbox-close')?.addEventListener('click', closeLightbox);
  document.getElementById('media-lightbox')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
});

// Login/logout changes who can see this page.
document.addEventListener('coachChanged', applyGate);
