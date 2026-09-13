// video-availability.js — which players have a tryout video this season.
//
// TEMPORARY-ISH: this exists because videos are still being matched and
// uploaded. The app normally discovers video by scanning the season Drive
// folder (players-data.js buildDriveIndex), which is the source of truth
// once everything is uploaded. This list lets the Has Video filter/sort
// work immediately, before the Drive scan would see the files.
//
// Regenerate from _local/_work/video_final.json as more clips are matched.

export const HAS_VIDEO_BY_SEASON = {
  '26.3': new Set([
    '16', '21', '23', '28', '30', '31', '32', '34',
    '35', '36', '37', '38', '40', '41', '42', '43',
    '44', '48', '49', '50', '51', '55', '56', '57',
    '58', '59', '60', '61', '62', '63', '65', '66',
    '67', '69', '70', '71', '73', '75', '77', '79',
    '81', '82', '83', '84', '85', '87', '88',
  ]),
};

/** Ids known to have a tryout video in the given season. */
export function hasVideoSet(seasonCode) {
  return HAS_VIDEO_BY_SEASON[seasonCode] || new Set();
}
