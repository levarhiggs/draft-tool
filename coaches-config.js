// coaches-config.js — define all coaches and their PINs here
// Add or remove entries to match your actual coaching staff.
// PINs can be any combination of letters and numbers (up to 6 characters).
// Share each coach's PIN with them privately.

export const COACHES = [
  { name: 'Coach Alex',          pin: '123'  },
  { name: 'Coach Alfred-Levar',  pin: '456'  },
  { name: 'Coach Andre',         pin: '789'  },
  { name: 'Coach Ben',           pin: '123'  },
  { name: 'Coach Chris',         pin: '456'  },
  { name: 'Coach Daven-Josiah',  pin: '789'  },
  { name: 'Coach Humberto',      pin: '123'  },
  { name: 'Coach Jeff',          pin: '456'  },
  { name: 'Coach Kevin',         pin: '789'  },
  { name: 'Coach Mike C.',       pin: '2345' },
  { name: 'Coach Sedat',         pin: '789'  },
  { name: 'Coach Tati',          pin: '1234' },
  { name: 'Director Mike M.',    pin: '1111' },
];

// Team color, as it appears in the season schedule sheet (V/H columns
// identify teams by color name, not coach/team name — this is the link
// between the two). Also used for color chips/badges in the UI.
// hex values are close visual approximations, not official brand codes.
// `shortName`, when present, is used ONLY in space-constrained UI (dropdown
// menus, the Gameboard team popover title) — `name` is the canonical value
// and must match the schedule sheet's Visitor/Home color columns verbatim,
// so it's never shortened at the data level.
export const TEAM_COLORS = {
  'Team Humberto':     { name: 'Purple',        hex: '#7B3FA0' },
  'Team Alex':         { name: 'Deep Orange',   hex: '#C1440E' },
  'Team Jeff':         { name: 'Carolina Blue', hex: '#B4E1FA' },
  'Team Daven-Josiah': { name: 'Grey Concrete', hex: '#8C8C8C', shortName: 'Grey' },
  'Team Ben':          { name: 'Maroon',        hex: '#7A3B2E' },
  'Team Tati':         { name: 'Neon Yellow',   hex: '#F5EA0A' },
  'Team Sedat':        { name: 'White',         hex: '#FFFFFF' },
  'Team Andre':        { name: 'Forest Green',  hex: '#1B5E20' },
  'Team Alfred-Levar': { name: 'Lime Shock',    hex: '#8BC98A', shortName: 'Lime' },
  'Team Kevin':        { name: 'Gold',          hex: '#F5A623' },
  'Team Mike C.':      { name: 'Black',         hex: '#0A0A0A' },
  'Team Chris':        { name: 'True Red',      hex: '#E30613' },
};

// Coaches allowed to view and change Team Assignment and mark No Shows
// Must match exactly as written in COACHES above
export const TEAM_ADMINS = [
  'Director Mike M.',
  'Coach Alfred-Levar',
];

// Team names available for assignment
export const TEAMS = [
  'Team Humberto',
  'Team Alex',
  'Team Jeff',
  'Team Daven-Josiah',
  'Team Ben',
  'Team Tati',
  'Team Sedat',
  'Team Andre',
  'Team Alfred-Levar',
  'Team Kevin',
  'Team Mike C.',
  'Team Chris',
  'Undrafted',
];
