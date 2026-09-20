// firebase.js — read/write rankings, notes, team assignments, favorites
import { db } from './firebase-config.js';
import { resolveSeason, isReadOnly, scheduleSeason } from './season-config.js';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField, serverTimestamp, arrayUnion,
  collection, getDocs, query, where, addDoc, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── SEASON SCOPING ───────────────────────────────────────────────────────────
// Every collection used to be flat and single-season: players/{id},
// coaches/{name}, scheduleGames/{num}, etc. Player IDs are season-scoped and
// get REUSED across seasons by design, so a second season writing to those
// flat paths would silently merge two different children's rankings into one
// document. Every ref below is therefore namespaced by season code.
//
// Scheme: season code becomes a doc-id prefix, e.g. players/26.3__12.
// Chosen over a `seasons/{code}/...` subcollection path because the existing
// wide-open Firestore rules (`allow read, write: if true` per collection,
// SETUP.md) keep applying unchanged — no new rule has to be published in the
// Console before writes work. See gotcha #3 in PROJECT_STATUS.md: an
// unpublished rule fails silently, which is exactly the failure mode to avoid
// on a deadline. The subcollection form remains the better long-term shape and
// is a clean follow-up migration once rules can be published deliberately.
//
// 26.2 docs are intentionally left UNPREFIXED so that season's existing data
// keeps resolving exactly as before — nothing is migrated or moved.
const SEASON = resolveSeason();
const SEASON_CODE = SEASON.code;
const LEGACY_SEASON = '26.2';
// Schedule-driven reads follow SCHEDULE_SEASON, which lags CURRENT_SEASON
// during tryouts/draft (new roster, no new schedule yet).
const SCHEDULE_CODE = scheduleSeason().code;

/** Season-scoped doc id. 26.2 keeps its original unprefixed ids. */
function sid(id) {
  return SEASON_CODE === LEGACY_SEASON ? String(id) : `${SEASON_CODE}__${id}`;
}

/**
 * Guard for every mutating call. A finished season is a permanent historical
 * record — its rankings, notes and scores must stop accepting edits.
 * Throws rather than failing silently so a blocked write is visible.
 */
function assertWritable(what) {
  if (isReadOnly(SEASON_CODE)) {
    throw new Error(
      `${SEASON.name} (${SEASON_CODE}) is complete and read-only — ${what} refused.`);
  }
}

// Firestore document shape for players/{playerId}:
// {
//   rankings:  { "CoachName": 4.8 },   // numeric value used for composite avg
//   modifiers: { "CoachName": "Low" },  // label stored separately, no effect on avg
//   notes:     { "CoachName": "..." },
//   team:      "Team Blue",
//   jerseyNumbers: { "CoachName": 4 }  // 1-8, per-coach (coaches don't share
//     a canonical numbering scheme, and don't always know the other team's
//     numbers) — same keyed-by-coach-name pattern as rankings/modifiers/notes
// }

function playerRef(playerId) {
  return doc(db, 'players', sid(playerId));
}

// Returns { composite, count, rankings, modifiers, notes, team }
export async function getCompositeRank(playerId) {
  try {
    const snap = await getDoc(playerRef(playerId));
    if (!snap.exists()) return emptyData();
    return buildComposite(snap.data());
  } catch (err) {
    console.error('getCompositeRank error:', err);
    return emptyData();
  }
}

/**
 * Composite rank for a player in a PRIOR season, addressed by that season's
 * own id (ids are season-scoped and change every season - see
 * player-identity.js for the mapping).
 *
 * Deliberately separate from getCompositeRank(), which resolves ids through
 * sid() against the CURRENT season and so cannot reach another season's docs.
 * Read-only by design: prior seasons are complete and must not be written.
 */
export async function getPriorComposite(seasonCode, priorId) {
  try {
    const docId = seasonCode === LEGACY_SEASON
      ? String(priorId)
      : `${seasonCode}__${priorId}`;
    const snap = await getDoc(doc(db, 'players', docId));
    if (!snap.exists()) return null;
    const { composite, count } = buildComposite(snap.data());
    return composite == null ? null : { composite, count, season: seasonCode };
  } catch (err) {
    console.error('getPriorComposite error:', err);
    return null;
  }
}

