// video-availability.js — which players have a tryout video this season.
//
// TEMPORARY-ISH: this exists because videos were still being matched and
// uploaded during the Fall intake. The app also discovers video by scanning
// the season Drive folder (players-data.js buildDriveIndex), which is the
// real source of truth; the Has Video filter checks this list OR the Drive
// index, so it stays correct either way. Once nothing is pending this module
// can be deleted and the filter left to rely on the Drive scan alone.
//
// Synced from the live Drive folder 2026-09-14: 61 of 66 attendees.

export const HAS_VIDEO_BY_SEASON = {
  '26.3': new Set([
    '02', '04', '05', '06', '07', '08', '09', '10',
    '11', '13', '14', '15', '16', '17', '20', '21',
    '23', '28', '30', '31', '32', '34', '35', '36',
    '37', '38', '40', '41', '42', '43', '44', '48',
    '49', '50', '51', '55', '56', '57', '58', '59',
    '60', '61', '62', '63', '65', '66', '67', '69',
    '70', '71', '73', '75', '77', '79', '81', '82',
    '83', '84', '85', '87', '88',
  ]),
};

/** Ids known to have a tryout video in the given season. */
export function hasVideoSet(seasonCode) {
  return HAS_VIDEO_BY_SEASON[seasonCode] || new Set();
}
