// playoffs.js — CURRENT season's Playoffs page (Fall 2026, season 26.3).
// Older seasons live on their own frozen pages (playoffs-26.2.html …), linked
// through the Season dropdown — see playoffs-seasons.js for the registry and
// the steps to archive this page when the next season's bracket starts.
//
// Static like Summer's page: seeds and results are hand-entered in SEEDS /
// GAMES below. To record a result, set `win: 'a'` or `win: 'b'` on the game.
// Everything downstream follows automatically: the loser is struck through and
// greyed, the winner's logo grows, later "Winner of …" slots resolve to the
// team, and the semifinal / championship candidate lists drop eliminated teams.
//
// Format (11 teams): seeds 6-11 play Round 1 (Tue Nov 17); seeds 1-5 enter in
// Round 2 (Thu Nov 19) — note 4 vs 5 is a Round 2 game with no Round 1 feeder.
// Playoff A: seeds 1,4,5,8,9. Playoff B: seeds 2,3,6,7,10,11.
import { teamColorsFor } from './coaches-config.js';
import { buildIconIndex, iconUrl } from './players-data.js';
import { mountPlayoffSeasonSelect, redirectToSeasonPage } from './playoffs-seasons.js';

const PLAYOFF_SEASON = '26.3';
const TEAM_COLORS = teamColorsFor(PLAYOFF_SEASON);

// Seed -> team colour name (the key into TEAM_COLORS / iconUrl), from the
// official final standings received 2026-11-17.
const SEEDS = {
  1: 'Black', 2: 'Purple', 3: 'Lime Shock', 4: 'Neon Yellow', 5: 'Maroon',
  6: 'Gold', 7: 'True Red', 8: 'Grey Concrete', 9: 'Carolina Blue',
  10: 'White', 11: 'Burnt Orange',
};

// Each side is a fixed seed, or `from`: the seeds that could fill it.
const GAMES = {
  // Round 1 — final (Tue Nov 17): True Red, Gold and Carolina Blue advance.
  r1_10v7: { bracket: 'B', a: { seed: 10 }, b: { seed: 7 }, win: 'b', day: 'Tue Nov 17', time: '6:00 PM', gym: 'Gym East' },
  r1_11v6: { bracket: 'B', a: { seed: 11 }, b: { seed: 6 }, win: 'b', day: 'Tue Nov 17', time: '6:00 PM', gym: 'Gym Middle' },
  r1_9v8:  { bracket: 'A', a: { seed: 9 },  b: { seed: 8 }, win: 'a', day: 'Tue Nov 17', time: '6:50 PM', gym: 'Gym Middle' },
  // Round 2 — Thu Nov 19
  r2_1:    { bracket: 'A', a: { seed: 1 }, b: { from: [8, 9] },  win: 'b', day: 'Thu Nov 19', time: '6:50 PM', gym: 'Gym Middle' },
  r2_2:    { bracket: 'B', a: { seed: 2 }, b: { from: [7, 10] }, win: 'a', day: 'Thu Nov 19', time: '7:40 PM', gym: 'Gym East' },
  r2_3:    { bracket: 'B', a: { seed: 3 }, b: { from: [6, 11] }, day: 'Thu Nov 19', time: '7:40 PM', gym: 'Gym Middle' },
  r2_4:    { bracket: 'A', a: { seed: 4 }, b: { seed: 5 },       win: 'a', day: 'Thu Nov 19', time: '8:30 PM', gym: 'Gym Middle' },
  // Semifinals — Mon Nov 30
  semiA:   { bracket: 'A', a: { from: [1, 8, 9] },  b: { from: [4, 5] },     day: 'Mon Nov 30', time: '6:50 PM', gym: 'Gym Middle' },
  semiB:   { bracket: 'B', a: { from: [3, 6, 11] }, b: { from: [2, 7, 10] }, day: 'Mon Nov 30', time: '6:50 PM', gym: 'Gym West' },
  // Championship — Wed Dec 2
  champ:   { bracket: null, a: { semi: 'A', from: [1, 8, 9, 4, 5] }, b: { semi: 'B', from: [3, 6, 11, 2, 7, 10] }, day: 'Wed Dec 2', time: '6:15 PM', gym: 'Gym Middle' },
};

