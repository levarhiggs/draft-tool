// media-data.js — Firestore layer for user-submitted media.
//
// Two collections, both season-scoped by the same doc-id prefix scheme
// firebase.js uses (see sid() there):
//
//   mediaSubmissions/{season}__{autoId}   every submission, any status
//   mediaPromotions/{season}__{playerId}  which approved item is the headshot
//
// ── THE MAPPING IS THE RECORD, NOT THE FILENAME ──────────────────────────────
// PROJECT_STATUS gotcha #15: media failures are this app's signature bug,
// four incidents, all rooted in "the filename IS the mapping, and nothing
// errors when it's wrong." This module deliberately does NOT extend that
// convention. A submission's identity is its Firestore doc holding an explicit
// Cloudinary publicId. Nothing is ever matched by filename.
//
// That also gives a positive abuse signal: a Cloudinary asset with no matching
// doc here is either an abuse upload or a failed submission. _local/preflight.py
// checks for exactly that.

import { db } from './firebase-config.js';
import { resolveSeason } from './season-config.js';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp,
  collection, getDocs, query, where,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  MAX_APPROVED_PHOTOS, MAX_APPROVED_VIDEOS, MAX_PENDING_PER_PLAYER,
} from './media-config.js';

const SEASON = resolveSeason();
const SEASON_CODE = SEASON.code;

/**
 * Season-scoped doc id.
 *
 * Note this does NOT carry firebase.js's legacy 26.2-stays-unprefixed rule:
 * this feature ships after 26.2 closed, so no unprefixed media docs exist or
 * ever will. Every media doc is prefixed, including 26.2's if any are ever
 * backfilled.
 */
function mid(id) { return `${SEASON_CODE}__${id}`; }

const SUBMISSIONS = 'mediaSubmissions';
const PROMOTIONS  = 'mediaPromotions';
const MESSAGES    = 'mediaMessages';

function submissionRef(id) { return doc(db, SUBMISSIONS, id); }
function messageRef(id) { return doc(db, MESSAGES, id); }
function promotionRef(playerId) { return doc(db, PROMOTIONS, mid(playerId)); }

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every submission for one player this season, newest first.
 * Filtered client-side by season prefix rather than with a compound where()
 * so no composite Firestore index is needed — at this league's scale
 * (88 players, low hundreds of submissions) the difference is unmeasurable.
 */
export async function getPlayerSubmissions(playerId) {
  const q = query(collection(db, SUBMISSIONS),
                  where('playerId', '==', String(playerId)),
                  where('season', '==', SEASON_CODE));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(bySubmittedDesc);
}

/** Every submission this season, any player. Admin inbox. */
export async function getAllSubmissions() {
  const q = query(collection(db, SUBMISSIONS), where('season', '==', SEASON_CODE));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(bySubmittedDesc);
}

/** Live admin inbox — fires on every submission as it arrives. */
export function subscribeSubmissions(callback) {
  const q = query(collection(db, SUBMISSIONS), where('season', '==', SEASON_CODE));
  return onSnapshot(q,
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(bySubmittedDesc)),
    err  => { console.warn('media: submissions subscription failed', err); callback([]); });
}

/** Approved media for a player, in the admin's sort order. */
export async function getApprovedMedia(playerId) {
  const all = await getPlayerSubmissions(playerId);
  return all.filter(s => s.status === 'approved').sort(bySortOrder);
}

function bySubmittedDesc(a, b) {
  return (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0);
}
function bySortOrder(a, b) {
  const d = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  return d !== 0 ? d : bySubmittedDesc(a, b);
}

// ── Counts and gates ─────────────────────────────────────────────────────────

/**
 * What's live in the app, and what's waiting.
 *
 * approvedPhotos/approvedVideos are what the caps govern. pending is NOT
 * capped by those — see media-config.js.
 */
export async function getPlayerCounts(playerId) {
  const all = await getPlayerSubmissions(playerId);
  const approved = all.filter(s => s.status === 'approved');
  const pending  = all.filter(s => s.status === 'pending');
  return {
    approvedPhotos: approved.filter(s => s.kind === 'photo').length,
    approvedVideos: approved.filter(s => s.kind === 'video').length,
    pending:        pending.length,
    maxPhotos:      MAX_APPROVED_PHOTOS,
    maxVideos:      MAX_APPROVED_VIDEOS,
  };
}

