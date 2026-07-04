// rotations-engine.js — pure rules-engine functions for the Rotations feature.
// No DOM, no I/O — safe to unit test in isolation.
//
// Data shapes used throughout:
//   pattern: Map<playerId, [bool, bool, bool, bool]>  — on/off per quarter (index 0..3 = Q1..Q4)
//   absent:  Set<playerId>
//   order:   array of playerId in tile order (index 0 = top of tile order)

export const HALVES = [[0, 1], [2, 3]]; // [Q1,Q2], [Q3,Q4]

/**
 * Count of present (non-absent) players.
 */
export function countPresent(order, absent) {
  return order.filter(id => !absent.has(id)).length;
}

/**
 * Per-quarter on-court counts: array of 4 integers.
 */
export function computeQuarterCounts(pattern, absent, order) {
  const counts = [0, 0, 0, 0];
  for (const id of order) {
    if (absent.has(id)) continue;
    const p = pattern.get(id) || [false, false, false, false];
    for (let q = 0; q < 4; q++) if (p[q]) counts[q]++;
  }
  return counts;
}

/**
 * Expected on-court count per quarter given N present players.
 * N >= 5 -> 5; N < 5 -> N (edge case, rule 4).
 */
export function expectedOnCourt(N) {
  return Math.min(5, N);
}

/**
 * Status for a single quarter header: { count, expected, ok }.
 */
export function computeQuarterStatus(pattern, absent, order, q) {
  const N = countPresent(order, absent);
  const expected = expectedOnCourt(N);
  const counts = computeQuarterCounts(pattern, absent, order);
  return { count: counts[q], expected, ok: N === 0 ? true : counts[q] === expected };
}

/**
 * Per-player status for one player.
 * Returns { state: 'absent'|'valid'|'error', reason: string|null }
 * `reason` is a short spec-style message, null for valid/absent default cases
 * (caller supplies the exact valid/absent copy — this only computes the state
 * and, for errors, which specific rule was violated).
 */
export function computePlayerStatus(pattern, absent, playerId, N) {
  if (absent.has(playerId)) {
    return { state: 'absent', reason: 'Marked absent — excluded from the rotation.' };
  }

  const p = pattern.get(playerId) || [false, false, false, false];
  const half1Count = (p[0] ? 1 : 0) + (p[1] ? 1 : 0);
  const half2Count = (p[2] ? 1 : 0) + (p[3] ? 1 : 0);

  if (half1Count === 0 && half2Count === 0) {
    return { state: 'error', reason: 'Sits out the entire game — must play at least 1 quarter each half.' };
  }
  if (half1Count === 0) {
    return { state: 'error', reason: 'Misses the entire first half (Q1-Q2).' };
  }
  if (half2Count === 0) {
    return { state: 'error', reason: 'Misses the entire second half (Q3-Q4).' };
  }

  // Rule 3: N >= 7 -> must sit at least 1 quarter (cannot play all 4)
  const totalQuarters = p.filter(Boolean).length;
  if (N >= 7 && totalQuarters === 4) {
    return { state: 'error', reason: 'Plays all 4 quarters — with 7+ players present, everyone must sit at least 1 quarter.' };
  }

  return { state: 'valid', reason: 'Plays ≥1 quarter each half.' };
}

/**
 * Overall game status.
 * Returns { valid: bool, playerErrors: number, quarterErrors: number }
 */
export function computeGameStatus(pattern, absent, order) {
  const N = countPresent(order, absent);
  let playerErrors = 0;
  for (const id of order) {
    if (absent.has(id)) continue;
    const status = computePlayerStatus(pattern, absent, id, N);
    if (status.state === 'error') playerErrors++;
  }

  let quarterErrors = 0;
  const expected = expectedOnCourt(N);
  const counts = computeQuarterCounts(pattern, absent, order);
  for (let q = 0; q < 4; q++) {
    if (N > 0 && counts[q] !== expected) quarterErrors++;
  }

  return {
    valid: playerErrors === 0 && quarterErrors === 0,
    playerErrors,
    quarterErrors,
    N,
  };
}

/**
 * Total quarters played by a player, from their pattern.
 */
export function totalQuartersPlayed(pattern, playerId) {
  const p = pattern.get(playerId) || [false, false, false, false];
  return p.filter(Boolean).length;
}

