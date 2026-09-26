// coaches-config.js — coach identity: slot + person + assignment.
//
// Three layers, deliberately separate (same shape as player-identity.js, and
// for the same reason — the seat is not the person):
//
//   SLOT       {season}.{1-15}   the seat. Pre-exists empty for every season.
//   PERSON     C###              the human. Permanent, never reused/deleted.
//   ASSIGNMENT slot -> person id which person sits in which seat, per season.
//
// PINs belong to the PERSON, not the slot — a returning coach keeps his PIN
// across seasons regardless of which seat he occupies. The commissioner
// swaps coaches in and out of seats by editing SLOT_ASSIGNMENTS only.
//
// A slot with no assignment, or a person with no PIN, is simply invisible at
// login — that IS "inactive," there is no separate flag.
//
// ── CONNECTING TO EXISTING FIRESTORE DATA ───────────────────────────────────
// Firestore keys rankings, notes, jersey numbers, live stat logs, rotation
// configs and gameboard ghosts by coach NAME (e.g. rankings: { "Coach
// Alfred-Levar": 4.8 }) — there is no coach id anywhere in stored data, and
// 26.2 documents are NOT migrated. getCurrentCoach() (coach-login.js) still
// hands back a { name, personId } object, so every existing call site that
// reads/writes with coach.name keeps working unchanged: the name used is
// simply the person's CURRENT display name, resolved through this file.
// A person's displayNames list must keep every historical name they've used
// (see PRODUCT_SPEC "Coach identity"), or their older rankings/notes under a
// retired name become unreachable.
import { scheduleSeason } from './season-config.js';

// ── People (permanent) ───────────────────────────────────────────────────────
// id: never reused, assigned once, append-only (same discipline as retired
// player ids). displayNames: most-recent name FIRST — that's what's shown
// and what NEW writes use as the Firestore key. pin: null = cannot log in.
export const PERSONS = [
  // Levar: renamed from "Coach Alfred-Levar" to "Coach Levar" 2026-09-15.
  // Old name kept in the list (most-recent first) so 26.2 rankings/notes
  // stored under "Coach Alfred-Levar" still resolve via personByName().
  { id: 'C001', displayNames: ['Coach Alex'],                          pin: '123'  },
  { id: 'C002', displayNames: ['Coach Levar', 'Coach Alfred-Levar'],   pin: 'levar' },
  { id: 'C003', displayNames: ['Coach Andre'],                         pin: '789'  },
  { id: 'C004', displayNames: ['Coach Ben'],                           pin: '123'  },
  { id: 'C005', displayNames: ['Coach Chris'],                         pin: '456'  },
  { id: 'C006', displayNames: ['Coach Daven-Josiah'],                  pin: '789'  },
  { id: 'C007', displayNames: ['Coach Humberto'],                      pin: 'humberto' },
  { id: 'C008', displayNames: ['Coach Jeff'],                          pin: '456'  },
  // Renamed 2026-09-15: some Summer 2026 notes/rankings are attributed to
  // "Coach Kevin", which now reads as ambiguous now that Fall has a second
  // Kevin (Kevin Koval, C015, "Coach Kevin K."). Old name kept second in the
  // list so his existing Summer 2026 data still resolves via personByName().
  { id: 'C009', displayNames: ['Coach Kevin S.', 'Coach Kevin'],       pin: '789'  },
  { id: 'C010', displayNames: ['Coach Mike C.'],                       pin: '2345' },
  { id: 'C011', displayNames: ['Coach Sedat'],                         pin: 'sedat' },
  { id: 'C012', displayNames: ['Coach Tati'],                          pin: '1234' },
  { id: 'C013', displayNames: ['Director Mike M.'],                    pin: '1111' },

  // Fall 2026 roster, loaded 2026-09-15. Login = "Coach {first name}",
  // pin = first name lowercase (Mason-Jaylen Noel is a coaching duo, so
  // "Mason-Jaylen" is the first name here). C007 (Humberto) and C011 (Sedat)
  // above are these same returning people, not new records — only their
  // pins changed. Kevin Koval is a NEW person distinct from C009 (Kevin Su,
  // Summer 2026) despite the shared first name.
  { id: 'C014', displayNames: ['Coach Michael'],       pin: 'michael' },  // Michael Mottley
  { id: 'C015', displayNames: ['Coach Kevin K.'],      pin: 'kevin'   },  // Kevin Koval — distinct from C009 (Kevin Su); last-initial per the existing "Coach Mike C." convention since "Coach Kevin" is taken
  { id: 'C016', displayNames: ['Coach Craig'],         pin: 'craig'   },  // Craig Crynes
  { id: 'C017', displayNames: ['Coach Andrew'],        pin: 'andrew'  },  // Andrew Shulman
  { id: 'C018', displayNames: ['Coach Reshaun'],       pin: 'reshaun' },  // Reshaun Hartison
  { id: 'C019', displayNames: ['Coach Xavier'],        pin: 'xavier'  },  // Xavier Charles
  { id: 'C020', displayNames: ['Coach David'],         pin: 'david'   },  // David Success
  { id: 'C021', displayNames: ['Coach Mason-Jaylen'],  pin: 'mason'   },  // Mason-Jaylen Noel (coaching duo)

  // Added 2026-09-16, the morning after the draft. These four coached the
  // draft itself without app logins — they were created straight from the
  // draft board, which needs no PERSONS entry — so the published board
  // still resolves their names through roster_26.3's `names` map under
  // BOARD-* ids. Those board ids are deliberately NOT changed to these
  // C### ids: the board doc is the season's record now, and rewriting its
  // keys would break the link between a row and the picks under it.
  { id: 'C022', displayNames: ['Coach Ken'],           pin: 'ken'      },
  { id: 'C023', displayNames: ['Coach Kingston'],      pin: 'kingston' },
  { id: 'C024', displayNames: ['Coach Micah'],         pin: 'micah'    },
  { id: 'C025', displayNames: ['Coach Paul'],          pin: 'paul'     },
];

