// playoffs.js — Playoffs page: static single-elimination bracket for the
// CSBC JVB League 2026 Summer Tournament playoffs. A standalone event,
// separate from the regular season (no Visitor/Home schedule-sheet rows for
// these games) — per the user's explicit direction, this is a STATIC page
// hardcoded with the seeding + schedule as of 2026-08-11, not wired to
// Firebase. Results get updated by editing PLAYOFF_GAMES below by hand until
// a live-data approach is decided later.
//
// Structure: 12 teams, seeds 1-12. Seeds 5-12 play Round 1 (Tue Aug 11);
// seeds 1-4 get byes straight to Round 2 (Fri Aug 14), each facing a Round 1
// winner. Two parallel brackets (Playoff A: seeds 1,4,5,8,9,12 / Playoff B:
// seeds 2,3,6,7,10,11) converge at the Semifinals (Thu Sep 3), which feed the
// Championship (Wed Sep 9).
import { TEAM_COLORS } from './coaches-config.js';
import { buildIconIndex, iconUrl } from './players-data.js';

// Seed (1-12, per the official playoff rankings image) -> team color name,
// which is the canonical key into TEAM_COLORS/iconUrl throughout the app.
const SEED_TEAM = {
  1: 'True Red', 2: 'Deep Orange', 3: 'Black', 4: 'Gold',
  5: 'Forest Green', 6: 'White', 7: 'Grey Concrete', 8: 'Maroon',
  9: 'Purple', 10: 'Neon Yellow', 11: 'Lime Shock', 12: 'Carolina Blue',
};

function teamColorEntry(colorName) {
  return Object.values(TEAM_COLORS).find(v => v.name === colorName) || null;
}

// Each game: seedA/seedB (fixed matchup) OR feederA/feederB (references another
// game's winner) — never both. `result: { winnerSeed, scoreA, scoreB }` is
// null until manually filled in after a game is played.
const PLAYOFF_GAMES = {
  // Round 1 — Tue Aug 11
  r1_9v8:   { round: 1, bracket: 'A', seedA: 9,  seedB: 8,  when: 'Tue Aug 11', time: '6:00 PM',  location: 'Gym East', result: null },
  r1_12v5:  { round: 1, bracket: 'A', seedA: 12, seedB: 5,  when: 'Tue Aug 11', time: '6:50 PM',  location: 'Gym East', result: null },
  r1_11v6:  { round: 1, bracket: 'B', seedA: 11, seedB: 6,  when: 'Tue Aug 11', time: '7:40 PM',  location: 'Gym East', result: null },
  r1_10v7:  { round: 1, bracket: 'B', seedA: 10, seedB: 7,  when: 'Tue Aug 11', time: '8:30 PM',  location: 'Gym East', result: null },

  // Round 2 — Fri Aug 14 (seeds 1-4 enter)
  r2_1:     { round: 2, bracket: 'A', seedA: 1, feederB: 'r1_9v8',  when: 'Fri Aug 14', time: '6:00 PM', location: 'Gym West',   result: null },
  r2_4:     { round: 2, bracket: 'A', seedA: 4, feederB: 'r1_12v5', when: 'Fri Aug 14', time: '6:50 PM', location: 'Gym West',   result: null },
  r2_3:     { round: 2, bracket: 'B', seedA: 3, feederB: 'r1_11v6', when: 'Fri Aug 14', time: '6:00 PM', location: 'Gym Middle', result: null },
  r2_2:     { round: 2, bracket: 'B', seedA: 2, feederB: 'r1_10v7', when: 'Fri Aug 14', time: '6:50 PM', location: 'Gym Middle', result: null },

  // Semifinals — Thu Sep 3
  semiA:    { round: 3, bracket: 'A', feederA: 'r2_1', feederB: 'r2_4', when: 'Thu Sep 3', time: '6:00 PM', location: 'Gym East', result: null },
  semiB:    { round: 3, bracket: 'B', feederA: 'r2_3', feederB: 'r2_2', when: 'Thu Sep 3', time: '6:50 PM', location: 'Gym West', result: null },

  // Championship — Wed Sep 9
  champ:    { round: 4, bracket: null, feederA: 'semiA', feederB: 'semiB', when: 'Wed Sep 9', time: '6:30 PM', location: 'Gym Middle', result: null },
};