// ── Suggestion algorithm ──────────────────────────────────────────────────────
//
// Goal: produce up to 10 distinct legal rotations (quarter-by-quarter grids),
// ordered strongest-to-weakest by how many top-tile-order players get the
// maximum allowed quarters, exhausting every quarter-by-quarter arrangement
// of a given "split" before moving to the next-weaker split.
//
// Hard constraints per rotation (must all hold):
//   - each quarter has exactly `expected` players on court
//   - each present player plays >=1 quarter in each half
//   - if N >= 7: each present player plays <=3 total quarters (sits >=1)
//
// Strategy:
//   1. Enumerate "splits": everyone starts at the floor (2 quarters — one
//      each half), then the top k players in tile order (k = N, N-1, ..., 0)
//      are bumped to the ceiling (maxPerPlayer). k=N is the strongest split
//      (as many top-order players as possible at max), k=0 is the weakest
//      (everyone at the floor). Splits are only valid if the total quarters
//      they produce can be redistributed to hit exactly `totalSlots` — the
//      leftover slots beyond the top-k-at-ceiling/rest-at-floor baseline are
//      handed out one at a time, continuing down tile order, so a split is
//      really "top k at ceiling, next few players at ceiling-ish, rest at
//      floor" — see buildSplit().
//   2. For each split, in strongest-first order, enumerate every distinct
//      legal quarter-by-quarter grid realizing that split (varying which
//      specific quarters within a half each player sits), appending them to
//      the results list, until 10 total suggestions are collected.

/**
 * Generate legal rotation suggestions, ordered strongest-to-weakest
 * (top-tile-order players maxed out first). Within each split, grids where
 * the top 2 tile-order players both play Q1 and Q4 are preferred (strongest
 * two players start and end the game), as a secondary tiebreaker under the
 * split-strength ordering — never overriding legality or which split comes
 * first.
 * @param {string[]} order - tile order of present playerIds (already excludes absent)
 * @param {number} count - how many suggestions to return
 * @param {number} skip - how many leading suggestions (in the same
 *   deterministic sequence) to skip before collecting `count` — used to
 *   fetch the "next" batch (e.g. "see 10 more") without repeating earlier ones.
 * @returns {Array<Map<string, boolean[4]>>} up to `count` patterns
 */
export function generateSuggestions(order, count = 10, skip = 0) {
  const N = order.length;
  if (N === 0) return [];
  const expected = expectedOnCourt(N);
  const maxPerPlayer = N >= 7 ? 3 : 4;
  const totalSlots = expected * 4; // total player-quarter slots to fill
  const target = skip + count;

  const results = [];
  const seen = new Set();
  const topTwo = order.slice(0, 2);

  // Strongest split first: k = N (as many top-order players at ceiling as
  // the slot budget allows) down to k = 0 (everyone at the floor).
  for (let k = N; k >= 0 && results.length < target; k--) {
    const dist = buildSplit(N, k, totalSlots, maxPerPlayer);
    if (!dist) continue; // infeasible split for this N/expected combo

    // Collect every distinct legal arrangement of this split first, then
    // sort by the Q1+Q4-top-2 preference, before appending to the running
    // results — so the anchoring preference only reorders within a split,
    // never across splits.
    const splitGrids = [];
    for (let variant = 0; ; variant++) {
      const grid = realizeGrid(order, dist, expected, maxPerPlayer, variant);
      if (!grid) break; // combos for this split are exhausted

      const key = gridKey(order, grid);
      if (seen.has(key)) continue;
      if (!isGridLegal(order, grid, N, expected, maxPerPlayer)) continue;

      seen.add(key);
      splitGrids.push(grid);
    }

    splitGrids.sort((a, b) => topTwoAnchorScore(b, topTwo) - topTwoAnchorScore(a, topTwo));
    results.push(...splitGrids);
  }

  return results.slice(skip, skip + count);
}

/**
 * Score a grid by how well it anchors the top-2 tile-order players in Q1
 * and Q4 ("strongest players start and end the game"). Higher is better.
 * Absent from the scoring entirely if fewer than 2 present players exist
 * (topTwo may have length < 2) — in that case every grid scores 0 and the
 * sort is a no-op, which is fine since there's no meaningful "top 2" then.
 */
function topTwoAnchorScore(grid, topTwo) {
  let score = 0;
  for (const id of topTwo) {
    const p = grid.get(id);
    if (!p) continue;
    if (p[0]) score++; // plays Q1
    if (p[3]) score++; // plays Q4
  }
  return score;
}