/** Placeholder for an unfilled slot — never assigned, never has a PIN. */
function placeholder(n) {
  return { id: `PLACEHOLDER-${n}`, displayNames: [`Coach ${n}`], pin: null };
}

/**
 * Look up a person by id, including unassigned-slot placeholders (which
 * exist only to be swapped for a real person in SLOT_ASSIGNMENTS below —
 * they're never returned by getActiveCoaches since they carry no PIN).
 */
function personById(id) {
  return PERSONS.find(p => p.id === id) || null;
}

// ── Slot assignments (per season) ────────────────────────────────────────────
// Slot id "{season}.{n}" -> person id. The league caps at 15 coaches, so all
// 15 slots exist for every season; a slot left as a placeholder id, or
// pointed at a person with no PIN, is simply skipped at login.
//
// 26.2 is complete/read-only and never needs a login roster, but its
// assignment is recorded for completeness / future history views.
export const SLOT_ASSIGNMENTS = {
  '26.2': {
    '26.2.1':  'C001', '26.2.2':  'C002', '26.2.3':  'C003', '26.2.4':  'C004',
    '26.2.5':  'C005', '26.2.6':  'C006', '26.2.7':  'C007', '26.2.8':  'C008',
    '26.2.9':  'C009', '26.2.10': 'C010', '26.2.11': 'C011', '26.2.12': 'C012',
    '26.2.13': 'C013',
  },

  // Fall 2026, rewritten 2026-09-16 to match the completed draft: the 11
  // coaches who actually took a team, in the board's own row order, so slot
  // number == team number. Slot 1 is the commissioner (C002), who evaluates
  // but doesn't coach a team.
  //
  // Michael (C014), Andrew (C017) and Reshaun (C018) were assigned here
  // before the draft but didn't end up with teams, so they're unassigned —
  // that alone removes their login, no flag and no deletion. Their PERSONS
  // records stay put on purpose: any ranking or note they left is keyed by
  // display name and still resolves through personByName().
  '26.3': {
    '26.3.1':  'C002',  // Coach Levar — commissioner, no team
    '26.3.2':  'C022',  // 1  Coach Ken
    '26.3.3':  'C011',  // 2  Coach Sedat
    '26.3.4':  'C019',  // 3  Coach Xavier
    '26.3.5':  'C021',  // 4  Coach Mason-Jaylen
    '26.3.6':  'C023',  // 5  Coach Kingston
    '26.3.7':  'C016',  // 6  Coach Craig
    '26.3.8':  'C007',  // 7  Coach Humberto
    '26.3.9':  'C024',  // 8  Coach Micah
    '26.3.10': 'C015',  // 9  Coach Kevin K.
    '26.3.11': 'C020',  // 10 Coach David
    '26.3.12': 'C025',  // 11 Coach Paul
    '26.3.13': 'PLACEHOLDER-13',
    '26.3.14': 'PLACEHOLDER-14',
    '26.3.15': 'PLACEHOLDER-15',
  },
};