// Resolves a game slot's "side" (a fixed seed, or the winner of a feeder game,
// or still-open) into a render-ready shape.
function resolveSide(game, side) {
  const seedKey = side === 'A' ? 'seedA' : 'seedB';
  const feederKey = side === 'A' ? 'feederA' : 'feederB';

  if (game[seedKey] != null) {
    return { known: true, seed: game[seedKey], team: SEED_TEAM[game[seedKey]] };
  }
  const feederId = game[feederKey];
  const feeder = PLAYOFF_GAMES[feederId];
  if (feeder?.result) {
    const winnerSeed = feeder.result.winnerSeed;
    return { known: true, seed: winnerSeed, team: SEED_TEAM[winnerSeed], fromFeeder: feederId };
  }
  return { known: false, feederId, feederRound: feeder?.round };
}

function teamChipHtml(team, opts = {}) {
  const info = teamColorEntry(team);
  const icon = iconUrl(team);
  const sizeClass = opts.size === 'lg' ? 'pg-chip-lg' : '';
  return `
    <span class="pg-chip ${sizeClass}">
      ${icon
        ? `<img src="${icon}" alt="" class="pg-chip-icon" />`
        : `<span class="pg-chip-swatch" style="background:${info?.hex || '#888'}"></span>`}
    </span>`;
}

function cardWhenHtml(game) {
  return `<div class="pg-card-when"><span class="pg-day">${game.when}</span> · ${game.time}</div>`;
}

function sideRowHtml(game, side, gameId) {
  const resolved = resolveSide(game, side);
  const result = game.result;

  if (!resolved.known) {
    return `
      <div class="pg-label-slot">
        <div class="pg-winner-of">Winner of <b>Round ${resolved.feederRound}</b></div>
      </div>`;
  }

  const teamName = resolved.team;
  const info = teamColorEntry(teamName);
  const label = info?.shortName || teamName;

  if (!result) {
    return `<div class="pg-team-row pg-upcoming">${teamChipHtml(teamName)}${label}</div>`;
  }

  const isWinner = result.winnerSeed === resolved.seed;
  const score = side === 'A' ? result.scoreA : result.scoreB;
  if (isWinner) {
    return `<div class="pg-team-row pg-win">${teamChipHtml(teamName)}${label}<span class="pg-score">${score}</span></div>`;
  }
  return `<div class="pg-team-row pg-lose">${teamChipHtml(teamName)}${label}<span class="pg-score">${score}</span></div>`;
}

function towerCardHtml(gameId) {
  const game = PLAYOFF_GAMES[gameId];
  return `
    <div class="pg-card ${game.round === 2 ? 'pg-card-r2' : ''}">
      ${cardWhenHtml(game)}
      ${sideRowHtml(game, 'A', gameId)}
      ${sideRowHtml(game, 'B', gameId)}
    </div>`;
}

function semiCardHtml(gameId) {
  const game = PLAYOFF_GAMES[gameId];
  return `
    <div class="pg-semi-card">
      ${cardWhenHtml(game)}
      ${sideRowHtml(game, 'A', gameId)}
      ${sideRowHtml(game, 'B', gameId)}
    </div>`;
}

function arrowHtml(bracket, direction) {
  const bracketClass = bracket === 'B' ? 'pg-arrow-b' : '';
  const dirClass = direction === 'left' ? 'pg-arrow-left' : 'pg-arrow-right';
  return `<div class="pg-arrow ${bracketClass} ${dirClass}"><div class="pg-arrow-stem"></div><div class="pg-arrow-head"></div></div>`;
}

