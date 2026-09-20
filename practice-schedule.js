// practice-schedule.js — Weekly Coaching Schedule (read-only MVP).
// Ported from the standalone artifact built 2026-09-20 (see
// _local/PRACTICE_SCHEDULE_SPEC.md for the full history/decisions). Admin
// drag-and-drop, Add Coach, and remove-by-double-click are NOT wired here —
// out of scope for this pass per the user's direction ("bypass coding that
// part" if it's a hiccup; ship the read-only view first).
import { subscribePracticeSchedule, seedPracticeScheduleIfEmpty } from './firebase.js';

// ── Static grid shape — which days/hours/courts exist. This does NOT change
// season to season on its own; it's a fact about the two gyms' rented time,
// not season config. Only the mutable coach/tbd per slot lives in Firestore.

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

const HOURS = ["9-10","10-11","11-12","12-1","BREAK","4-5","5-6","6-7","7-8","8-9"];
const HOUR_LABELS = {
  "9-10":"9 AM", "10-11":"10 AM", "11-12":"11 AM", "12-1":"12 PM",
  "4-5":"4 PM", "5-6":"5 PM", "6-7":"6 PM", "7-8":"7 PM", "8-9":"8 PM",
};

const ACTIVE_HOURS = {
  Sunday:    ["4-5","5-6","6-7"],
  Monday:    ["6-7","7-8","8-9"],
  Tuesday:   ["6-7","7-8","8-9"],
  Wednesday: ["6-7","7-8","8-9"],
  Thursday:  ["6-7","7-8","8-9"],
  Friday:    [],
  Saturday:  ["9-10","10-11","11-12","12-1"],
};

// Per-day slot layout: how many Mullins/Glades slots exist at each hour, and
// (for Mullins) which court — West/East — each index is. This is the shape
// the seed data below was built from; it stays fixed even as `coach`/`tbd`
// values change in Firestore.
const SLOT_LAYOUT = {
  Sunday: {
    "4-5": { mullins: ["East","East"], glades: [] },
    "5-6": { mullins: ["East","East"], glades: [] },
    "6-7": { mullins: ["East","East"], glades: [] },
  },
  Monday: {
    "6-7": { mullins: ["West","West"], glades: [null,null] },
    "7-8": { mullins: ["East","East","West","West"], glades: [null,null] },
    "8-9": { mullins: [], glades: [null,null] },
  },
  Tuesday: {
    "6-7": { mullins: [], glades: [null,null] },
    "7-8": { mullins: [], glades: [null,null] },
    "8-9": { mullins: [], glades: [null,null] },
  },
  Wednesday: {
    "6-7": { mullins: ["West","West"], glades: [null,null] },
    "7-8": { mullins: ["East","East","West","West"], glades: [null,null] },
    "8-9": { mullins: [], glades: [null,null] },
  },
  Thursday: {
    "6-7": { mullins: [], glades: [null,null] },
    "7-8": { mullins: [], glades: [null,null] },
    "8-9": { mullins: [], glades: [null,null] },
  },
  Friday: {},
  Saturday: {
    "9-10":  { mullins: ["East","East"], glades: [] },
    "10-11": { mullins: ["East","East"], glades: [] },
    "11-12": { mullins: ["East","East"], glades: [] },
    "12-1":  { mullins: ["East","East"], glades: [] },
  },
};