/** All 15 placeholders, indexed 1-15, for slots not pointed at a real person. */
const PLACEHOLDERS = Object.fromEntries(
  Array.from({ length: 15 }, (_, i) => i + 1).map(n => [`PLACEHOLDER-${n}`, placeholder(n)])
);

function resolvePersonId(personId) {
  return personById(personId) || PLACEHOLDERS[personId] || null;
}

/**
 * Coaches who can actually log in this season: assigned slots whose person
 * has a PIN, in slot order. Feeds the login dropdown directly.
 * Shape: [{ personId, name, pin }]
 */
export function getActiveCoaches(season) {
  const assignments = SLOT_ASSIGNMENTS[season] || {};
  return Object.keys(assignments)
    .sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
    .map(slotId => resolvePersonId(assignments[slotId]))
    .filter(person => person && person.pin)
    .map(person => ({ personId: person.id, name: person.displayNames[0], pin: person.pin }));
}

/**
 * Name -> person lookup, across every historical display name. This is how
 * old Firestore documents (keyed by a name that may no longer be a person's
 * current display name) resolve back to a person at read time.
 */
export function personByName(name) {
  return PERSONS.find(p => p.displayNames.includes(name)) || null;
}

/**
 * The team name a drafted player gets written to, e.g. "Team Craig".
 *
 * Fall's real TEAMS/TEAM_COLORS don't exist yet — colors are assigned a day
 * or two before the first game (SEASON_INTAKE_RECONSTRUCTION.md) — so the
 * draft can't wait on them. This derives the same `Team {suffix}` shape the
 * app already uses everywhere, from the coach's current display name.
 *
 * Deliberately mirrors gameboard.js's existing coach->team string match, so
 * a team assigned at the draft resolves the same way there. Once real colors
 * land for a season, TEAM_COLORS_BY_SEASON[season] keys must match what this
 * produced for that season's coaches.
 */
export function teamNameFor(personId) {
  const p = PERSONS.find(x => x.id === personId);
  if (!p) return '';
  const suffix = p.displayNames[0].replace(/^(Coach|Director)\s+/, '');
  return `Team ${suffix}`;
}

// ── Team color, as it appears in the season schedule sheet (V/H columns
// identify teams by color name, not coach/team name — this is the link
// between the two). Also used for color chips/badges in the UI.
// hex values are close visual approximations, not official brand codes.
// `shortName`, when present, is used ONLY in space-constrained UI (dropdown
// menus, the Gameboard team popover title) — `name` is the canonical value
// and must match the schedule sheet's Visitor/Home color columns verbatim,
// so it's never shortened at the data level.
//
// KEYED BY SEASON, same discipline as SLOT_ASSIGNMENTS above and for the
// same reason: colors are NOT a coach's property. They're reassigned from
// scratch every season, randomly, to whichever coaches are actually seated
// once that season's draft finalizes — a coach who was "White" one season
// has no claim on White (or any color) the next. Team names, similarly,
// depend on who drafted a team that season (TEAMS_BY_SEASON below), so
// a new season starts with its OWN empty color map and team list rather
// than inheriting the previous one. This is the fix for the bug where two
// returning coaches (Sedat, Humberto) silently kept showing their Summer
// 2026 colors on Fall pages — see PROJECT_STATUS.md's "Known architecture
// gap" writeup for the incident.
const TEAM_COLORS_BY_SEASON = {
  '26.2': {
    'Team Humberto':     { name: 'Purple',        hex: '#7B3FA0' },
    'Team Alex':         { name: 'Deep Orange',   hex: '#C1440E' },
    'Team Jeff':         { name: 'Carolina Blue', hex: '#B4E1FA' },
    'Team Daven-Josiah': { name: 'Grey Concrete', hex: '#8C8C8C', shortName: 'Grey' },
    'Team Ben':          { name: 'Maroon',        hex: '#7A3B2E' },
    'Team Tati':         { name: 'Neon Yellow',   hex: '#F5EA0A' },
    'Team Sedat':        { name: 'White',         hex: '#FFFFFF' },
    'Team Andre':        { name: 'Forest Green',  hex: '#1B5E20' },
    'Team Alfred-Levar': { name: 'Lime Shock',    hex: '#8BC98A', shortName: 'Lime' },
    'Team Kevin':        { name: 'Gold',          hex: '#F5A623' },
    'Team Mike C.':      { name: 'Black',         hex: '#0A0A0A' },
    'Team Chris':        { name: 'True Red',      hex: '#E30613' },
  },

  // Fall 2026: colors assigned 2026-09-26, in draft-board order (Team 1-11
  // per the commissioner's screenshot) — matches the schedule sheet's V/H
  // columns verbatim (gotcha #4).
  '26.3': {
    'Team Ken':           { name: 'Purple',        hex: '#7B3FA0' },
    'Team Sedat':         { name: 'Neon Yellow',   hex: '#F5EA0A' },
    'Team Xavier':        { name: 'Carolina Blue', hex: '#B4E1FA' },
    'Team Mason-Jaylen':  { name: 'Grey Concrete', hex: '#8C8C8C', shortName: 'Grey' },
    'Team Kingston':      { name: 'Maroon',        hex: '#7A3B2E' },
    'Team Craig':         { name: 'Burnt Orange',  hex: '#CC5500' },
    'Team Humberto':      { name: 'White',         hex: '#FFFFFF' },
    'Team Micah':         { name: 'Black',         hex: '#0A0A0A' },
    'Team Kevin K.':      { name: 'Lime Shock',    hex: '#8BC98A', shortName: 'Lime' },
    'Team David':         { name: 'Gold',          hex: '#F5A623' },
    'Team Paul':          { name: 'True Red',      hex: '#E30613' },
  },
};

