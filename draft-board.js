// draft-board.js — snake draft board + seed pool.
//
// Three scopes, one rule: state lives with whoever owns the decision it
// represents. See _local/DRAFT_BOARD_SPEC.md for the full model.
//
//   PRIVATE        each coach's sandbox board, their favorites, their seeds
//   SHARED         composite seed — derived from everyone's seeds, owned by nobody
//   AUTHORITATIVE  the real draft board, commissioner-owned, projected when live
//
// Live draft is a CHANNEL SWITCH, not a state mutation: it changes which
// board renders, it never destroys a coach's sandbox.
import { escHtml, COL, photoUrl, videoUrl } from './app.js';
import { fetchPlayers, buildDriveIndex, SEASON_CODE } from './players-data.js';
import { getCurrentCoach } from './coach-login.js';
import { contactFor } from './player-contacts.js';
import {
  getActiveCoaches, personByName, teamNameFor, TEAM_ADMINS, teamColorsFor,
} from './coaches-config.js';
import {
  subscribePlayer, saveRanking, deleteRanking, saveFavorites, getFavorites,
  subscribeDraftBoard, saveDraftBoard, saveDraftSlots,
  subscribeBoardRoster, saveBoardRoster,
  getSandbox, saveSandbox, commitDraftResults, decodeRanking,
} from './firebase.js';

const SPOTS = 8, MAX_COACHES = 15;

/**
 * Coaches created straight from the draft board (Add Coach -> New coach),
 * not through coaches-config.js -- board-only seats with no login, no PIN.
 * Declared up top since allKnownCoaches() below reads it on every render.
 */
const NEW_COACHES = new Map();   // personId -> { personId, name }

// ── State ────────────────────────────────────────────────────────────────────
let allPlayers = [];
const live = {};          // playerId -> latest Firestore doc (rankings/notes/team)
const unsubs = {};
let favorites = new Set();

let board = null;         // authoritative draftBoard doc, or null
let sandbox = null;       // this coach's private board
// Who holds a draft slot this season — SHARED, and deliberately not the same
// list as who can log in. null until the first snapshot; falls back to
// coaches-config.js when no override has been saved.
let boardRoster = null;
let isLive = false;
let coachRows = [];       // [{ personId, name }] — current board rows
let slots = {};           // '{personId}:{spot}' -> playerId

let view = 'names';
let photoMode = false, poolPhotos = false;
let focusKey = '', wantFocus = false;
let editing = false;
let saveTimer = null;
// Set while a drag that actually moved is finishing, so the click that
// follows a pointerup doesn't also open the player photo.
let suppressClick = false;

/**
 * 'composite' — read-only for everyone, always. Shows the group's average;
 *   no seed/modifier UI on a card, just the number.
 * 'personal'  — placement and editing driven by YOUR OWN seed. Editable
 *   whenever the coach otherwise could edit at all (see canEditSeeds()).
 */
let poolMode = 'personal';

const el = id => document.getElementById(id);

const byId = id => allPlayers.find(p => String(p[COL.ID]) === String(id));
const coach = () => getCurrentCoach();
const isAdmin = () => { const c = coach(); return !!c && TEAM_ADMINS.includes(c.name); };
const myPersonId = () => coach()?.personId || personByName(coach()?.name)?.id || null;

/**
 * Is this board column the logged-in coach's own?
 *
 * Compares by display name rather than id. A coach added directly on the board
 * gets a synthetic BOARD-* id that never matches their C### login id, so an id
 * comparison silently fails for exactly those four coaches (Ken, Kingston,
 * Micah, Paul) — which is how the contact number went missing for Micah.
 */
function isMyColumn(personId) {
  const me = coach();
  if (!me || !personId) return false;
  if (personId === myPersonId()) return true;
  const row = coachRows.find(c => c.personId === personId);
  return !!row && !!me.name && row.name === me.name;
}

/**
 * Sandbox = your own board. Live = the commissioner's, read-only unless
 * admin. Finished = the published result, read-only for everyone — it's the
 * season's record now, and a stray drag shouldn't be able to rewrite it.
 */
const canEdit = () => !!coach() && !draftFinished() && (!isLive || isAdmin());

// ── Seeds ────────────────────────────────────────────────────────────────────
const MOD_OFFSET = { Strong: 0.0, Reg: 0.2, Mid: 0.5, Low: 0.8 };
const MOD_CYCLE  = ['Reg', 'Strong', 'Low', 'Mid'];

/**
 * While a coach is actively cycling a card's modifier, the column must NOT
 * re-sort on every click — each save fires a live Firestore update that
 * would otherwise yank the card out from under the cursor mid-click, so
 * cycling to "Strong" meant chasing the tile around the screen.
 *
 * pinnedSort remembers each pinned player's position (by id) at the moment
 * the FIRST click in a burst happened; renderPool() reads it and holds that
 * ordering instead of the live composite/effSeed sort. A short idle timer
 * per player releases the pin once clicking stops, so the real sort catches
 * up a beat after the coach is actually done, not after every click.
 */
const pinnedSort = new Map();   // tier -> [ids in the order they were shown when pinned]
const pinTimers  = new Map();   // id -> { tier, timer } — the pin THIS click armed
const PIN_RELEASE_MS = 900;

function pinCard(id, tier) {
  if (!pinnedSort.has(tier)) {
    // Snapshot the CURRENT on-screen order for this tier so nothing else
    // jumps around either — only the sort key changes, the layout doesn't,
    // until the pin releases.
    const order = [...document.querySelectorAll(`.tier-col[data-tier="${tier}"] .p-card`)]
      .map(el => el.dataset.pid).filter(Boolean);
    pinnedSort.set(tier, order);
  }
  clearTimeout(pinTimers.get(id)?.timer);
  const timer = setTimeout(() => {
    pinTimers.delete(id);
    // Release this tier only once nothing still active in it is pinned —
    // another card in the same column may still be mid-click-streak.
    const stillActive = [...pinTimers.values()].some(v => v.tier === tier);
    if (!stillActive) pinnedSort.delete(tier);
    render();
  }, PIN_RELEASE_MS);
  pinTimers.set(id, { tier, timer });
}

function compositeOf(id) {
  const d = live[id];
  return d && d.composite != null ? d.composite : null;
}
/** The commissioner's own seed, used as a display override while live. */
function adminSeedOf(id) {
  const d = live[id];
  if (!d) return null;
  const admin = TEAM_ADMINS.find(n => d.rankings && d.rankings[n] != null);
  return admin ? Number(d.rankings[admin]) : null;
}
function mySeedOf(id) {
  const c = coach(); const d = live[id];
  if (!c || !d || !d.rankings) return null;
  const v = d.rankings[c.name];
  return v == null ? null : Number(v);
}
function myModOf(id) {
  const c = coach(); const d = live[id];
  if (!c || !d) return null;
  const { modifier } = decodeRanking(d.rankings?.[c.name] ?? null, d.modifiers, c.name);
  return modifier;
}
/**
 * Which seed places a card in the pool. Two independent axes:
 *
 *   poolMode  'composite' | 'personal' — what the coach is LOOKING at
 *   isLive    the commissioner's seed already overrode composite before
 *             this toggle existed; that rule only applies in composite mode
 *             now, since live-draft's whole point is projecting the GROUP's
 *             board, and personal mode is explicitly not that.
 *
 * This is the fix for the trap where dragging a disputed player to Strong-3
 * sprang back to composite's column before a coach could even set the
 * modifier: personal mode places by YOUR OWN seed, full stop, so it never
 * fights you for where your own opinion lives.
 */
function effSeed(id) {
  if (poolMode === 'personal') return mySeedOf(id);
  if (isLive) {
    const a = adminSeedOf(id);
    if (a != null) return a;
  }
  return compositeOf(id);
}
function tierOf(id) {
  const s = effSeed(id);
  return s == null ? null : Math.max(1, Math.min(SPOTS, Math.floor(s)));
}

const placedIds = () => new Set(Object.values(slots));

// ── Snake order ──────────────────────────────────────────────────────────────
function pickNumber(ci, si) {
  const n = coachRows.length;
  const within = si % 2 === 0 ? ci : (n - 1 - ci);
  return si * n + within + 1;
}
function nextPick() {
  const total = coachRows.length * SPOTS;
  for (let pick = 1; pick <= total; pick++) {
    for (let c = 0; c < coachRows.length; c++) {
      for (let s = 0; s < SPOTS; s++) {
        if (pickNumber(c, s) === pick && !slots[`${coachRows[c].personId}:${s}`]) {
          return { coachIdx: c, spotIdx: s, pick };
        }
      }
    }
  }
  return null;
}
const nextOpenKey = () => {
  const np = nextPick();
  return np ? `${coachRows[np.coachIdx].personId}:${np.spotIdx}` : '';
};

