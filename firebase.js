// firebase.js — read/write rankings, notes, team assignments, favorites
import { db } from './firebase-config.js';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField, serverTimestamp, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firestore document shape for players/{playerId}:
// {
//   rankings:  { "CoachName": 4.8 },   // numeric value used for composite avg
//   modifiers: { "CoachName": "Low" },  // label stored separately, no effect on avg
//   notes:     { "CoachName": "..." },
//   team:      "Team Blue"
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
  return { composite: null, count: 0, rankings: {}, modifiers: {}, notes: {}, team: '', noShow: false };
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
