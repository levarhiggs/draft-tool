// coaches-config.js — define all coaches and their PINs here
// Add or remove entries to match your actual coaching staff.
// PINs can be any combination of letters and numbers (up to 6 characters).
// Share each coach's PIN with them privately.

export const COACHES = [
  { name: 'Coach Alex',            pin: '123'  },
  { name: 'Coach Alfred',          pin: '456'  },
  { name: 'Coach Andre',           pin: '789'  },
  { name: 'Coach Ben',             pin: '123'  },
  { name: 'Coach Chris',           pin: '456'  },
  { name: 'Coach Daven-Josiah',    pin: '789'  },
  { name: 'Coach Humberto-Felipe', pin: '123'  },
  { name: 'Coach Jeff',            pin: '456'  },
  { name: 'Coach Kevin',           pin: '789'  },
  { name: 'Coach Levar',           pin: '123'  },
  { name: 'Coach Mike',            pin: '1111' },
  { name: 'Coach Sedat',           pin: '789'  },
  { name: 'Coach Tati',            pin: '1234' },
];

// Coaches allowed to view and change Team Assignment and mark No Shows
// Must match exactly as written in COACHES above
export const TEAM_ADMINS = [
  'Coach Mike',
  'Coach Levar',
];

// Team names available for assignment
export const TEAMS = [
  'Team Mike',
  'Team Levar',
  'Team Alfred',
  'Team Alex',
  'Team Tatiana',
  'Undrafted',
];