/**
 * Full prior-season doc (per-coach rankings + notes), for showing as
 * read-only history on a returning player — NOT written into the current
 * season. Rankings/notes are keyed by whatever coach name was in use that
 * season, which may not match anyone coaching now; display-only, never
 * merged into this season's composite. Same read-only contract as
 * getPriorComposite() above.
 */
export async function getPriorPlayerData(seasonCode, priorId) {
  try {
    const docId = seasonCode === LEGACY_SEASON
      ? String(priorId)
      : `${seasonCode}__${priorId}`;
    const snap = await getDoc(doc(db, 'players', docId));
    if (!snap.exists()) return null;
    return { ...buildComposite(snap.data()), season: seasonCode };
  } catch (err) {
    console.error('getPriorPlayerData error:', err);
    return null;
  }
}

export function subscribePlayer(playerId, callback) {
  return onSnapshot(playerRef(playerId), snap => {
    callback(snap.exists() ? buildComposite(snap.data()) : emptyData());
  });
}

function emptyData() {
  return { composite: null, count: 0, rankings: {}, modifiers: {}, notes: {}, team: '', noShow: false, jerseyNumbers: {} };
}

function buildComposite(data) {
  const rankings = data.rankings || {};
  const values   = Object.values(rankings).map(Number).filter(v => !isNaN(v));
  const composite = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
  return {
    composite,
    count:     values.length,
    rankings,
    modifiers: data.modifiers || {},
    notes:     data.notes     || {},
    team:      data.team      || '',
    noShow:    data.noShow    || false,
    jerseyNumbers: data.jerseyNumbers || {},
  };
}

// Modifier offsets — stored value = seed + offset
export const MODIFIER_OFFSET = { Strong: 0.0, Mid: 0.5, Low: 0.8 };
export const DEFAULT_OFFSET  = 0.2;  // no modifier selected → "Reg"
export const DEFAULT_LABEL   = 'Reg';

// Saves numeric ranking (seed + modifier offset) and the modifier label separately
export async function saveRanking(playerId, coachName, seed, modifier) {
  const offset = modifier ? MODIFIER_OFFSET[modifier] : DEFAULT_OFFSET;
  const value  = Math.round((seed + offset) * 10) / 10;
  const label  = modifier || DEFAULT_LABEL;

  // A NaN here (e.g. a stale UI closure re-decoding a ranking mid-render race)
  // must never reach Firestore — it would poison decodeRanking() for every
  // future read of this coach's seed on this player.
  if (!Number.isFinite(value)) {
    throw new Error(`saveRanking: computed a non-finite value (seed=${seed}, modifier=${modifier})`);
  }

  const ref  = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, {
      [`rankings.${coachName}`]:  value,
      [`modifiers.${coachName}`]: label,
    });
  } else {
    await setDoc(ref, {
      rankings:  { [coachName]: value },
      modifiers: { [coachName]: label },
      notes: {}, team: '',
    });
  }
}

// Given a stored ranking value, reverse-engineer the base seed and modifier
// label. DEFAULT_LABEL ('Reg') is a STORAGE detail meaning "no modifier was
// chosen" — it must decode back to modifier: null, never to the literal
// string 'Reg', or a caller that feeds it straight back into saveRanking()
// looks up MODIFIER_OFFSET['Reg'] (undefined) and writes a NaN ranking.
export function decodeRanking(value, modifiers, coachName) {
  if (value == null) return { seed: null, modifier: null };
  const rawLabel = modifiers?.[coachName] || null;
  const label  = rawLabel && rawLabel !== DEFAULT_LABEL ? rawLabel : null;
  const offset = label ? MODIFIER_OFFSET[label] : DEFAULT_OFFSET;
  const seed = Math.round((value - offset) * 10) / 10;
  return { seed: Math.round(seed), modifier: label };
}

