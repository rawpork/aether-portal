// The Elarion tray: the conversation slides up from the bottom, just above the composer, over whatever page is open. Sending from the
// composer opens it (the composer stays the place you type), Esc or the close button puts it away, and the page underneath stays
// where it is, so asking about a node or a project never takes you anywhere. It is not a modal: the page and the composer stay usable.
// The conversation itself is the brain dock (brain-dock.js), mounted into #mc-elaron inside the tray by the caller.

export function setupElarionDrawer(doc, { onOpen = () => {}, onClose = () => {}, onClosing = () => {}, focusTarget = () => null } = {}) {
  const win = doc.defaultView || globalThis;
  const drawer = doc.getElementById('mc-drawer');
  const scrim = doc.getElementById('mc-drawer-scrim');
  const closeButton = doc.getElementById('mc-drawer-close');
  if (!drawer) return null;
  let open = false;
  let opener = null;

  // Closed, the drawer is off-screen: it must not be reachable by Tab or a screen reader.
  function sync() {
    drawer.toggleAttribute('inert', !open);
    drawer.setAttribute('aria-hidden', String(!open));
    if (scrim) scrim.hidden = true;
    doc.body.classList.toggle('drawer-open', open);
  }

  function show(from) {
    if (open) {
      const target = focusTarget();
      if (target) target.focus({ preventScroll: true });
      return;
    }
    open = true;
    opener = from || doc.activeElement;
    sync();
    // Focus goes to the message box, where the person types next.
    const target = focusTarget() || closeButton;
    if (target) target.focus({ preventScroll: true });
    onOpen();
  }

  function hide(restore = true) {
    if (!open) return;
    open = false;
    sync();
    // Told before focus goes back, so a composer that opens the drawer when focused does not reopen it on the way out.
    onClosing();
    if (restore && opener && opener.focus && doc.contains(opener) && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    onClose();
  }

  if (closeButton) closeButton.addEventListener('click', () => hide());
  if (scrim) scrim.addEventListener('click', () => hide());
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open && !event.defaultPrevented) {
      event.preventDefault();
      hide();
    }
  });
  sync();

  return { open: show, close: hide, toggle: (from) => (open ? hide() : show(from)), isOpen: () => open };
}