const ROUND_1_GAMES = ['r1_10v7', 'r1_11v6', 'r1_9v8'];
const ROUND_2_GAMES = ['r2_1', 'r2_4', 'r2_2', 'r2_3'];

// ── Team lookups ─────────────────────────────────────────────────────────────

// Bracket-card-only short names, on top of coaches-config's shortName. The
// winner row (big logo + green tick) doesn't fit "Carolina Blue (9)" or
// "Neon Yellow (4)" in a 163px card; setting shortName globally would rename it app-wide.
const BRACKET_SHORT = { 'Carolina Blue': 'Carolina', 'Neon Yellow': 'Neon' };

function teamInfo(seed) {
  const name = SEEDS[seed];
  const entry = Object.values(TEAM_COLORS).find(v => v.name === name);
  return { name, short: BRACKET_SHORT[name] || entry?.shortName || name, hex: entry?.hex || '#888' };
}

// White/Neon Yellow etc. need dark letters on their chips; everything else light.
function readableTextColor(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return 'rgba(255,255,255,0.95)';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1a1d27' : 'rgba(255,255,255,0.95)';
}

// Colour block + letter underneath, logo on top. A failed Drive image is
// removed so the letter shows instead of a broken-image icon (Drive image
// URLs get rate-limited — same fallback the Summer page uses).
function chip(seed, cls = '') {
  const t = teamInfo(seed);
  const icon = iconUrl(t.name);
  const edge = t.name === 'Black' || t.name === 'White' ? 'pg-chip-edge' : '';
  return `
    <span class="pg-chip ${edge} ${cls}" style="background:${t.hex}" title="${t.name}">
      <span class="pg-chip-fallback" style="color:${readableTextColor(t.hex)}">${t.short.charAt(0)}</span>
      ${icon ? `<img src="${icon}" alt="" class="pg-chip-icon" loading="lazy" onerror="this.remove()" />` : ''}
    </span>`;
}

const stack = seeds => `<span class="pg-stack">${seeds.map(s => chip(s)).join('')}</span>`;

function orList(seeds) {
  const n = seeds.map(s => teamInfo(s).name);
  return n.length <= 2 ? n.join(' or ') : `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}`;
}

// ── Results ──────────────────────────────────────────────────────────────────
// Any team that has lost a game is out. An undecided slot narrows to the teams
// still alive; once one is left it shows as that team.

const ELIM = new Set();
const live = from => from.filter(s => !ELIM.has(s));

function resolve(side) {
  if (!side.from) return side;
  const f = live(side.from);
  if (!side.semi && f.length === 1) return { seed: f[0] };
  return { ...side, from: f };
}

// Each game's two sides are resolved ONCE, in round order (GAMES is listed
// that way), against the losers of the rounds before it, and kept on the game
// as g.sides. Resolving later against the full ELIM set would drop a team from
// the very game it lost (True Red would vanish from its own Round 2 card).
const seedOf = (g, key) => g.sides[key].seed;
const winnerOf = g => g.win ? seedOf(g, g.win) : null;
const loserOf  = g => g.win ? seedOf(g, g.win === 'a' ? 'b' : 'a') : null;
Object.values(GAMES).forEach(g => {
  g.sides = { a: resolve(g.a), b: resolve(g.b) };
  if (g.win) ELIM.add(loserOf(g));
});

const stateOf = (g, key) => !g.win ? '' : g.win === key ? 'pg-win' : 'pg-lose';

// ── Rendering ────────────────────────────────────────────────────────────────

// side = a game's resolved side (g.sides.a / g.sides.b).
function rowHtml(side, long = false, state = '') {
  if (side.semi) {
    return `<div class="pg-team-row pg-tbd">${stack(side.from)}<span>Winner of <b>Semi ${side.semi}</b></span></div>`;
  }
  if (side.seed != null) {
    const t = teamInfo(side.seed);
    return `<div class="pg-team-row ${state}">${chip(side.seed)}<span class="pg-name">${long ? t.name : t.short}</span><span class="pg-seed">(${side.seed})</span></div>`;
  }
  const label = long ? orList(side.from) : `Winner of <b>${side.from.join(' / ')}</b>`;
  return `<div class="pg-team-row pg-tbd">${stack(side.from)}<span>${label}</span></div>`;
}