// ── Persistence ──────────────────────────────────────────────────────────────
/** Live writes hit the shared board; sandbox writes stay on the coach's doc. */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (isLive) {
        if (!isAdmin()) return;               // coaches can't write the live board
        await saveDraftSlots(slots, coach().name);
      } else {
        const pid = myPersonId();
        if (!pid) return;
        await saveSandbox(pid, {
          slots,
          coachOrder: coachRows.map(c => c.personId),
        });
      }
    } catch (err) {
      toast('Could not save', err.message);
    }
  }, 260);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [players] = await Promise.all([fetchPlayers(), buildDriveIndex()]);
    allPlayers = players.slice();
    allPlayers.sort((a, b) => {
      const na = parseFloat(a[COL.ID]), nb = parseFloat(b[COL.ID]);
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : 0;
    });

    const c = coach();
    if (c) {
      try { favorites = new Set(await getFavorites(c.name)); } catch { /* keep empty */ }
    }

    allPlayers.forEach(p => {
      const id = String(p[COL.ID]);
      unsubs[id] = subscribePlayer(id, data => { live[id] = data; scheduleRender(); });
    });

    // Wait for the board's first snapshot before deciding which mode to
    // render — otherwise boot races the subscription and can paint an empty
    // sandbox over a live draft that's already in progress.
    let firstSnapshot;
    const ready = new Promise(res => { firstSnapshot = res; });
    let settled = false;

    subscribeDraftBoard(async doc => {
      board = doc;
      const wasLive = isLive;
      isLive = !!doc?.live;
      if (!settled) { settled = true; firstSnapshot(); return; }
      if (isLive !== wasLive) await switchMode();
      else if (isLive || draftFinished()) { adoptBoard(); render(); }
      else render();
    });

    // Roster changes are shared — every open device re-renders on a change.
    let rosterFirst;
    const rosterReady = new Promise(res => { rosterFirst = res; });
    let rosterSettled = false;
    subscribeBoardRoster(data => {
      boardRoster = data?.personIds || null;
      // Board-only coaches (no login) resolve through this shared map on
      // every device, not just the one that created them.
      Object.entries(data?.names || {}).forEach(([id, name]) => {
        if (!NEW_COACHES.has(id)) NEW_COACHES.set(id, { personId: id, name });
      });
      if (!rosterSettled) { rosterSettled = true; rosterFirst(); return; }
      switchMode();
    });

    // Don't hang forever if Firestore is unreachable — fall back to sandbox.
    await Promise.race([
      Promise.all([ready, rosterReady]),
      new Promise(r => setTimeout(r, 4000)),
    ]);
    await switchMode();

    el('db-loading').classList.add('hidden');
    el('db-content').classList.remove('hidden');
    wireStatic();
    // Public view opens on Photos: a visitor is here to see who went where,
    // and faces read faster than a grid of names. Coaches keep Names, which
    // fits more on screen while working. setView() renders, so this runs
    // before the render() below rather than fighting it.
    setView(coach() ? 'names' : 'photos');
    render();

    document.addEventListener('coachChanged', async () => {
      const cc = coach();
      favorites = cc ? new Set(await getFavorites(cc.name).catch(() => [])) : new Set();
      // Logging out of Split would leave the view stuck on a button that's
      // no longer there to switch away from.
      if (!cc && view === 'split') setView('photos');
      await switchMode();
      render();
    });
  } catch (err) {
    el('db-loading').textContent = `Could not load the draft board: ${err.message}`;
    console.error(err);
  }
}

/**
 * Every coach identity this device knows about: the real login roster plus
 * any board-only coach created straight from this session (NEW_COACHES,
 * defined near addCoach()). Board-only coaches never appear in
 * getActiveCoaches() — they have no login — so anything resolving a
 * personId to a name must go through this, not the bare roster call.
 */
function allKnownCoaches() {
  return [...getActiveCoaches(SEASON_CODE), ...NEW_COACHES.values()];
}

/** Everyone who holds a draft slot this season, in board order. */
function seatedCoaches() {
  const all = allKnownCoaches();
  const ids = boardRoster || all.map(c => c.personId);
  return ids
    .map(id => all.find(r => r.personId === id))
    .filter(Boolean)
    .map(r => ({ personId: r.personId, name: r.name }));
}

/**
 * True once a draft has been run to completion and switched off. The board
 * then stops being a private sandbox and becomes the season's published
 * result: the same rows and picks for everyone, logged in or not.
 */
const draftFinished = () => !isLive && !!board?.endedAt && !!board?.slots
  && Object.keys(board.slots).length > 0;

/** Point `slots`/`coachRows` at whichever board this mode should render. */
async function switchMode() {
  if (isLive) { adoptBoard(); render(); return; }
  // A finished draft outranks the sandbox — nobody wants to reopen the app
  // after the draft and find their own pre-draft practice board where the
  // real results should be. adoptBoard() already renders the shared doc.
  if (draftFinished()) { adoptBoard(); render(); return; }
  const pid = myPersonId();
  sandbox = pid ? await getSandbox(pid) : null;

  // The roster is shared; only the ORDER is a per-coach preference. A coach
  // removed from the board stays removed for everyone — re-seating anyone
  // missing here is what made deletions bounce back.
  const seated = seatedCoaches();
  const pref = sandbox?.coachOrder || [];
  coachRows = [
    ...pref.map(id => seated.find(s => s.personId === id)).filter(Boolean),
    ...seated.filter(s => !pref.includes(s.personId)),
  ];
  slots = { ...(sandbox?.slots || {}) };
  render();
}

function adoptBoard() {
  const all = allKnownCoaches();
  const seated = seatedCoaches();
  const order = board?.coachOrder?.length ? board.coachOrder : seated.map(c => c.personId);
  coachRows = order
    .map(id => all.find(r => r.personId === id) || { personId: id, name: id })
    .map(r => ({ personId: r.personId, name: r.name }));
  slots = { ...(board?.slots || {}) };
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const c = coach();
  document.body.classList.toggle('is-live', isLive);
  document.body.classList.toggle('editing-coaches', editing);
  document.body.classList.toggle('draft-final', draftFinished());

  const done = draftFinished();

  // The pool, Split and the Unranked strip are all ranking tools, and the
  // draft is over — nobody is in the pool. Admin-only for the rest of the
  // season so the commissioner can still look; hidden (never removed) for
  // everyone else, so next season brings them straight back.
  const poolVisible = !!c && isAdmin();
  el('pool-panel').classList.toggle('hidden', !poolVisible);
  // Split exists to show the board and the pool together; with the pool
  // hidden it's just Photos with extra steps, so it goes too.
  el('view-split').classList.toggle('hidden', !poolVisible);
  el('unranked-shell').classList.toggle('hidden', !poolVisible);

  el('mode-chip').textContent = isLive ? 'LIVE DRAFT' : done ? 'FINAL' : 'Sandbox';
  el('mode-chip').classList.toggle('live', isLive);
  el('db-mode-note').textContent = isLive
    ? (isAdmin()
        ? 'You are running the live draft. Every coach sees this board.'
        : 'Live draft in progress — following the commissioner’s board.')
    : done
      ? 'Final draft results — Fall 2026.'
      : !c
        ? 'Log in as a coach to use the board.'
        : 'Sandbox — this board is yours alone. Nothing here affects anyone else.';

  el('live-btn').classList.toggle('hidden', !isAdmin());
  el('live-btn').setAttribute('aria-pressed', String(isLive));
  el('live-label').textContent = isLive ? 'Live Draft On' : 'Live Draft Off';
  el('edit-coaches').classList.toggle('hidden', !isAdmin() || isLive || done);
  el('add-coach').classList.toggle('hidden', !isAdmin() || isLive || done);
  el('coach-hint').textContent = isLive
    ? 'Coach list is locked while the draft is live'
    : done
      ? `${coachRows.length} teams · team number is the row number`
      : isAdmin()
        ? `${coachRows.length} of ${MAX_COACHES} coach slots used · drag a row to reorder`
        : (c ? 'Drag a row to reorder your own view' : '');

  el('pool-sub').textContent =
    'Seed placement based on average of all submitted coach rankings. ' +
    'Can be overridden by Commissioner during Live Draft';
  el('board-sub').textContent = isLive
    ? 'Highlighted cell is next in order — placement is never enforced'
    : '8 roster spots · snake order runs down each column';

  const np = nextPick();
  el('turn-banner').hidden = !isLive;
  if (isLive && np) {
    el('turn-name').textContent = coachRows[np.coachIdx].name;
    el('turn-pick').textContent = np.pick;
    el('turn-spot').textContent = np.spotIdx + 1;
    const key = `${coachRows[np.coachIdx].personId}:${np.spotIdx}`;
    if (key !== clockKey) { clockKey = key; resetClock(); }
    tickClock();
  } else if (!isLive) { clockKey = ''; }

  renderBoard(np);
  renderArrows();
  renderUnranked();
  renderPool();
  wantFocus = false;
}

