// media-page.js — the public per-player media page (media-gallery.html?id=NN).
//
// Public by design: the parent who submitted a clip has to be able to see it
// appear, and send the link to family. Everything here already passed admin
// approval.
//
// Shows NO ranking data — see PRODUCT_SPEC "Rankings are never stated
// publicly". Name, photo, grade, age; nothing evaluative.

import { fetchPlayers, buildDriveIndex, photoUrl, videoUrl, ageDisplay, COL }
  from './players-data.js';
import { loadPromotions } from './media-promotions.js';
import { renderGallery } from './media-gallery.js';
import { attachMediaSubmit, openMediaSheet } from './media-submit.js';
import { createMessage } from './media-data.js';

function playerIdFromUrl() {
  return new URLSearchParams(location.search).get('id') || '';
}

async function init() {
  const headEl = document.getElementById('media-page-head');
  const galEl  = document.getElementById('media-page-gallery');
  const id = playerIdFromUrl();

  if (!id) {
    headEl.innerHTML = `
      <div class="media-gal-empty">
        <div class="media-gal-empty-t">No player selected</div>
        <div class="media-gal-empty-b">
          Open this page from a player's picture — press and hold it anywhere in
          the app — or head back to the
          <a href="directory.html">Player Directory</a>.
        </div>
      </div>`;
    return;
  }

  headEl.innerHTML = `<div class="media-gal-loading">Loading…</div>`;

  let players;
  try {
    // loadPromotions() before the first render so a promoted headshot doesn't
    // flash the Drive original first (photoUrl reads the map synchronously).
    [players] = await Promise.all([fetchPlayers(), buildDriveIndex(), loadPromotions()]);
  } catch (err) {
    headEl.innerHTML = `
      <div class="media-gal-empty">
        <div class="media-gal-empty-t">Couldn't load the roster</div>
        <div class="media-gal-empty-b">${escHtml(err.message)}</div>
      </div>`;
    return;
  }

  const p = players.find(x => String(x[COL.ID]) === String(id));
  if (!p) {
    headEl.innerHTML = `
      <div class="media-gal-empty">
        <div class="media-gal-empty-t">Player not found</div>
        <div class="media-gal-empty-b">
          No player with ID ${escHtml(id)} this season.
          <a href="directory.html">Back to the directory</a>.
        </div>
      </div>`;
    return;
  }

  const name  = p[COL.NAME] || 'Unknown';
  const photo = photoUrl(p);
  document.title = `${name} — Player Media`;

  headEl.innerHTML = `
    <a class="media-page-back" href="directory.html">← Back to Player Directory</a>
    <div class="media-page-id">
      ${photo
        ? `<img class="media-page-ava" id="media-page-ava" src="${photo}" alt="${escHtml(name)}" />`
        : `<div class="media-page-ava" id="media-page-ava">🏀</div>`}
      <div class="media-page-meta">
        <h2 class="media-page-name"><span class="pid">${escHtml(String(p[COL.ID]))}</span> ${escHtml(name)}</h2>
        <div class="media-page-sub">Grade ${escHtml(p[COL.GRADE] || '—')} · Age ${escHtml(ageDisplay(p[COL.AGE]))}</div>
        <div class="media-page-actions">
          <button class="btn btn-primary" id="media-page-add">＋ Add a photo or clip</button>
          <button class="btn" id="media-page-share">🔗 Share</button>
          <button class="btn" id="media-page-contact">✉ Contact admin</button>
        </div>
        <div class="media-page-toast hidden" id="media-page-toast"></div>
      </div>
    </div>`;

  // The header photo carries the same long-press/double-click trigger as
  // everywhere else, so the gesture is consistent — and the explicit button
  // below it gives the same action a visible affordance, which matters on a
  // page someone may have reached from a shared link with no idea the
  // gesture exists.
  const ava = document.getElementById('media-page-ava');
  const player = { id: p[COL.ID], name };
  // Long-press on the header photo, same as everywhere else on touch.
  if (ava) attachMediaSubmit(ava, player);
  document.getElementById('media-page-add')
    ?.addEventListener('click', () => openMediaSheet(player));

  wireShare(name);
  wireContact(p, name);

  await renderGallery(galEl, id, {
    playerName: name,
    // The league's own tryout clip leads the gallery. It lives in Drive, not
    // Cloudinary, so it is pinned and never removable - see media-gallery.js.
    tryoutVideo: videoUrl(p),
    // Roster record, so the gallery can decide whether this viewer may remove
    // anything: admins always, a coach only for their own players.
    player: { ...p, name, _teamFB: p._teamFB || p[COL.TEAM] || '' },
  });
}