function cardHtml(id, r2 = false) {
  const g = GAMES[id];
  return `
    <div class="pg-card ${r2 ? 'pg-card-r2' : ''}" id="card-${id}">
      <div class="pg-card-when"><span><span class="pg-day">${g.day}</span> · ${g.time}</span><span class="pg-gym">${g.gym}</span></div>
      ${rowHtml(g.sides.a, false, stateOf(g, 'a'))}
      ${rowHtml(g.sides.b, false, stateOf(g, 'b'))}
    </div>`;
}

function arrowHtml(bracket, dir) {
  return `<div class="pg-arrow ${bracket === 'B' ? 'pg-arrow-b' : ''} pg-arrow-${dir}"><div class="pg-arrow-stem"></div><div class="pg-arrow-head"></div></div>`;
}

// Semi slot: the Round 2 host team's logo leads, larger; the teams that could
// still take the slot sit beside it. Once Round 2 is played the slot shows the
// team that advanced and who it beat.
function semiRowHtml(side) {
  if (side.seed != null) {
    const seed = side.seed;
    const beat = ROUND_2_GAMES.map(id => GAMES[id]).find(g => winnerOf(g) === seed);
    return `
    <div class="pg-semi-row pg-semi-set">
      <div class="pg-semi-logos">${chip(seed, 'pg-chip-lead')}</div>
      <div class="pg-semi-text">
        <div class="pg-semi-who">${teamInfo(seed).name} <span>(${seed})</span></div>
        <div class="pg-semi-opts">${beat ? `Beat ${teamInfo(loserOf(beat)).name}, ${beat.day}` : 'Advanced'}</div>
      </div>
    </div>`;
  }
  const [host, ...rest] = side.from;
  const hostName = teamInfo(host).name;
  const feeder = Object.values(GAMES).find(x => x.a.seed === host);
  const other = rest.length === 1
    ? teamInfo(rest[0]).name
    : `the ${rest.map(s => teamInfo(s).short).join('/')} winner`;
  return `
    <div class="pg-semi-row">
      <div class="pg-semi-logos">${chip(host, 'pg-chip-lead')}<span class="pg-semi-alts">${rest.map(s => chip(s)).join('')}</span></div>
      <div class="pg-semi-text">
        <div class="pg-semi-who">${hostName} <span>or</span> ${other}</div>
        <div class="pg-semi-opts">Winner of ${feeder.day}, ${feeder.time} game</div>
      </div>
    </div>`;
}

function semiCardHtml(id, title, cls) {
  const g = GAMES[id];
  return `
    <div class="pg-semi-card ${cls}" id="card-${id}">
      <div class="pg-semi-header">
        <div class="pg-semi-icon">&#127936;</div>
        <div class="pg-semi-title">${title}</div>
        <div class="pg-semi-when">${g.day} · ${g.time} · ${g.gym}</div>
      </div>
      <div class="pg-semi-matchup">
        ${semiRowHtml(g.sides.a)}
        ${semiRowHtml(g.sides.b)}
      </div>
    </div>`;
}

function champTeamHtml(side) {
  return `
    <div class="pg-champ-team">
      <div class="pg-champ-team-color">TBD</div>
      <div class="pg-champ-team-tile pg-champ-team-tile-empty">?</div>
      <div class="pg-champ-team-coach">Winner of Semi ${side.semi}</div>
      <div class="pg-champ-pool">${side.from.map(s => chip(s)).join('')}</div>
    </div>`;
}

// "Gold, True Red and Carolina Blue" — winners' seeds, lowest number first.
function andList(ids) {
  const seeds = ids.map(id => winnerOf(GAMES[id])).filter(s => s != null).sort((x, y) => x - y);
  return orList(seeds).replace(/ or ([^,]*)$/, ' and $1');
}