function renderBoard(np) {
  const g = el('board-grid');
  g.innerHTML = '';
  g.appendChild(document.createElement('div'));       // corner
  for (let s = 0; s < SPOTS; s++) {
    const h = document.createElement('div');
    h.className = 'spot-head' + (isLive && np && np.spotIdx === s ? ' next-col' : '');
    h.textContent = s + 1;
    g.appendChild(h);
  }

  coachRows.forEach((c, ci) => {
    const cell = document.createElement('div');
    cell.className = 'coach-cell' + (isLive && np && np.coachIdx === ci ? ' on-clock' : '');
    cell.innerHTML =
      `<button class="grip" title="Drag to reorder" aria-label="Reorder ${escHtml(c.name)}">⣿</button>` +
      `<span class="seq">${ci + 1}</span>` +
      `<span class="cname">${escHtml(c.name)}</span>` +
      `<button class="rm" title="Remove ${escHtml(c.name)}" aria-label="Remove ${escHtml(c.name)}">✕</button>`;
    if (!isLive && !draftFinished() && coach()) {
      // The grip icon alone was too small a target to reliably grab —
      // the whole cell is now the drag handle, except the remove button
      // (which needs its own click, not a drag start).
      cell.addEventListener('pointerdown', e => {
        if (e.target.closest('.rm')) return;
        startCoachDrag(e, ci);
      });
    }
    cell.querySelector('.rm').addEventListener('click', () => removeCoach(ci));
    g.appendChild(cell);

    for (let s = 0; s < SPOTS; s++) {
      const key = `${c.personId}:${s}`;
      const pid = slots[key];
      const p = pid ? byId(pid) : null;
      const isNext = isLive && np && np.coachIdx === ci && np.spotIdx === s;
      const slot = document.createElement('div');
      slot.className = 'slot' + (pid ? ' filled' : '') + (isNext ? ' next-up' : '') +
        (photoMode ? ' photo' : '');
      slot.dataset.key = key;
      slot.tabIndex = 0;

      if (pid) {
        // Photo view has the vertical room for a full name and is what the
        // public sees; Names view packs 8 columns across, so it stays on the
        // first name to fit.
        const fullName = p ? p[COL.NAME] : '?';
        const firstName = p ? p[COL.NAME].split(' ')[0] : '?';
        slot.innerHTML = photoMode
          ? avatarHTML(p, 'slot-ava-tall') +
            `<span class="tall-meta"><span class="pid">${escHtml(pid)}</span>` +
            `<span class="pname">${escHtml(fullName)}</span></span>` +
            `<span class="picknum">${pickNumber(ci, s)}</span>`
          : `<span class="pid">${escHtml(pid)}</span>` +
            `<span class="pname">${escHtml(firstName)}</span>` +
            `<span class="picknum">${pickNumber(ci, s)}</span>`;
        slot.title = canEdit()
          ? `${p ? p[COL.NAME] : pid} — click for photo, double-click to send back to the pool`
          : `${p ? p[COL.NAME] : pid} — click for photo`;
        if (canEdit()) {
          slot.addEventListener('dblclick', () => returnToPool(key, pid));
          slot.addEventListener('pointerdown', e => startCardDrag(e, pid, slot, key));
        }
        // Click opens the photo. suppressClick is set by a drag that actually
        // moved, so releasing a drag over the original tile doesn't also pop
        // the lightbox open.
        slot.addEventListener('click', () => {
          if (suppressClick) return;
          openPlayerPhoto(c.personId, s);
        });
      } else if (canEdit()) {
        slot.innerHTML =
          `<input class="slot-input" inputmode="numeric" autocomplete="off" maxlength="3"
                  aria-label="Player ID for ${escHtml(c.name)}, spot ${s + 1}">` +
          `<span class="picknum">${pickNumber(ci, s)}</span>`;
        const inp = slot.querySelector('.slot-input');
        if (key === focusKey && wantFocus) {
          queueMicrotask(() => { inp.focus({ preventScroll: true }); inp.select(); });
        }
        inp.addEventListener('input', () => tryInlineAssign(key, inp));
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); tryInlineAssign(key, inp, true); }
          if (e.key === 'Escape') { inp.value = ''; inp.blur(); }
        });
        inp.addEventListener('focus', () => { focusKey = key; });
      } else {
        slot.innerHTML = `<span class="picknum">${pickNumber(ci, s)}</span>`;
      }
      g.appendChild(slot);
    }
  });
}

function renderArrows() {
  const grid = el('board-grid');
  const heads = [...grid.querySelectorAll('.spot-head')];
  if (!heads.length) return;
  const gRect = grid.getBoundingClientRect();
  const xs = heads.map(h => {
    const r = h.getBoundingClientRect();
    return r.left - gRect.left + r.width / 2;
  });
  const draw = (host, pairs, dir) => {
    let d = '';
    pairs.forEach(([a, b]) => {
      const y = dir === 'top' ? 14 : 2, yMid = dir === 'top' ? 2 : 14;
      d += `M${xs[a]} ${y} L${xs[a]} ${yMid} L${xs[b]} ${yMid} L${xs[b]} ${y} `;
    });
    host.innerHTML = `<svg viewBox="0 0 ${gRect.width} 16" preserveAspectRatio="none" aria-hidden="true">` +
      `<path d="${d}" fill="none" stroke="var(--snake-rail, #1c5a80)" stroke-width="3"/></svg>`;
  };
  const top = [], bot = [];
  for (let s = 0; s + 1 < SPOTS; s++) (s % 2 === 0 ? bot : top).push([s, s + 1]);
  draw(el('arrows-top'), top, 'top');
  draw(el('arrows-bot'), bot, 'bot');
}

function renderUnranked() {
  const track = el('unranked-track');
  const shell = el('unranked-shell');
  track.innerHTML = '';
  // Logged out, there's no "your ranking" for an unranked player to be
  // missing from — the strip is a ranking tool, so it isn't shown at all.
  if (!coach()) { shell.classList.add('hidden'); return; }
  const placed = placedIds();
  const list = allPlayers.filter(p => {
    const id = String(p[COL.ID]);
    return tierOf(id) == null && !placed.has(id);
  });
  shell.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  el('unranked-count').textContent = `${list.length} player${list.length === 1 ? '' : 's'}`;

  list.forEach(p => {
    const id = String(p[COL.ID]);
    const c = document.createElement('div');
    c.className = 'u-card' + (poolPhotos ? ' photo' : '');
    c.tabIndex = 0;
    c.innerHTML = (poolPhotos ? avatarHTML(p, 'u-ava') : '') +
      `<span class="uid">${escHtml(id)}</span>` +
      `<span class="uname">${escHtml(p[COL.NAME])}</span>`;
    c.title = `${p[COL.NAME]} — drag into a seed column to rank`;
    if (canEditSeeds()) c.addEventListener('pointerdown', e => startCardDrag(e, id, c));
    track.appendChild(c);
  });
}

/** Seeds freeze for everyone but the commissioner once the draft is live. */
// Composite mode is read-only for everyone, always -- it's a view of the
// group's number, not anyone's personal input. Personal mode follows the
// existing live-draft freeze (only the commissioner edits while live).
const canEditSeeds = () => poolMode === 'personal' && !!coach() && (!isLive || isAdmin());

function renderPool() {
  el('pool-sub').textContent = poolMode === 'composite'
    ? 'Composite — read-only group ranking'
    : 'Personal — your own seed, editable';

  const entry = el('pool-entry');
  entry.innerHTML = '';
  for (let t = 1; t <= SPOTS; t++) {
    const i = document.createElement('input');
    i.id = `tier-entry-${t}`;
    i.placeholder = '#';
    i.maxLength = 3;
    i.inputMode = 'numeric';
    i.setAttribute('aria-label', `Add player ID to seed ${t}`);
    i.disabled = !canEditSeeds();
    i.addEventListener('input', () => trySeedEntry(t, i));
    i.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); trySeedEntry(t, i, true); }
      if (e.key === 'Escape') { i.value = ''; i.blur(); }
    });
    entry.appendChild(i);
  }

  const head = el('pool-head');
  head.innerHTML = '';
  for (let t = 1; t <= SPOTS; t++) {
    const h = document.createElement('div');
    h.className = 'tier-head';
    h.textContent = t;
    head.appendChild(h);
  }

  const grid = el('pool-grid');
  grid.innerHTML = '';
  const placed = placedIds();
  for (let t = 1; t <= SPOTS; t++) {
    const col = document.createElement('div');
    col.className = 'tier-col';
    col.dataset.tier = t;
    const inTier = allPlayers.filter(p => tierOf(String(p[COL.ID])) === t);

    const pinned = pinnedSort.get(t);
    if (pinned) {
      // Hold the on-screen order from the moment this tier was pinned. A
      // card whose seed just moved it INTO this tier (from another one,
      // mid-pin) wasn't part of that snapshot — append those at the end
      // rather than dropping them.
      const byId2 = new Map(inTier.map(p => [String(p[COL.ID]), p]));
      const ordered = pinned.map(id => byId2.get(id)).filter(Boolean);
      const seen = new Set(pinned);
      inTier.filter(p => !seen.has(String(p[COL.ID]))).forEach(p => ordered.push(p));
      ordered.forEach(p => col.appendChild(poolCard(p, placed)));
    } else {
      inTier
        .sort((a, b) => {
          const ai = String(a[COL.ID]), bi = String(b[COL.ID]);
          const ad = placed.has(ai), bd = placed.has(bi);
          if (ad !== bd) return ad ? 1 : -1;
          if (ad && bd) return ai.localeCompare(bi);
          return (effSeed(ai) ?? 9) - (effSeed(bi) ?? 9);
        })
        .forEach(p => col.appendChild(poolCard(p, placed)));
    }
    grid.appendChild(col);
  }

  // #pool-entry's height just changed (it was rebuilt above) — #pool-head's
  // sticky offset needs to track it or the two rows overlap.
  updateStickyOffset();
}

function poolCard(p, placed) {
  const id = String(p[COL.ID]);
  const drafted = placed.has(id);
  const fav = favorites.has(id);
  const mine = mySeedOf(id);
  const comp = compositeOf(id);
  const mod = myModOf(id) || 'Reg';

  const card = document.createElement('div');
  card.className = 'p-card' + (drafted ? ' is-drafted' : '') + (poolPhotos ? ' photo' : '') +
    (fav ? ' is-fav' : '') + (isLive && adminSeedOf(id) != null ? ' admin-override' : '');
  card.dataset.pid = id;   // read by pinCard() to snapshot on-screen order
  card.tabIndex = 0;
  // Composite mode is a read of the group's number, full stop — no personal
  // seed row, no modifier chip to click. Personal mode is the only place a
  // coach's own vote is visible or touchable in the pool.
  const metaHtml = drafted
    ? `<div class="pmeta"><span class="drafted-tag">DRAFTED</span></div>`
    : poolMode === 'composite'
      ? `<div class="pmeta pmeta-composite"><span class="comp-only-val">${comp != null ? comp.toFixed(1) : '—'}</span></div>`
      : `<div class="rank-head"><span>Your Rank</span><span>Composite</span></div>` +
        `<div class="rank-vals">` +
          `<span class="mine-val">${mine != null ? mine.toFixed(1) : '—'}` +
            `<button class="mod" data-mod-btn="${mod}">${mod}</button></span>` +
          `<span class="comp-val">${comp != null ? comp.toFixed(1) : '—'}</span>` +
        `</div>`;

  card.innerHTML =
    (poolPhotos ? avatarHTML(p, 'card-ava-tall') : '') +
    `<button class="fav-btn" data-fav aria-pressed="${fav}"
             aria-label="${fav ? 'Unfavorite' : 'Favorite'} ${escHtml(p[COL.NAME])}">♥</button>` +
    `<div class="prow"><span class="pid">${escHtml(id)}</span>` +
    `<span class="pname">${escHtml(p[COL.NAME])}</span></div>` +
    metaHtml;

  // Hearts survive live mode AND composite mode — it's the one private
  // action that's never gated by what view you're looking at.
  const favBtn = card.querySelector('[data-fav]');
  favBtn.addEventListener('pointerdown', e => e.stopPropagation());
  favBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!coach()) return toast('Log in to save favorites');
    favorites.has(id) ? favorites.delete(id) : favorites.add(id);
    render();
    try { await saveFavorites(coach().name, [...favorites]); } catch { /* silent */ }
  });

  const modBtn = card.querySelector('[data-mod-btn]');
  if (modBtn) {
    modBtn.disabled = !canEditSeeds() || mine == null;
    modBtn.title = canEditSeeds() ? 'Click to cycle Reg → Strong → Low → Mid' : '';
    modBtn.addEventListener('pointerdown', e => e.stopPropagation());
    modBtn.addEventListener('click', e => { e.stopPropagation(); cycleMod(id); });
  }
  if (!drafted && canEditSeeds()) {
    card.addEventListener('pointerdown', e => startCardDrag(e, id, card));
  }
  return card;
}

