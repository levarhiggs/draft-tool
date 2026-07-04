// side-menu.js — hamburger side panel, shared by index.html and rotations.html
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
})();