/**
 * Can this player accept another SUBMISSION?
 *
 * Almost always yes. The display caps deliberately do not block submission —
 * only the abuse circuit-breaker does.
 */
export async function canSubmit(playerId) {
  const { pending } = await getPlayerCounts(playerId);
  return pending >= MAX_PENDING_PER_PLAYER
    ? { ok: false, reason: `There are already ${pending} submissions waiting for review on this player. Try again once an admin has worked through them.` }
    : { ok: true };
}

/**
 * Can this submission be APPROVED? This is where the display cap bites.
 * Rejecting is always allowed; only going live is gated.
 */
export async function canApprove(playerId, kind) {
  const c = await getPlayerCounts(playerId);
  const isPhoto = kind === 'photo';
  const used = isPhoto ? c.approvedPhotos : c.approvedVideos;
  const max  = isPhoto ? c.maxPhotos : c.maxVideos;
  return used >= max
    ? { ok: false, used, max,
        reason: `All ${max} ${isPhoto ? 'photo' : 'clip'} slots are full for this player. Remove one from the app to approve this, or swap it in directly.` }
    : { ok: true, used, max };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Record a submission. Called ONLY after the Cloudinary upload succeeded —
 * the returned publicId is what makes the record meaningful.
 *
 * Deliberately not season-guarded by assertWritable(): media can legitimately
 * be submitted against a completed season (a parent finding an old photo), and
 * nothing here mutates that season's rankings or scores.
 */
export async function createSubmission(fields) {
  const id = mid(`${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const record = {
    playerId:   String(fields.playerId),
    playerName: fields.playerName || '',
    season:     SEASON_CODE,
    kind:       fields.kind,
    status:     'pending',

    publicId:   fields.publicId,
    url:        fields.url,
    thumbUrl:   fields.thumbUrl || null,
    width:      fields.width ?? null,
    height:     fields.height ?? null,
    durationSec: fields.durationSec ?? null,
    bytes:      fields.bytes ?? null,
    format:     fields.format || '',

    submitterName:  (fields.submitterName || '').trim(),
    submitterPhone: (fields.submitterPhone || '').trim(),
    caption:        (fields.caption || '').trim(),
    // Private message to the admin — shown in the inbox, NEVER in the gallery.
    adminNote:      (fields.adminNote || '').trim(),

    sortOrder:    0,
    submittedAt:  serverTimestamp(),
    reviewedAt:   null,
    reviewedBy:   null,
    rejectReason: null,
  };
  await setDoc(submissionRef(id), record);
  return { id, ...record };
}

/** Approve. Caller is expected to have checked canApprove() first. */
export async function approveSubmission(id, adminName) {
  await updateDoc(submissionRef(id), {
    status: 'approved', reviewedAt: serverTimestamp(),
    reviewedBy: adminName, rejectReason: null,
  });
}

/**
 * Reject. NON-DESTRUCTIVE by design: the Cloudinary asset and this record
 * both survive, so the admin inbox's Rejected filter IS the archive and
 * re-approving restores an item with no restore step. Permanent deletion
 * happens only through _local/archive_media.py, which verifies a local copy
 * before it will purge.
 */
export async function rejectSubmission(id, adminName, reason = null) {
  await updateDoc(submissionRef(id), {
    status: 'rejected', reviewedAt: serverTimestamp(),
    reviewedBy: adminName, rejectReason: reason,
  });
}

/**
 * Remove an approved item from public view.
 *
 * Deliberately the SAME non-destructive path as rejectSubmission: the item
 * moves to 'rejected', keeping its Cloudinary asset and its record, so it can
 * be restored with one click. Nobody — coach or admin — can permanently
 * destroy a parent's contribution from the UI.
 *
 * `removedBy` records WHO pulled it, because the admin needs to tell their own
 * rejections apart from a coach's. reviewedBy carries the name; removedRole
 * carries the capacity they acted in.
 */
export async function removeSubmission(id, actorName, role, reason = null) {
  await updateDoc(submissionRef(id), {
    status: 'rejected',
    reviewedAt: serverTimestamp(),
    reviewedBy: actorName,
    removedRole: role,          // 'admin' | 'coach'
    rejectReason: reason,
  });
}

/** Back to the pending queue — the undo for both actions above. */
export async function unreviewSubmission(id) {
  await updateDoc(submissionRef(id), {
    status: 'pending', reviewedAt: null, reviewedBy: null, rejectReason: null,
  });
}

/**
 * Remove the Firestore record outright.
 *
 * Note this does NOT delete the Cloudinary asset — an unsigned preset can
 * upload but not delete (that needs the API secret, which can never ship in
 * client JS). So calling this creates an orphan asset by definition. Prefer
 * rejectSubmission(); this exists for genuine mistakes (a duplicate upload,
 * a submission on the wrong player).
 */
export async function deleteSubmission(id) {
  await deleteDoc(submissionRef(id));
}

/** Persist a drag-reordered gallery. */
export async function saveSortOrder(orderedIds) {
  await Promise.all(orderedIds.map((id, i) =>
    updateDoc(submissionRef(id), { sortOrder: i })));
}

// ── Contact-admin messages ───────────────────────────────────────────────────
// Sent from the player media page. Kept in their own collection rather than
// bolted onto mediaSubmissions: a message is not a submission, has no media,
// and needs its own read/unread lifecycle.

export async function createMessage(fields) {
  const id = mid(`${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const record = {
    season:      SEASON_CODE,
    playerId:    fields.playerId ? String(fields.playerId) : null,
    playerName:  fields.playerName || '',
    submissionId: fields.submissionId || null,   // set when reporting one item
    kind:        fields.kind || 'question',      // 'removal' | 'question'
    fromName:    (fields.fromName || '').trim(),
    fromContact: (fields.fromContact || '').trim(),
    body:        (fields.body || '').trim(),
    status:      'unread',
    createdAt:   serverTimestamp(),
    handledAt:   null,
    handledBy:   null,
  };
  await setDoc(messageRef(id), record);
  return { id, ...record };
}

/** Live message list for the admin badge and inbox. */
export function subscribeMessages(callback) {
  const q = query(collection(db, MESSAGES), where('season', '==', SEASON_CODE));
  return onSnapshot(q,
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))),
    err => { console.warn('media: messages subscription failed', err); callback([]); });
}

