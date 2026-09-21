// media-page.js — the public per-player media page (media-gallery.html?id=NN).
//
// Public by design: the parent who submitted a clip has to be able to see it
// appear, and send the link to family. Everything here already passed admin
// approval.
//
// Shows NO ranking data — see PRODUCT_SPEC "Rankings are never stated
// publicly". Name, photo, grade, age; nothing evaluative.

import { fetchPlayers, buildDriveIndex, photoUrl, ageDisplay, COL } from './players-data.js';
import { loadPromotions } from './media-promotions.js';
import { renderGallery } from './media-gallery.js';
import { attachMediaSubmit } from './media-submit.js';

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
    <div class="media-page-id">
      ${photo
        ? `<img class="media-page-ava" id="media-page-ava" src="${photo}" alt="${escHtml(name)}" />`
        : `<div class="media-page-ava" id="media-page-ava">🏀</div>`}
      <div class="media-page-meta">
        <h2 class="media-page-name"><span class="pid">${escHtml(String(p[COL.ID]))}</span> ${escHtml(name)}</h2>
        <div class="media-page-sub">Grade ${escHtml(p[COL.GRADE] || '—')} · Age ${escHtml(ageDisplay(p[COL.AGE]))}</div>
        <button class="btn btn-primary media-page-add" id="media-page-add">＋ Add a photo or clip</button>
      </div>
    </div>`;

  // The header photo carries the same long-press/double-click trigger as
  // everywhere else, so the gesture is consistent — and the explicit button
  // below it gives the same action a visible affordance, which matters on a
  // page someone may have reached from a shared link with no idea the
  // gesture exists.
  const ava = document.getElementById('media-page-ava');
  const player = { id: p[COL.ID], name };
  if (ava) attachMediaSubmit(ava, player);
  document.getElementById('media-page-add')?.addEventListener('click', () => {
    // Synthesise the same entry point the gesture uses, rather than
    // duplicating openSubmitSheet's logic here.
    ava?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });

  await renderGallery(galEl, id, { playerName: name });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