export async function saveNote(playerId, coachName, text) {
  const ref  = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { [`notes.${coachName}`]: text });
  } else {
    await setDoc(ref, { rankings: {}, modifiers: {}, notes: { [coachName]: text }, team: '' });
  }
}

export async function deleteNote(playerId, coachName) {
  await updateDoc(playerRef(playerId), { [`notes.${coachName}`]: deleteField() });
}

export async function deleteRanking(playerId, coachName) {
  await updateDoc(playerRef(playerId), {
    [`rankings.${coachName}`]:  deleteField(),
    [`modifiers.${coachName}`]: deleteField(),
  });
}

// Jersey # is set once per player, per coach, and rarely changes mid-season
// (players are required to have one to play; different coaches don't
// necessarily know each other's numbering until they meet). 1-8 per the
// user's spec.
export async function saveJerseyNumber(playerId, coachName, number) {
  const ref  = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { [`jerseyNumbers.${coachName}`]: number });
  } else {
    await setDoc(ref, { rankings: {}, modifiers: {}, notes: {}, team: '', jerseyNumbers: { [coachName]: number } });
  }
}

export async function clearJerseyNumber(playerId, coachName) {
  await updateDoc(playerRef(playerId), { [`jerseyNumbers.${coachName}`]: deleteField() });
}

// Coach favorites stored in coaches/{coachName}
function coachRef(coachName) { return doc(db, 'coaches', sid(coachName)); }

export async function saveFavorites(coachName, favoriteIds) {
  const ref  = coachRef(coachName);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { favorites: favoriteIds });
  } else {
    await setDoc(ref, { favorites: favoriteIds });
  }
}

export async function getFavorites(coachName) {
  try {
    const snap = await getDoc(coachRef(coachName));
    return snap.exists() ? (snap.data().favorites || []) : [];
  } catch { return []; }
}

// ── Coach PIN overrides ──────────────────────────────────────────────────────
// PINs are defined in coaches-config.js (PERSONS[].pin) but that file only
// changes when code is edited and deployed. A coach's self-service "Change
// PIN" needs a real write path. Deliberately reuses the EXISTING `coaches`
// collection (already has a published wide-open rule — a brand-new
// `coachPins` collection was tried first and failed with "Missing or
// insufficient permissions", since an unpublished rule denies silently by
// default; see gotcha #3 in PROJECT_STATUS.md) rather than risk needing a
// Firestore Console change before Wednesday's draft.
//
// Keyed `pin_{personId}` — NOT through sid() and NOT a bare personId — so
// this can never collide with a season-prefixed favorites doc
// (`26.3__Coach Levar`) or a legacy unprefixed one (`Coach Levar`) in the
// same collection. A PIN belongs to the permanent person, independent of
// season or display name, so it deliberately does NOT go through sid().
function coachPinRef(personId) { return doc(db, 'coaches', `pin_${personId}`); }

/** The coach's current PIN override, or null if they've never changed it. */
export async function getPinOverride(personId) {
  try {
    const snap = await getDoc(coachPinRef(personId));
    return snap.exists() ? (snap.data().pin ?? null) : null;
  } catch { return null; }
}

export async function savePinOverride(personId, newPin) {
  await setDoc(coachPinRef(personId), { pin: newPin, updatedAt: serverTimestamp() });
}