function roundNote(label, ids) {
  const done = ids.filter(id => GAMES[id].win);
  if (!done.length) return '';
  if (done.length === ids.length) return ` <b>${label} is final</b>: ${andList(ids)} advance.`;
  const open = ids.filter(id => !GAMES[id].win).map(id => {
    const g = GAMES[id];
    return `${teamInfo(seedOf(g, 'a')).name} vs ${teamInfo(seedOf(g, 'b')).name}`;
  });
  return ` <b>${label}</b>: ${andList(done)} advance; ${open.join(', ')} result to come.`;
}

function renderNote() {
  document.getElementById('pg-v2-note').innerHTML =
    `Playoff schedule, <b>Nov 17 to Dec 2</b>. Seeds follow the <b>official final standings</b>.` +
    roundNote('Round 1', ROUND_1_GAMES) + roundNote('Round 2', ROUND_2_GAMES);
}

function renderDesktop() {
  const c = GAMES.champ;
  document.getElementById('pg-desktop-bracket').innerHTML = `
    <div class="pg-stage" id="pg-stage">
      <svg class="pg-wires" id="pg-wires" aria-hidden="true"></svg>
      <div class="pg-prelim-tier">
        <div class="pg-bracket-block pg-block-a" id="block-a">
          <div class="pg-bracket-label"><span>Playoff A Bracket</span></div>
          <div class="pg-col-heads"><span>Round 1</span><span></span><span>Round 2</span></div>
          <div class="pg-round-row">${cardHtml('r1_9v8')}${arrowHtml('A', 'right')}${cardHtml('r2_1', true)}</div>
          <div class="pg-round-row">
            <div class="pg-card-ghost">No Round 1 game.<br>${teamInfo(4).name} &amp; ${teamInfo(5).name} open Thursday.</div>
            <div></div>
            ${cardHtml('r2_4', true)}
          </div>
          <div class="pg-elbow-spacer"></div>
        </div>
        <div class="pg-bracket-block pg-block-b" id="block-b">
          <div class="pg-bracket-label"><span>Playoff B Bracket</span></div>
          <div class="pg-col-heads"><span>Round 1</span><span></span><span>Round 2</span></div>
          <div class="pg-round-row">${cardHtml('r1_11v6')}${arrowHtml('B', 'left')}${cardHtml('r2_3', true)}</div>
          <div class="pg-round-row">${cardHtml('r1_10v7')}${arrowHtml('B', 'left')}${cardHtml('r2_2', true)}</div>
          <div class="pg-elbow-spacer"></div>
        </div>
      </div>

      <div class="pg-semis-tier">
        ${semiCardHtml('semiA', 'Semi A', 'pg-semi-a')}
        ${semiCardHtml('semiB', 'Semi B', 'pg-semi-b')}
      </div>

      <div class="pg-champ-drop"><div class="pg-drop-stem"></div><div class="pg-drop-arrowhead"></div></div>
      <div class="pg-champ-row">
        <div class="pg-champ">
          <div class="pg-champ-trophy">&#127942;</div>
          <div class="pg-champ-label">Championship</div>
          <div class="pg-champ-when">${c.day} · ${c.time} · ${c.gym}</div>
          <div class="pg-champ-matchup">
            ${champTeamHtml(c.sides.a)}
            <div class="pg-champ-vs">VS</div>
            ${champTeamHtml(c.sides.b)}
          </div>
        </div>
      </div>
    </div>`;
}

