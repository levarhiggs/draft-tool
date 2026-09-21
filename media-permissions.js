// media-permissions.js — who is allowed to remove media, and from whom.
//
// One module so the rule lives in ONE place: the gallery, the media page and
// the admin inbox all ask the same question and get the same answer. The
// alternative is three copies that drift — gotcha #12's three parallel
// win/loss implementations, which this codebase has already paid for once.
//
// The rule:
//   ADMIN (TEAM_ADMINS)  — may remove any media, any player
//   COACH                — may remove media ONLY for players on their roster
//   EVERYONE ELSE        — may remove nothing
//
// "Remove" is never destructive. It sets the item back to 'rejected', so it
// keeps its Cloudinary asset and its Firestore record and an admin can restore
// it with one click. Nobody can permanently destroy a parent's contribution
// from the UI.

import { getCurrentCoach } from './coach-login.js';
import { TEAM_ADMINS, personByName, teamNameFor } from './coaches-config.js';

/** The logged-in coach is a commissioner/admin. */
export function isAdmin() {
  const c = getCurrentCoach();
  return !!c && TEAM_ADMINS.includes(c.name);
}

/**
 * The team the logged-in coach holds this season, or '' if none.
 *
 * Resolved by NAME through personByName(), never by id: four Fall 2026 coaches
 * were created straight from the draft board and hold synthetic BOARD-* ids
 * while their logins are C022–C025 (gotcha #17). An id comparison silently
 * fails for exactly those four.
 *
 * Coach Levar holds admin rights but drafted no roster, so this correctly
 * returns '' for him — he can still remove anything, via isAdmin().
 */
export function myTeam() {
  const c = getCurrentCoach();
  if (!c) return '';
  const person = personByName(c.name);
  return (person && teamNameFor(person.id)) || '';
}

/**
 * Is this player on the logged-in coach's roster?
 *
 * Reads the team the same way app.js's myPlayerPhone() does — the Firestore
 * team (_teamFB) first, then the sheet's TEAM column — so "my player" means
 * the same thing here as it does for parent phone visibility.
 */
export function isMyPlayer(player) {
  const team = myTeam();
  if (!team || !player) return false;
  const playerTeam = player._teamFB || player.team || player.TEAM || '';
  return String(playerTeam) === String(team);
}

/**
 * May the current viewer remove media for this player?
 *
 * @param {object|null} player  roster record, or null when unknown (e.g. the
 *        media page before the roster resolves). Admins pass regardless.
 * @returns {{ok: boolean, role: 'admin'|'coach'|null, reason?: string}}
 */
export function canRemoveFor(player) {
  if (isAdmin()) return { ok: true, role: 'admin' };

  const c = getCurrentCoach();
  if (!c) return { ok: false, role: null, reason: 'Log in as a coach to manage media.' };

  if (!player) return { ok: false, role: null, reason: 'Roster not loaded yet.' };

  if (isMyPlayer(player)) return { ok: true, role: 'coach' };

  return {
    ok: false, role: null,
    reason: `Only ${player.name || 'this player'}'s own coach or a league admin can remove their media.`,
  };
}

/**
 * Only an admin may promote a still to be the profile picture.
 *
 * Deliberately narrower than removal: a promoted photo becomes that child's
 * face on EVERY page of the app, which is a league-wide editorial decision
 * rather than a roster one.
 */
export function canPromote() {
  return isAdmin();
}

/** Label for who pulled an item, so an admin can tell their own removals apart. */
export function removalLabel(sub) {
  if (!sub || sub.status !== 'rejected') return '';
  const who = sub.reviewedBy || 'someone';
  if (sub.removedRole === 'coach') return `Removed by ${who} (coach)`;
  if (sub.removedRole === 'admin') return `Removed by ${who} (admin)`;
  // Pre-dates removedRole, or was rejected from the inbox rather than removed
  // from a gallery — both are admin actions by definition.
  return `Rejected by ${who}`;
}
