// Keyboard shortcuts shared by the two Aether surfaces (WCAG 3.2.3 keeps the cross-link in the same header slot on both):
//   Alt+S  go to Space (the 3D graph, "/")
//   Alt+M  go to Mission Control ("/mission-control")
// A pressed shortcut for the surface you are already on does nothing. Shortcuts stay quiet while typing, so Option+S on a
// Mac never swallows a character. A modifier is held, so WCAG 2.1.4 (character key shortcuts) does not apply.
const SURFACES = {
	KeyS: { surface: 'space', href: '/' },
	KeyM: { surface: 'mission-control', href: '/mission-control' }
};

function isTypingTarget(el) {
	if (!el || el.nodeType !== 1) return false;
	return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

document.addEventListener('keydown', (event) => {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
	const dest = SURFACES[event.code];
	if (!dest || dest.surface === document.body?.dataset.shellSurface) return;
	if (isTypingTarget(event.target)) return;
	event.preventDefault();
	window.location.assign(dest.href);
});