export async function markMessageHandled(id, adminName, handled = true) {
  await updateDoc(messageRef(id), {
    status: handled ? 'handled' : 'unread',
    handledAt: handled ? serverTimestamp() : null,
    handledBy: handled ? adminName : null,
  });
}

// ── Promotions ───────────────────────────────────────────────────────────────
// An override layer over the existing Drive headshot, never a mutation of it.
// The Drive file is never overwritten, renamed or deleted — un-promoting
// deletes the override and the original returns. Given gotcha #15's four
// media-loss incidents, a destructive "replacement" would be the fifth.

/** Every promotion this season, as { playerId: {photo, video} }. */
export async function getAllPromotions() {
  try {
    const q = query(collection(db, PROMOTIONS), where('season', '==', SEASON_CODE));
    const snap = await getDocs(q);
    const out = {};
    snap.docs.forEach(d => {
      const data = d.data();
      out[String(data.playerId)] = { photo: data.photo || null, video: data.video || null };
    });
    return out;
  } catch (err) {
    // Never let a promotion read break a page: the Drive headshot is still
    // the fallback, so an empty map degrades to exactly today's behaviour.
    console.warn('media: promotions load failed — falling back to Drive media', err);
    return {};
  }
}

/** Promote an approved submission to profile picture ('photo') or primary video. */
export async function promote(playerId, kind, submission, adminName) {
  const ref  = promotionRef(playerId);
  const snap = await getDoc(ref);
  const base = snap.exists() ? snap.data() : { playerId: String(playerId), season: SEASON_CODE };
  await setDoc(ref, {
    ...base,
    playerId: String(playerId),
    season:   SEASON_CODE,
    [kind]: {
      submissionId: submission.id,
      publicId:     submission.publicId,
      url:          submission.url,
      promotedBy:   adminName,
      promotedAt:   serverTimestamp(),
    },
  });
}

/** Revert to the original Drive media. One click, always available. */
export async function unpromote(playerId, kind) {
  const ref  = promotionRef(playerId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  const next = { ...data, [kind]: null };
  // Nothing promoted at all? Drop the doc rather than leaving an empty shell,
  // so the collection only ever holds real overrides.
  if (!next.photo && !next.video) await deleteDoc(ref);
  else await setDoc(ref, next);
}

/** True if this submission is currently serving as a headshot/primary video. */
export function isPromoted(promotions, playerId, submissionId) {
  const p = promotions[String(playerId)];
  if (!p) return null;
  if (p.photo?.submissionId === submissionId) return 'photo';
  if (p.video?.submissionId === submissionId) return 'video';
  return null;
}