// -- Share ------------------------------------------------------------------

function wireShare(playerName) {
  document.getElementById('media-page-share')?.addEventListener('click', async () => {
    const url = location.href;
    const title = `${playerName} \u2014 CSBC media`;
    // Native share sheet where it exists (every phone) - that is what a parent
    // actually wants, since it reaches Messages and WhatsApp directly. Falls
    // back to copying the link on desktop.
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (err) {
      // A cancelled share is not an error worth reporting.
      if (err?.name === 'AbortError') return;
      // Clipboard can be blocked (insecure context, denied permission) - show
      // the URL so it can still be copied by hand rather than failing silently.
      window.prompt('Copy this link:', url);
    }
  });
}

function toast(msg) {
  const el = document.getElementById('media-page-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2200);
}

// -- Contact admin ----------------------------------------------------------

function wireContact(p, name) {
  document.getElementById('media-page-contact')?.addEventListener('click', () => {
    openContactModal(p, name);
  });
}

function openContactModal(p, name) {
  let el = document.getElementById('media-contact-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'media-contact-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-box">
        <h2>Contact the league admin</h2>
        <p class="media-contact-sub" id="media-contact-sub"></p>
        <label>What is this about?
          <select id="media-contact-kind">
            <option value="removal">Request removal of a photo or clip</option>
            <option value="question">Something else</option>
          </select>
        </label>
        <label>Your name
          <input id="media-contact-name" type="text" maxlength="60" placeholder="So we know who to reply to" />
        </label>
        <label>Email or phone <span class="media-optional">\u2014 optional</span>
          <input id="media-contact-from" type="text" maxlength="60" placeholder="How to reach you" />
        </label>
        <label>Message
          <textarea id="media-contact-body" maxlength="1000" rows="4"
                    placeholder="Which photo or clip, and what you would like done"></textarea>
        </label>
        <p id="media-contact-err" class="error-msg hidden"></p>
        <div class="modal-actions">
          <button id="media-contact-cancel" class="btn-secondary">Cancel</button>
          <button id="media-contact-send" class="btn-primary">Send</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.classList.add('hidden'); });
    el.querySelector('#media-contact-cancel')
      .addEventListener('click', () => el.classList.add('hidden'));
  }

  el.querySelector('#media-contact-sub').textContent = `About ${name} (#${p[COL.ID]}).`;
  el.querySelector('#media-contact-err').classList.add('hidden');
  el.classList.remove('hidden');

  const sendBtn = el.querySelector('#media-contact-send');
  sendBtn.onclick = async () => {
    const fromName = el.querySelector('#media-contact-name').value.trim();
    const body     = el.querySelector('#media-contact-body').value.trim();
    const errEl    = el.querySelector('#media-contact-err');

    if (!fromName || !body) {
      errEl.textContent = 'Please add your name and a message.';
      errEl.classList.remove('hidden');
      return;
    }
    sendBtn.disabled = true;
    try {
      await createMessage({
        playerId: p[COL.ID], playerName: name,
        kind: el.querySelector('#media-contact-kind').value,
        fromName,
        fromContact: el.querySelector('#media-contact-from').value.trim(),
        body,
      });
      el.classList.add('hidden');
      el.querySelector('#media-contact-body').value = '';
      toast('Message sent to the admin');
    } catch (err) {
      errEl.textContent = `Could not send: ${err.message}`;
      errEl.classList.remove('hidden');
    } finally {
      sendBtn.disabled = false;
    }
  };
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
