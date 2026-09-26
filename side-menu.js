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
let pendingUnsub = null;
let msgUnsub = null;

function syncAdminLinks() {
  const link = document.getElementById('nav-media-admin');
  if (!link) return;
  const coach = getCurrentCoach();
  const isAdmin = !!coach && TEAM_ADMINS.includes(coach.name);
  // Toggle a class, not inline style: this link is a flex row (so the pending
  // badge can sit at its right edge) and an inline `display` would override
  // that rule, collapsing the badge back onto the text.
  link.classList.toggle('hidden', !isAdmin);

  if (isAdmin) startPendingBadge(link);
  else {
    // Drop the subscription on logout — no reason to hold a live Firestore
    // listener open for someone who can't see the inbox.
    pendingUnsub?.(); pendingUnsub = null;
    msgUnsub?.(); msgUnsub = null;
    link.querySelector('.nav-badge')?.remove();
    document.getElementById('media-msg-badge')?.classList.add('hidden');
  }
}

/**
 * Live count of media awaiting review, as a red pill on the menu item.
 *
 * Subscribed rather than fetched once: an admin often leaves a tab open, and
 * a submission that arrives while they're on another page should surface
 * without a refresh. Imported lazily so no non-admin page pays for
 * media-data.js (and its Firestore query) just to render a menu.
 */
async function startPendingBadge(link) {
  if (pendingUnsub) return;
  try {
    const { subscribeSubmissions, subscribeMessages } = await import('./media-data.js');

    // Unread parent messages get their own badge in the HEADER, next to
    // Change PIN — not in the hamburger. A removal request is time-sensitive
    // in a way a queued photo is not, so it should be visible without opening
    // a menu.
    msgUnsub = subscribeMessages(list => {
      const n = list.filter(m => m.status === 'unread').length;
      const el = document.getElementById('media-msg-badge');
      const ct = document.getElementById('media-msg-count');
      if (!el || !ct) return;
      ct.textContent = n > 99 ? '99+' : String(n);
      el.classList.toggle('hidden', n === 0);
      el.setAttribute('aria-label', `${n} unread message${n === 1 ? '' : 's'} from parents`);
    });

    pendingUnsub = subscribeSubmissions(list => {
      const n = list.filter(s => s.status === 'pending').length;
      let badge = link.querySelector('.nav-badge');
      if (!n) { badge?.remove(); return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        link.appendChild(badge);
      }
      // 99+ keeps the pill from stretching the menu row on an unworked queue.
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.setAttribute('aria-label', `${n} item${n === 1 ? '' : 's'} awaiting review`);
    });
  } catch (err) {
    // A badge is a nicety — never let it break the menu.
    console.warn('media: pending badge unavailable', err);
  }
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

  // Draft Board is coach-only, same reasoning as Coach Rankings above — the
  // draft is final and coach-only tooling (sandbox boards, Pool/Split/
  // Unranked, the Random Coach Pick Wheel) has no business being reachable
  // by a logged-out visitor. draft-board.js gates itself too for anyone who
  // reaches the URL directly rather than through this menu.
  document.getElementById('nav-draft-board')?.addEventListener('click', e => {
    if (!getCurrentCoach()) {
      e.preventDefault();
      alert('Coaches must login to view the Draft Board.');
    }
  });
})();
