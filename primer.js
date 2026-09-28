// primer.js — Rotations primer page: records who has read it (logged-in
// coaches only) and shows admins a live "who's read it" list.
import { getCurrentCoach } from './coach-login.js';
import { getActiveCoaches, TEAM_ADMINS, TEAMS, TEAM_COLORS } from './coaches-config.js';
import { CURRENT_SEASON } from './season-config.js';
import { recordPrimerView, subscribePrimerViews } from './firebase.js';

let recordedFor = null;   // personId already recorded on this page load
let viewsUnsub = null;

function isAdmin(coach) {
  return !!coach && TEAM_ADMINS.includes(coach.name);
}

// Same "Coach X" -> "Team X" suffix match as coach-login.js / gameboard.js.
function coachTeam(coachName) {
  const suffix = coachName.replace(/^(Coach|Director)\s+/, '');
  return TEAMS.find(t => t.replace(/^Team\s+/, '') === suffix) || '';
}

async function sync() {
  const coach = getCurrentCoach();
  document.getElementById('primer-login-note').classList.toggle('hidden', !!coach);

  // One view per page load. Logging in on this page counts too — coach-login.js
  // deliberately doesn't redirect away from primer.html.
  if (coach && recordedFor !== coach.personId) {
    recordedFor = coach.personId;
    try {
      await recordPrimerView(coach.personId, coach.name);
    } catch (err) {
      console.error('recordPrimerView failed:', err);
    }
  }

  const panel = document.getElementById('primer-readers');
  if (isAdmin(coach)) {
    panel.classList.remove('hidden');
    if (!viewsUnsub) viewsUnsub = subscribePrimerViews(renderReaders);
  } else {
    panel.classList.add('hidden');
    viewsUnsub?.(); viewsUnsub = null;
  }
}

function formatWhen(ts) {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

function renderReaders(views) {
  // Coaches with a team this season; admins aren't the audience.
  const coaches = getActiveCoaches(CURRENT_SEASON).filter(c => !TEAM_ADMINS.includes(c.name));
  const rows = coaches.map(c => ({ ...c, team: coachTeam(c.name), view: views[c.personId] }));
  // Unread first, so the follow-up list is at the top.
  rows.sort((a, b) => (!!a.view - !!b.view) || a.name.localeCompare(b.name));

  const readCount = rows.filter(r => r.view).length;
  document.getElementById('primer-readers-summary').textContent =
    `${readCount} of ${rows.length} coaches have opened this page.`;

  document.getElementById('primer-readers-body').innerHTML = rows.map(r => {
    const color = TEAM_COLORS[r.team]?.shortName || TEAM_COLORS[r.team]?.name || '';
    const status = r.view
      ? `<span class="primer-read-yes">✓ ${escHtml(formatWhen(r.view.firstViewed))}</span>`
      : '<span class="primer-read-no">Not yet</span>';
    const times = r.view ? `${r.view.count || 1}` : '—';
    return `<tr>
      <td>${escHtml(r.name)}</td>
      <td>${escHtml(color)}</td>
      <td>${status}</td>
      <td>${times}</td>
    </tr>`;
  }).join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('coachChanged', sync);
sync();
