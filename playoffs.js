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
import { TEAM_COLORS, TEAMS } from './coaches-config.js';
import { buildIconIndex, buildDriveIndex, iconUrl, photoUrl, fetchPlayers, COL as PLAYER_COL } from './players-data.js';
import { fetchSchedule, COL as SCHED_COL } from './schedule-data.js';
import { getAllScheduleGames, getCompositeRank } from './firebase.js';

// Referenced from an inline onerror= attribute (see rosterPlayerTileHtml) —
// a broken/unreachable Drive image would otherwise leave the browser's
// default broken-image icon on screen instead of falling back to the
// placeholder.
window.__pgSwapAvatarPlaceholder = function (img) {
  const placeholder = document.createElement('div');
  placeholder.className = 'pg-roster-avatar-img pg-roster-avatar-placeholder';
  placeholder.innerHTML = '&#127936;';
  img.replaceWith(placeholder);
};

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

// "Forest Green" -> "Team Andre". TEAM_COLORS is keyed by team name, so this
// is the reverse lookup.
function coachForColor(colorName) {
  const entry = Object.entries(TEAM_COLORS).find(([, v]) => v.name === colorName);
  return entry ? entry[0] : null;
}

// Semis read better as "Semi A" than "Round 3" — there's no calendar-facing
// "Round 3" the way Round 1/2 are named elsewhere on the page.
function feederLabel(feederId, feederRound) {
  if (feederId === 'semiA') return 'Semi A';
  if (feederId === 'semiB') return 'Semi B';
  return `Round ${feederRound}`;
}

// ── Regular-season records, shown under the Championship contenders ─────────
// Same computation the Gameboard's Board view runs (see loadTeamStats there):
// walk the schedule sheet, pair each row with its scheduleGames result, and
// tally W/L plus points for/against. Kept local rather than imported so the
// Playoffs page doesn't pull in the whole Gameboard module.
let seasonStats = {};

async function loadSeasonStats() {
  try {
    const [games, results] = await Promise.all([fetchSchedule(), getAllScheduleGames()]);
    const stats = {};
    TEAMS.filter(t => t !== 'Undrafted').forEach(t => {
      stats[t] = { pointsMade: 0, pointsAllowed: 0, wins: 0, losses: 0 };
    });

    games.forEach(game => {
      const result = results[game[SCHED_COL.GAME]];
      if (!result || result.vScore == null || result.hScore == null) return;
      const vTeam = coachForColor(game[SCHED_COL.V]);
      const hTeam = coachForColor(game[SCHED_COL.H]);
      if (vTeam && stats[vTeam]) {
        stats[vTeam].pointsMade += result.vScore;
        stats[vTeam].pointsAllowed += result.hScore;
        if (result.winner === 'V') stats[vTeam].wins += 1;
        else if (result.winner === 'H') stats[vTeam].losses += 1;
      }
      if (hTeam && stats[hTeam]) {
        stats[hTeam].pointsMade += result.hScore;
        stats[hTeam].pointsAllowed += result.vScore;
        if (result.winner === 'H') stats[hTeam].wins += 1;
        else if (result.winner === 'V') stats[hTeam].losses += 1;
      }
    });
    seasonStats = stats;
  } catch (err) {
    // Stats are supporting context, not the point of the page — if the sheet
    // or Firestore is unreachable the bracket still renders, just without
    // the record line.
    console.error('loadSeasonStats error:', err);
    seasonStats = {};
  }
}

// ── Team rosters, for the "who's on each Championship team" list ───────────
// Same source-of-truth resolution Gameboard's buildRosterSide() uses: a
// player's ACTUAL team is Firestore's players/{id}.team if set (post-draft
// admin assignment), falling back to the sheet's own TEAM column — never the
// sheet column alone, since team assignment happens in-app after the draft.
let teamRosters = {};

