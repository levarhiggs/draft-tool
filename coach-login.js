// coach-login.js — handles coach session (stored in sessionStorage)
import { getActiveCoaches, TEAMS } from './coaches-config.js';
import { CURRENT_SEASON } from './season-config.js';
import { getPinOverride, savePinOverride } from './firebase.js';

const SESSION_KEY = 'draft_tool_coach';

export function getCurrentCoach() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null;
  } catch { return null; }
}

function setCurrentCoach(coach) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(coach));
}

function clearCurrentCoach() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── UI wiring (runs on every page that loads coach-login.js) ─────────────────

function updateBadge() {
  const coach = getCurrentCoach();
  const badge  = document.getElementById('coach-badge');
  const btnLogin = document.getElementById('btn-login');
  const badgeName = document.getElementById('coach-badge-name');
  if (!badge || !btnLogin) return;

  if (coach) {
    badgeName.textContent = coach.name;
    badge.classList.remove('hidden');
    btnLogin.classList.add('hidden');
  } else {
    badge.classList.add('hidden');
    btnLogin.classList.remove('hidden');
  }

  // Notify other modules that coach state changed
  document.dispatchEvent(new CustomEvent('coachChanged', { detail: coach }));
}

function openLoginModal() {
  const modal = document.getElementById('modal-login');
  const select = document.getElementById('login-name');
  const pinInput = document.getElementById('login-pin');
  const errMsg = document.getElementById('login-error');
  if (!modal) return;

  // Populate coach dropdown — only slots assigned to a person with a PIN.
  select.innerHTML = '<option value="">— choose —</option>' +
    getActiveCoaches(CURRENT_SEASON).map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  pinInput.value = '';
  errMsg.classList.add('hidden');
  modal.classList.remove('hidden');
  setTimeout(() => select.focus(), 50);
}

function closeLoginModal() {
  document.getElementById('modal-login')?.classList.add('hidden');
}

async function attemptLogin() {
  const name  = document.getElementById('login-name').value;
  const pin   = document.getElementById('login-pin').value;
  const errMsg = document.getElementById('login-error');
  const submitBtn = document.getElementById('btn-login-submit');

  const candidate = getActiveCoaches(CURRENT_SEASON).find(c => c.name === name);
  if (!candidate) {
    errMsg.classList.remove('hidden');
    return;
  }

  submitBtn.disabled = true;
  // A coach who has changed their PIN has an override in Firestore that
  // takes priority over the static coaches-config.js pin (which only
  // changes when code is edited and deployed).
  const currentPin = (await getPinOverride(candidate.personId)) ?? candidate.pin;
  submitBtn.disabled = false;

  if (pin !== currentPin) {
    errMsg.classList.remove('hidden');
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
    return;
  }

  setCurrentCoach({ name: candidate.name, personId: candidate.personId });
  closeLoginModal();
  updateBadge();

  // Straight to Rotations with the coach's own team pre-selected — building
  // game lineups is the coach's real job during the regular season, not
  // wherever they clicked "Coach Login" from. Used to be draft-board.html
  // during the draft, and player.html (rankings) before that. A coach with
  // no team this season (the commissioner) lands on Rotations without one,
  // which falls back to their last-viewed team.
  const team = coachTeam(candidate.name);
  window.location.href = team
    ? `rotations.html?team=${encodeURIComponent(team)}`
    : 'rotations.html';
}

// Coach's own team, by the same "Coach X" -> "Team X" suffix match
// gameboard.js's coachDefaultTeam uses (no stored coach->team mapping exists).
function coachTeam(coachName) {
  const suffix = coachName.replace(/^(Coach|Director)\s+/, '');
  return TEAMS.find(t => t.replace(/^Team\s+/, '') === suffix) || '';
}

// ── Change PIN ────────────────────────────────────────────────────────────────

function openChangePinModal() {
  const modal = document.getElementById('modal-change-pin');
  if (!modal) return;
  document.getElementById('change-pin-new').value = '';
  document.getElementById('change-pin-confirm').value = '';
  document.getElementById('change-pin-error').classList.add('hidden');
  document.getElementById('change-pin-success').classList.add('hidden');
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('change-pin-new').focus(), 50);
}

function closeChangePinModal() {
  document.getElementById('modal-change-pin')?.classList.add('hidden');
}

async function submitChangePin() {
  const coach = getCurrentCoach();
  if (!coach) return;

  const newPin   = document.getElementById('change-pin-new').value.trim();
  const confirm  = document.getElementById('change-pin-confirm').value.trim();
  const errMsg   = document.getElementById('change-pin-error');
  const successMsg = document.getElementById('change-pin-success');
  const submitBtn = document.getElementById('btn-change-pin-submit');

  errMsg.classList.add('hidden');
  successMsg.classList.add('hidden');

  if (!newPin) {
    errMsg.textContent = 'Enter a PIN.';
    errMsg.classList.remove('hidden');
    return;
  }
  if (newPin !== confirm) {
    errMsg.textContent = 'PINs do not match.';
    errMsg.classList.remove('hidden');
    return;
  }

  submitBtn.disabled = true;
  try {
    await savePinOverride(coach.personId, newPin);
    successMsg.classList.remove('hidden');
    setTimeout(closeChangePinModal, 1200);
  } catch (err) {
    errMsg.textContent = err.message;
    errMsg.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateBadge();

  document.getElementById('btn-login')
    ?.addEventListener('click', openLoginModal);

  document.getElementById('btn-login-submit')
    ?.addEventListener('click', attemptLogin);

  document.getElementById('btn-login-cancel')
    ?.addEventListener('click', closeLoginModal);

  document.getElementById('login-pin')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });

  document.getElementById('btn-logout')
    ?.addEventListener('click', () => {
      clearCurrentCoach();
      updateBadge();
    });

  // Close modal on backdrop click
  document.getElementById('modal-login')
    ?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeLoginModal();
    });

  document.getElementById('btn-change-pin')
    ?.addEventListener('click', openChangePinModal);

  document.getElementById('btn-change-pin-submit')
    ?.addEventListener('click', submitChangePin);

  document.getElementById('btn-change-pin-cancel')
    ?.addEventListener('click', closeChangePinModal);

  document.getElementById('change-pin-confirm')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') submitChangePin(); });

  document.getElementById('modal-change-pin')
    ?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeChangePinModal();
    });
});
