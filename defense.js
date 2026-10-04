// defense.js — Build Defense (Rotations page). ADMIN-ONLY hidden feature as
// of 2026-10-04: the commissioner is trialing it before revealing it to the
// other coaches, so both the Rotations button and openBuildDefense() itself
// check canBuildDefense() (TEAM_ADMINS).
//
// Takes the rotation grid currently on screen, splits it into the 5 on-court
// players per quarter, and lets the coach drag each one onto a zone-defense
// spot on a half court — one court per quarter, each quarter with its own
// defensive strategy. Saved per game with the same game-picker pattern as
// "Apply to Gameboard" (see saveDefenseConfig in firebase.js for where the
// docs live and why they stay invisible to the existing rotation reads).
//
// Designed as a standalone Artifact first, then ported here — see
// _local/PROJECT_STATUS.md's build log entry for the decision history.
import { photoUrl, COL } from './players-data.js';
import { getCurrentCoach } from './coach-login.js';
import { TEAM_ADMINS, resolvedJerseyNumber } from './coaches-config.js';
import { getDefenseConfigsForTeam, saveDefenseConfig } from './firebase.js';

// ── Defense layouts ────────────────────────────────────────────────────────
// Court coordinates are feet×10 on a 500×470 half court, basket at the
// bottom. A new scheme is a new entry here (plus SCHEME_ORDER). Spot numbers
// (1-5) are what Auto Insert fills and what's preserved when a quarter
// switches schemes; spot ids are what gets saved.
export const DEFENSE_LAYOUTS = {
  '2-3': {
    name: '2–3 Zone',
    spots: [
      { id: 'g1', no: 1, label: 'Guard',  x: 180, y: 228 },
      { id: 'g2', no: 2, label: 'Guard',  x: 320, y: 228 },
      { id: 'w3', no: 3, label: 'Wing',   x: 112, y: 372 },
      { id: 'w4', no: 4, label: 'Wing',   x: 388, y: 372 },
      { id: 'c5', no: 5, label: 'Center', x: 250, y: 384 },
    ],
  },
  '1-3-1': {
    name: '1–3–1 Zone',
    spots: [
      { id: 'p1', no: 1, label: 'Point',    x: 250, y: 178 },
      { id: 'w2', no: 2, label: 'Wing',     x: 112, y: 270 },
      { id: 'm3', no: 3, label: 'Middle',   x: 250, y: 292 },
      { id: 'w4', no: 4, label: 'Wing',     x: 388, y: 270 },
      { id: 'b5', no: 5, label: 'Baseline', x: 250, y: 392 },
    ],
  },
  '3-2': {
    name: '3–2 Zone',
    spots: [
      { id: 't1', no: 1, label: 'Top',  x: 250, y: 196 },
      { id: 'w2', no: 2, label: 'Wing', x: 120, y: 262 },
      { id: 'w3', no: 3, label: 'Wing', x: 380, y: 262 },
      { id: 'p4', no: 4, label: 'Post', x: 178, y: 384 },
      { id: 'p5', no: 5, label: 'Post', x: 322, y: 384 },
    ],
  },
};
const SCHEME_ORDER = ['2-3', '1-3-1', '3-2'];
const DEFAULT_SCHEME = '2-3';

// Same palette + hash as rotations.js's playerColor(), so a player's
// initials badge is the same color on both screens.
const INITIALS_COLORS = ['#4f8ef7', '#4ecf87', '#e0a75c', '#e05c5c', '#9b6fe0', '#5cc7e0', '#e05c9e', '#8890a8'];

export function canBuildDefense() {
  const coach = getCurrentCoach();
  return !!coach && TEAM_ADMINS.includes(coach.name);
}