async function loadTeamRosters() {
  try {
    const players = await fetchPlayers();
    const withTeam = await Promise.all(players.map(async p => {
      const data = await getCompositeRank(p[PLAYER_COL.ID]);
      return { ...p, _teamFB: data.team || '' };
    }));

    const rosters = {};
    TEAMS.filter(t => t !== 'Undrafted').forEach(t => { rosters[t] = []; });
    withTeam.forEach(p => {
      const team = p._teamFB || p[PLAYER_COL.TEAM] || '';
      if (rosters[team]) rosters[team].push(p);
    });
    Object.values(rosters).forEach(roster => {
      roster.sort((a, b) => firstNameOf(a[PLAYER_COL.NAME]).localeCompare(firstNameOf(b[PLAYER_COL.NAME])));
    });
    teamRosters = rosters;
  } catch (err) {
    // Same "supporting context, not the point of the page" rationale as
    // loadSeasonStats — the bracket/championship card still render fine
    // without a roster list if the sheet/Firestore is unreachable.
    console.error('loadTeamRosters error:', err);
    teamRosters = {};
  }
}

function firstNameOf(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || fullName || '';
}

function rosterPlayerTileHtml(p) {
  const first = firstNameOf(p[PLAYER_COL.NAME]);
  const photo = photoUrl(p);
  // If the image genuinely fails to load (Drive unreachable/rate-limited —
  // an observed real scenario, not hypothetical), swap it for the same
  // placeholder a player with no known photo gets, instead of leaving the
  // browser's broken-image icon on screen.
  const avatar = photo
    ? `<img src="${photo}" alt="" class="pg-roster-avatar-img" loading="lazy" onerror="window.__pgSwapAvatarPlaceholder(this)" />`
    : `<div class="pg-roster-avatar-img pg-roster-avatar-placeholder">&#127936;</div>`;
  return `
    <div class="pg-roster-tile">
      <div class="pg-roster-avatar">${avatar}</div>
      <span class="pg-roster-name">${first}</span>
    </div>`;
}

// Standalone roster card for a Championship contender — sits below the
// Championship tile as its own separate object (Variant B, chosen over a
// single shared two-column card), bordered in the team's own colour. Black
// is the one exception: its hex (#0A0A0A) is nearly invisible as a border on
// this page's near-black card background, so it borders in white instead —
// the visually "inverse" colour, per explicit request — rather than the
// team's literal hex like every other team gets.
function rosterCardHtml(side) {
  const game = PLAYOFF_GAMES.champ;
  const resolved = resolveSide(game, side);
  if (!resolved.known) return '';

  const teamName = resolved.team;
  const info = teamColorEntry(teamName);
  const hex = info?.hex || '#888';
  const borderColor = teamName === 'Black' ? '#FFFFFF' : hex;
  const icon = iconUrl(teamName);
  const coach = coachForColor(teamName);
  const letter = teamName.trim().charAt(0).toUpperCase();
  const roster = teamRosters[coach];
  if (!roster || roster.length === 0) return '';

  const players = roster.map(rosterPlayerTileHtml).join('');

  return `
    <div class="pg-roster-card" style="border-color:${borderColor}">
      <div class="pg-roster-card-header">
        <div class="pg-roster-card-icon" style="background:${hex}">
          <span style="color:${readableTextColor(hex)}">${letter}</span>
          ${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
        </div>
        <div class="pg-roster-card-name" style="color:${borderColor}">${teamName.toUpperCase()}</div>
      </div>
      <div class="pg-roster-card-players">${players}</div>
    </div>`;
}

function seasonStatLine(team) {
  const s = seasonStats[team];
  if (!s) return null;
  const ratio = s.pointsAllowed === 0
    ? (s.pointsMade === 0 ? 0 : Infinity)
    : s.pointsMade / s.pointsAllowed;
  const ratioStr = ratio === Infinity ? '—' : ratio.toFixed(2);
  return `W: ${s.wins} - L:${s.losses} - R:${ratioStr}`;
}

