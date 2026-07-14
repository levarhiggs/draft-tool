// firebase.js — read/write rankings, notes, team assignments, favorites
import { db } from './firebase-config.js';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField, serverTimestamp, arrayUnion,
  collection, getDocs, query, where, addDoc, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

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
  return doc(db, 'players', String(playerId));
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

// Given a stored ranking value, reverse-engineer the base seed and modifier label
export function decodeRanking(value, modifiers, coachName) {
  if (value == null) return { seed: null, modifier: null };
  const label = modifiers?.[coachName] || null;
  const offset = label && label !== DEFAULT_LABEL
    ? MODIFIER_OFFSET[label]
    : (label === DEFAULT_LABEL ? DEFAULT_OFFSET : DEFAULT_OFFSET);
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
function coachRef(coachName) { return doc(db, 'coaches', coachName); }

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
  return doc(db, 'scheduleGames', String(gameNum));
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
    snap.forEach(doc => { games[doc.id] = doc.data(); });
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
  return doc(db, 'liveStatLogs', id);
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
  return doc(db, 'gameLogNotes', id);
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
  return doc(db, 'gameboardGhosts', id);
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
  return collection(db, 'rotationConfigs', coachName, 'configs');
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
    const ref = doc(db, 'rotationConfigs', coachName, 'configs', existing.id);
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
  const ref = doc(db, 'rotationConfigs', coachName, 'configs', configId);
  await updateDoc(ref, { title: newTitle });
}

export async function deleteRotationConfig(coachName, configId) {
  const ref = doc(db, 'rotationConfigs', coachName, 'configs', configId);
  await deleteDoc(ref);
}