// ── State ──────────────────────────────────────────────────────────────────
// ctx: { team, teamLabel, playersById, order, pattern (plain obj), presentIds,
//        lineups: [[id × ≤5] × 4], loadGames }
// quarters[q] = { scheme, spots: { spotId: playerId } } — the saved shape.
let ctx = null;
let quarters = [];
let selected = null;           // { q, pid } — tap-to-place selection
let flipped = false;           // Flip Grid: court rotated 180° (second-half view)
let avatarStyle = 'photo';     // 'photo' | 'initials'
let firstNameCounts = {};
let built = false;

const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full/blocked */ } };
const draftKey = team => `defense_${team}`;

// ── Entry point ────────────────────────────────────────────────────────────
// source: { team, teamLabel, order, pattern: Map, absent: Set, playersById,
//           loadGames: async () => [{ sheetGameNum, displayNum, opponentTeam, label }] }
export function openBuildDefense(source) {
  if (!canBuildDefense()) return;
  buildDomOnce();

  const presentIds = source.order.filter(id => !source.absent.has(id));
  // Same "on court" rule the rotation grid uses: marked on for that quarter
  // and not absent, in the grid's tile order.
  const lineups = [0, 1, 2, 3].map(q => presentIds.filter(id => (source.pattern.get(id) || [])[q]));
  ctx = {
    team: source.team,
    teamLabel: source.teamLabel,
    playersById: source.playersById,
    order: [...source.order],
    pattern: Object.fromEntries([...source.pattern.entries()].map(([id, p]) => [id, [...p]])),
    presentIds,
    lineups,
    loadGames: source.loadGames,
  };

  firstNameCounts = {};
  presentIds.forEach(id => {
    const f = firstName(id);
    firstNameCounts[f] = (firstNameCounts[f] || 0) + 1;
  });

  quarters = loadDraft(source.team);
  selected = null;
  flipped = lsGet('defense_flip') === true;
  avatarStyle = lsGet('defense_avatarStyle') === 'initials' ? 'initials' : 'photo';

  document.getElementById('bd-team').textContent = ctx.teamLabel;
  syncControls();
  render();
  document.getElementById('bd-view').classList.remove('hidden');
  document.body.classList.add('bd-open');
  document.getElementById('bd-view').scrollTop = 0;

  if (lineups.every(l => l.length === 0)) {
    toast('No one is on court in this rotation yet. Fill in the grid first.');
  }
}

function closeBuildDefense() {
  document.getElementById('bd-view').classList.add('hidden');
  document.body.classList.remove('bd-open');
  selected = null;
}

// The draft (unsaved placements) is kept per team on this device, the same
// way the rotation grid itself is. On open it's reconciled against the
// CURRENT grid: anyone no longer on court in a quarter drops off that court.
function loadDraft(team) {
  const raw = lsGet(draftKey(team));
  return [0, 1, 2, 3].map(q => {
    const src = Array.isArray(raw) ? raw[q] : null;
    const scheme = src && DEFENSE_LAYOUTS[src.scheme] ? src.scheme : DEFAULT_SCHEME;
    const validSpots = new Set(DEFENSE_LAYOUTS[scheme].spots.map(s => s.id));
    const spots = {};
    if (src && src.spots) {
      for (const [sid, pid] of Object.entries(src.spots)) {
        if (validSpots.has(sid) && ctx.lineups[q].includes(pid)) spots[sid] = pid;
      }
    }
    return { scheme, spots };
  });
}

function persist() { lsSet(draftKey(ctx.team), quarters); }

