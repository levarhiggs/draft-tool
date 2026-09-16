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
import { escHtml, COL, photoUrl } from './app.js';
import { fetchPlayers, buildDriveIndex, SEASON_CODE } from './players-data.js';
import { getCurrentCoach } from './coach-login.js';
import {
  getActiveCoaches, personByName, teamNameFor, TEAM_ADMINS,
} from './coaches-config.js';
import {
  subscribePlayer, saveRanking, deleteRanking, saveFavorites, getFavorites,
  subscribeDraftBoard, saveDraftBoard, saveDraftSlots,
  subscribeBoardRoster, saveBoardRoster,
  getSandbox, saveSandbox, commitDraftResults, decodeRanking,
} from './firebase.js';

const SPOTS = 8, MAX_COACHES = 15;

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

const el = id => document.getElementById(id);
const byId = id => allPlayers.find(p => String(p[COL.ID]) === String(id));
const coach = () => getCurrentCoach();
const isAdmin = () => { const c = coach(); return !!c && TEAM_ADMINS.includes(c.name); };
const myPersonId = () => coach()?.personId || personByName(coach()?.name)?.id || null;

/** Sandbox = your own board. Live = the commissioner's, read-only unless admin. */
const canEdit = () => !!coach() && (!isLive || isAdmin());

