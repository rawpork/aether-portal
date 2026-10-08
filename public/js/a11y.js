// Shared keyboard and screen-reader helpers for both Aether surfaces.
//
//   announce(text)              say something in a polite live region (spatial mode shifts, scope and zoom changes)
//   trapFocus(container, opts)  keep Tab and Shift+Tab inside a modal panel, and give focus back when it closes
//
// Space's inline script cannot import modules, so this file also publishes window.AetherA11y (it is imported by the spatial
// entry module, which runs before any of these are needed by a user action).

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="slider"], [role="switch"]';

// Focusable and actually reachable: not disabled, not tabindex -1, not inside a hidden or inert ancestor.
function reachable(el) {
  if (el.disabled || el.getAttribute('tabindex') === '-1') return false;
  if (el.type === 'hidden') return false;
  return !el.closest('[hidden], [inert], [aria-hidden="true"]');
}

export function focusableWithin(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(reachable);
}

// Traps Tab inside `container` while it is open. Returns { release({ restore }) }: restore (default true) puts focus back on
// the element that had it when the trap began (or `returnTo`), which is what a dialog opened from a button should do.
export function trapFocus(container, { returnTo = null } = {}) {
  const doc = container.ownerDocument;
  const opener = returnTo || doc.activeElement;
  let active = true;

  function onKeydown(event) {
    if (!active || event.key !== 'Tab') return;
    const items = focusableWithin(container);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = doc.activeElement;
    if (!container.contains(current)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }
  doc.addEventListener('keydown', onKeydown, true);

  return {
    release({ restore = true } = {}) {
      if (!active) return;
      active = false;
      doc.removeEventListener('keydown', onKeydown, true);
      if (restore && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    },
  };
}

// One polite live region for the whole page. Rapid changes (a wheel ring turning through several stops) say only the last one.
let region = null;
let pending = null;
export function announce(text, { delay = 200 } = {}) {
  if (typeof document === 'undefined' || !text) return;
  if (!region || !region.isConnected) {
    region = document.createElement('div');
    region.id = 'aether-live';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
    document.body.append(region);
  }
  clearTimeout(pending);
  region.textContent = '';
  pending = setTimeout(() => {
    region.textContent = text;
  }, delay);
}

if (typeof window !== 'undefined') window.AetherA11y = { announce, trapFocus, focusableWithin };