// ── Draft board ──────────────────────────────────────────────────────────────
// Three scopes, one rule: state lives with whoever owns the decision it
// represents (see _local/DRAFT_BOARD_SPEC.md).
//
//   AUTHORITATIVE  coaches/draftBoard_{season}   the real draft, commissioner-owned
//   PRIVATE        coaches/sandbox_{season}_{personId}   each coach's practice board
//   SHARED         players/{season}__{id}.rankings       composite, already exists
//
// Both live in the `coaches` collection for the same reason the PIN overrides
// do: it has a published wide-open rule, and a new collection would need one
// added in the Console first — which fails silently until someone does
// (gotcha #3). Prefixed ids keep them from colliding with favorites docs.
//
// draftBoard doc shape:
// {
//   live:          bool,          // the mode switch every client reacts to
//   coachOrder:    ['C002', ...], // rows, top to bottom
//   slots:         { 'C002:0': '04', ... },  // '{personId}:{spotIndex}' -> playerId
//   pickStartedAt: ms epoch,      // one anchor; each client derives its own clock
//   startedAt:     ms epoch,
//   endedAt:       ms epoch | null,
//   adminSeeds:    { '04': 1.2 }, // commissioner's live display-override
//   updatedBy:     'Coach Levar',
// }
function draftBoardRef() {
  return doc(db, 'coaches', `draftBoard_${SEASON_CODE}`);
}
function sandboxRef(personId) {
  return doc(db, 'coaches', `sandbox_${SEASON_CODE}_${personId}`);
}

export function subscribeDraftBoard(callback) {
  return onSnapshot(draftBoardRef(), snap => {
    callback(snap.exists() ? snap.data() : null);
  }, err => {
    console.error('subscribeDraftBoard error:', err);
    callback(null);
  });
}

export async function saveDraftBoard(patch) {
  assertWritable('draft board update');
  await setDoc(draftBoardRef(), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
}

/**
 * Replaces slots wholesale. Firestore's merge:true merges nested map fields
 * KEY BY KEY, so writing `slots: {}` (or any smaller object) over an
 * existing slots map does NOT clear the keys that are missing from the new
 * object — they simply survive untouched. That silently broke "Clear board"
 * before starting a live draft: the board looked empty in the UI (which
 * rendered off the patch just sent) but the old picks were still in
 * Firestore underneath, and reappeared as soon as anything re-read the doc
 * (e.g. toggling live draft back off). Explicitly deleteField() every old
 * key that isn't in the new slots object so a clear actually clears.
 */
export async function saveDraftSlots(slots, updatedBy) {
  assertWritable('draft board update');
  const ref = draftBoardRef();
  const snap = await getDoc(ref);
  const existing = snap.exists() ? (snap.data().slots || {}) : {};
  const patch = { ...slots };
  Object.keys(existing).forEach(key => {
    if (!(key in slots)) patch[key] = deleteField();
  });
  await setDoc(ref, {
    ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [`slots.${k}`, v])),
    updatedBy, updatedAt: serverTimestamp(),
  }, { merge: true });
}

// ── Board roster ─────────────────────────────────────────────────────────────
// WHO HOLDS A DRAFT SLOT is separate from WHO CAN LOG IN. A commissioner who
// evaluates players but doesn't run a team is a coach with no board row —
// so removing someone from the board must not touch their login.
//
// Shared across every device (a coach roster is a fact about the league, not
// a per-coach opinion), and stored in Firestore so it takes effect without a
// code push. coaches-config.js SLOT_ASSIGNMENTS stays the fallback when no
// override has been written.
function boardRosterRef() {
  return doc(db, 'coaches', `roster_${SEASON_CODE}`);
}

/**
 * personIds is the seated roster. names carries display names for
 * BOARD-only coaches (created straight from the draft board, no login) --
 * getActiveCoaches() has no idea these people exist, so every device needs
 * a shared place to resolve their id back to a name. Callback receives
 * { personIds, names } or null if nothing's been saved yet.
 */
export function subscribeBoardRoster(callback) {
  return onSnapshot(boardRosterRef(), snap => {
    if (!snap.exists()) return callback(null);
    const d = snap.data();
    callback({ personIds: d.personIds || null, names: d.names || {} });
  }, err => {
    console.error('subscribeBoardRoster error:', err);
    callback(null);
  });
}

export async function saveBoardRoster(personIds, updatedBy, names) {
  assertWritable('board roster update');
  const patch = { personIds, updatedBy, updatedAt: serverTimestamp() };
  if (names) patch.names = names;
  await setDoc(boardRosterRef(), patch, { merge: true });
}

