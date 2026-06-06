// coach-login.js — handles coach session (stored in sessionStorage)
import { COACHES } from './coaches-config.js';

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

// ── UI wiring (runs on both index.html and player.html) ──────────────────────

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

  // Populate coach dropdown
  select.innerHTML = '<option value="">— choose —</option>' +
    COACHES.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  pinInput.value = '';
  errMsg.classList.add('hidden');
  modal.classList.remove('hidden');
  setTimeout(() => select.focus(), 50);
}

function closeLoginModal() {
  document.getElementById('modal-login')?.classList.add('hidden');
}

function attemptLogin() {
  const name  = document.getElementById('login-name').value;
  const pin   = document.getElementById('login-pin').value;
  const errMsg = document.getElementById('login-error');

  const match = COACHES.find(c => c.name === name && c.pin === pin);
  if (!match) {
    errMsg.classList.remove('hidden');
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
    return;
  }

  setCurrentCoach({ name: match.name });
  closeLoginModal();
  updateBadge();
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
});