const AVA_HUES = [210, 262, 154, 24, 340, 190, 45, 288];
function avatarHTML(p, cls) {
  if (!p) return `<span class="${cls}" style="background:var(--line)"></span>`;
  const url = photoUrl(p);
  if (url) return `<img class="${cls}" src="${url}" alt="" loading="lazy" />`;
  const initials = p[COL.NAME].split(' ').map(w => w[0]).slice(0, 2).join('');
  const hue = AVA_HUES[(+String(p[COL.ID]).replace(/\D/g, '') || 0) % AVA_HUES.length];
  return `<span class="${cls}" style="background:hsl(${hue} 42% 38%)">${escHtml(initials)}</span>`;
}

// ── Player photo lightbox ────────────────────────────────────────────────────
// The board's avatars are small. Clicking a drafted tile opens the same
// photo at full size, with the rest of that coach's roster one arrow-key or
// swipe away — walking seed order (spot 1..8), wrapping at the ends.

/** Drive thumbnails are sized by query param; ask for a big one. */
function bigPhotoUrl(p) {
  const url = photoUrl(p);
  return url ? url.replace(/sz=w\d+/, 'sz=w1200') : null;
}

// The roster currently open in the lightbox: [{ playerId, spotIdx }, ...] in
// seed order, plus where in it we are. null when the lightbox is closed.
let lbRoster = null;
let lbIndex = -1;

function openPlayerPhoto(personId, spotIdx) {
  const roster = [];
  for (let s = 0; s < SPOTS; s++) {
    const pid = slots[`${personId}:${s}`];
    if (pid) roster.push({ playerId: pid, spotIdx: s });
  }
  const idx = roster.findIndex(r => r.spotIdx === spotIdx);
  lbRoster = roster;
  lbIndex = idx === -1 ? 0 : idx;
  showLightboxSlide(personId);
}

/** Re-render the lightbox for whatever lbIndex now points at. */
function showLightboxSlide(personId) {
  if (!lbRoster || !lbRoster.length) return;
  const { playerId } = lbRoster[lbIndex];
  const p = byId(playerId);

  // A video playing for the PREVIOUS player must not carry over onto this
  // one — always land back on the photo when the slide changes, whether
  // that's an arrow/swipe step or the lightbox just opening.
  stopLightboxVideo();

  const img = el('db-lightbox-img');
  const url = p ? bigPhotoUrl(p) : null;
  if (url) {
    img.src = url;
    img.alt = p[COL.NAME];
    img.classList.remove('no-photo');
  } else {
    img.src = '';
    img.alt = '';
    img.classList.add('no-photo');   // CSS shows a placeholder instead of a broken image
  }

  const video = p ? videoUrl(p) : null;
  const videoBtn = el('db-lightbox-video-btn');
  videoBtn.classList.toggle('hidden', !video);
  videoBtn.dataset.videoUrl = video || '';

  const rowCoach = coachRows.find(c => c.personId === personId);
  const coachName = rowCoach?.name || '';

  el('db-lightbox-name').textContent = p ? p[COL.NAME] : `#${playerId}`;
  // Team color, from THIS season's own map (teamColorsFor(SEASON_CODE)) —
  // never the flat TEAM_COLORS export, which resolves to SCHEDULE_SEASON
  // (26.2) and would show Sedat/Humberto their now-wrong Summer colors on
  // the Fall board. Colors are assigned late (~1-2 days before the first
  // game), so this season's map is {} until then and the color line stays
  // suppressed rather than show nothing useful; "Team {Name}" alone would
  // just repeat the caption's own name, so that part stays as coachName.
  const teamName = rowCoach ? teamNameFor(rowCoach.personId) || coachName : coachName;
  const colorInfo = teamColorsFor(SEASON_CODE)[teamName];
  el('db-lightbox-sub').textContent = colorInfo ? `${coachName} — ${colorInfo.name}` : coachName;

  // Parent phone, but only on the viewing coach's OWN column. Contact details
  // for minors, so the gate stays narrow.
  //
  // Matching on personId alone is NOT enough: four coaches were created
  // straight from the board and hold synthetic BOARD-* ids, while their login
  // accounts are C022-C025 (see coaches-config.js). Their board id and their
  // person id are deliberately different, so the column is matched by NAME —
  // the one identity both halves share.
  const phoneEl = el('db-lightbox-phone');
  const phone = isMyColumn(personId) ? contactFor(SEASON_CODE, playerId) : '';
  if (phone) {
    phoneEl.innerHTML =
      `<a href="tel:${escHtml(phone.replace(/[^0-9]/g, ''))}" title="Call ${escHtml(phone)}">` +
      `${escHtml(phone)}</a>`;
    phoneEl.classList.remove('hidden');
  } else {
    phoneEl.textContent = '';
    phoneEl.classList.add('hidden');
  }

  // Nothing to step to with just one pick — hide the arrows rather than
  // show a control that would only ever land back on the same player.
  const canStep = lbRoster.length > 1;
  el('db-lightbox-prev').classList.toggle('hidden', !canStep);
  el('db-lightbox-next').classList.toggle('hidden', !canStep);

  el('db-lightbox').classList.remove('hidden');
  el('db-lightbox').dataset.personId = personId;
}

/** Swap the photo for an inline video player, in the same frame. */
function playLightboxVideo() {
  const url = el('db-lightbox-video-btn').dataset.videoUrl;
  if (!url) return;
  const media = el('db-lightbox-media');
  media.innerHTML = `<iframe class="db-lightbox-video" src="${url}" allowfullscreen allow="autoplay"></iframe>`;
}

/** The video button lives inside the swipeable frame — without this, a tap
 *  on it would also register as the start of a swipe drag. */
function wireLightboxVideoBtn() {
  const btn = el('db-lightbox-video-btn');
  btn.addEventListener('pointerdown', e => e.stopPropagation());
  btn.addEventListener('click', e => { e.stopPropagation(); playLightboxVideo(); });
}

/** Back to the photo — same media box, whatever was in it before. */
function stopLightboxVideo() {
  const media = el('db-lightbox-media');
  if (!media || !media.querySelector('iframe')) return;
  media.innerHTML =
    `<img id="db-lightbox-img" src="" alt="" />` +
    `<button id="db-lightbox-video-btn" class="card-video-badge db-lightbox-video-btn hidden"
             title="Watch tryout video">▶</button>`;
  wireLightboxVideoBtn();
}

function lightboxStep(dir) {
  if (!lbRoster || lbRoster.length < 2) return;
  lbIndex = (lbIndex + dir + lbRoster.length) % lbRoster.length;
  showLightboxSlide(el('db-lightbox').dataset.personId);
}

function closePlayerPhoto() {
  el('db-lightbox').classList.add('hidden');
  stopLightboxVideo();   // torn down before the image lookup below, so it's back
  el('db-lightbox-img').src = '';   // stop the download if it's still in flight
  lbRoster = null;
  lbIndex = -1;
}

/**
 * Swipe left/right on the lightbox to step through the roster, same as the
 * arrow keys. The frame follows the finger while dragging, then either
 * completes the step (past a distance threshold or a fast flick) or springs
 * back — Pointer Events, matching the drag handling used elsewhere on this
 * board rather than native HTML5 DnD, which doesn't track touch reliably.
 */
function wireLightboxSwipe() {
  const frame = el('db-lightbox-frame');
  let startX = 0, startT = 0, dx = 0, dragging = false;

  frame.addEventListener('pointerdown', e => {
    if (!lbRoster || lbRoster.length < 2) return;
    // A playing video's iframe swallows pointer capture, so a drag started
    // over it would end up stuck mid-swipe. The badge is still clickable —
    // stopLightboxVideo() already returns to the photo on any real step, so
    // this doesn't block getting to the next player, just from a video frame.
    if (el('db-lightbox-media').querySelector('iframe')) return;
    dragging = true;
    startX = e.clientX;
    startT = Date.now();
    frame.classList.remove('sliding');
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    frame.style.transform = `translateX(${dx}px)`;
  });
  function release(e) {
    if (!dragging) return;
    dragging = false;
    const elapsed = Date.now() - startT;
    const fast = elapsed < 300 && Math.abs(dx) > 40;
    const far = Math.abs(dx) > frame.getBoundingClientRect().width * 0.22;
    frame.classList.add('sliding');
    if (dx < 0 && (fast || far)) {
      // Slide fully off to the left, then swap the image and recenter —
      // matches "swipe left brings in the next player."
      frame.style.transform = 'translateX(-40px)';
      frame.style.opacity = '0';
      setTimeout(() => { lightboxStep(1); frame.style.transform = ''; frame.style.opacity = '1'; }, 140);
    } else if (dx > 0 && (fast || far)) {
      frame.style.transform = 'translateX(40px)';
      frame.style.opacity = '0';
      setTimeout(() => { lightboxStep(-1); frame.style.transform = ''; frame.style.opacity = '1'; }, 140);
    } else {
      frame.style.transform = '';   // not far/fast enough — spring back
    }
    dx = 0;
  }
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);
}

