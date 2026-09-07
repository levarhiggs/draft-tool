// schedule-data.js — season schedule Sheet CSV fetch + parse, and date helpers.
// Mirrors players-data.js's CSV fetch pattern but is a standalone module —
// players-data.js is left untouched.

export const SCHEDULE_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTCOk033NnCmR_lgFCWNLkMSdqNSAHbQ7PtldyAsf1qvh9YQdVP6gxntlYRoapaIMfumz0jRoXBeT-1/pub?output=csv';

export const COL = {
  GAME:        'Game #',
  DAY:         'Day',
  DATE:        'Date',
  TIME:        'Time',
  VISITOR:     'Visitor',
  HOME:        'Home',
  LOCATION:    'Location',
  FILTER:      'FILTER',
  V:           'V',
  H:           'H',
  DESCR:       'DESCR',
  V_SCORE:     'V_SCORE',
  H_SCORE:     'H_SCORE',
  WINNER:      'WINNER',
  FINAL_SCORE: 'Final Score',
};

// ── Sheet fetch ───────────────────────────────────────────────────────────────

export async function fetchSchedule() {
  const cached = sessionStorage.getItem('scheduleSheet');
  if (cached) return JSON.parse(cached);
  const res = await fetch(SCHEDULE_CSV_URL);
  if (!res.ok) throw new Error(`Schedule sheet fetch failed: ${res.status}`);
  const text = await res.text();
  const games = parseCSV(text);
  sessionStorage.setItem('scheduleSheet', JSON.stringify(games));
  return games;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

// Turns "07/07 - Tue" + "6:30 PM" into a real JS Date. No year is present in
// the sheet, so we assume the current calendar year.
//
// A previous version of this function auto-rolled to "next year" whenever a
// parsed date landed more than ~60 days in the past, intended to keep a
// schedule published BEFORE a season started from misreading early dates as
// "last year." In practice this backfired once the season itself ran long
// past that 60-day window: by ~60 days after the season started, EVERY game
// (including ones already played) started reading as more than 60 days in
// the past and got silently bumped a full year forward (e.g. discovered
// 2026-09-07: a season that ran 07/07-08/10/2026 was rendering as July 2027
// on the calendar). The heuristic had no way to distinguish "this sheet is
// for next year" from "this season is just over now" — it's being removed
// rather than patched with a wider window, since any fixed window will
// eventually hit the same failure mode again as more time passes.
//
// Once the multi-season work lands (see _local/PRODUCT_SPEC.md's
// "Multi-Season Architecture"), each season's schedule will carry its own
// explicit year/season code instead of asking this function to guess it —
// this plain current-year assumption is the correct interim behavior until
// then, not a permanent design.
export function parseGameDate(dateStr, timeStr) {
  if (!dateStr) return null;

  const dateMatch = String(dateStr).match(/(\d{1,2})\/(\d{1,2})/);
  if (!dateMatch) return null;
  const month = parseInt(dateMatch[1], 10);
  const day   = parseInt(dateMatch[2], 10);

  let hours = 0, minutes = 0;
  if (timeStr) {
    const timeMatch = String(timeStr).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      minutes = parseInt(timeMatch[2], 10);
      const ampm = timeMatch[3]?.toUpperCase();
      if (ampm === 'PM' && hours !== 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
    }
  }

  const year = new Date().getFullYear();
  return new Date(year, month - 1, day, hours, minutes);
}
