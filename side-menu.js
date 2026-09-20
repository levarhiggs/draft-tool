// side-menu.js — hamburger side panel, shared by every page.
import { getCurrentCoach } from './coach-login.js';
import { TEAM_ADMINS } from './coaches-config.js';

/**
 * The Media Inbox link is admin-only, so it's hidden rather than shown-then-
 * refused. Runs on load and again on every login/logout, since the menu markup
 * is static in each page's HTML and nothing else re-renders it.
 *
 * media-admin.html gates itself independently for anyone reaching the URL
 * directly — this is the menu-level half, same split as Coach Rankings below.
 */
function syncAdminLinks() {
  const link = document.getElementById('nav-media-admin');
  if (!link) return;
  const coach = getCurrentCoach();
  const isAdmin = !!coach && TEAM_ADMINS.includes(coach.name);
  link.style.display = isAdmin ? '' : 'none';
}
document.addEventListener('coachChanged', syncAdminLinks);
document.addEventListener('DOMContentLoaded', syncAdminLinks);
syncAdminLinks();

(function wireSideMenu() {
  const toggle  = document.getElementById('btn-menu-toggle');
  const closeBtn = document.getElementById('btn-menu-close');
  const overlay = document.getElementById('side-menu-overlay');
  const menu    = document.getElementById('side-menu');
  if (!toggle || !overlay || !menu) return;

  function setOpen(open) {
    menu.classList.toggle('open', open);
    overlay.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
  closeBtn?.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });

  // Coach Rankings is coach-only. Intercept the click on every page's menu
  // rather than only gating inside player.html itself, so a logged-out coach
  // gets the notice without a page navigation + bounce-back. player.html
  // still gates itself too (see its own coach-only gate) for anyone who
  // reaches the URL directly rather than through this menu.
  document.getElementById('nav-player-ranking')?.addEventListener('click', e => {
    if (!getCurrentCoach()) {
      e.preventDefault();
      alert('Coaches must login to view and set player rankings.');
    }
  });
})();