// ── Seeding ──────────────────────────────────────────────────────────────────
async function setSeed(id, tier, mod, announce = true) {
  const c = coach();
  if (!c || !canEditSeeds()) return;
  const m = mod || myModOf(id) || 'Reg';
  try {
    await saveRanking(id, c.name, tier, m === 'Reg' ? null : m);
    if (announce) {
      const name = byId(id)?.[COL.NAME] || `#${id}`;
      toast(`Saved: ${name} → ${tier}${m !== 'Reg' ? ' ' + m : ''}`, 'Your ranking is updated');
    }
  } catch (err) {
    toast('Could not save that seed', err.message);
  }
}

async function cycleMod(id) {
  const seed = mySeedOf(id);
  if (seed == null) return;
  const tier = Math.floor(seed);

  // Pin the column BEFORE saving — the live update from this write must
  // not re-sort the card out from under a coach mid-click-streak.
  pinCard(id, tier);

  const cur = MOD_CYCLE.indexOf(myModOf(id) || 'Reg');
  const next = MOD_CYCLE[(cur + 1) % MOD_CYCLE.length];
  const before = tierOf(id);
  await setSeed(id, tier, next, false);
  const after = tierOf(id);
  if (after !== before && after != null) {
    // A real column change is worth breaking the pin early for — the coach
    // needs to see it land in its new home, not held in the old one.
    pinnedSort.delete(tier);
    clearTimeout(pinTimers.get(id)?.timer);
    pinTimers.delete(id);
    toast(`${byId(id)?.[COL.NAME]} moved to column ${after}`, next);
  } else {
    toast(`Saved: ${byId(id)?.[COL.NAME] || id} → ${tier} ${next}`, 'Your ranking is updated');
  }
}

const idWidth = () => allPlayers.length > 99 ? 3 : 2;

async function trySeedEntry(tier, inp, forced = false) {
  if (!canEditSeeds()) return;
  const raw = inp.value.replace(/\D/g, '');
  inp.value = raw;
  if (!forced && raw.length < idWidth()) return;
  if (!raw.length) return;

  const id = raw.padStart(2, '0');
  const p = byId(id);
  if (!p) { flagInput(inp, `No ${raw}`); toast(`No player with ID ${raw}`); return; }

  const wasUnranked = tierOf(id) == null;
  inp.value = '';
  await setSeed(id, tier);
  const landed = tierOf(id);
  if (landed != null && landed !== tier) {
    toast(`${p[COL.NAME]} seeded ${tier}`, `Composite puts them in column ${landed}`);
  } else {
    toast(`${p[COL.NAME]} → seed ${tier}`, wasUnranked ? 'Moved out of Unranked' : '');
  }
}

// ── Board assignment ─────────────────────────────────────────────────────────
function tryInlineAssign(key, inp, forced = false) {
  if (!canEdit()) return;
  const raw = inp.value.replace(/\D/g, '');
  inp.value = raw;
  if (!forced && raw.length < idWidth()) return;
  if (!raw.length) return;

  const id = raw.padStart(2, '0');
  const p = byId(id);
  if (!p) { flagInput(inp, `No player ${raw}`); return; }

  const taken = Object.entries(slots).find(([, v]) => v === id);
  if (taken) {
    const [ck, cs] = taken[0].split(':');
    const c = coachRows.find(x => x.personId === ck);
    flagInput(inp, 'Already drafted');
    toast(`${p[COL.NAME]} is already drafted`, `${c ? c.name : ck} · spot ${+cs + 1}`);
    return;
  }
  if (tierOf(id) == null) {
    flagInput(inp, 'Not seeded');
    toast(`${p[COL.NAME]} has no seed yet`, 'Rank them in the pool before drafting');
    return;
  }

  slots[key] = id;
  focusKey = nextOpenKey();
  wantFocus = true;
  persist();
  render();
}

function flagInput(inp, msg) {
  inp.classList.add('bad');
  inp.value = '';
  inp.placeholder = msg;
  setTimeout(() => { inp.classList.remove('bad'); inp.placeholder = ''; }, 1400);
}

function returnToPool(key, pid) {
  if (!canEdit()) return;
  const p = byId(pid);
  delete slots[key];
  focusKey = key;
  persist();
  render();
  toast(`${p ? p[COL.NAME] : pid} returned to the pool`, 'Slot is open again');
}

// ── Drag ─────────────────────────────────────────────────────────────────────
function startCardDrag(e, playerId, node, srcKey = null) {
  if (e.target.closest('.slot-input, [data-mod-btn], [data-fav]')) return;
  if (srcKey ? !canEdit() : !canEditSeeds()) return;
  e.preventDefault();
  node.classList.add('dragging');
  const ghost = node.cloneNode(true);
  Object.assign(ghost.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 99, opacity: '.92',
    width: node.getBoundingClientRect().width + 'px',
    left: e.clientX - 40 + 'px', top: e.clientY - 18 + 'px',
  });
  document.body.appendChild(ghost);

  let target = null;
  // A press that never moves is a click (open the photo), not a drag.
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const clearHi = () => document.querySelectorAll('.drop-ok').forEach(n => n.classList.remove('drop-ok'));

  function move(ev) {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
    ghost.style.left = ev.clientX - 40 + 'px';
    ghost.style.top = ev.clientY - 18 + 'px';
    clearHi();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    target = under?.closest('.tier-col, .slot:not(.filled)') || null;
    if (target) target.classList.add('drop-ok');
  }
  async function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    ghost.remove();
    node.classList.remove('dragging');
    clearHi();
    if (moved) {
      // Cleared on the next tick — after the click event this pointerup
      // generates has already been dispatched and ignored.
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (!target) return;

    const p = byId(playerId);
    if (target.classList.contains('tier-col')) {
      if (!canEditSeeds()) return;
      const tier = +target.dataset.tier;
      const wasUnranked = tierOf(playerId) == null;
      await setSeed(playerId, tier);
      const landed = tierOf(playerId);
      if (wasUnranked && landed != null && landed !== tier) {
        toast(`${p[COL.NAME]} seeded ${tier}`, `Composite puts them in column ${landed}`);
      }
    } else if (target.classList.contains('slot')) {
      if (!canEdit()) return;
      const destKey = target.dataset.key;
      if (destKey === srcKey) return;
      if (tierOf(playerId) == null) {
        toast(`${p[COL.NAME]} has no seed yet`, 'Rank them in the pool before drafting');
        return;
      }
      if (srcKey) delete slots[srcKey];
      slots[destKey] = playerId;
      persist();
      render();
      if (srcKey) {
        const [ck, cs] = destKey.split(':');
        const c = coachRows.find(x => x.personId === ck);
        toast(`${p[COL.NAME]} moved`, `${c ? c.name : ck} · spot ${+cs + 1}`);
      }
    }
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function startCoachDrag(e, idx) {
  if (isLive || !coach()) return;
  e.preventDefault();
  const cells = [...el('board-grid').querySelectorAll('.coach-cell')];
  const h = cells[0].getBoundingClientRect().height + 4;
  const startY = e.clientY;
  let cur = idx;
  cells[idx].classList.add('dragging');

  function move(ev) {
    const steps = Math.round((ev.clientY - startY) / h);
    const t = Math.max(0, Math.min(coachRows.length - 1, idx + steps));
    if (t !== cur) {
      const [m] = coachRows.splice(cur, 1);
      coachRows.splice(t, 0, m);
      cur = t;
      render();
      const n = [...el('board-grid').querySelectorAll('.coach-cell')][cur];
      if (n) n.classList.add('dragging');
    }
  }
  function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    persist();
    render();
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ── Clock ────────────────────────────────────────────────────────────────────
// Derived from the board's pickStartedAt so every screen agrees within a
// fraction of a second, with no clock syncing.
const CHIME_AT = [60, 120];
let clockKey = '', chimed = new Set(), muted = false;

const fmtClock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const pickStart = () => board?.pickStartedAt || Date.now();

function resetClock() {
  chimed = new Set();
  if (isLive && isAdmin()) saveDraftBoard({ pickStartedAt: Date.now() }).catch(() => {});
  if (isLive) openingBell();
}

function tickClock() {
  const host = el('clock-time'), total = el('clock-total');
  if (board?.startedAt) {
    const end = isLive ? Date.now() : (board.endedAt || Date.now());
    total.textContent = fmtClock(Math.max(0, Math.floor((end - board.startedAt) / 1000)));
  }
  if (!isLive) return;
  const sec = Math.max(0, Math.floor((Date.now() - pickStart()) / 1000));
  host.textContent = fmtClock(sec);
  host.classList.toggle('warn', sec >= CHIME_AT[0] && sec < CHIME_AT[1]);
  host.classList.toggle('over', sec >= CHIME_AT[1]);
  CHIME_AT.forEach((mark, i) => {
    if (sec >= mark && !chimed.has(mark)) {
      chimed.add(mark);
      if (i === 0) ding(3); else { ding(3); ding(3, 1.2); }
      host.classList.remove('flash'); void host.offsetWidth; host.classList.add('flash');
    }
  });
}
setInterval(tickClock, 250);

let audioCtx = null;
function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.01);
  } catch { /* no audio */ }
}
['pointerdown', 'touchstart', 'keydown'].forEach(evt =>
  document.addEventListener(evt, primeAudio, { once: true, passive: true }));

function ding(times, offset = 0) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    for (let i = 0; i < times; i++) {
      const t0 = audioCtx.currentTime + offset + i * 0.26;
      const gain = audioCtx.createGain();
      gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.75, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
      [[880, 1], [1760, 0.32]].forEach(([f, rel]) => {
        const osc = audioCtx.createOscillator(), mix = audioCtx.createGain();
        mix.gain.value = rel;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, t0);
        osc.connect(mix).connect(gain);
        osc.start(t0); osc.stop(t0 + 0.26);
      });
    }
  } catch { /* no audio */ }
}