// Coaches allowed to view and change Team Assignment and mark No Shows.
// Must match a person's CURRENT display name (PERSONS above) exactly —
// update this if that person's displayNames[0] ever changes.
export const TEAM_ADMINS = [
  'Director Mike M.',
  'Coach Levar',
];

// Team names available for assignment, per season — same season-scoping
// reasoning as TEAM_COLORS_BY_SEASON above: which teams exist depends on who
// actually drafted that season, so a new season gets its own list rather
// than the previous one's names lingering (and being assignable) forever.
const TEAMS_BY_SEASON = {
  '26.2': [
    'Team Alex', 'Team Jeff', 'Team Daven-Josiah', 'Team Ben', 'Team Tati',
    'Team Sedat', 'Team Andre', 'Team Alfred-Levar', 'Team Kevin',
    'Team Mike C.', 'Team Chris', 'Team Humberto',
    'Undrafted',
  ],

  // Fall 2026, set from the 2026-09-16 draft board — 11 teams, in board
  // order. Ken, Kingston, Micah and Paul coached the draft without app
  // logins, so they have no PERSONS entry; their team names come straight
  // from the board rather than from teamNameFor(), which only resolves
  // people who do.
  '26.3': [
    'Team Ken',
    'Team Sedat',
    'Team Xavier',
    'Team Mason-Jaylen',
    'Team Kingston',
    'Team Craig',
    'Team Humberto',
    'Team Micah',
    'Team Kevin K.',
    'Team David',
    'Team Paul',
    'Undrafted',
  ],
};

/**
 * Season-scoped accessor — pass an explicit season code (e.g. from a
 * ?season= param) to read any season's color map, past or present.
 * Returns {} for a season with no colors assigned yet, never another
 * season's map.
 */
export function teamColorsFor(season) {
  return TEAM_COLORS_BY_SEASON[season] || {};
}

/** Season-scoped accessor — see teamColorsFor() above. */
export function teamsFor(season) {
  return TEAMS_BY_SEASON[season] || [];
}

// ── Default exports for the schedule-driven pages (Schedules, Standings,
// Gameboard, Rotations, Playoffs) ────────────────────────────────────────────
// These pages don't (yet) carry their own season selector — they all read
// whatever season schedule-data.js resolves to (SCHEDULE_SEASON, deliberately
// decoupled from the roster's CURRENT_SEASON — see season-config.js), so
// TEAM_COLORS/TEAMS resolve to that SAME season here rather than each of the
// 5+ consumer files re-deriving it themselves. A page that needs a different
// season's colors (e.g. a future season switcher) should call teamColorsFor()/
// teamsFor() directly with its own resolved season instead of importing these.
export const TEAM_COLORS = teamColorsFor(scheduleSeason().code);
export const TEAMS = teamsFor(scheduleSeason().code);