export async function getSandbox(personId) {
  try {
    const snap = await getDoc(sandboxRef(personId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getSandbox error:', err);
    return null;
  }
}

export async function saveSandbox(personId, data) {
  assertWritable('sandbox update');
  await setDoc(sandboxRef(personId), { ...data, updatedAt: serverTimestamp() });
}

/**
 * Writes each drafted player's team onto their player doc, so the directory,
 * gameboard and standings all see the assignment with no changes of their own.
 * Called once when the commissioner ends the draft.
 */
export async function commitDraftResults(slots, personIdToTeam) {
  assertWritable('draft results');
  const writes = Object.entries(slots).map(([key, playerId]) => {
    const personId = key.split(':')[0];
    const team = personIdToTeam[personId];
    if (!team) return null;
    return saveTeam(playerId, team);
  }).filter(Boolean);
  await Promise.all(writes);
  return writes.length;
}

export async function saveNoShow(playerId, value) {
  const ref  = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { noShow: value });
  } else {
    await setDoc(ref, { rankings: {}, modifiers: {}, notes: {}, team: '', noShow: value });
  }
}

export async function saveTeam(playerId, teamName) {
  const ref  = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { team: teamName });
  } else {
    await setDoc(ref, { rankings: {}, modifiers: {}, notes: {}, team: teamName });
  }
}

// ── Schedule score overrides ────────────────────────────────────────────────
// Firestore document shape for scheduleGames/{gameNum}:
// {
//   vScore: number | null,
//   hScore: number | null,
//   winner: 'V' | 'H' | null,
//   updatedAt: timestamp,
//   updatedBy: string (coach name),
// }

function scheduleGameRef(gameNum) {
  return doc(db, 'scheduleGames', sid(gameNum));
}

export async function getScheduleGame(gameNum) {
  try {
    const snap = await getDoc(scheduleGameRef(gameNum));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getScheduleGame error:', err);
    return null;
  }
}

// Bulk read of every scheduleGames doc in one round trip, keyed by game
// number (string, matching the doc ID) — used by Gameboard's Board view to
// compute season stats for all 12 teams without issuing 60 individual
// getDoc calls.
export async function getAllScheduleGames() {
  try {
    const snap = await getDocs(collection(db, 'scheduleGames'));
    const games = {};
    // Docs from every season live in this one collection (see SEASON SCOPING
    // above), so filter to the schedule season and strip the prefix — callers
    // expect plain game numbers as keys and would otherwise double-count
    // across seasons in every win/loss computation.
    const prefix = `${SCHEDULE_CODE}__`;
    snap.forEach(d => {
      const isLegacy = !d.id.includes('__');
      if (SCHEDULE_CODE === LEGACY_SEASON) {
        if (isLegacy) games[d.id] = d.data();
      } else if (d.id.startsWith(prefix)) {
        games[d.id.slice(prefix.length)] = d.data();
      }
    });
    return games;
  } catch (err) {
    console.error('getAllScheduleGames error:', err);
    return {};
  }
}

