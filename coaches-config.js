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