// ── Player helpers ───────────────────────────────────────────────────────────
function playerName(id) { return (ctx.playersById[id] && ctx.playersById[id][COL.NAME]) || '?'; }
function firstName(id) { return playerName(id).split(/\s+/)[0] || '?'; }
// First name only on screen (jersey #/ID are never shown here — they only
// drive Auto Insert). Two teammates sharing a first name get a last initial.
function displayName(id) {
  const f = firstName(id);
  if ((firstNameCounts[f] || 0) < 2) return f;
  const last = playerName(id).split(/\s+/)[1];
  return last ? `${f} ${last[0]}.` : f;
}
function initials(id) {
  return playerName(id).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function initialsColor(id) {
  const idx = [...String(id)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % INITIALS_COLORS.length;
  return INITIALS_COLORS[idx];
}
function jerseyOf(id) {
  const p = ctx.playersById[id];
  return p ? resolvedJerseyNumber(ctx.team, p._jerseyByCoach) : null;
}
function avatarHTML(id) {
  const p = ctx.playersById[id];
  const photo = avatarStyle === 'photo' && p ? photoUrl(p) : null;
  if (photo) {
    // Initials sit underneath the photo; a photo that fails to load (missing
    // Drive file) removes itself and the initials badge shows instead.
    return `<div class="bd-av bd-av-photo" style="background:${initialsColor(id)}">${escHtml(initials(id))}<img src="${escHtml(photo)}" alt="" draggable="false" onerror="this.remove()" /></div>`;
  }
  return `<div class="bd-av" style="background:${initialsColor(id)}">${escHtml(initials(id))}</div>`;
}

const spotOf = (q, pid) => Object.keys(quarters[q].spots).find(s => quarters[q].spots[s] === pid) || null;
const spotDef = (q, sid) => DEFENSE_LAYOUTS[quarters[q].scheme].spots.find(s => s.id === sid);

// ── DOM ──────────────────────────────────────────────────────────────────────
function buildDomOnce() {
  if (built) return;
  built = true;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="bd-view" class="bd-view hidden" role="dialog" aria-modal="true" aria-labelledby="bd-title">
      <div class="bd-wrap">
        <div class="bd-topbar">
          <div class="bd-title-block">
            <div class="bd-eyebrow">Rotations › Build Defense <span class="bd-admin-pill">Admins only · hidden from coaches</span></div>
            <h1 id="bd-title" class="bd-title">Build Defense</h1>
            <div id="bd-team" class="bd-sub"></div>
          </div>
          <div class="bd-controls">
            <button type="button" class="bd-switch" id="bd-flip" role="switch" aria-checked="false" title="Rotate the court 180° to see the second-half view after teams switch baskets">
              <span class="bd-switch-track"><span class="bd-switch-knob"></span></span>Flip Grid
            </button>
            <div class="bd-toggle" role="group" aria-label="Avatar style">
              <span class="bd-bar-label">Avatars:</span>
              <button type="button" class="bd-toggle-btn" data-style="photo">Photo</button>
              <button type="button" class="bd-toggle-btn" data-style="initials">Initials</button>
            </div>
          </div>
        </div>
        <div class="bd-howto"><b>Drag</b> a face onto a spot to place them. Drag between spots to swap, or back to the lineup column to clear. On a phone you can also <b>tap a face, then tap a spot</b>. Each quarter picks its own defense. <b>Flip Grid</b> turns the court around for the switch at halftime. <b>Auto Insert</b> fills every quarter by jersey number, lowest at spot 1.</div>
        <div id="bd-quarters" class="bd-quarters"></div>
      </div>
      <div class="bd-actionbar">
        <button class="btn-secondary" id="bd-back" type="button">← Back to Rotation</button>
        <button class="btn-secondary" id="bd-auto" type="button">🔢 Auto Insert</button>
        <button class="btn-primary" id="bd-save" type="button">🛡️ Save Defense to Games</button>
      </div>
    </div>

    <div id="bd-modal-auto" class="modal-overlay bd-modal hidden">
      <div class="modal-box">
        <h2>Replace Current Placements?</h2>
        <p class="rot-suggestions-hint">Auto Insert fills all four quarters by jersey number, lowest at spot 1 through highest at spot 5. Players without a jersey number go by ID number. The placements already on the board will be replaced.</p>
        <div class="modal-actions">
          <button id="bd-auto-cancel" class="btn-secondary" type="button">Cancel</button>
          <button id="bd-auto-ok" class="btn-primary" type="button">Auto Insert</button>
        </div>
      </div>
    </div>

    <div id="bd-modal-save" class="modal-overlay bd-modal hidden">
      <div class="modal-box">
        <h2>Save Defense to Games</h2>
        <p class="rot-suggestions-hint">Choose which game(s) this defense should be saved to. Games already showing a saved defense will be overwritten if check-marked.</p>
        <button id="bd-save-selall" class="apply-gameboard-select-all" type="button">Select All</button>
        <div id="bd-save-list" class="apply-gameboard-list"></div>
        <p id="bd-save-empty" class="loading hidden">This team has no scheduled games yet.</p>
        <div class="modal-actions">
          <button id="bd-save-cancel" class="btn-secondary" type="button">Cancel</button>
          <button id="bd-save-confirm" class="btn-primary" type="button">Save</button>
        </div>
      </div>
    </div>

    <div id="bd-modal-warn" class="modal-overlay bd-modal hidden">
      <div class="modal-box">
        <h2>Overwrite Saved Defenses?</h2>
        <p id="bd-warn-text"></p>
        <div class="modal-actions">
          <button id="bd-warn-cancel" class="btn-secondary" type="button">Cancel</button>
          <button id="bd-warn-ok" class="btn-primary" type="button">Overwrite</button>
        </div>
      </div>
    </div>

    <div id="bd-toast" class="bd-toast hidden" role="status"></div>
  `);
  wireDom();
}

function syncControls() {
  document.getElementById('bd-flip').setAttribute('aria-checked', String(flipped));
  document.querySelectorAll('.bd-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.style === avatarStyle));
}

function courtSVG() {
  // Basket 5.25ft from baseline; 3pt arc 23.75ft; corners 3ft in from the
  // sidelines. Flip Grid rotates the line work 180°; the ball and its
  // caption are drawn outside the rotated group so they stay upright.
  const L = 'stroke="var(--bd-court-line)" stroke-width="2.5" fill="none"';
  const ball = flipped ? { y: 350, ty: 384, text: 'BALL' } : { y: 120, ty: 96, text: 'BALL AT TOP' };
  return `<svg viewBox="0 0 500 470" aria-hidden="true">
    <g${flipped ? ' transform="rotate(180 250 235)"' : ''}>
      <rect x="1.5" y="1.5" width="497" height="467" rx="4" fill="var(--bd-court)" stroke="var(--bd-court-line)" stroke-width="3"/>
      <path d="M190 1.5 A60 60 0 0 0 310 1.5" ${L}/>
      <rect x="170" y="280" width="160" height="188.5" fill="var(--bd-paint)" stroke="var(--bd-court-line)" stroke-width="2.5"/>
      <path d="M190 280 A60 60 0 0 1 310 280" ${L}/>
      <path d="M190 280 A60 60 0 0 0 310 280" ${L} stroke-dasharray="7 7"/>
      <path d="M30 468.5 L30 328 A237.5 237.5 0 0 1 470 328 L470 468.5" ${L}/>
      <path d="M210 430 A40 40 0 0 0 290 430" ${L}/>
      <line x1="220" y1="430" x2="280" y2="430" stroke="var(--bd-court-line)" stroke-width="4"/>
      <circle cx="250" cy="417.5" r="9" fill="none" stroke="var(--bd-ball)" stroke-width="2.5"/>
    </g>
    <circle cx="250" cy="${ball.y}" r="10" fill="var(--bd-ball)"/>
    <text x="250" y="${ball.ty}" text-anchor="middle" font-size="13" font-weight="700" letter-spacing="1.5" fill="var(--clr-muted)" font-family="Segoe UI, system-ui, sans-serif">${ball.text}</text>
  </svg>`;
}

function render() {
  document.getElementById('bd-quarters').innerHTML = [0, 1, 2, 3].map(quarterHTML).join('');
}

function quarterHTML(q) {
  const lineup = ctx.lineups[q];
  const layout = DEFENSE_LAYOUTS[quarters[q].scheme];
  const placed = lineup.filter(pid => spotOf(q, pid)).length;
  const need = Math.min(lineup.length, layout.spots.length);
  const done = need > 0 && placed === need;
  const chipClass = done ? 'bd-chip-done' : placed > 0 ? 'bd-chip-short' : '';
  const chipText = done ? `All ${need} placed` : `${placed} of ${need} placed`;

  const tiles = lineup.length
    ? lineup.map(pid => {
        const s = spotOf(q, pid);
        const sel = selected && selected.q === q && selected.pid === pid && !s ? ' bd-selected' : '';
        return `<button type="button" class="bd-tile${sel}" data-q="${q}" data-pid="${escHtml(pid)}" aria-label="${escHtml(playerName(pid))}${s ? ', at spot ' + spotDef(q, s).no : ''}">
          ${avatarHTML(pid)}<span class="bd-nm">${escHtml(displayName(pid))}</span>${s ? `<span class="bd-spotno">${spotDef(q, s).no}</span>` : ''}
        </button>`;
      }).join('')
    : '<div class="bd-empty-note">No one on court this quarter</div>';

  const spots = layout.spots.map(s => {
    const pid = quarters[q].spots[s.id];
    const x = flipped ? 500 - s.x : s.x;
    const y = flipped ? 470 - s.y : s.y;
    const pos = `left:${(x / 500 * 100).toFixed(2)}%;top:${(y / 470 * 100).toFixed(2)}%`;
    const sel = pid && selected && selected.q === q && selected.pid === pid ? ' bd-selected' : '';
    const inner = pid
      ? `<div class="bd-token${sel}" data-q="${q}" data-pid="${escHtml(pid)}">${avatarHTML(pid)}<span class="bd-badge">${s.no}</span></div>`
      : `<div class="bd-ring">${s.no}</div>`;
    return `<button type="button" class="bd-spot${pid ? ' bd-filled' : ''}" style="${pos}" data-q="${q}" data-spot="${s.id}" aria-label="Spot ${s.no} ${s.label}${pid ? ': ' + escHtml(playerName(pid)) : ', empty'}">
      ${inner}<span class="bd-spot-label">${pid ? escHtml(displayName(pid)) : s.label}</span>
    </button>`;
  }).join('');

  return `<section class="bd-qcard" data-q="${q}">
    <div class="bd-qhead">
      <span class="bd-qname">Q${q + 1}</span>
      <span class="bd-chip ${chipClass}">${chipText}</span>
      <div class="bd-qactions">
        <label class="bd-strategy-label" for="bd-scheme-q${q}">DEFENSIVE STRATEGY:</label>
        <select id="bd-scheme-q${q}" class="bd-scheme" data-scheme-q="${q}">
          ${SCHEME_ORDER.map(k => `<option value="${k}"${k === quarters[q].scheme ? ' selected' : ''}>${DEFENSE_LAYOUTS[k].name}</option>`).join('')}
          <option disabled>Man-to-Man (later)</option>
        </select>
        <button type="button" class="bd-btn-ghost" data-act="clear" data-q="${q}" ${placed ? '' : 'disabled'}>Clear</button>
      </div>
    </div>
    <div class="bd-qbody">
      <div class="bd-lineup" data-q="${q}" data-lineup="1"><div class="bd-lineup-label">Lineup</div>${tiles}</div>
      <div class="bd-court">${courtSVG()}${spots}</div>
    </div>
  </section>`;
}

// ── Mutations ────────────────────────────────────────────────────────────────
function place(q, pid, targetSpot) {
  const a = quarters[q].spots;
  const from = spotOf(q, pid);
  const occupant = a[targetSpot];
  if (from === targetSpot) return;
  if (from) delete a[from];
  a[targetSpot] = pid;
  // Swap: whoever held the target moves to the dragged player's old spot
  // (or back to the lineup if the dragged player came from the lineup).
  if (occupant && occupant !== pid && from) a[from] = occupant;
  persist();
}

function unplace(q, pid) {
  const s = spotOf(q, pid);
  if (s) { delete quarters[q].spots[s]; persist(); }
}

// Auto Insert: per quarter, lowest jersey # -> spot 1 ... highest -> spot 5
// (jerseys are handed out roughly by size). Players with no resolved jersey
// # follow the numbered players, ordered by ID #.
function autoInsertOrder(a, b) {
  const ja = jerseyOf(a), jb = jerseyOf(b);
  if (ja != null && jb != null) return ja - jb;
  if (ja != null) return -1;
  if (jb != null) return 1;
  return Number(a) - Number(b);
}

function autoInsert() {
  for (let q = 0; q < 4; q++) {
    const sorted = [...ctx.lineups[q]].sort(autoInsertOrder);
    const spots = [...DEFENSE_LAYOUTS[quarters[q].scheme].spots].sort((a, b) => a.no - b.no);
    quarters[q].spots = {};
    sorted.slice(0, spots.length).forEach((pid, i) => { quarters[q].spots[spots[i].id] = pid; });
  }
  selected = null;
  persist();
  render();
  toast('Filled all quarters by jersey number. Drag to adjust.');
}

// Changing a quarter's defense keeps each player on the same spot NUMBER.
function changeScheme(q, scheme) {
  const oldSpots = DEFENSE_LAYOUTS[quarters[q].scheme].spots;
  const newSpots = DEFENSE_LAYOUTS[scheme].spots;
  const next = {};
  for (const [sid, pid] of Object.entries(quarters[q].spots)) {
    const no = oldSpots.find(s => s.id === sid)?.no;
    const target = newSpots.find(s => s.no === no);
    if (target) next[target.id] = pid;
  }
  quarters[q] = { scheme, spots: next };
  selected = null;
  persist();
  render();
}

// ── Interaction wiring ───────────────────────────────────────────────────────
let drag = null;
let suppressClick = false;

function wireDom() {
  const view = document.getElementById('bd-view');

  // Drag via pointer events, so mouse and touch share one path. A move under
  // 6px is a tap and falls through to the click handler (tap-to-place).
  view.addEventListener('pointerdown', e => {
    const src = e.target.closest('.bd-tile, .bd-token');
    if (!src || e.button > 0) return;
    drag = { q: +src.dataset.q, pid: src.dataset.pid, x0: e.clientX, y0: e.clientY, started: false, ghost: null, hot: null, src };
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.started = true;
      selected = null;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'bd-ghost';
      drag.ghost.innerHTML = avatarHTML(drag.pid);
      document.body.appendChild(drag.ghost);
      drag.src.style.opacity = '.25';
    }
    e.preventDefault();
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    const hit = dropTargetAt(e.clientX, e.clientY, drag.q);
    if (hit !== drag.hot) {
      if (drag.hot) drag.hot.classList.remove('bd-drop-hot');
      drag.hot = hit;
      if (hit) hit.classList.add('bd-drop-hot');
    }
  }, { passive: false });
  document.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.started) return;
    d.ghost.remove();
    if (d.hot) d.hot.classList.remove('bd-drop-hot');
    const hit = dropTargetAt(e.clientX, e.clientY, d.q);
    if (hit && hit.dataset.spot) place(d.q, d.pid, hit.dataset.spot);
    else if (hit && hit.dataset.lineup) unplace(d.q, d.pid);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    render();
  });
  document.addEventListener('pointercancel', () => {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    drag = null;
    render();
  });

  view.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'clear') {
        quarters[+act.dataset.q].spots = {};
        selected = null;
        persist();
        render();
      }
      return;
    }
    const token = e.target.closest('.bd-token');
    const spot = e.target.closest('.bd-spot');
    const tile = e.target.closest('.bd-tile');
    const lineup = e.target.closest('.bd-lineup');

    // Tap a placed player to pick them up — unless another player in the
    // same quarter is already picked up, in which case the tap is a drop.
    if (token && !(selected && selected.q === +token.dataset.q && selected.pid !== token.dataset.pid)) {
      const same = selected && selected.q === +token.dataset.q && selected.pid === token.dataset.pid;
      selected = same ? null : { q: +token.dataset.q, pid: token.dataset.pid };
      render();
      return;
    }
    if (spot && selected && selected.q === +spot.dataset.q) {
      place(selected.q, selected.pid, spot.dataset.spot);
      selected = null;
      render();
      return;
    }
    if (tile) {
      const q = +tile.dataset.q, pid = tile.dataset.pid;
      if (selected && selected.q === q && selected.pid !== pid && spotOf(q, selected.pid)) {
        // A placed player is picked up and a lineup face is tapped: that
        // lineup player takes the picked-up player's spot.
        place(q, pid, spotOf(q, selected.pid));
        selected = null;
        render();
        return;
      }
      const same = selected && selected.q === q && selected.pid === pid;
      selected = same ? null : { q, pid };
      render();
      return;
    }
    if (lineup && selected && selected.q === +lineup.dataset.q) {
      unplace(selected.q, selected.pid);
      selected = null;
      render();
    }
  });

  view.addEventListener('change', e => {
    const sel = e.target.closest('[data-scheme-q]');
    if (sel) changeScheme(+sel.dataset.schemeQ, sel.value);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || view.classList.contains('hidden')) return;
    if (document.querySelector('.bd-modal:not(.hidden)')) return;
    if (selected) { selected = null; render(); }
  });

  document.getElementById('bd-flip').addEventListener('click', () => {
    flipped = !flipped;
    lsSet('defense_flip', flipped);
    syncControls();
    render();
  });
  document.querySelectorAll('.bd-toggle-btn').forEach(btn => btn.addEventListener('click', () => {
    avatarStyle = btn.dataset.style;
    lsSet('defense_avatarStyle', avatarStyle);
    syncControls();
    render();
  }));

  document.getElementById('bd-back').addEventListener('click', closeBuildDefense);

  const autoModal = document.getElementById('bd-modal-auto');
  document.getElementById('bd-auto').addEventListener('click', () => {
    if (quarters.some(x => Object.keys(x.spots).length)) autoModal.classList.remove('hidden');
    else autoInsert();
  });
  document.getElementById('bd-auto-cancel').addEventListener('click', () => autoModal.classList.add('hidden'));
  document.getElementById('bd-auto-ok').addEventListener('click', () => { autoModal.classList.add('hidden'); autoInsert(); });

  wireSaveModals();

  document.querySelectorAll('.bd-modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) m.classList.add('hidden');
  }));
}

// A player only belongs to their own quarter, so only that quarter's spots
// and lineup column accept the drop.
function dropTargetAt(x, y, q) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const t = el.closest('.bd-spot, .bd-lineup');
  return t && +t.dataset.q === q ? t : null;
}

// ── Save to games (same picker pattern as Apply to Gameboard) ────────────────
let pickerGames = [];
let pendingSave = [];

function wireSaveModals() {
  const saveModal = document.getElementById('bd-modal-save');
  const warnModal = document.getElementById('bd-modal-warn');

  document.getElementById('bd-save').addEventListener('click', openSaveModal);
  document.getElementById('bd-save-cancel').addEventListener('click', () => saveModal.classList.add('hidden'));
  document.getElementById('bd-save-selall').addEventListener('click', () => {
    const boxes = [...document.querySelectorAll('#bd-save-list input[type="checkbox"]')];
    const all = boxes.length > 0 && boxes.every(b => b.checked);
    boxes.forEach(b => { b.checked = !all; });
    syncSelectAll();
  });
  document.getElementById('bd-save-confirm').addEventListener('click', async () => {
    pendingSave = [...document.querySelectorAll('#bd-save-list input[type="checkbox"]:checked')]
      .map(b => pickerGames.find(g => String(g.sheetGameNum) === b.dataset.sheetGamenum))
      .filter(Boolean);
    if (!pendingSave.length) { toast('Select at least one game.'); return; }
    saveModal.classList.add('hidden');
    const overwrite = pendingSave.filter(g => g._hasDefense).length;
    if (overwrite) {
      document.getElementById('bd-warn-text').textContent =
        `${overwrite} of the ${pendingSave.length} selected game${pendingSave.length === 1 ? '' : 's'} already ${overwrite === 1 ? 'has' : 'have'} a saved defense. Overwrite ${overwrite === 1 ? 'it' : 'them'}?`;
      warnModal.classList.remove('hidden');
      return;
    }
    await commitSave();
  });
  document.getElementById('bd-warn-cancel').addEventListener('click', () => warnModal.classList.add('hidden'));
  document.getElementById('bd-warn-ok').addEventListener('click', async () => {
    warnModal.classList.add('hidden');
    await commitSave();
  });
}

async function openSaveModal() {
  const coach = getCurrentCoach();
  if (!coach || !canBuildDefense()) { toast('Log in as an admin to save a defense.'); return; }

  const list = document.getElementById('bd-save-list');
  const empty = document.getElementById('bd-save-empty');
  const [games, existing] = await Promise.all([
    ctx.loadGames(),
    getDefenseConfigsForTeam(coach.name, ctx.team),
  ]);
  const saved = new Set(existing.map(c => String(c.defenseTag?.gameNum)));
  pickerGames = games.map(g => ({ ...g, _hasDefense: saved.has(String(g.sheetGameNum)) }));

  empty.classList.toggle('hidden', pickerGames.length > 0);
  // Pre-check games without a saved defense, same as Apply to Gameboard.
  list.innerHTML = pickerGames.map(g => `
    <label class="apply-gameboard-row">
      <span class="apply-gameboard-dot${g._hasDefense ? ' apply-gameboard-dot-valid' : ''}"${g._hasDefense ? ' title="Defense already saved"' : ''}></span>
      <input type="checkbox" data-sheet-gamenum="${escHtml(g.sheetGameNum)}" ${g._hasDefense ? '' : 'checked'} />
      <span class="apply-gameboard-row-label">${escHtml(g.label)}</span>
    </label>`).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', syncSelectAll));
  syncSelectAll();
  document.getElementById('bd-modal-save').classList.remove('hidden');
}

function syncSelectAll() {
  const boxes = [...document.querySelectorAll('#bd-save-list input[type="checkbox"]')];
  document.getElementById('bd-save-selall').textContent =
    boxes.length > 0 && boxes.every(b => b.checked) ? 'Deselect All' : 'Select All';
}

async function commitSave() {
  const coach = getCurrentCoach();
  if (!coach) return;
  const games = pendingSave;
  pendingSave = [];
  try {
    await Promise.all(games.map(g => saveDefenseConfig(coach.name, ctx.team, g.sheetGameNum, {
      kind: 'defense',
      defenseTeam: ctx.team,
      defenseTag: { team: ctx.team, opponentTeam: g.opponentTeam || null, gameNum: g.sheetGameNum },
      title: `${g.label} — Defense`,
      quarters: quarters.map(x => ({ scheme: x.scheme, spots: { ...x.spots } })),
      // Snapshot of the rotation this defense was built from, so a saved
      // defense can be reconstructed later even if the grid has changed.
      rotation: { order: ctx.order, pattern: ctx.pattern, presentIds: ctx.presentIds },
    })));
    toast(`Saved defense to ${games.length} game${games.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('saveDefenseConfig error:', err);
    toast('Saving failed. Check your connection and try again.');
  }
}

// ── Misc ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = document.getElementById('bd-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
