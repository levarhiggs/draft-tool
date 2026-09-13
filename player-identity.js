// player-identity.js — cross-season player identity links.
//
// Player IDs are SEASON-SCOPED and deliberately NOT stable across seasons:
// a returning player gets a brand-new ID each cycle, matching how the season
// sheet and Drive media folders are naturally rebuilt. This file is the
// lookup layer that links those per-season IDs to one continuing person.
//
// Keyed by normalized full name (uppercase, single-spaced). Each entry maps
// to the { season, id } pairs that person has held.
//
// GENERATED for Fall 2026 intake by matching the Fall roster against
// _local/players_data.json (the Summer 2026 roster snapshot). 18 of 85 Fall
// players were found to be returning.
//
// KNOWN LIMITATION: matching is by exact name only. Two different players
// with the same name would collide here — the spec calls for a sequence
// suffix to disambiguate. No collision exists in the current data.

export const PLAYER_IDENTITIES = {
  'ANDREW MASCARY': [
    { season: '26.2', id: '55' },
    { season: '26.3', id: '69' },
  ],
  'ANGEL FORERO': [
    { season: '26.2', id: '54' },
    { season: '26.3', id: '29' },
  ],
  'AXEL ALMADA': [
    { season: '26.2', id: '41' },
    { season: '26.3', id: '49' },
  ],
  'CAMDEN BRYANT': [
    { season: '26.2', id: '13' },
    { season: '26.3', id: '16' },
  ],
  'CHRISTIAN VILCA': [
    { season: '26.2', id: '77' },
    { season: '26.3', id: '38' },
  ],
  'CHRISTIAN WILLIAMS': [
    { season: '26.2', id: '76' },
    { season: '26.3', id: '62' },
  ],
  'DAVID MARTIN': [
    { season: '26.2', id: '19' },
    { season: '26.3', id: '07' },
  ],
  'HUMBERTO ESPINAL': [
    { season: '26.2', id: '24' },
    { season: '26.3', id: '36' },
  ],
  'JACOB PEREZ': [
    { season: '26.2', id: '42' },
    { season: '26.3', id: '50' },
  ],
  'JAXON PERRY': [
    { season: '26.2', id: '75' },
    { season: '26.3', id: '46' },
  ],
  'KALEB PINA': [
    { season: '26.2', id: '92' },
    { season: '26.3', id: '52' },
  ],
  'KENO JAMMIE TURNER': [
    { season: '26.2', id: '82' },
    { season: '26.3', id: '85' },
  ],
  'KEVIN HERNANDEZ': [
    { season: '26.2', id: '78' },
    { season: '26.3', id: '51' },
  ],
  'RACHAAD SPENCE': [
    { season: '26.2', id: '31' },
    { season: '26.3', id: '05' },
  ],
  'RYAN DASHOUSH': [
    { season: '26.2', id: '80' },
    { season: '26.3', id: '86' },
  ],
  'SAMUEL TORRES': [
    { season: '26.2', id: '65' },
    { season: '26.3', id: '67' },
  ],
  'SEBASTIAN FERNANDEZ': [
    { season: '26.2', id: '1' },
    { season: '26.3', id: '01' },
  ],
  'SEBASTIAN GUTIERREZ': [
    { season: '26.2', id: '25' },
    { season: '26.3', id: '61' },
  ],
};

/** Normalize a display name into the PLAYER_IDENTITIES key form. */
export function identityKey(name) {
  return String(name || '').toUpperCase().split(/\s+/).filter(Boolean).join(' ');
}

/** All { season, id } pairs for a player name, or [] if not tracked. */
export function identityFor(name) {
  return PLAYER_IDENTITIES[identityKey(name)] || [];
}

/**
 * Seasons this player appeared in BEFORE the given one.
 * Used by the directory to show a returning-player badge.
 */
export function priorSeasons(name, currentCode) {
  return identityFor(name).filter(e => e.season < currentCode);
}

/** True when the player appeared in any earlier season. */
export function isReturning(name, currentCode) {
  return priorSeasons(name, currentCode).length > 0;
}