function openingBell() {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [[1318.5, 0.20], [1975.5, 0.09], [2637.0, 0.05]].forEach(([f, peak]) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 1.55);
    });
  } catch { /* no audio */ }
}

// ── Live toggle ──────────────────────────────────────────────────────────────
async function toggleLive() {
  if (!isAdmin()) return showDialog('Commissioner only', 'Only a league admin can start or end the live draft.');

  if (!isLive) {
    const placed = Object.keys(slots).length;
    const start = async (clear) => {
      const next = clear ? {} : { ...slots };
      // saveDraftBoard's merge:true would leave old slot keys sitting
      // underneath an empty {} — saveDraftSlots is the one that actually
      // clears keys that dropped out, so a real board wipe has to go
      // through it, not through the general patch call below.
      await saveDraftSlots(next, coach().name);
      await saveDraftBoard({
        live: true,
        coachOrder: coachRows.map(c => c.personId),
        startedAt: Date.now(),
        endedAt: null,
        pickStartedAt: Date.now(),
        updatedBy: coach().name,
      });
      if (clear) toast('Board cleared', 'All players returned to the pool');
    };
    if (!placed) return start(true);
    return showDialog('Start the live draft',
      `Your board has <strong>${placed}</strong> player${placed === 1 ? '' : 's'} placed from ` +
      `pre-draft planning. Clear the board and start clean, or carry them into the live draft?`,
      () => start(true), 'Clear board', 'Keep changes',
      `<p style="margin:0;font-size:12px;color:var(--clr-muted)">Every coach will see this board
       once the draft is live.</p>`,
      () => start(false));
  }

  // Ending: write results, then drop everyone back to sandbox.
  const picks = Object.keys(slots).length;
  showDialog('End the live draft',
    `<strong>${picks}</strong> pick${picks === 1 ? '' : 's'} will be written to the players' ` +
    `team assignments, and the Draft Results page will reflect this board. ` +
    `Everyone returns to their own sandbox afterward.`,
    async () => {
      // Snapshot FIRST. If the writes below fail, the pixels still prove
      // who drafted whom — that's the whole point of saving an image.
      const shot = await captureBoard();
      try {
        const map = {};
        coachRows.forEach(c => { map[c.personId] = teamNameFor(c.personId) || c.name; });
        const n = await commitDraftResults(slots, map);
        await saveDraftBoard({ live: false, endedAt: Date.now(), updatedBy: coach().name });
        showSummary();
        toast('Draft complete', `${n} player${n === 1 ? '' : 's'} assigned to teams` +
          (shot ? ' · board image saved' : ''));
      } catch (err) {
        toast('Could not finish the draft', err.message +
          (shot ? ' — board image was saved' : ''));
      }
    }, 'End draft & assign teams', 'Keep drafting');
}

/**
 * Saves a PNG of the finished board to the commissioner's device.
 *
 * This is a deliberate belt-and-braces step: if the Firestore data is ever
 * lost or corrupted, the pixels are still proof of who drafted whom. It runs
 * on draft end, before anything else can change the board.
 *
 * Two traps, both already learned the hard way in rotations.js:
 *  - Player photos come from Drive, a cross-origin host with no CORS headers.
 *    html2canvas can't read pixels from those, so a capture in photo mode
 *    produces blank cells. Force name tiles for the duration of the capture.
 *  - html2canvas snapshots what's actually laid out, so the DOM has to be
 *    changed AND reflowed before it reads — hence the double rAF.
 */