// Round 2 -> Semi wires, measured from the real card positions (unlike the
// Summer page's hand-tuned SVG, this survives card-size changes). Each exits
// the card's inner edge, turns once, and drops into its semi; the top row's
// lane sits farther into the centre gap so the lanes never cross.
function drawWires() {
  const stage = document.getElementById('pg-stage');
  const svg = document.getElementById('pg-wires');
  if (!stage || !svg || stage.offsetParent === null) return;
  const s = stage.getBoundingClientRect();
  const rel = el => {
    const r = el.getBoundingClientRect();
    return { l: r.left - s.left, r: r.right - s.left, t: r.top - s.top, b: r.bottom - s.top };
  };
  const gapL = rel(document.getElementById('block-a')).r;
  const gapR = rel(document.getElementById('block-b')).l;
  const endY = rel(document.getElementById('card-semiA')).t - 12;
  const wires = [
    { id: 'r2_1', side: 'A', lane: gapL + 48, color: 'var(--clr-accent)' },
    { id: 'r2_4', side: 'A', lane: gapL + 20, color: 'var(--clr-accent)' },
    { id: 'r2_3', side: 'B', lane: gapR - 48, color: 'var(--pg-bracket-b)' },
    { id: 'r2_2', side: 'B', lane: gapR - 20, color: 'var(--pg-bracket-b)' },
  ];
  svg.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`);
  svg.innerHTML = wires.map(w => {
    const c = rel(document.getElementById('card-' + w.id));
    const x0 = w.side === 'A' ? c.r : c.l;
    const y0 = (c.t + c.b) / 2;
    return `<path d="M ${x0} ${y0} L ${w.lane} ${y0} L ${w.lane} ${endY}" stroke="${w.color}" stroke-width="3" fill="none" />
            <polygon points="${w.lane - 6},${endY} ${w.lane},${endY + 12} ${w.lane + 6},${endY}" fill="${w.color}" />`;
  }).join('');
}

function ladderCardHtml(id, tag, tagCls = '') {
  const g = GAMES[id];
  return `
    <div class="pg-ladder-card ${id === 'champ' ? 'pg-ladder-champ' : ''}">
      <div class="pg-rail ${g.win ? 'pg-rail-done' : 'pg-rail-tbd'}"></div>
      <div class="pg-ladder-top">
        <span class="pg-ladder-tag ${tagCls}">${tag}</span>
        <span class="pg-ladder-when">${g.day} · ${g.time} · ${g.gym}${g.win ? ' · Final' : ''}</span>
      </div>
      ${rowHtml(g.sides.a, true, stateOf(g, 'a'))}
      ${rowHtml(g.sides.b, true, stateOf(g, 'b'))}
    </div>`;
}

function renderLadder() {
  const round = (n, title, sub, body) => `
    <div class="pg-ladder-round">
      <div class="pg-ladder-round-title"><span class="pg-round-num">${n}</span><div><h3>${title}</h3><div class="pg-round-sub">${sub}</div></div></div>
      ${body}
    </div>`;
  document.getElementById('pg-mobile-ladder').innerHTML =
    round(1, 'Round 1', 'Tuesday, November 17 · Seeds 6-11',
      ladderCardHtml('r1_10v7', 'PLAYOFF B', 'pg-tag-b') +
      ladderCardHtml('r1_11v6', 'PLAYOFF B', 'pg-tag-b') +
      ladderCardHtml('r1_9v8', 'PLAYOFF A')) +
    round(2, 'Round 2', 'Thursday, November 19 · Seeds 1-5 enter',
      ladderCardHtml('r2_1', 'PLAYOFF A') +
      ladderCardHtml('r2_2', 'PLAYOFF B', 'pg-tag-b') +
      ladderCardHtml('r2_3', 'PLAYOFF B', 'pg-tag-b') +
      ladderCardHtml('r2_4', 'PLAYOFF A')) +
    round(3, 'Semifinals', 'Monday, November 30',
      ladderCardHtml('semiA', 'SEMI A') +
      ladderCardHtml('semiB', 'SEMI B', 'pg-tag-b')) +
    round(4, 'Championship', 'Wednesday, December 2',
      ladderCardHtml('champ', 'CHAMPIONSHIP', 'pg-tag-gold'));
}

function render() {
  renderNote();
  renderDesktop();
  renderLadder();
  drawWires();
}

async function init() {
  if (redirectToSeasonPage(PLAYOFF_SEASON)) return;
  mountPlayoffSeasonSelect(PLAYOFF_SEASON);
  // Render once straight away (letter chips), then again once the Drive icon
  // index is in so the logos appear — the bracket never waits on Drive.
  render();
  await buildIconIndex();
  render();
  window.addEventListener('resize', drawWires);
  document.fonts?.ready?.then(drawWires);
}

init();