// Seed data — the artifact's schedule as of 2026-09-20, written once into
// Firestore if the doc doesn't exist yet (seedPracticeScheduleIfEmpty never
// overwrites real data). Key scheme matches firebase.js's own comment:
// "{day}|{hour}|{loc}|{idx}".
const SEED_SLOTS = {
  "Sunday|4-5|mullins|0":  { coach: "Kev",  tbd: false },
  "Sunday|4-5|mullins|1":  { coach: null,   tbd: false },
  "Sunday|5-6|mullins|0":  { coach: null,   tbd: false },
  "Sunday|5-6|mullins|1":  { coach: null,   tbd: false },
  "Sunday|6-7|mullins|0":  { coach: null,   tbd: false },
  "Sunday|6-7|mullins|1":  { coach: null,   tbd: false },

  "Monday|6-7|mullins|0":  { coach: "Kingston/Shaun", tbd: false },
  "Monday|6-7|mullins|1":  { coach: "Micah",          tbd: false },
  "Monday|6-7|glades|0":   { coach: "Sedat",          tbd: false },
  "Monday|6-7|glades|1":   { coach: null,             tbd: false },
  "Monday|7-8|mullins|0":  { coach: "Humberto", tbd: false },
  "Monday|7-8|mullins|1":  { coach: "Paul",     tbd: false },
  "Monday|7-8|mullins|2":  { coach: "X",        tbd: false },
  "Monday|7-8|mullins|3":  { coach: "Ken",      tbd: false },
  "Monday|7-8|glades|0":   { coach: "Craig",    tbd: false },
  "Monday|7-8|glades|1":   { coach: null,       tbd: true  },
  "Monday|8-9|glades|0":   { coach: null,       tbd: false },
  "Monday|8-9|glades|1":   { coach: null,       tbd: false },

  "Tuesday|6-7|glades|0":  { coach: null,          tbd: false },
  "Tuesday|6-7|glades|1":  { coach: null,          tbd: false },
  "Tuesday|7-8|glades|0":  { coach: null,          tbd: false },
  "Tuesday|7-8|glades|1":  { coach: "Mason/Jaylen", tbd: false },
  "Tuesday|8-9|glades|0":  { coach: null,          tbd: false },
  "Tuesday|8-9|glades|1":  { coach: null,          tbd: false },

  "Wednesday|6-7|mullins|0": { coach: "Sedat", tbd: false },
  "Wednesday|6-7|mullins|1": { coach: null,    tbd: false },
  "Wednesday|6-7|glades|0":  { coach: null,    tbd: false },
  "Wednesday|6-7|glades|1":  { coach: null,    tbd: false },
  "Wednesday|7-8|mullins|0": { coach: "Humberto", tbd: false },
  "Wednesday|7-8|mullins|1": { coach: null,       tbd: false },
  "Wednesday|7-8|mullins|2": { coach: null,       tbd: false },
  "Wednesday|7-8|mullins|3": { coach: null,       tbd: false },
  "Wednesday|7-8|glades|0":  { coach: null,       tbd: false },
  "Wednesday|7-8|glades|1":  { coach: null,       tbd: false },
  "Wednesday|8-9|glades|0":  { coach: null,       tbd: false },
  "Wednesday|8-9|glades|1":  { coach: null,       tbd: false },

  "Thursday|6-7|glades|0": { coach: "Mason/Jaylen",  tbd: false },
  "Thursday|6-7|glades|1": { coach: "Kingston/Shaun", tbd: false },
  "Thursday|7-8|glades|0": { coach: "Ken",  tbd: false },
  "Thursday|7-8|glades|1": { coach: null,  tbd: false },
  "Thursday|8-9|glades|0": { coach: null,  tbd: false },
  "Thursday|8-9|glades|1": { coach: null,  tbd: false },

  "Saturday|9-10|mullins|0":  { coach: "Paul", tbd: false },
  "Saturday|9-10|mullins|1":  { coach: null,   tbd: true  },
  "Saturday|10-11|mullins|0": { coach: "David", tbd: false },
  "Saturday|10-11|mullins|1": { coach: null,    tbd: false },
  "Saturday|11-12|mullins|0": { coach: null, tbd: false },
  "Saturday|11-12|mullins|1": { coach: null, tbd: false },
  "Saturday|12-1|mullins|0":  { coach: null, tbd: false },
  "Saturday|12-1|mullins|1":  { coach: null, tbd: false },
};

let liveSlots = null; // populated from Firestore on first snapshot

function slotKey(day, hour, loc, idx) {
  return `${day}|${hour}|${loc}|${idx}`;
}

function courtFor(day, hour, idx) {
  const layout = SLOT_LAYOUT[day]?.[hour]?.mullins;
  return layout ? layout[idx] : null;
}

function slotCountFor(day, hour, loc) {
  return (SLOT_LAYOUT[day]?.[hour]?.[loc] || []).length;
}

function dayHasLocation(day, loc) {
  const hours = ACTIVE_HOURS[day] || [];
  return hours.some(hour => slotCountFor(day, hour, loc) > 0);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}

function chipHtml(entry) {
  if (entry.tbd) return `<span class="psched-chip tbd-chip" title="Coach TBD">TBD</span>`;
  if (!entry.coach) return "";
  const name = escHtml(entry.coach);
  return `<span class="psched-chip" title="${name}">${name}</span>`;
}

function openLabelHtml(loc, court) {
  if (loc === "mullins" && court) return `<span class="psched-open-label">OPEN - ${court.toUpperCase()}</span>`;
  return `<span class="psched-open-label">OPEN</span>`;
}

function renderSlot(day, hour, loc, idx) {
  const key = slotKey(day, hour, loc, idx);
  const entry = (liveSlots && liveSlots[key]) || { coach: null, tbd: false };
  const chip = chipHtml(entry);
  const openClass = chip ? "" : " open-slot";
  const court = loc === "mullins" ? courtFor(day, hour, idx) : null;
  const courtClass = court ? " " + court.toLowerCase() : "";
  const content = chip || openLabelHtml(loc, court);
  return `<div class="psched-tile ${loc}${openClass}${courtClass}">${content}</div>`;
}