/**
 * Build a "split": exactly the top `k` players (in tile order) sit at
 * maxPerPlayer quarters, everyone else sits at the floor (2). This is a
 * strict boundary — no leftover redistribution — so different `k` values
 * always produce genuinely different splits. If a whole-number remainder
 * can't be evenly distributed among the remaining (non-top-k, non-floor)
 * players to make the totals sum to totalSlots exactly, one "swing" player
 * just below the top-k boundary absorbs the remainder (floor+1..maxPerPlayer-1),
 * keeping the split as top-heavy as possible while still exact.
 * Returns null if no valid split exists for this k.
 */
function buildSplit(N, k, totalSlots, maxPerPlayer) {
  k = Math.max(0, Math.min(k, N));
  const floor = 2;
  const dist = new Array(N).fill(floor);
  for (let i = 0; i < k; i++) dist[i] = maxPerPlayer;

  let remaining = totalSlots - dist.reduce((a, b) => a + b, 0);
  if (remaining === 0) return dist;
  if (remaining < 0) return null; // top-k-at-ceiling alone overshoots — infeasible split for this k

  // Distribute the remainder one at a time among the below-the-boundary
  // players (index >= k), starting closest to the boundary, capped at
  // maxPerPlayer each — keeps the split as top-heavy as the exact k allows.
  let i = k;
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard++;
    if (i >= N) return null; // ran out of players below the boundary — infeasible for this k
    if (dist[i] < maxPerPlayer) {
      dist[i]++;
      remaining--;
    } else {
      i++;
    }
  }
  return remaining === 0 ? dist : null;
}

/**
 * Try to realize an actual quarter-by-quarter grid from a total-quarters
 * distribution. `halfVariant` selects which combinatorial arrangement (of
 * all legal ways to split the "one-quarter" players between the two
 * quarters of each half, across both halves) to produce — a single integer
 * that the caller increments to walk every distinct legal grid for `dist`.
 * Returns a Map<playerId, bool[4]>, or null once `halfVariant` exceeds the
 * number of distinct arrangements this distribution admits.
 */
function realizeGrid(order, dist, expected, maxPerPlayer, halfVariant = 0) {
  const N = order.length;
  const pattern = new Map(order.map(id => [id, [false, false, false, false]]));

  // Players with total=2 or total=4 have a fixed, forced half1/half2 split
  // (1/1 or 2/2). Players with total=3 (odd) have a choice: lean half1
  // (h1=2,h2=1) or lean half2 (h1=1,h2=2) — call the half1-leaning group
  // "swing-to-1". The number of swing-to-1 players is fixed by the
  // requirement that half1's total sum across all players equals
  // expected*2; which specific odd players are in that group is the
  // remaining freedom, enumerated below alongside the within-half choices.
  const fixed1 = new Array(N).fill(0); // forced half1 contribution
  const oddIdx = [];
  let fixedSum1 = 0;
  for (let i = 0; i < N; i++) {
    const total = dist[i];
    if (total === 4) { fixed1[i] = 2; fixedSum1 += 2; }
    else if (total === 2) { fixed1[i] = 1; fixedSum1 += 1; }
    else if (total === 3) { oddIdx.push(i); }
    else return null; // total must be in {2,3,4}
  }
  const targetHalf1Sum = expected * 2;
  const neededFromOdd = targetHalf1Sum - fixedSum1; // total half1 contribution odd players must supply
  // Each odd player contributes either 1 (swing-to-2, i.e. h1=1) or 2 (swing-to-1, h1=2).
  // If s = count of swing-to-1 among the M odd players: sum = s*2 + (M-s)*1 = M + s.
  const M = oddIdx.length;
  const s = neededFromOdd - M; // count of odd players that lean half1
  if (s < 0 || s > M) return null; // infeasible for this distribution

  const swingCombos = [];
  choose(oddIdx, s, [], 0, swingCombos);
  if (!swingCombos.length && s === 0) swingCombos.push([]); // s=0 still has 1 valid (empty) combo

  // Enumerate: for each swing combo (which odd players lean half1), build
  // half1Play/half2Play, then enumerate every within-half assignment for
  // both halves. Flatten all of it into a single index space so the caller
  // can walk every distinct grid via one incrementing halfVariant.
  let idx = 0;
  for (const swingSet of swingCombos.length ? swingCombos : [[]]) {
    const swing = new Set(swingSet);
    const half1Play = new Array(N);
    const half2Play = new Array(N);
    for (let i = 0; i < N; i++) {
      if (dist[i] === 3) {
        half1Play[i] = swing.has(i) ? 2 : 1;
        half2Play[i] = 3 - half1Play[i];
      } else {
        half1Play[i] = fixed1[i];
        half2Play[i] = dist[i] - fixed1[i];
      }
    }

    const half1Options = enumerateHalfAssignments(half1Play, expected);
    const half2Options = enumerateHalfAssignments(half2Play, expected);
    if (!half1Options.length || !half2Options.length) continue;

    const comboCount = half1Options.length * half2Options.length;
    if (halfVariant < idx + comboCount) {
      const local = halfVariant - idx;
      const half1 = half1Options[Math.floor(local / half2Options.length)];
      const half2 = half2Options[local % half2Options.length];
      for (let i = 0; i < N; i++) {
        const id = order[i];
        const p = pattern.get(id);
        p[0] = half1[i].includes(0);
        p[1] = half1[i].includes(1);
        p[2] = half2[i].includes(0);
        p[3] = half2[i].includes(1);
      }
      return pattern;
    }
    idx += comboCount;
  }
  return null; // halfVariant exceeds total distinct arrangements for this distribution
}

