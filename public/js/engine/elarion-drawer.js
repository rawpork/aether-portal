// The Elarion conversation drawer: a panel that slides in from the right over whatever page is open, instead of Elarion being a
// page of its own. The bottom composer opens it (typing or sending there carries over into the conversation), Esc or the close
// button shuts it, and the page underneath stays where it was, so asking about a project never loses the project.
//
// On a phone it covers the screen like a chat app and keeps Tab inside; on a wide screen it is a side panel the page can still be
// used beside. The conversation itself is the brain dock (brain-dock.js), mounted into #mc-elaron inside the drawer by the caller.
import { trapFocus } from '../a11y.js';

export function setupElarionDrawer(doc, { onOpen = () => {}, onClose = () => {}, onClosing = () => {}, focusTarget = () => null } = {}) {
  const win = doc.defaultView || globalThis;
  const drawer = doc.getElementById('mc-drawer');
  const scrim = doc.getElementById('mc-drawer-scrim');
  const closeButton = doc.getElementById('mc-drawer-close');
  if (!drawer) return null;
  const phone = win.matchMedia ? win.matchMedia('(max-width: 680px)') : { matches: false, addEventListener() {} };
  let open = false;
  let trap = null;
  let opener = null;

  // Closed, the drawer is off-screen: it must not be reachable by Tab or a screen reader.
  function sync() {
    drawer.toggleAttribute('inert', !open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.setAttribute('aria-modal', String(open && phone.matches));
    if (scrim) scrim.hidden = !(open && phone.matches);
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
    if (phone.matches) trap = trapFocus(drawer, { returnTo: opener });
    onOpen();
  }

  function hide(restore = true) {
    if (!open) return;
    open = false;
    if (trap) {
      trap.release({ restore: false });
      trap = null;
    }
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
  if (phone.addEventListener) phone.addEventListener('change', sync);
  sync();

  return { open: show, close: hide, toggle: (from) => (open ? hide() : show(from)), isOpen: () => open };
}
