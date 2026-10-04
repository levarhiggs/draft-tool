// jersey-picker.js — shared 1-8 jersey # picker popover.
//
// One tap/click on a player's jersey badge opens a 4x2 grid of numbers;
// tapping a free one assigns it, tapping a taken one unassigns it from its
// current owner (so a coach can immediately re-tap to claim it, rather than
// the popover closing and forcing a reopen). Originally built for
// gameboard.js's live Jersey # mode (showJerseyPicker there) — pulled out
// here so the SAME picker, with the SAME write-lock hierarchy
// (coaches-config.js's canEditJerseyNumber: team owner > admin > any other
// coach), is reachable from player.html and draft-board.html's lightbox too
// (user's request, 2026-10-05: "intuitively in 3 different places").
// gameboard.js keeps its own copy rather than importing this one — its
// picker is wired to live-game `side` roster state (ghosts, unresolved
// placeholders, in/out attendance) that doesn't apply anywhere else, and
// forcing a shared abstraction over that would cost more than the ~80 lines
// of duplication saved.
import { getCurrentCoach } from './coach-login.js';
import { canEditJerseyNumber, resolvedJerseyNumber } from './coaches-config.js';
import { saveJerseyNumber, clearJerseyNumber } from './firebase.js';

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same silhouette as gameboard.js's jerseyIconSvg — kept as its own copy
// rather than an import since gameboard.js's version isn't exported and
// this is the only other place that needs it.
function jerseyIconSvg(hex) {
  return `<svg class="gb-jersey-icon" viewBox="0 0 24 24" fill="${hex}" aria-hidden="true">
    <path d="M8 2 L2 6 L4.5 9.5 L7 8 L7 21 L17 21 L17 8 L19.5 9.5 L22 6 L16 2 L14 4 Q12 5.5 10 4 Z" />
  </svg>`;
}

// Same anchored-popover positioning already duplicated in gameboard.js and
// schedule.js — small enough that a fourth copy here is simpler than a
// shared export nobody else would import cleanly.
function positionPopover(popoverEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
  popoverEl.classList.remove('hidden');
  requestAnimationFrame(() => {
    const pw = popoverEl.offsetWidth;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 8;
    if (left > maxLeft) popoverEl.style.left = `${Math.max(8, maxLeft)}px`;
  });
}

let popoverEl = null;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement('div');
  popoverEl.id = 'jersey-picker-popover';
  popoverEl.className = 'sched-popover gb-jersey-popover hidden';
  document.body.appendChild(popoverEl);
  document.addEventListener('click', e => {
    if (!popoverEl.contains(e.target) && !e.target.closest('[data-jersey-trigger]')) {
      popoverEl.classList.add('hidden');
    }
  });
  return popoverEl;
}

/**
 * Open the picker anchored to `anchorEl` for `player` on `team`.
 *
 * `teammates` — every player on `team` (including `player` itself), each
 * `{ id, name, jerseyNumbers }` — is what "taken" is scoped to, per the
 * user's confirmed scope (2026-10-04): a number is only dimmed/blocked
 * relative to the other 7 players on the SAME team, not the whole league.
 *
 * `onChange()` is called after any successful write (assign or unassign)
 * so the caller can refresh whatever it renders — this module never
 * touches the caller's own DOM beyond the popover itself.
 */
export function openJerseyPicker(anchorEl, { player, team, teammates, onChange }) {
  const coach = getCurrentCoach();
  if (!coach) {
    alert('Log in as a coach to set jersey numbers.');
    return;
  }

  const popover = ensurePopover();
  const name = player.name || 'Player';

  function render() {
    // Re-read live each render — a teammate's entry may have just changed
    // (e.g. this same picker unassigned someone a moment ago).
    const taken = {}; // number -> teammate
    teammates.forEach(tm => {
      const num = resolvedJerseyNumber(team, tm.jerseyNumbers);
      if (num != null) taken[num] = tm;
    });

    const ownNum = resolvedJerseyNumber(team, player.jerseyNumbers);

    const buttons = Array.from({ length: 8 }, (_, i) => i + 1).map(n => {
      const owner = taken[n];
      const isSelf = owner && owner.id === player.id;
      const cls = owner && !isSelf ? ' gb-jersey-pick-taken' : isSelf ? ' gb-jersey-pick-selected' : '';
      const title = owner && !isSelf
        ? ` title="Assigned to ${escHtml(owner.name || 'another player')} — tap to unassign"`
        : isSelf ? ` title="${escHtml(name)}'s current number"` : '';
      return `<button class="gb-jersey-pick-btn${cls}" data-num="${n}"${title} type="button">${jerseyIconSvg('#8890a8')}<span>${n}</span></button>`;
    }).join('');

    // Explicit remove row, not just "tap your own highlighted number again"
    // — the user asked for an unambiguous way to remove a jersey # from
    // this same prompt, not an overloaded re-tap gesture.
    const removeRow = ownNum != null
      ? `<button class="gb-jersey-pick-remove" type="button">✕ Remove #${ownNum}</button>`
      : '';

    popover.innerHTML = `
      <div class="sched-popover-title">${escHtml(name)} — Jersey #</div>
      <div class="gb-jersey-pick-grid">${buttons}</div>
      ${removeRow}
    `;

    popover.querySelectorAll('.gb-jersey-pick-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const num = parseInt(btn.dataset.num, 10);
        const owner = taken[num];

        if (owner && owner.id === player.id) return; // already this player's own number — use Remove instead

        if (owner) {
          // Tapping someone else's number unassigns THEM — see the module
          // comment and gameboard.js's own showJerseyPicker for why this
          // beats reassigning directly (never a moment with a duplicate).
          try {
            await clearJerseyNumber(owner.id, coach.name, team);
            owner.jerseyNumbers = {};
            render();
            onChange?.();
          } catch (err) {
            if (err.code === 'jersey-locked') {
              alert(`#${num} is already set by ${err.blockedBy}. Confirm with them before changing it.`);
            } else {
              throw err;
            }
          }
          return;
        }

        try {
          await saveJerseyNumber(player.id, coach.name, team, num);
          player.jerseyNumbers = { [coach.name]: num };
          popover.classList.add('hidden');
          onChange?.();
        } catch (err) {
          if (err.code === 'jersey-locked') {
            alert(`#${num} is already set by ${err.blockedBy}. Confirm with them before changing it.`);
          } else {
            throw err;
          }
        }
      });
    });

    popover.querySelector('.gb-jersey-pick-remove')?.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await clearJerseyNumber(player.id, coach.name, team);
        player.jerseyNumbers = {};
        popover.classList.add('hidden');
        onChange?.();
      } catch (err) {
        if (err.code === 'jersey-locked') {
          alert(`Jersey # was set by ${err.blockedBy}. Confirm with them before clearing it.`);
        } else {
          throw err;
        }
      }
    });
  }

  render();
  positionPopover(popover, anchorEl);
}