/**
 * Enumerate every distinct legal way to assign specific quarters within a
 * 2-quarter half so each of the two quarters ends up with exactly
 * `expected` players on court. `playCounts[i]` is 1 or 2 for player i.
 * Returns an array of "assignment" arrays (one per distinct arrangement),
 * each itself an array of per-player quarter-index-lists (local 0/1).
 * Players who play 2 quarters have no choice (on for both); players who
 * play exactly 1 quarter must be split into "plays quarter A" vs "plays
 * quarter B" groups sized to fill each quarter to `expected` — every
 * distinct such split is a separate valid arrangement.
 */
function enumerateHalfAssignments(playCounts, expected) {
  const N = playCounts.length;
  const totalSlots = expected * 2;
  const sum = playCounts.reduce((a, b) => a + b, 0);
  if (sum !== totalSlots) return [];

  const bothIdx = [];
  const oneIdx = [];
  playCounts.forEach((c, i) => (c === 2 ? bothIdx : oneIdx).push(i));

  const baseCount = bothIdx.length;
  const remainingA = expected - baseCount; // how many "one-quarter" players go in quarter A
  if (remainingA < 0 || remainingA > oneIdx.length) return [];
  if (expected - baseCount !== oneIdx.length - remainingA) return [];

  // Enumerate every distinct way to choose `remainingA` of oneIdx's players
  // for quarter A (the rest get quarter B) — this is the real source of
  // grid-to-grid variety within a fixed distribution.
  const combos = [];
  choose(oneIdx, remainingA, [], 0, combos);

  return combos.map(chosenForA => {
    const chosenSet = new Set(chosenForA);
    const assign = new Array(N).fill(null).map(() => []);
    bothIdx.forEach(i => { assign[i] = [0, 1]; });
    oneIdx.forEach(i => { assign[i] = chosenSet.has(i) ? [0] : [1]; });
    return assign;
  });
}

// Enumerate all k-combinations of `items` (small N in practice — at most 8
// players per half here, so this is always cheap).
function choose(items, k, current, startIdx, results) {
  if (current.length === k) { results.push(current.slice()); return; }
  for (let i = startIdx; i < items.length; i++) {
    current.push(items[i]);
    choose(items, k, current, i + 1, results);
    current.pop();
  }
}

function isGridLegal(order, pattern, N, expected, maxPerPlayer) {
  const absentEmpty = new Set();
  for (const id of order) {
    const status = computePlayerStatus(pattern, absentEmpty, id, N);
    if (status.state === 'error') return false;
  }
  const counts = computeQuarterCounts(pattern, absentEmpty, order);
  for (let q = 0; q < 4; q++) if (counts[q] !== expected) return false;
  return true;
}

function gridKey(order, pattern) {
  return order.map(id => (pattern.get(id) || []).map(b => (b ? '1' : '0')).join('')).join('|');
}

export const __test__ = { buildSplit, realizeGrid, enumerateHalfAssignments, isGridLegal };