function renderDesktopBracket() {
  const el = document.getElementById('pg-desktop-bracket');
  el.innerHTML = `
    <div class="pg-stage">
      <div class="pg-towers-row">
        <div class="pg-tower pg-tower-left">
          <div class="pg-bracket-label">Playoff A Bracket</div>
          <div class="pg-round-row">
            ${towerCardHtml('r1_9v8')}
            ${arrowHtml('A', 'right')}
            ${towerCardHtml('r2_1')}
          </div>
          <div class="pg-round-row">
            ${towerCardHtml('r1_12v5')}
            ${arrowHtml('A', 'right')}
            ${towerCardHtml('r2_4')}
          </div>
        </div>

        <div class="pg-center-cell">
          <div class="pg-semis-row">
            <div>${semiCardHtml('semiA')}<div class="pg-semi-label">Semi A</div></div>
            <div>${semiCardHtml('semiB')}<div class="pg-semi-label">Semi B</div></div>
          </div>
        </div>

        <div class="pg-tower pg-tower-right">
          <div class="pg-bracket-label">Playoff B Bracket</div>
          <div class="pg-round-row">
            ${towerCardHtml('r1_11v6')}
            ${arrowHtml('B', 'left')}
            ${towerCardHtml('r2_3')}
          </div>
          <div class="pg-round-row">
            ${towerCardHtml('r1_10v7')}
            ${arrowHtml('B', 'left')}
            ${towerCardHtml('r2_2')}
          </div>
        </div>
      </div>

      <div class="pg-below-grid">
        <div class="pg-drop"><div class="pg-drop-stem"></div><div class="pg-drop-arrowhead"></div></div>
        <div class="pg-champ">
          <div class="pg-champ-trophy">&#127942;</div>
          <div class="pg-champ-label">Championship</div>
          <div class="pg-champ-when">Wed, Sep 9 · 6:30 PM · Gym Middle</div>
        </div>
      </div>
    </div>`;
}

function ladderGameCardHtml(gameId, label) {
  const game = PLAYOFF_GAMES[gameId];
  const hasResult = !!game.result;
  const railClass = hasResult ? 'pg-rail-done' : 'pg-rail-tbd';
  return `
    <div class="pg-ladder-card">
      <div class="pg-rail ${railClass}"></div>
      <div class="pg-ladder-top">
        <span class="pg-ladder-tag">${label}</span>
        <span class="pg-ladder-when">${game.when} · ${game.time}</span>
      </div>
      ${sideRowHtml(game, 'A', gameId)}
      ${sideRowHtml(game, 'B', gameId)}
    </div>`;
}

function renderMobileLadder() {
  const el = document.getElementById('pg-mobile-ladder');
  el.innerHTML = `
    <div class="pg-ladder-round">
      <div class="pg-ladder-round-title"><span class="pg-round-num">1</span><div><h3>Round 1</h3><div class="pg-round-sub">Tuesday, August 11 · Gym East</div></div></div>
      ${ladderGameCardHtml('r1_9v8', 'PLAYOFF A')}
      ${ladderGameCardHtml('r1_12v5', 'PLAYOFF A')}
      ${ladderGameCardHtml('r1_11v6', 'PLAYOFF B')}
      ${ladderGameCardHtml('r1_10v7', 'PLAYOFF B')}
    </div>
    <div class="pg-ladder-round">
      <div class="pg-ladder-round-title"><span class="pg-round-num">2</span><div><h3>Round 2</h3><div class="pg-round-sub">Friday, August 14 · Seeds 1-4 enter</div></div></div>
      ${ladderGameCardHtml('r2_1', 'PLAYOFF A')}
      ${ladderGameCardHtml('r2_4', 'PLAYOFF A')}
      ${ladderGameCardHtml('r2_3', 'PLAYOFF B')}
      ${ladderGameCardHtml('r2_2', 'PLAYOFF B')}
    </div>
    <div class="pg-ladder-round">
      <div class="pg-ladder-round-title"><span class="pg-round-num">3</span><div><h3>Semifinals</h3><div class="pg-round-sub">Thursday, September 3</div></div></div>
      ${ladderGameCardHtml('semiA', 'SEMI A')}
      ${ladderGameCardHtml('semiB', 'SEMI B')}
    </div>
    <div class="pg-ladder-round pg-ladder-round-last">
      <div class="pg-ladder-round-title"><span class="pg-round-num">4</span><div><h3>Championship</h3><div class="pg-round-sub">Wednesday, September 9</div></div></div>
      <div class="pg-champ-strip">
        <div class="pg-champ-strip-trophy">&#127942;</div>
        <div class="pg-champ-strip-txt">
          <div class="pg-champ-strip-lbl">Championship Game</div>
          <div class="pg-champ-strip-val">6:30 PM · Gym Middle</div>
        </div>
      </div>
    </div>`;
}

async function init() {
  await buildIconIndex();
  renderDesktopBracket();
  renderMobileLadder();
}

init();