// ── Live Stat logs ───────────────────────────────────────────────────────────
// Firestore doc shape for liveStatLogs/{coachName}_{team}_{sheetGameNum}:
// {
//   coachName, team, sheetGameNum,
//   entries: [ { quarter, side: 'own'|'opp', playerId, playerName, jerseyNum,
//                isAnonymous,  // true = credited to the team itself (tapped
//                              // the team icon), not a specific roster player
//                statKey, favorable, shotValue, made, madeAfter, attemptsAfter,
//                countAfter }, ... ],   // full log, in entry order
//   updatedAt: timestamp,
// }
// Deterministic doc ID (not addDoc/auto-id) so re-saving the same
// coach+team+game overwrites in place instead of piling up duplicates.
function liveStatLogRef(coachName, team, sheetGameNum) {
  const id = `${coachName}_${team}_${sheetGameNum}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return doc(db, 'liveStatLogs', sid(id));
}

export async function saveLiveStatLog(coachName, team, sheetGameNum, entries) {
  const ref = liveStatLogRef(coachName, team, sheetGameNum);
  await setDoc(ref, {
    coachName, team, sheetGameNum: String(sheetGameNum),
    entries,
    updatedAt: serverTimestamp(),
  });
}

export async function getLiveStatLog(coachName, team, sheetGameNum) {
  try {
    const snap = await getDoc(liveStatLogRef(coachName, team, sheetGameNum));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getLiveStatLog error:', err);
    return null;
  }
}

// ── Game Log notes (rudimentary per-quarter notepad) ────────────────────────
// Firestore doc shape for gameLogNotes/{coachName}_{team}_{sheetGameNum}:
// { coachName, team, sheetGameNum, notesByQuarter: { "0": "text", "1": "..." }, updatedAt }
// Same deterministic-ID/overwrite pattern as liveStatLogRef above — one doc
// per coach+team+game, holding all 4 quarters' notes together.
function gameLogNotesRef(coachName, team, sheetGameNum) {
  const id = `${coachName}_${team}_${sheetGameNum}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return doc(db, 'gameLogNotes', sid(id));
}

export async function saveGameLogNotes(coachName, team, sheetGameNum, notesByQuarter) {
  const ref = gameLogNotesRef(coachName, team, sheetGameNum);
  await setDoc(ref, {
    coachName, team, sheetGameNum: String(sheetGameNum),
    notesByQuarter,
    updatedAt: serverTimestamp(),
  });
}

export async function getGameLogNotes(coachName, team, sheetGameNum) {
  try {
    const snap = await getDoc(gameLogNotesRef(coachName, team, sheetGameNum));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getGameLogNotes error:', err);
    return null;
  }
}

