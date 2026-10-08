// Keyboard shortcuts and arrival announcement shared by the two Aether surfaces (see shell-surfaces.js):
//   Alt+S  go to Space (the 3D graph, "/")
//   Alt+M  go to Mission Control ("/mission-control")
// A pressed shortcut for the surface you are already on does nothing. Shortcuts stay quiet while typing, so Option+S on a
// Mac never swallows a character. A modifier is held, so WCAG 2.1.4 (character key shortcuts) does not apply.
//
// The two surfaces are separate pages, so a screen reader would hear a plain page load. When the operator moved by a shortcut
// or by the header's switch, the next page says "Now in <surface>" once, in a polite live region, so the move is confirmed
// the same way in both directions.
import { SURFACES } from './shell-surfaces.js';

const ARRIVED_KEY = 'aether.shell.arrived';

const surfaceHere = () => document.body?.dataset.shellSurface;

function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function remember(surface) {
  try {
    sessionStorage.setItem(ARRIVED_KEY, surface);
  } catch {
    // Storage blocked: the move still works, it just is not announced.
  }
}

// A visually hidden status region, created on first use.
function liveRegion() {
  let region = document.getElementById('shell-live');
  if (!region) {
    region = document.createElement('div');
    region.id = 'shell-live';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
    document.body.append(region);
  }
  return region;
}

export function announceArrival() {
  let from = null;
  try {
    from = sessionStorage.getItem(ARRIVED_KEY);
    if (from) sessionStorage.removeItem(ARRIVED_KEY);
  } catch {
    return;
  }
  const here = SURFACES.find((s) => s.id === surfaceHere());
  // Only announce a move that really ended on the surface the operator asked for.
  if (!from || !here || here.id !== from) return;
  const region = liveRegion();
  region.textContent = '';
  setTimeout(() => {
    region.textContent = 'Now in ' + here.label;
  }, 60);
}

document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
  const dest = SURFACES.find((s) => s.code === event.code);
  if (!dest || dest.id === surfaceHere()) return;
  if (isTypingTarget(event.target)) return;
  event.preventDefault();
  remember(dest.id);
  window.location.assign(dest.href);
});

// A click on a surface link counts the same as the shortcut: the header's switch on Space, the rail's brand on Mission Control.
document.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('a[data-surface]') : null;
  if (link && link.getAttribute('aria-current') !== 'page') remember(link.dataset.surface);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announceArrival, { once: true });
else announceArrival();
