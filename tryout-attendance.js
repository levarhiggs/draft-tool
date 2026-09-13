// tryout-attendance.js — who missed this season's tryouts.
//
// Derived from photo capture: every player who attended was photographed
// holding their name/id slip, so "no real photo" == "did not attend".
// Six of these were additionally confirmed by the coach announcing them
// absent on the tryout video. See _local/PENDING_ROSTER_CHANGES.md.
//
// Season-scoped by design: ids only mean anything within their own season.

export const MISSED_TRYOUT_BY_SEASON = {
  '26.3': new Set([
    '01', '03', '18', '24', '25', '26',
    '27', '29', '33', '39', '45', '46',
    '47', '52', '64', '72', '74', '76',
    '78', '80', '86',
  ]),
};

/** Ids that missed tryouts in the given season (empty set if unknown). */
export function missedTryout(seasonCode) {
  return MISSED_TRYOUT_BY_SEASON[seasonCode] || new Set();
}