// ── Gameboard "ghost" players ────────────────────────────────────────────────
// A jersey # typed into the Lineup Manager's 5-digit quick-set that doesn't
// match any real roster player gets a placeholder tile; naming it via the
// custom-name option in its resolve-popover promotes it to a permanent
// "ghost" — not a real roster player/profile, but tracked like one from
// then on (Live Stat logging, IN/OUT, etc.), scoped to this coach's own
// view of this team (same rationale as per-coach jersey numbers: coaches
// don't share a numbering scheme, and a ghost is really just a named
// placeholder for "whoever is wearing #7"). Lives at the team level, not
// per-game, since jersey assignments are meant to hold for the whole season.
// Firestore doc shape for gameboardGhosts/{coachName}_{team}:
// { coachName, team, ghostsByJersey: { "7": "Sub Kid" }, updatedAt }
function gameboardGhostsRef(coachName, team) {
  const id = `${coachName}_${team}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return doc(db, 'gameboardGhosts', sid(id));
}

export async function saveGameboardGhosts(coachName, team, ghostsByJersey) {
  const ref = gameboardGhostsRef(coachName, team);
  await setDoc(ref, {
    coachName, team,
    ghostsByJersey,
    updatedAt: serverTimestamp(),
  });
}

export async function getGameboardGhosts(coachName, team) {
  try {
    const snap = await getDoc(gameboardGhostsRef(coachName, team));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('getGameboardGhosts error:', err);
    return null;
  }
}

export async function saveScheduleGame(gameNum, vScore, hScore, coachName) {
  let winner = null;
  if (vScore != null && hScore != null) {
    if (vScore > hScore) winner = 'V';
    else if (hScore > vScore) winner = 'H';
    // equal scores -> winner stays null (tie)
  }
  const ref = scheduleGameRef(gameNum);
  await setDoc(ref, {
    vScore,
    hScore,
    winner,
    updatedAt: serverTimestamp(),
    updatedBy: coachName,
  }, { merge: true }); // merge, not overwrite — a comment may already exist on this doc
  return { vScore, hScore, winner };
}

// Comments accumulate — each save APPENDS a new { text, coachName, at }
// entry via arrayUnion rather than overwriting the field, so multiple
// coaches' comments over time all persist. serverTimestamp() can't be
// nested inside an array element passed to arrayUnion (a Firestore
// limitation), so each entry's `at` is a plain client-side Date instead.
export async function saveGameComment(gameNum, text, coachName) {
  const ref = scheduleGameRef(gameNum);
  const entry = { text: String(text).slice(0, 100), coachName, at: new Date() };
  await setDoc(ref, {
    comments: arrayUnion(entry),
  }, { merge: true });
  return entry;
}

// ── Saved Rotation Configurations ────────────────────────────────────────────
// Firestore shape: rotationConfigs/{coachName}/configs/{autoId}
// {
//   team: string,
//   order: [playerId, ...],                 // tile/rank order at save time
//   pattern: { [playerId]: [bool,bool,bool,bool] },
//   presentIds: [playerId, ...],             // present (non-absent) players, for the N-available dedup key
//   isValid: bool,
//   title: string,                           // auto-generated, user-editable afterward
//   createdAt: timestamp,
//   gameTag: { team, opponentTeam, gameNum } | undefined,  // present only for
//     Gameboard Game-view saves (see saveGameConfig below) — ties this config
//     to one specific real game rather than being a freeform named variation.
// }
//
// Dedup key = team + presentIds (sorted) + order (as tie-break for ranking
// changes) + pattern (serialized) — see fingerprintConfig() in rotations.js,
// which builds the comparable string this module just stores/queries against
// verbatim rather than re-deriving it here. Game-tagged configs (gameTag
// present) don't use this dedup path at all — they upsert by team+gameNum
// instead, see saveGameConfig.

function rotationConfigsRef(coachName) {
  return collection(db, 'rotationConfigs', sid(coachName), 'configs');
}

export async function getRotationConfigs(coachName, team) {
  try {
    const q = query(rotationConfigsRef(coachName), where('team', '==', team));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('getRotationConfigs error:', err);
    return [];
  }
}

export async function saveRotationConfig(coachName, config) {
  const ref = await addDoc(rotationConfigsRef(coachName), {
    ...config,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// ── Gameboard: per-game saved configs ────────────────────────────────────────
// Same rotationConfigs/{coachName}/configs collection as above (so these
// show up in the Rotations page's Saved Configurations gallery too), but
// tagged with `gameTag: { team, opponentTeam, gameNum }`. Unlike a normal
// Rotations-page save (unlimited variations per team), there is only ever
// ONE config per coach+team+gameNum — saving again from the Gameboard's
// Game view overwrites the existing doc for that team+gameNum instead of
// adding a new one. This is per-coach: two coaches can save totally
// different configs for the same team+game and neither overwrites the
// other's — Firestore path already scopes everything under the coach's own
// name, same as every other rotationConfigs doc.

export async function getGameConfig(coachName, team, gameNum) {
  try {
    const q = query(
      rotationConfigsRef(coachName),
      where('team', '==', team),
      where('gameTag.gameNum', '==', gameNum),
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    // Should only ever be one match (enforced by saveGameConfig's
    // overwrite-existing behavior) — if more exist from before this
    // constraint was added, most-recently-created wins.
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    return docs[0];
  } catch (err) {
    console.error('getGameConfig error:', err);
    return null;
  }
}

export async function saveGameConfig(coachName, team, gameNum, config) {
  const existing = await getGameConfig(coachName, team, gameNum);
  const payload = { ...config, createdAt: serverTimestamp() };
  if (existing) {
    const ref = doc(db, 'rotationConfigs', sid(coachName), 'configs', existing.id);
    await setDoc(ref, payload); // full overwrite, not merge — old pattern/order shouldn't linger
    return existing.id;
  }
  const ref = await addDoc(rotationConfigsRef(coachName), payload);
  return ref.id;
}

// All of this coach's game-tagged configs for a team in one query — used by
// the Rotations page's "Apply to Gameboard" picker to show which of the
// team's games already have a saved config, without querying 10 times.
export async function getGameConfigsForTeam(coachName, team) {
  try {
    const q = query(rotationConfigsRef(coachName), where('team', '==', team));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.gameTag);
  } catch (err) {
    console.error('getGameConfigsForTeam error:', err);
    return [];
  }
}

export async function renameRotationConfig(coachName, configId, newTitle) {
  const ref = doc(db, 'rotationConfigs', sid(coachName), 'configs', configId);
  await updateDoc(ref, { title: newTitle });
}

export async function deleteRotationConfig(coachName, configId) {
  const ref = doc(db, 'rotationConfigs', sid(coachName), 'configs', configId);
  await deleteDoc(ref);
}

// ── Practice Schedule (weekly coaching court-slot grid) ─────────────────────
// Deliberately NOT season-scoped (no sid()) — this is the recurring weekly
// practice-slot assignment, not season-specific roster/ranking data. It
// persists across the whole season and just gets edited in place as coaches
// change, per the user's framing when this feature was built (2026-09-20).
// If a future season ever needs its own separate slate, revisit this.
//
// Lives in the EXISTING `coaches` collection (already has a published
// wide-open Firestore rule) rather than a new top-level collection, for the
// same reason draftBoard/roster/pin overrides do (see those comments above,
// and gotcha #3 in PROJECT_STATUS.md): a brand-new collection has no rule
// until one is manually published in the Console, and an unpublished rule
// denies writes SILENTLY. `schedule_practice` can never collide with a
// season-prefixed favorites doc or any other reserved key in this collection.
//
// Doc shape:
// {
//   slots: {
//     "Sunday|4-5|mullins|0": { coach: "Kev", tbd: false, loc: "East" },
//     ...
//   },
//   updatedAt: timestamp,
//   updatedBy: string (coach name) | null,
// }
// Key scheme "{day}|{hour}|{loc}|{idx}" mirrors practice-schedule.js's own
// in-memory addressing for a slot — see that file for the full day/hour/
// loc/idx model (which days and hours exist, which Mullins slot is West vs.
// East, how many slots each day/hour has) — none of that shape lives here,
// only the mutable coach/tbd state per slot.
function practiceScheduleRef() {
  return doc(db, 'coaches', 'schedule_practice');
}

export function subscribePracticeSchedule(callback) {
  return onSnapshot(practiceScheduleRef(), snap => {
    callback(snap.exists() ? (snap.data().slots || {}) : null);
  }, err => {
    console.error('subscribePracticeSchedule error:', err);
    callback(null);
  });
}

/**
 * Seeds the doc if (and only if) it doesn't already exist — safe to call on
 * every page load. Never overwrites real data with the hardcoded fixture.
 */
export async function seedPracticeScheduleIfEmpty(seedSlots) {
  const ref = practiceScheduleRef();
  const snap = await getDoc(ref);
  if (snap.exists()) return false;
  await setDoc(ref, { slots: seedSlots, updatedAt: serverTimestamp(), updatedBy: null });
  return true;
}

/**
 * Writes one slot's coach/tbd fields via a dotted field path — never a
 * read-modify-write of the whole `slots` map (see saveDraftSlots's own
 * comment above for the exact stale-merge bug that pattern caused there).
 */
export async function savePracticeSlot(slotKey, coach, tbd, updatedBy) {
  await updateDoc(practiceScheduleRef(), {
    [`slots.${slotKey}.coach`]: coach,
    [`slots.${slotKey}.tbd`]: !!tbd,
    updatedAt: serverTimestamp(),
    updatedBy,
  });
}

/** Swap two slots' coach/tbd fields in one atomic write (drag-and-drop). */
export async function swapPracticeSlots(slotKeyA, coachA, tbdA, slotKeyB, coachB, tbdB, updatedBy) {
  await updateDoc(practiceScheduleRef(), {
    [`slots.${slotKeyA}.coach`]: coachA,
    [`slots.${slotKeyA}.tbd`]: !!tbdA,
    [`slots.${slotKeyB}.coach`]: coachB,
    [`slots.${slotKeyB}.tbd`]: !!tbdB,
    updatedAt: serverTimestamp(),
    updatedBy,
  });
}