// Each game: seedA/seedB (fixed matchup) OR feederA/feederB (references another
// game's winner) — never both. `result: { winnerSeed, scoreA, scoreB }` is
// null until manually filled in after a game is played.
const PLAYOFF_GAMES = {
  // Round 1 — Tue Aug 11 (final results — winners only, no scores shown per request)
  r1_9v8:   { round: 1, bracket: 'A', seedA: 9,  seedB: 8,  when: 'Tue Aug 11', time: '6:00 PM',  location: 'Gym East', result: { winnerSeed: 8 } },
  r1_12v5:  { round: 1, bracket: 'A', seedA: 12, seedB: 5,  when: 'Tue Aug 11', time: '6:50 PM',  location: 'Gym East', result: { winnerSeed: 12 } },
  r1_11v6:  { round: 1, bracket: 'B', seedA: 11, seedB: 6,  when: 'Tue Aug 11', time: '7:40 PM',  location: 'Gym East', result: { winnerSeed: 6 } },
  r1_10v7:  { round: 1, bracket: 'B', seedA: 10, seedB: 7,  when: 'Tue Aug 11', time: '8:30 PM',  location: 'Gym East', result: { winnerSeed: 7 } },

  // Round 2 — Fri Aug 14 (seeds 1-4 enter) — final results
  r2_1:     { round: 2, bracket: 'A', seedA: 1, feederB: 'r1_9v8',  when: 'Fri Aug 14', time: '6:00 PM', location: 'Gym West',   result: { winnerSeed: 1 } },
  r2_4:     { round: 2, bracket: 'A', seedA: 4, feederB: 'r1_12v5', when: 'Fri Aug 14', time: '6:50 PM', location: 'Gym West',   result: { winnerSeed: 4 } },
  r2_3:     { round: 2, bracket: 'B', seedA: 3, feederB: 'r1_11v6', when: 'Fri Aug 14', time: '6:00 PM', location: 'Gym Middle', result: { winnerSeed: 3 } },
  r2_2:     { round: 2, bracket: 'B', seedA: 2, feederB: 'r1_10v7', when: 'Fri Aug 14', time: '6:50 PM', location: 'Gym Middle', result: { winnerSeed: 2 } },

  // Semifinals — Thu Sep 3 — final results
  semiA:    { round: 3, bracket: 'A', feederA: 'r2_1', feederB: 'r2_4', when: 'Thu Sep 3', time: '6:00 PM', location: 'Gym East', result: { winnerSeed: 4 } },
  semiB:    { round: 3, bracket: 'B', feederA: 'r2_3', feederB: 'r2_2', when: 'Thu Sep 3', time: '6:50 PM', location: 'Gym West', result: { winnerSeed: 3 } },

  // Championship — Wed Sep 9 — not yet played
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

// Round 1/2 chips are deliberately a letter on the team's colour — compact and
// instant, no image load. The Semifinals and Championship use the real team
// PNG (see teamLogoHtml) so the later rounds carry the actual artwork.
function teamChipHtml(team) {
  const info = teamColorEntry(team);
  const hex = info?.hex || '#888';
  const letter = (info?.shortName || team || '?').trim().charAt(0).toUpperCase();
  return `
    <span class="pg-chip" style="background:${hex}">
      <span style="color:${readableTextColor(hex)}">${letter}</span>
    </span>`;
}

// Semifinal / Championship chip: the team's PNG logo, with the colour block
// underneath so something is visible while the image loads (or if Drive is
// unreachable) — same rationale as the Gameboard's podium tiles.
function teamLogoHtml(team, extraClass = '') {
  const info = teamColorEntry(team);
  const hex = info?.hex || '#888';
  const icon = iconUrl(team);
  const letter = (info?.shortName || team || '?').trim().charAt(0).toUpperCase();
  return `
    <span class="pg-chip ${extraClass}" style="background:${hex}">
      <span class="pg-chip-fallback" style="color:${readableTextColor(hex)}">${letter}</span>
      ${icon ? `<img src="${icon}" alt="" class="pg-chip-icon" loading="lazy" />` : ''}
    </span>`;
}

// White/Neon Yellow etc. need dark text on their chips; everything else light.
function readableTextColor(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return 'rgba(255,255,255,0.95)';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1d27' : 'rgba(255,255,255,0.95)';
}

function cardWhenHtml(game) {
  return `<div class="pg-card-when"><span class="pg-day">${game.when}</span> · ${game.time}</div>`;
}

// `useLogo` switches the chip from the letter-on-colour block (Round 1/2) to
// the real team PNG (Semifinals onward).
function sideRowHtml(game, side, gameId, useLogo = false) {
  const resolved = resolveSide(game, side);
  const result = game.result;

  if (!resolved.known) {
    return `
      <div class="pg-label-slot">
        <div class="pg-winner-of">Winner of <b>${feederLabel(resolved.feederId, resolved.feederRound)}</b></div>
      </div>`;
  }

  const teamName = resolved.team;
  const info = teamColorEntry(teamName);
  const label = info?.shortName || teamName;
  const chip = useLogo ? teamLogoHtml(teamName) : teamChipHtml(teamName);

  if (!result) {
    return `<div class="pg-team-row pg-upcoming">${chip}${label}</div>`;
  }

  const isWinner = result.winnerSeed === resolved.seed;
  const score = side === 'A' ? result.scoreA : result.scoreB;
  const scoreHtml = score != null ? `<span class="pg-score">${score}</span>` : '';
  if (isWinner) {
    return `<div class="pg-team-row pg-win">${chip}${label}${scoreHtml}</div>`;
  }
  return `<div class="pg-team-row pg-lose">${chip}${label}${scoreHtml}</div>`;
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

// Semifinal card: basketball icon + title header (mirroring the Championship
// card's structure), then the matchup using the real team logos.
function semiCardHtml(gameId, title, bracketClass) {
  const game = PLAYOFF_GAMES[gameId];
  return `
    <div class="pg-semi-card ${bracketClass}">
      <div class="pg-semi-header">
        <div class="pg-semi-icon">&#127936;</div>
        <div class="pg-semi-title">${title}</div>
        <div class="pg-semi-when">${game.when} · ${game.time} · ${game.location}</div>
      </div>
      <div class="pg-semi-matchup">
        ${sideRowHtml(game, 'A', gameId, true)}
        ${sideRowHtml(game, 'B', gameId, true)}
      </div>
    </div>`;
}

// Championship contender: podium-style tile matching the Gameboard Board
// view's 2nd/3rd place cards — uppercase colour name, large logo tile, coach
// name and regular-season record underneath.
function champTeamHtml(side) {
  const game = PLAYOFF_GAMES.champ;
  const resolved = resolveSide(game, side);

  if (!resolved.known) {
    return `
      <div class="pg-champ-team pg-champ-team-tbd">
        <div class="pg-champ-team-color">TBD</div>
        <div class="pg-champ-team-tile pg-champ-team-tile-empty">?</div>
        <div class="pg-champ-team-coach">Winner of ${feederLabel(resolved.feederId, resolved.feederRound)}</div>
      </div>`;
  }

  const teamName = resolved.team;
  const info = teamColorEntry(teamName);
  const hex = info?.hex || '#888';
  const icon = iconUrl(teamName);
  const coach = coachForColor(teamName);
  const stats = seasonStatLine(coach);
  const letter = teamName.trim().charAt(0).toUpperCase();

  let stateClass = '';
  if (game.result) {
    stateClass = game.result.winnerSeed === resolved.seed ? 'pg-champ-team-win' : 'pg-champ-team-lose';
  }

  return `
    <div class="pg-champ-team ${stateClass}">
      <div class="pg-champ-team-color">${teamName.toUpperCase()}</div>
      <div class="pg-champ-team-tile" style="background:${hex}">
        <span class="pg-chip-fallback" style="color:${readableTextColor(hex)}">${letter}</span>
        ${icon ? `<img src="${icon}" alt="" loading="lazy" />` : ''}
      </div>
      ${coach ? `<div class="pg-champ-team-coach">${coach}</div>` : ''}
      ${stats ? `<div class="pg-champ-team-stats">${stats}</div>` : ''}
    </div>`;
}

function arrowHtml(bracket, direction) {
  const bracketClass = bracket === 'B' ? 'pg-arrow-b' : '';
  const dirClass = direction === 'left' ? 'pg-arrow-left' : 'pg-arrow-right';
  return `<div class="pg-arrow ${bracketClass} ${dirClass}"><div class="pg-arrow-stem"></div><div class="pg-arrow-head"></div></div>`;
}

// Round 2 -> Semifinal wires. Each is a simple L: it exits the OUTER edge of
// its Round 2 card horizontally (right for bracket A, left for B — away from
// the R1->R2 arrows in the inner gutter), turns once, then drops straight
// into the semi below. The top row's horizontal run is longer than the bottom
// row's, so the two vertical lanes never share an x and never cross.
//
// Coordinate space (viewBox 820x290, stretched to the tier's real size):
// block A x:0-335, centre gap x:335-485, block B x:485-820. All four lanes
// live inside that centre gap, clear of every card face.
function wireOverlayHtml() {
  return `
    <div class="pg-elbow-overlay" aria-hidden="true">
      <svg viewBox="0 0 820 290" preserveAspectRatio="none">
        <path d="M 335 75 L 390 75 L 390 290" stroke="var(--clr-accent)" stroke-width="3" fill="none" />
        <polygon points="384,290 390,302 396,290" fill="var(--clr-accent)" />
        <path d="M 335 171 L 360 171 L 360 290" stroke="var(--clr-accent)" stroke-width="3" fill="none" />
        <polygon points="354,290 360,302 366,290" fill="var(--clr-accent)" />

        <path d="M 485 75 L 430 75 L 430 290" stroke="var(--pg-bracket-b)" stroke-width="3" fill="none" />
        <polygon points="424,290 430,302 436,290" fill="var(--pg-bracket-b)" />
        <path d="M 485 171 L 460 171 L 460 290" stroke="var(--pg-bracket-b)" stroke-width="3" fill="none" />
        <polygon points="454,290 460,302 466,290" fill="var(--pg-bracket-b)" />
      </svg>
    </div>`;
}

function renderDesktopBracket() {
  const el = document.getElementById('pg-desktop-bracket');
  el.innerHTML = `
    <div class="pg-stage">
      <div class="pg-prelim-tier">
        ${wireOverlayHtml()}

        <div class="pg-bracket-block pg-block-a">
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
          <div class="pg-elbow-spacer"></div>
        </div>

        <div class="pg-bracket-block pg-block-b">
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
          <div class="pg-elbow-spacer"></div>
        </div>
      </div>

      <div class="pg-semis-tier">
        ${semiCardHtml('semiA', 'Semi A', 'pg-semi-a')}
        ${semiCardHtml('semiB', 'Semi B', 'pg-semi-b')}
      </div>

      <div class="pg-champ-drop">
        <div class="pg-drop-stem"></div>
        <div class="pg-drop-arrowhead"></div>
      </div>
      <div class="pg-champ-row">
        <div class="pg-champ">
          <div class="pg-champ-trophy">&#127942;</div>
          <div class="pg-champ-label">Championship</div>
          <div class="pg-champ-when">${PLAYOFF_GAMES.champ.when} · ${PLAYOFF_GAMES.champ.time} · ${PLAYOFF_GAMES.champ.location}</div>
          <div class="pg-champ-matchup">
            ${champTeamHtml('A')}
            ${champTeamHtml('B')}
          </div>
        </div>
      </div>

      <div class="pg-roster-cards-row">
        ${rosterCardHtml('A')}
        ${rosterCardHtml('B')}
      </div>
    </div>`;
}

function ladderGameCardHtml(gameId, label) {
  const game = PLAYOFF_GAMES[gameId];
  const hasResult = !!game.result;
  const railClass = hasResult ? 'pg-rail-done' : 'pg-rail-tbd';
  // Semis and the Championship use the real logos here too, matching desktop.
  const useLogo = game.round >= 3;
  return `
    <div class="pg-ladder-card ${useLogo ? 'pg-ladder-card-late' : ''}">
      <div class="pg-rail ${railClass}"></div>
      <div class="pg-ladder-top">
        <span class="pg-ladder-tag">${label}</span>
        <span class="pg-ladder-when">${game.when} · ${game.time}</span>
      </div>
      ${sideRowHtml(game, 'A', gameId, useLogo)}
      ${sideRowHtml(game, 'B', gameId, useLogo)}
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
      ${ladderGameCardHtml('champ', 'CHAMPIONSHIP')}
    </div>`;
}

async function init() {
  await Promise.all([buildIconIndex(), buildDriveIndex(), loadSeasonStats(), loadTeamRosters()]);
  renderDesktopBracket();
  renderMobileLadder();
}

init();
