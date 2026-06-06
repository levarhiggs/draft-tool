// firebase.js — read/write rankings, notes, team assignments via Firestore
import { db } from './firebase-config.js';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firestore document path: players/{playerId}
// Document shape:
// {
//   rankings: { "CoachName": 7.5, "OtherCoach": 6.0 },
//   notes:    { "CoachName": "Good handles, needs work on D", ... },
//   team:     "Team Blue"
// }

function playerRef(playerId) {
  return doc(db, 'players', String(playerId));
}

// Returns { composite, count, rankings, notes, team }
export async function getCompositeRank(playerId) {
  try {
    const snap = await getDoc(playerRef(playerId));
    if (!snap.exists()) return { composite: null, count: 0, rankings: {}, notes: {}, team: '' };
    const data = snap.data();
    return buildComposite(data);
  } catch (err) {
    console.error('getCompositeRank error:', err);
    return { composite: null, count: 0, rankings: {}, notes: {}, team: '' };
  }
}

// Subscribe to live updates for a single player (used on profile page)
export function subscribePlayer(playerId, callback) {
  return onSnapshot(playerRef(playerId), snap => {
    if (!snap.exists()) {
      callback({ composite: null, count: 0, rankings: {}, notes: {}, team: '' });
    } else {
      callback(buildComposite(snap.data()));
    }
  });
}

function buildComposite(data) {
  const rankings = data.rankings || {};
  const values   = Object.values(rankings).map(Number).filter(v => !isNaN(v));
  const composite = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
  return {
    composite,
    count:    values.length,
    rankings,
    notes:    data.notes || {},
    team:     data.team  || '',
  };
}

// Save a single coach's ranking (1.0–8.0)
export async function saveRanking(playerId, coachName, value) {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed < 1 || parsed > 8) {
    throw new Error('Ranking must be a number between 1 and 8.');
  }
  const rounded = Math.round(parsed * 10) / 10; // one decimal
  const ref = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { [`rankings.${coachName}`]: rounded });
  } else {
    await setDoc(ref, { rankings: { [coachName]: rounded }, notes: {}, team: '' });
  }
}

// Save a single coach's notes
export async function saveNote(playerId, coachName, text) {
  const ref = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { [`notes.${coachName}`]: text });
  } else {
    await setDoc(ref, { rankings: {}, notes: { [coachName]: text }, team: '' });
  }
}

// Delete a single coach's note
export async function deleteNote(playerId, coachName) {
  await updateDoc(playerRef(playerId), { [`notes.${coachName}`]: deleteField() });
}

// Coach favorites — stored in coaches/{coachName} document
function coachRef(coachName) {
  return doc(db, 'coaches', coachName);
}

export async function saveFavorites(coachName, favoriteIds) {
  const ref = coachRef(coachName);
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
    if (!snap.exists()) return [];
    return snap.data().favorites || [];
  } catch { return []; }
}

// Save team assignment (any coach can assign)
export async function saveTeam(playerId, teamName) {
  const ref = playerRef(playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { team: teamName });
  } else {
    await setDoc(ref, { rankings: {}, notes: {}, team: teamName });
  }
}