function captureBoard() {
  return new Promise(resolve => {
    const target = el('board-capture');
    if (typeof html2canvas !== 'function' || !target) return resolve(false);

    const prevView = view;
    if (prevView !== 'names') setView('names');   // avoid tainted-canvas blanks

    const head = el('capture-head'), foot = el('capture-foot');
    const when = new Date();
    const stamp = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' @ ' + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    head.textContent = `CSBC SJV Fall 2026 — Final Draft Board`;
    foot.textContent = `${Object.keys(slots).length} picks · completed ${stamp}`;
    head.classList.remove('hidden');
    foot.classList.remove('hidden');

    requestAnimationFrame(() => requestAnimationFrame(() => {
      html2canvas(target, { backgroundColor: '#0f1117', scale: 2 }).then(canvas => {
        const link = document.createElement('a');
        const d = when.toISOString().slice(0, 10);
        link.download = `csbc-fall-2026-draft-board-${d}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        // Desktop convenience: also drop it on the clipboard so it can be
        // pasted straight into a message. Silently unsupported on mobile,
        // where the download is the whole outcome.
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          canvas.toBlob(blob => {
            if (!blob) return;
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
              .catch(() => {});
          }, 'image/png');
        }
        resolve(true);
      }).catch(err => {
        console.error('Board snapshot failed:', err);
        resolve(false);
      }).finally(() => {
        head.classList.add('hidden');
        foot.classList.add('hidden');
        if (prevView !== 'names') setView(prevView);
      });
    }));
  });
}

function showSummary() {
  if (!board?.startedAt) return;
  const secs = Math.floor(((board.endedAt || Date.now()) - board.startedAt) / 1000);
  const picks = Object.keys(slots).length;
  el('summary-time').textContent = fmtClock(secs);
  el('summary-note').textContent = picks
    ? `${picks} pick${picks === 1 ? '' : 's'} · ${fmtClock(Math.round(secs / picks))} average`
    : 'No picks recorded';
  el('draft-summary').hidden = false;
}

// ── Coach management (commissioner, sandbox only) ────────────────────────────
/**
 * Writes the seated roster to Firestore. Shared, so it reaches every coach's
 * board on their next snapshot — unlike the row ORDER, which stays a personal
 * preference in each coach's sandbox.
 */
async function pushRoster(msg, detail = '') {
  const ids = coachRows.map(c => c.personId);
  boardRoster = ids;                 // optimistic, so the row goes now
  render();
  try {
    // Board-only coach names ride along on every write, merged rather than
    // replaced, so a name never disappears once another device has seen it.
    const names = Object.fromEntries([...NEW_COACHES.values()].map(c => [c.personId, c.name]));
    await saveBoardRoster(ids, coach()?.name || '', names);
    toast(msg, detail || 'Updated for every coach');
  } catch (err) {
    toast('Could not save the roster', err.message);
  }
}

function removeCoach(idx) {
  if (!isAdmin() || isLive) return;
  const c = coachRows[idx];
  const theirs = Object.keys(slots).filter(k => k.startsWith(c.personId + ':'));
  if (!theirs.length) {
    return showDialog('Remove from the draft board?',
      `<strong>${escHtml(c.name)}</strong> loses their draft slot for this season, on ` +
      `every coach's board. They can still log in, rank players and leave notes — ` +
      `this only means they aren't drafting a team.`,
      () => {
        coachRows.splice(idx, 1);
        pushRoster(`${c.name} removed from the board`);
      }, 'Remove from board');
  }
  const open = coachRows.filter((o, i) => i !== idx &&
    !Object.keys(slots).some(k => k.startsWith(o.personId + ':')));
  if (!open.length) {
    return showDialog('Add the replacement first',
      `<strong>${escHtml(c.name)}</strong> has <strong>${theirs.length}</strong> drafted ` +
      `player${theirs.length === 1 ? '' : 's'}. Add the incoming coach first — their whole roster transfers over.`);
  }
  showDialog('Transfer roster, then remove',
    `<strong>${escHtml(c.name)}</strong>'s <strong>${theirs.length}</strong> drafted ` +
    `player${theirs.length === 1 ? '' : 's'} transfer to the coach you pick.`,
    () => {
      const to = el('dlg-select').value;
      theirs.forEach(k => { slots[`${to}:${k.split(':')[1]}`] = slots[k]; delete slots[k]; });
      coachRows.splice(idx, 1);
      persist();
      pushRoster(`${c.name} removed · roster transferred`);
    }, 'Transfer & remove', 'Cancel',
    `<label style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--clr-muted)">
       Transfer roster to
       <select id="dlg-select">${open.map(o =>
         `<option value="${o.personId}">${escHtml(o.name)}</option>`).join('')}</select>
     </label>`);
}

function addCoach() {
  if (!isAdmin() || isLive || coachRows.length >= MAX_COACHES) return;
  const onBoard = new Set(coachRows.map(c => c.personId));
  const avail = getActiveCoaches(SEASON_CODE).filter(c => !onBoard.has(c.personId));
  const opts = avail.length
    ? avail.map(c => `<option value="${c.personId}">${escHtml(c.name)}</option>`).join('')
    : '<option value="">— none available —</option>';

  showDialog('Add a coach to the board',
    'Seat a coach who already has an account, or create a new one.',
    () => {
      const mode = document.querySelector('input[name="add-mode"]:checked').value;
      if (mode === 'existing') {
        const id = el('dlg-select').value;
        const found = avail.find(c => c.personId === id);
        if (!found) return;
        coachRows.push({ personId: found.personId, name: found.name });
        pushRoster(`${found.name} added to the board`, `Seat ${coachRows.length}`);
      } else {
        const name = el('dlg-newname').value.trim();
        if (!name) return toast('Enter a name for the new coach');
        const label = /^coach\b/i.test(name) || /^director\b/i.test(name) ? name : `Coach ${name}`;
        // A board-only seat -- not a real login. addNewCoach() below hands
        // back a stable id derived from the name, so re-adding the same
        // person after removing them lands on the same seat instead of a
        // fresh one each time.
        const id = addNewCoach(label);
        coachRows.push({ personId: id, name: label });
        pushRoster(`${label} created and added`, `Seat ${coachRows.length}`);
      }
    }, 'Add coach', 'Cancel',
    `<div class="add-modes">
       <label class="add-mode">
         <input type="radio" name="add-mode" value="existing" id="mode-existing"
                ${avail.length ? 'checked' : 'disabled'}>
         <span>Existing coach</span>
       </label>
       <select id="dlg-select" ${avail.length ? '' : 'disabled'}>${opts}</select>

       <label class="add-mode">
         <input type="radio" name="add-mode" value="new" id="mode-new"
                ${avail.length ? '' : 'checked'}>
         <span>New coach</span>
       </label>
       <input id="dlg-newname" placeholder="First name, e.g. Marcus">
     </div>`);

  // Picking either field selects its radio, so the choice follows intent.
  el('dlg-select')?.addEventListener('focus', () => { const r = el('mode-existing'); if (r && !r.disabled) r.checked = true; });
  el('dlg-newname')?.addEventListener('focus', () => { el('mode-new').checked = true; });
}

/**
 * Registers a board-only coach (NEW_COACHES is declared near the top of the
 * file). Stable id derived from the name, so removing and re-adding the same
 * person lands on the same seat instead of fragmenting into multiple ids.
 */
function addNewCoach(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const id = `BOARD-${slug || Date.now()}`;
  if (!NEW_COACHES.has(id)) NEW_COACHES.set(id, { personId: id, name });
  return id;
}

// ── Toast + dialog ───────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, detail) {
  const host = el('toast');
  host.innerHTML = `<span class="t-msg">${escHtml(msg)}</span>` +
    (detail ? `<span class="t-detail">${escHtml(detail)}</span>` : '');
  host.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), 2600);
}

let dlgOk = null, dlgCancel = null;
function showDialog(title, body, onOk, okLabel = 'OK', cancelLabel = 'Cancel', extra = '', onCancel = null) {
  el('dlg-title').textContent = title;
  el('dlg-body').innerHTML = body;
  el('dlg-extra').innerHTML = extra;
  el('dlg-extra').style.display = extra ? 'block' : 'none';
  el('dlg-ok').textContent = onOk ? okLabel : 'Got it';
  el('dlg-cancel').textContent = cancelLabel;
  el('dlg-cancel').style.display = onOk ? '' : 'none';
  dlgOk = onOk || null;
  dlgCancel = onCancel || null;
  el('scrim').classList.remove('hidden');
}
function closeDialog() { el('scrim').classList.add('hidden'); dlgOk = null; dlgCancel = null; }

function wireStatic() {
  el('dlg-ok').addEventListener('click', () => { const f = dlgOk; closeDialog(); if (f) f(); });
  el('dlg-cancel').addEventListener('click', () => { const f = dlgCancel; closeDialog(); if (f) f(); });
  el('scrim').addEventListener('click', e => { if (e.target === el('scrim')) closeDialog(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog(); });

  // Photo lightbox: click the backdrop (not the photo/arrows/caption), the
  // close button, or Escape to dismiss. Left/Right walk the roster.
  el('db-lightbox').addEventListener('click', e => {
    if (e.target === el('db-lightbox')) closePlayerPhoto();
  });
  el('db-lightbox-close').addEventListener('click', closePlayerPhoto);
  el('db-lightbox-prev').addEventListener('click', () => lightboxStep(-1));
  el('db-lightbox-next').addEventListener('click', () => lightboxStep(1));

  wireWheel();
  wireLightboxVideoBtn();
  document.addEventListener('keydown', e => {
    if (el('db-lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closePlayerPhoto();
    if (e.key === 'ArrowLeft') lightboxStep(-1);
    if (e.key === 'ArrowRight') lightboxStep(1);
  });
  wireLightboxSwipe();

  el('live-btn').addEventListener('click', toggleLive);
  el('add-coach').addEventListener('click', addCoach);
  el('save-image').addEventListener('click', async () => {
    // Hold the node directly — e.currentTarget is null once the handler
    // resumes after an await.
    const btn = el('save-image');
    btn.disabled = true;
    const ok = await captureBoard();
    btn.disabled = false;
    toast(ok ? 'Board image saved' : 'Could not save the image',
      ok ? 'Check your downloads' : 'Try again in a moment');
  });
  el('edit-coaches').addEventListener('click', () => { editing = !editing; render(); });
  el('clock-reset').addEventListener('click', () => { resetClock(); tickClock(); });
  el('clock-mute').addEventListener('click', e => {
    muted = !muted;
    e.currentTarget.setAttribute('aria-pressed', String(muted));
    e.currentTarget.textContent = muted ? '🔕' : '🔔';
  });

  ['names', 'photos', 'split'].forEach(k =>
    el('view-' + k).addEventListener('click', () => setView(k)));

  ['composite', 'personal'].forEach(m =>
    el('pmode-' + m).addEventListener('click', () => setPoolMode(m)));

  window.addEventListener('resize', renderArrows);
  window.addEventListener('resize', updateStickyOffset);
  updateStickyOffset();
}

/**
 * Three layers stack on top of each other while scrolling: the site header,
 * the mode/view topbar right under it, and (further down the page) the pool's
 * seed-entry row + column headers right under THAT. Each needs to know the
 * combined height of everything sticky above it. None of these have a fixed
 * pixel height — the header wraps to two lines on narrow screens, and the
 * topbar wraps too — so measure them instead of guessing an offset that
 * would drift out of sync the next time either one's content changes.
 */
function updateStickyOffset() {
  const header = document.querySelector('header');
  const topbar = document.querySelector('.db-topbar');
  const headerH = header ? header.offsetHeight : 0;
  const topbarH = topbar ? topbar.offsetHeight : 0;
  document.documentElement.style.setProperty('--header-h', `${headerH}px`);
  document.documentElement.style.setProperty('--pool-sticky-top', `${headerH + topbarH}px`);

  // #pool-entry and #pool-head both stick to the top of the pool's own
  // scrollbox (see .pool-panel .panel-body in style.css) — they'd land on
  // top of each other at top:0 unless #pool-head is pushed down by exactly
  // #pool-entry's rendered height, which isn't a fixed number.
  const entry = el('pool-entry');
  if (entry) document.documentElement.style.setProperty('--pool-entry-h', `${entry.offsetHeight}px`);
}

function setView(v) {
  // Split shows board + pool side by side. With the pool hidden for
  // non-admins that's a two-pane layout with one empty pane, so fall back to
  // Photos — including for anyone who was already in Split when this landed.
  if (v === 'split' && !(coach() && isAdmin())) v = 'photos';
  view = v;
  ['names', 'photos', 'split'].forEach(k =>
    el('view-' + k).setAttribute('aria-pressed', String(k === v)));
  document.body.classList.toggle('view-tall', v === 'photos');
  document.body.classList.toggle('view-split', v === 'split');
  photoMode = v === 'photos';
  poolPhotos = v === 'photos' || v === 'split';
  render();
}

function setPoolMode(m) {
  poolMode = m;
  ['composite', 'personal'].forEach(k =>
    el('pmode-' + k).setAttribute('aria-pressed', String(k === m)));
  // Switching modes changes which seed places each card, so any tier
  // pinned under the old mode is stale — drop the holds instead of
  // carrying a composite-mode snapshot into personal mode or vice versa.
  pinnedSort.clear();
  pinTimers.forEach(t => clearTimeout(t.timer));
  pinTimers.clear();
  render();
}

// ── Random Coach Pick Wheel ──────────────────────────────────────────────────
// Prototyped and tested as a standalone artifact before wiring in (see
// _local/ for the design notes). Purely client-side and not persisted to
// Firestore — it's a lottery aid for the pre-draft lottery step, not part of
// the board's own state, so nothing here needs to sync between devices.
// A novelty for this season (the draft it would have run the lottery for
// already happened) but built for real use in Fall/next season's draft.
const WHEEL_PALETTE = [
  '#4f8ef7', '#e35b4f', '#f5a623', '#3ec28f', '#a86bef', '#f2637a',
  '#33c1c9', '#ff9f5a', '#6b78e8', '#c9d64a', '#f06fb0', '#4fd1e0',
];

let wheelNames = [];       // [{ name, color, removed }], rebuilt on open
let wheelRotation = 0;     // radians
let wheelSpinning = false;
let wheelDrawOrder = [];
let wheelRemovalStack = [];   // for Undo — see removeWheelCoach()

function wheelActive() { return wheelNames.filter(n => !n.removed); }

/** Pulled fresh from coachRows every time the wheel opens — never a
 *  hardcoded roster, so it always reflects who's actually seated on this
 *  board right now, added/removed coaches included. Admins (the
 *  commissioner) don't hold a team and aren't lottery candidates. */
function buildWheelRoster() {
  const eligible = coachRows.filter(c => !TEAM_ADMINS.includes(c.name));
  wheelNames = eligible.map((c, i) => ({
    name: c.name, color: WHEEL_PALETTE[i % WHEEL_PALETTE.length], removed: false,
  }));
  wheelRotation = 0;
  wheelDrawOrder = [];
  wheelRemovalStack = [];
}

function removeWheelCoach(name) {
  const item = wheelNames.find(n => n.name === name && !n.removed);
  if (!item) return;
  item.removed = true;
  wheelRemovalStack.push(name);
  updateWheelUndoState();
}

function undoWheelRemoval() {
  const name = wheelRemovalStack.pop();
  if (!name) return;
  const item = wheelNames.find(n => n.name === name && n.removed);
  if (item) item.removed = false;
  if (wheelDrawOrder.length && wheelDrawOrder[wheelDrawOrder.length - 1] === name) {
    wheelDrawOrder.pop();
  }
  drawWheelCanvas();
  renderWheelChips();
  updateWheelSub();
  renderWheelDrawOrder();
  updateWheelUndoState();
  el('wheel-winner').className = 'wheel-winner empty';
  el('wheel-winner').textContent = wheelActive().length ? 'Spin to pick a coach' : 'Everyone has been picked';
  setWheelSpinEnabled(wheelActive().length > 0);
}

function setWheelSpinEnabled(enabled) {
  el('wheel-spin').disabled = !enabled;
  el('wheel-hub').disabled = !enabled;
}

function updateWheelUndoState() {
  const btn = el('wheel-undo');
  btn.disabled = wheelRemovalStack.length === 0;
  btn.title = wheelRemovalStack.length
    ? `Bring back ${wheelRemovalStack[wheelRemovalStack.length - 1]}` : '';
}

function drawWheelCanvas() {
  const canvas = el('wheel-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, r = w / 2 - 6;
  ctx.clearRect(0, 0, w, h);

  const active = wheelActive();
  const n = active.length;
  if (n === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3a3f52';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '600 24px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Wheel is empty', cx, cy);
    return;
  }

  const slice = (Math.PI * 2) / n;
  active.forEach((item, i) => {
    const start = wheelRotation + i * slice;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + slice / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const fontSize = n > 14 ? 15 : n > 9 ? 18 : 22;
    ctx.font = `700 ${fontSize}px -apple-system, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 3;
    let label = item.name.replace(/^Coach\s+/, '');
    const maxChars = n > 14 ? 12 : 16;
    if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
    ctx.fillText(label, r - 18, 0);
    ctx.restore();
  });
}

function renderWheelChips() {
  const list = el('wheel-chip-list');
  list.innerHTML = '';
  wheelNames.forEach((item, idx) => {
    const chip = document.createElement('div');
    chip.className = 'wheel-chip' + (item.removed ? ' removed' : '');
    chip.innerHTML =
      `<span style="width:9px;height:9px;border-radius:50%;background:${item.color};display:inline-block;${item.removed ? 'opacity:.5' : ''}"></span>` +
      `<span>${escHtml(item.name)}</span>` +
      (item.removed ? '' : `<button data-idx="${idx}" title="Remove from wheel" aria-label="Remove ${escHtml(item.name)}">✕</button>`);
    list.appendChild(chip);
  });
  list.querySelectorAll('button[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      removeWheelCoach(wheelNames[+btn.dataset.idx].name);
      drawWheelCanvas();
      renderWheelChips();
      updateWheelSub();
    });
  });
}

function updateWheelSub() {
  const n = wheelActive().length;
  el('wheel-sub').textContent = n === 1 ? '1 coach on the wheel' : `${n} coaches on the wheel`;
}

function renderWheelDrawOrder() {
  const box = el('wheel-drawn-order');
  if (!wheelDrawOrder.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  el('wheel-drawn-list').innerHTML = wheelDrawOrder.map(n => `<li>${escHtml(n)}</li>`).join('');
}

/**
 * Landing sound — a whole step above openingBell()'s E6/B6/E7 (F#6/C#7) with
 * a shorter decay (0.55s vs. 1.5s), so the spin's start and end don't blur
 * into the same sound. openingBell() itself (already in this file, and
 * already what the pick clock plays on every reset) is reused unchanged for
 * the start sound rather than duplicating it.
 */
function wheelLandingChime() {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    [1479.98, 2217.46].forEach((freq, i) => {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const startAt = audioCtx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.28, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.55);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.6);
    });
  } catch { /* no audio */ }
}

function easeOutCubicWheel(t) { return 1 - Math.pow(1 - t, 3); }

function spinWheel() {
  const active = wheelActive();
  if (wheelSpinning || active.length === 0) return;
  wheelSpinning = true;
  setWheelSpinEnabled(false);
  el('wheel-stage').classList.add('spinning');
  el('wheel-winner').className = 'wheel-winner empty';
  el('wheel-winner').textContent = 'Spinning…';
  openingBell();

  const n = active.length;
  const slice = (Math.PI * 2) / n;
  const winnerIndex = Math.floor(Math.random() * n);

  const targetSliceCenter = winnerIndex * slice + slice / 2;
  const twoPi = Math.PI * 2;
  const spins = 5 + Math.floor(Math.random() * 3);
  let finalRotation = (-Math.PI / 2 - targetSliceCenter);
  finalRotation = ((finalRotation % twoPi) + twoPi) % twoPi;
  finalRotation += spins * twoPi;

  const duration = 4200 + Math.random() * 600;
  const start = performance.now();
  const from = wheelRotation;
  const to = wheelRotation - (wheelRotation % twoPi) + finalRotation;

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    wheelRotation = from + (to - from) * easeOutCubicWheel(t);
    drawWheelCanvas();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      wheelRotation = to;
      drawWheelCanvas();
      finishWheelSpin(active[winnerIndex].name);
    }
  }
  requestAnimationFrame(frame);
}

function finishWheelSpin(winnerName) {
  wheelSpinning = false;
  el('wheel-stage').classList.remove('spinning');
  wheelLandingChime();

  // Removed the instant they're drawn — no separate "remove" step to skip,
  // so Undo always has exactly the last spin to reverse and a coach can
  // never be drawn twice by spinning again without an extra click.
  wheelDrawOrder.push(winnerName);
  removeWheelCoach(winnerName);
  drawWheelCanvas();
  renderWheelChips();
  updateWheelSub();
  renderWheelDrawOrder();
  setWheelSpinEnabled(wheelActive().length > 0);

  const banner = el('wheel-winner');
  banner.className = 'wheel-winner';
  banner.innerHTML =
    `<div><div class="wheel-winner-label">Selected</div><div class="wheel-winner-name">${escHtml(winnerName)}</div></div>` +
    `<div class="wheel-winner-actions"><button class="btn btn-dark" id="wheel-spin-again">Spin again</button></div>`;
  const againBtn = el('wheel-spin-again');
  if (wheelActive().length === 0) {
    againBtn.disabled = true;
    againBtn.title = 'Everyone has been picked';
    // The whole point of the lottery is to set the draft order — once every
    // coach has a position, offer to actually use it rather than leaving
    // the result to be copied down by hand.
    promptApplyWheelOrder();
  } else {
    againBtn.addEventListener('click', spinWheel);
  }
}

/**
 * Offers to reorder the real draft board's coach rows to match the sequence
 * the wheel just drew. Only touches non-admin rows — the commissioner
 * doesn't hold a team and was never a candidate for the wheel (see
 * buildWheelRoster), so their row (if they somehow have one) stays put
 * rather than being silently dropped by a reorder built from a list that
 * never included them.
 */
function promptApplyWheelOrder() {
  showDialog(
    'Apply this order to the draft board?',
    `The wheel drew ${wheelDrawOrder.length} coach${wheelDrawOrder.length === 1 ? '' : 's'} in this order:<br>` +
      `<ol style="margin:8px 0 0;padding-left:20px;font-weight:600">` +
      wheelDrawOrder.map(n => `<li>${escHtml(n)}</li>`).join('') +
      `</ol>`,
    applyWheelOrderToBoard,
    'Apply order', 'Not now',
  );
}

function applyWheelOrderToBoard() {
  if (draftFinished()) {
    showDialog('Coach order is locked',
      'This draft is finished and the board is the published result — coach order can\'t be changed.');
    return;
  }

  // Rebuild coachRows in the wheel's sequence, but only reshuffle the rows
  // the wheel actually drew from (non-admins). An admin's row, if present,
  // keeps its current position rather than being displaced by a reorder
  // that was never drawn from a list including them.
  const byName = new Map(coachRows.map(c => [c.name, c]));
  const drawnRows = wheelDrawOrder.map(name => byName.get(name)).filter(Boolean);
  let drawnIdx = 0;
  coachRows = coachRows.map(c =>
    TEAM_ADMINS.includes(c.name) ? c : drawnRows[drawnIdx++]);

  persist();
  render();
  toast('Draft order updated', 'The board now follows the wheel\'s draw order');
}

function resetWheel() {
  buildWheelRoster();
  el('wheel-winner').className = 'wheel-winner empty';
  el('wheel-winner').textContent = 'Spin to pick a coach';
  setWheelSpinEnabled(true);
  drawWheelCanvas();
  renderWheelChips();
  updateWheelSub();
  renderWheelDrawOrder();
  updateWheelUndoState();
}

function openWheel() {
  buildWheelRoster();
  el('wheel-overlay').classList.add('open');
  setWheelSpinEnabled(true);
  el('wheel-winner').className = 'wheel-winner empty';
  el('wheel-winner').textContent = 'Spin to pick a coach';
  drawWheelCanvas();
  renderWheelChips();
  updateWheelSub();
  renderWheelDrawOrder();
  updateWheelUndoState();
}

function closeWheel() {
  el('wheel-overlay').classList.remove('open');
}

/**
 * Close, but never lose a draw in progress by accident.
 *
 * openWheel() rebuilds the roster from scratch, so closing IS a reset — the
 * draw order is not persisted anywhere. A stray click used to wipe a
 * half-finished lottery with no warning, which is the one thing this modal
 * must not do. Confirm only when there's something to lose; with no picks yet
 * there's nothing to protect and the prompt would just be noise.
 */
function requestCloseWheel() {
  if (wheelSpinning) return;              // mid-spin: ignore, the result is landing
  if (wheelDrawOrder.length) {
    const n = wheelDrawOrder.length;
    const ok = confirm(
      `Close the wheel and reset it?

${n} pick${n === 1 ? '' : 's'} ` +
      `already made will be cleared — the draw order is not saved.`);
    if (!ok) return;
  }
  closeWheel();
}

function wireWheel() {
  el('wheel-open').addEventListener('click', openWheel);
  // The close button is the ONLY way out — backdrop click and Escape are
  // deliberately not wired, so a mis-tap beside the modal can't reset a
  // lottery that's underway.
  el('wheel-close').addEventListener('click', requestCloseWheel);
  el('wheel-spin').addEventListener('click', spinWheel);
  el('wheel-hub').addEventListener('click', spinWheel);
  el('wheel-reset').addEventListener('click', resetWheel);
  el('wheel-undo').addEventListener('click', undoWheelRemoval);
}

init();