// ── Seeds ────────────────────────────────────────────────────────────────────
const MOD_OFFSET = { Strong: 0.0, Reg: 0.2, Mid: 0.5, Low: 0.8 };
const MOD_CYCLE  = ['Strong', 'Reg', 'Mid', 'Low'];

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
/** While live the commissioner's seed drives placement; otherwise composite. */
function effSeed(id) {
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
    allPlayers = players.slice().sort((a, b) => {
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
      else if (isLive) { adoptBoard(); render(); }
      else render();
    });

    // Roster changes are shared — every open device re-renders on a change.
    let rosterFirst;
    const rosterReady = new Promise(res => { rosterFirst = res; });
    let rosterSettled = false;
    subscribeBoardRoster(ids => {
      boardRoster = ids;
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
    render();

    document.addEventListener('coachChanged', async () => {
      const cc = coach();
      favorites = cc ? new Set(await getFavorites(cc.name).catch(() => [])) : new Set();
      await switchMode();
      render();
    });
  } catch (err) {
    el('db-loading').textContent = `Could not load the draft board: ${err.message}`;
    console.error(err);
  }
}

/** Everyone who holds a draft slot this season, in board order. */
function seatedCoaches() {
  const all = getActiveCoaches(SEASON_CODE);
  const ids = boardRoster || all.map(c => c.personId);
  return ids
    .map(id => all.find(r => r.personId === id))
    .filter(Boolean)
    .map(r => ({ personId: r.personId, name: r.name }));
}

/** Point `slots`/`coachRows` at whichever board this mode should render. */
async function switchMode() {
  if (isLive) { adoptBoard(); render(); return; }
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
  const all = getActiveCoaches(SEASON_CODE);
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

  el('mode-chip').textContent = isLive ? 'LIVE DRAFT' : 'Sandbox';
  el('mode-chip').classList.toggle('live', isLive);
  el('db-mode-note').textContent = !c
    ? 'Log in as a coach to use the board.'
    : isLive
      ? (isAdmin()
          ? 'You are running the live draft. Every coach sees this board.'
          : 'Live draft in progress — following the commissioner’s board.')
      : 'Sandbox — this board is yours alone. Nothing here affects anyone else.';

  el('live-btn').classList.toggle('hidden', !isAdmin());
  el('live-btn').setAttribute('aria-pressed', String(isLive));
  el('live-label').textContent = isLive ? 'Live Draft On' : 'Live Draft Off';
  el('edit-coaches').classList.toggle('hidden', !isAdmin() || isLive);
  el('add-coach').classList.toggle('hidden', !isAdmin() || isLive);
  el('coach-hint').textContent = isLive
    ? 'Coach list is locked while the draft is live'
    : isAdmin()
      ? `${coachRows.length} of ${MAX_COACHES} coach slots used · drag ⣿ to reorder`
      : (c ? 'Drag ⣿ to reorder your own view' : '');

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
    if (!isLive && coach()) {
      cell.querySelector('.grip').addEventListener('pointerdown', e => startCoachDrag(e, ci));
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
        slot.innerHTML = photoMode
          ? avatarHTML(p, 'slot-ava-tall') +
            `<span class="tall-meta"><span class="pid">${escHtml(pid)}</span>` +
            `<span class="pname">${escHtml(p ? p[COL.NAME].split(' ')[0] : '?')}</span></span>` +
            `<span class="picknum">${pickNumber(ci, s)}</span>`
          : `<span class="pid">${escHtml(pid)}</span>` +
            `<span class="pname">${escHtml(p ? p[COL.NAME].split(' ')[0] : '?')}</span>` +
            `<span class="picknum">${pickNumber(ci, s)}</span>`;
        slot.title = `${p ? p[COL.NAME] : pid} — double-click to send back to the pool`;
        if (canEdit()) {
          slot.addEventListener('dblclick', () => returnToPool(key, pid));
          slot.addEventListener('pointerdown', e => startCardDrag(e, pid, slot, key));
        }
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
      `<path d="${d}" fill="none" stroke="var(--rail)" stroke-width="3"/></svg>`;
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
const canEditSeeds = () => !!coach() && (!isLive || isAdmin());

function renderPool() {
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
    allPlayers
      .filter(p => tierOf(String(p[COL.ID])) === t)
      .sort((a, b) => {
        const ai = String(a[COL.ID]), bi = String(b[COL.ID]);
        const ad = placed.has(ai), bd = placed.has(bi);
        if (ad !== bd) return ad ? 1 : -1;
        if (ad && bd) return ai.localeCompare(bi);
        return (effSeed(ai) ?? 9) - (effSeed(bi) ?? 9);
      })
      .forEach(p => col.appendChild(poolCard(p, placed)));
    grid.appendChild(col);
  }
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
  card.tabIndex = 0;
  card.innerHTML =
    (poolPhotos ? avatarHTML(p, 'card-ava-tall') : '') +
    `<button class="fav-btn" data-fav aria-pressed="${fav}"
             aria-label="${fav ? 'Unfavorite' : 'Favorite'} ${escHtml(p[COL.NAME])}">♥</button>` +
    `<div class="prow"><span class="pid">${escHtml(id)}</span>` +
    `<span class="pname">${escHtml(p[COL.NAME])}</span></div>` +
    (drafted
      ? `<div class="pmeta"><span class="drafted-tag">DRAFTED</span></div>`
      : `<div class="rank-head"><span>Your Rank</span><span>Composite</span></div>` +
        `<div class="rank-vals">` +
          `<span class="mine-val">${mine != null ? mine.toFixed(1) : '—'}` +
            `<button class="mod" data-mod-btn="${mod}">${mod}</button></span>` +
          `<span class="comp-val">${comp != null ? comp.toFixed(1) : '—'}</span>` +
        `</div>`);

  // Hearts survive live mode — the one private action that does.
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
    modBtn.title = canEditSeeds() ? 'Click to cycle Strong → Reg → Mid → Low' : '';
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

// ── Seeding ──────────────────────────────────────────────────────────────────
async function setSeed(id, tier, mod) {
  const c = coach();
  if (!c || !canEditSeeds()) return;
  const m = mod || myModOf(id) || 'Reg';
  try {
    await saveRanking(id, c.name, tier, m === 'Reg' ? null : m);
  } catch (err) {
    toast('Could not save that seed', err.message);
  }
}

async function cycleMod(id) {
  const cur = MOD_CYCLE.indexOf(myModOf(id) || 'Reg');
  const next = MOD_CYCLE[(cur + 1) % MOD_CYCLE.length];
  const before = tierOf(id);
  const seed = mySeedOf(id);
  if (seed == null) return;
  await setSeed(id, Math.floor(seed), next);
  const after = tierOf(id);
  if (after !== before && after != null) {
    toast(`${byId(id)?.[COL.NAME]} moved to column ${after}`, next);
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
  const clearHi = () => document.querySelectorAll('.drop-ok').forEach(n => n.classList.remove('drop-ok'));

  function move(ev) {
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
      await saveDraftBoard({
        live: true,
        slots: next,
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
    await saveBoardRoster(ids, coach()?.name || '');
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
  if (!avail.length) {
    return showDialog('Everyone is already on the board',
      'Every coach with a login this season already holds a draft slot.');
  }
  showDialog('Add a coach to the board',
    'Give a coach a draft slot. This shows up on every coach’s board.',
    () => {
      const id = el('dlg-select').value;
      const found = avail.find(c => c.personId === id);
      if (!found) return;
      coachRows.push({ personId: found.personId, name: found.name });
      pushRoster(`${found.name} added to the board`, `Seat ${coachRows.length}`);
    }, 'Add coach', 'Cancel',
    `<label style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--clr-muted)">
       Coach
       <select id="dlg-select">${avail.map(c =>
         `<option value="${c.personId}">${escHtml(c.name)}</option>`).join('')}</select>
     </label>`);
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

  window.addEventListener('resize', renderArrows);
}

function setView(v) {
  view = v;
  ['names', 'photos', 'split'].forEach(k =>
    el('view-' + k).setAttribute('aria-pressed', String(k === v)));
  document.body.classList.toggle('view-tall', v === 'photos');
  document.body.classList.toggle('view-split', v === 'split');
  photoMode = v === 'photos';
  poolPhotos = v === 'photos' || v === 'split';
  render();
}

init();
