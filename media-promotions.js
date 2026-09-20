// media-promotions.js — the promoted-media override for profile pictures and
// primary videos.
//
// ── WHY THIS IS A SEPARATE MODULE, LOADED ONCE ───────────────────────────────
// players-data.js's photoUrl()/videoUrl() are SYNCHRONOUS, and all six of
// their callers (app.js, player.js, draft-board.js, gameboard.js, rotations.js,
// playoffs.js) assume that. An async Firestore read inside them would mean
// rewriting every call site.
//
// So promotions load ONCE into an in-memory map — the same shape and lifecycle
// as the existing driveIndex in players-data.js — and the lookup below stays
// synchronous. The map is tiny: at most one photo + one video per player.
//
// ── PRECEDENCE ───────────────────────────────────────────────────────────────
//   promoted submission  →  sheet PHOTO/VIDEO column  →  Drive index  →  none
//
// This is purely additive. The Drive file is never overwritten, renamed or
// deleted, and un-promoting removes the override so the original returns —
// one click, always reversible. Given gotcha #15's four media-loss incidents,
// a destructive replacement would have been the fifth.

import { headshotUrl, videoUrl as cldVideoUrl } from './media-config.js';
import { getAllPromotions } from './media-data.js';
import { cacheKey, resolveSeason } from './season-config.js';

let promotions = {};
let loaded = false;

// Keyed to resolveSeason(), NOT cacheKey()'s CURRENT_SEASON default: media-data
// reads through resolveSeason() too, and the two diverge whenever a page is
// viewed with ?season=26.2. A mismatched key would serve one season's
// promotions against another season's players.
const CK = cacheKey('mediaPromotions', resolveSeason().code);

/**
 * Load promotions into memory. Call once per page, BEFORE the first render —
 * alongside buildDriveIndex(), which has the same contract.
 *
 * Never throws: a failure leaves the map empty, which degrades to exactly
 * today's behaviour (the Drive headshot), rather than breaking the page.
 */
export async function loadPromotions() {
  if (loaded) return;

  // sessionStorage first, same pattern as buildDriveIndex(). Keyed through
  // cacheKey() so it carries the season and CACHE_EPOCH (gotcha #16).
  try {
    const cached = sessionStorage.getItem(CK);
    if (cached) { promotions = JSON.parse(cached); loaded = true; return; }
  } catch { /* private mode / cleared storage — fall through to the network */ }

  try {
    promotions = await getAllPromotions();
    loaded = true;
    try { sessionStorage.setItem(CK, JSON.stringify(promotions)); } catch {}
  } catch (err) {
    console.warn('media: promotions unavailable — using Drive media', err);
    promotions = {};
    loaded = true;
  }
}

/**
 * Drop the cache and reload.
 *
 * Called after an admin promotes or reverts: without this the change wouldn't
 * show until the tab was closed, since the map is cached for the session.
 */
export async function refreshPromotions() {
  try { sessionStorage.removeItem(CK); } catch {}
  loaded = false;
  promotions = {};
  await loadPromotions();
}

/**
 * The promoted headshot for a player, or null.
 * SYNCHRONOUS on purpose — see the module header.
 */
export function promotedPhotoUrl(playerId) {
  const p = promotions[String(playerId)];
  return p?.photo?.publicId ? headshotUrl(p.photo.publicId) : null;
}

/** The promoted primary video for a player, or null. Synchronous. */
export function promotedVideoUrl(playerId) {
  const p = promotions[String(playerId)];
  return p?.video?.publicId ? cldVideoUrl(p.video.publicId) : null;
}

/** Raw promotion record — who promoted it and when. For the admin UI. */
export function promotionFor(playerId, kind) {
  return promotions[String(playerId)]?.[kind] || null;
}

/** True if anything at all is promoted for this player. */
export function hasPromotion(playerId) {
  const p = promotions[String(playerId)];
  return Boolean(p?.photo || p?.video);
}
