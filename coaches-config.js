// coaches-config.js — define all coaches and their PINs here
// Add or remove entries to match your actual coaching staff.
// PINs can be any combination of letters and numbers (up to 6 characters).
// Share each coach's PIN with them privately.

export const COACHES = [
  { name: 'Coach Mike',  pin: '123'},
  { name: 'Coach Levar',  pin: '123'},
  { name: 'Coach Alfred',   pin: '123'},
  { name: 'Coach Alex',     pin: '123'},
  { name: 'Coach Tatiana',  pin: '123'},
  { name: 'Coach Benjamin',  pin: '123'},
  { name: 'Coach 7',    pin: '123'},
  { name: 'Coach 8',    pin: '123'},
  { name: 'Coach 9',     pin: '123'},
  { name: 'Coach 10',    pin: '123'},
  { name: 'Coach 11',   pin: '123'},
  { name: 'Coach 12',     pin: '123'},
  { name: 'Coach 13',    pin: '123'},
  { name: 'Coach 14',    pin: '123'},
  { name: 'Coach 15',       pin: '123'},

];

// Coaches allowed to view and change Team Assignment
// Add or remove names here — must match exactly as written in COACHES above
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