function rowCountFor(day, hour) {
  return Math.max(slotCountFor(day, hour, "mullins"), slotCountFor(day, hour, "glades"));
}

function build() {
  const table = document.getElementById('psched-table');
  if (!table) return;

  if (liveSlots === null) {
    table.innerHTML = '';
    const wrap = table.closest('.psched-grid-scroll');
    if (wrap && !wrap.querySelector('.psched-loading')) {
      const p = document.createElement('div');
      p.className = 'psched-loading';
      p.textContent = 'Loading schedule…';
      wrap.appendChild(p);
    }
    return;
  }
  table.closest('.psched-grid-scroll')?.querySelector('.psched-loading')?.remove();

  const activeDayLocs = {};
  DAYS.forEach(day => {
    activeDayLocs[day] = ["mullins","glades"].filter(loc => dayHasLocation(day, loc));
  });

  const WIDE_DAYS = ["Monday","Wednesday"];
  const NARROW_DAYS = ["Sunday","Tuesday","Thursday","Saturday"];
  const colgroup = '<colgroup><col class="time-col">' + DAYS.map(d => {
    if (d === "Friday") return '<col class="friday-col">';
    if (WIDE_DAYS.includes(d)) return '<col class="wide-day">';
    if (NARROW_DAYS.includes(d)) return '<col class="narrow-day">';
    return '<col>';
  }).join('') + '</colgroup>';

  const thead = '<thead><tr><th>Time</th>' +
    DAYS.map(d => d === "Friday" ? '<th class="friday-head">Fri</th>' : `<th>${d}</th>`).join('') +
    '</tr></thead>';

  function renderLocHeaderRow() {
    let row = '<tr class="loc-header-row"><th></th>';
    DAYS.forEach(day => {
      if (day === "Friday") { row += '<td class="friday-cell"></td>'; return; }
      const labels = activeDayLocs[day].map(loc =>
        `<span class="psched-loc-label ${loc}">${loc === "mullins" ? "Mullins" : "Glades"}</span>`
      ).join('');
      row += `<td><div style="display:flex;justify-content:center;gap:6px;">${labels}</div></td>`;
    });
    return row + '</tr>';
  }

  let tbody = '';
  HOURS.forEach(hour => {
    if (hour === "BREAK") {
      tbody += `<tr class="break-row"><th>&mdash;</th><td colspan="${DAYS.length}" style="text-align:center;font-size:0.62rem;font-style:italic;">no available slots 1 PM – 4 PM</td></tr>`;
      tbody += renderLocHeaderRow();
      return;
    }
    const anyActive = DAYS.some(day => (ACTIVE_HOURS[day] || []).includes(hour));
    if (!anyActive) return;

    const maxRows = Math.max(1, ...DAYS.map(day =>
      (ACTIVE_HOURS[day] || []).includes(hour) ? rowCountFor(day, hour) : 0));

    for (let r = 0; r < maxRows; r++) {
      const isFirst = r === 0;
      let row = `<tr class="${isFirst ? 'hour-start slot-row' : 'slot-row'}">`;
      row += isFirst ? `<th rowspan="${maxRows}">${HOUR_LABELS[hour]}</th>` : '';
      DAYS.forEach(day => {
        if (day === "Friday") {
          if (isFirst) row += `<td class="friday-cell" rowspan="${maxRows}"></td>`;
          return;
        }
        const active = (ACTIVE_HOURS[day] || []).includes(hour);
        if (!active) {
          if (isFirst) row += `<td class="nodata-cell" rowspan="${maxRows}"></td>`;
          return;
        }
        const locs = activeDayLocs[day];
        const cells = locs.map(loc => {
          const count = slotCountFor(day, hour, loc);
          return r < count
            ? `<div>${renderSlot(day, hour, loc, r)}</div>`
            : '<div></div>';
        }).join('');
        row += `<td><div style="display:flex;justify-content:center;gap:6px;">${cells}</div></td>`;
      });
      tbody += row + '</tr>';
    }
  });

  table.innerHTML = colgroup + thead + '<tbody>' + tbody + '</tbody>';
}

// ── Boot ─────────────────────────────────────────────────────────────────────

seedPracticeScheduleIfEmpty(SEED_SLOTS).catch(err =>
  console.error('seedPracticeScheduleIfEmpty error:', err));

subscribePracticeSchedule(slots => {
  liveSlots = slots || SEED_SLOTS;
  build();
});

build();
