// Group picker (SPATIAL_ARCHITECTURE.md, section 1.6): a chip showing a node's group that opens a filterable list to
// move the node to another group, create a new one, or remove it from its group. One popover is shared by every chip.
// The page does the saving: onChoose gets { groupId }, { newName } or { remove: true } and the popover closes at once.

const NAME_MAX = 40;
let stylesAdded = false;
let open = null; // { chip, options, active, getCurrent, getGroups, onChoose }
let popover = null;
let input = null;
let list = null;

function addStyles() {
  if (stylesAdded) return;
  stylesAdded = true;
  const style = document.createElement('style');
  style.textContent = `
    .gp-chip { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 190px; height: 26px; padding: 0 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; background: var(--bg-raised, rgba(255,255,255,0.04)); color: var(--text, #dffdf7); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: transform 300ms cubic-bezier(0.25, 1, 0.5, 1), border-color 150ms ease; }
    .gp-chip::after { content: ''; position: absolute; inset: -9px -4px; }
    .gp-chip:hover, .gp-chip[aria-expanded="true"] { border-color: var(--accent-line, rgba(0,255,204,0.55)); }
    .gp-chip:active { transform: scale(0.98); transition-duration: 0s; }
    .gp-chip:focus-visible { outline: 1px solid var(--accent-line, rgba(0,255,204,0.55)); outline-offset: 2px; }
    .gp-chip.empty { color: var(--text-muted, #8a93a6); }
    .gp-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--gp-color, #8a93a6); }
    .gp-chip.empty .gp-dot { background: transparent; border: 1px dashed currentColor; box-sizing: border-box; }
    .gp-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gp-spark { flex: none; color: var(--text-muted, #8a93a6); font-size: 10px; }
    .gp-chevron { width: 10px; height: 10px; flex: none; opacity: 0.6; }
    .gp-pop { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 6px; width: min(260px, calc(100vw - 16px)); max-height: min(340px, calc(100vh - 16px)); padding: 6px; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; background: var(--bg-panel, #0b1320); color: var(--text, #dffdf7); font-family: inherit; }
    .gp-pop[hidden] { display: none; }
    .gp-input { height: 36px; flex: none; padding: 0 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; background: var(--bg-raised, rgba(255,255,255,0.04)); color: inherit; font: inherit; font-size: 16px; outline: none; }
    .gp-input:focus { border-color: var(--accent-line, rgba(0,255,204,0.55)); }
    .gp-input::placeholder { color: var(--text-muted, #8a93a6); }
    .gp-list { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .gp-section { margin: 6px 8px 2px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted, #8a93a6); }
    .gp-option { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 8px; border-left: 2px solid transparent; border-radius: 4px; font-size: 14px; cursor: pointer; }
    .gp-option .gp-name { flex: 1; }
    .gp-option .gp-count { color: var(--text-muted, #8a93a6); font-size: 12px; font-variant-numeric: tabular-nums; }
    .gp-option.active { background: var(--accent-soft, rgba(0,255,204,0.14)); }
    .gp-option.current { border-left-color: var(--accent, #00ffcc); color: var(--accent, #00ffcc); }
    .gp-option.create .gp-plus { color: var(--accent, #00ffcc); font-weight: 700; }
    .gp-option.remove { color: var(--text-muted, #8a93a6); }
    .gp-empty { padding: 10px 8px; color: var(--text-muted, #8a93a6); font-size: 13px; }
    @media (pointer: coarse) { .gp-option { min-height: 44px; } }
    @media (prefers-reduced-motion: reduce) { .gp-chip { transition: none; } .gp-chip:active { transform: none; } }
  `;
  document.head.append(style);
}

const normalizeName = value => String(value || '').replace(/\s+/g, ' ').trim();

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('class', 'gp-chevron');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 3.5l3 3 3-3');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}

function ensurePopover() {
  if (popover) return;
  popover = document.createElement('div');
  popover.className = 'gp-pop';
  popover.hidden = true;
  input = document.createElement('input');
  input.className = 'gp-input';
  input.type = 'text';
  input.placeholder = 'Find or create a group';
  input.maxLength = NAME_MAX;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-label', 'Group');
  list = document.createElement('div');
  list.className = 'gp-list';
  list.id = 'gp-list';
  list.setAttribute('role', 'listbox');
  input.setAttribute('aria-controls', list.id);
  popover.append(input, list);
  document.body.append(popover);

  input.addEventListener('input', () => {
    if (!open) return;
    open.active = 0;
    renderOptions();
  });
  input.addEventListener('keydown', event => {
    if (!open) return;
    const count = open.options.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) open.active = (open.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      renderOptions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open.options[open.active]) choose(open.options[open.active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  });
  // Keep card clicks, board drags and canvas taps from seeing presses inside the popover.
  ['pointerdown', 'click', 'touchstart'].forEach(type => popover.addEventListener(type, event => event.stopPropagation(), { passive: type === 'touchstart' }));
  document.addEventListener('pointerdown', event => {
    if (open && !popover.contains(event.target) && !open.chip.contains(event.target)) close(false);
  }, true);
  window.addEventListener('resize', () => close(false));
  window.addEventListener('scroll', event => { if (open && !popover.contains(event.target)) close(false); }, true);
}

// Options for the current query: matching user groups, matching AI groups, a create row when the typed name is new,
// and a remove row when the node has a group.
function buildOptions() {
  const query = normalizeName(input.value).toLowerCase();
  const current = open.getCurrent();
  const groups = open.getGroups().filter(group => !query || group.name.toLowerCase().includes(query));
  const options = [];
  const byName = (a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name);
  const mine = groups.filter(group => group.source !== 'ai').sort(byName);
  const suggested = groups.filter(group => group.source === 'ai').sort(byName);
  if (mine.length) options.push({ type: 'section', label: 'Your groups' }, ...mine.map(group => ({ type: 'group', group })));
  if (suggested.length) options.push({ type: 'section', label: 'Suggested' }, ...suggested.map(group => ({ type: 'group', group })));
  const typed = normalizeName(input.value);
  const exists = open.getGroups().some(group => group.name.toLowerCase() === typed.toLowerCase());
  if (typed && typed.length <= NAME_MAX && !exists) options.push({ type: 'create', name: typed });
  if (current && !query) options.push({ type: 'remove' });
  return options;
}

function renderOptions() {
  const all = buildOptions();
  open.options = all.filter(option => option.type !== 'section');
  if (open.active >= open.options.length) open.active = Math.max(0, open.options.length - 1);
  const current = open.getCurrent();
  let index = 0;
  const rows = all.map(option => {
    if (option.type === 'section') {
      const label = document.createElement('div');
      label.className = 'gp-section';
      label.textContent = option.label;
      return label;
    }
    const position = index++;
    const row = document.createElement('div');
    row.className = 'gp-option';
    row.id = 'gp-option-' + position;
    row.setAttribute('role', 'option');
    if (position === open.active) {
      row.classList.add('active');
      input.setAttribute('aria-activedescendant', row.id);
    }
    if (option.type === 'group') {
      const isCurrent = Boolean(current && current.id === option.group.id);
      row.classList.toggle('current', isCurrent);
      row.setAttribute('aria-selected', String(isCurrent));
      const dot = document.createElement('span');
      dot.className = 'gp-dot';
      dot.style.setProperty('--gp-color', option.group.color || '#8a93a6');
      const name = document.createElement('span');
      name.className = 'gp-name';
      name.textContent = option.group.name;
      row.append(dot, name);
      if (option.group.source === 'ai') {
        const spark = document.createElement('span');
        spark.className = 'gp-spark';
        spark.textContent = '✦';
        spark.title = 'Suggested by Elarion';
        row.append(spark);
      }
      const count = document.createElement('span');
      count.className = 'gp-count';
      count.textContent = String(option.group.count || 0);
      row.append(count);
    } else if (option.type === 'create') {
      row.classList.add('create');
      const plus = document.createElement('span');
      plus.className = 'gp-plus';
      plus.textContent = '+';
      const name = document.createElement('span');
      name.className = 'gp-name';
      name.textContent = 'Create “' + option.name + '”';
      row.append(plus, name);
    } else {
      row.classList.add('remove');
      row.textContent = 'Remove from group';
    }
    row.addEventListener('pointerenter', () => {
      if (open.active === position) return;
      open.active = position;
      renderOptions();
    });
    row.addEventListener('click', () => choose(option));
    return row;
  });
  if (!open.options.length) {
    const empty = document.createElement('div');
    empty.className = 'gp-empty';
    empty.textContent = 'Type a name to create a group.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
  const activeRow = list.querySelector('.gp-option.active');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

function position(chip) {
  const rect = chip.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const below = window.innerHeight - rect.bottom;
  const top = below >= height + 12 || below >= rect.top ? rect.bottom + 6 : rect.top - height - 6;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  popover.style.top = Math.max(8, top) + 'px';
  popover.style.left = left + 'px';
}

function choose(option) {
  const { onChoose } = open;
  close(true);
  if (option.type === 'group') onChoose({ groupId: option.group.id });
  else if (option.type === 'create') onChoose({ newName: option.name });
  else onChoose({ remove: true });
}

function close(restoreFocus) {
  if (!open) return;
  const { chip } = open;
  open = null;
  popover.hidden = true;
  input.removeAttribute('aria-activedescendant');
  chip.setAttribute('aria-expanded', 'false');
  if (restoreFocus) chip.focus();
}

function openFor(state) {
  ensurePopover();
  if (open && open.chip === state.chip) {
    close(true);
    return;
  }
  close(false);
  open = { ...state, options: [], active: 0 };
  state.chip.setAttribute('aria-expanded', 'true');
  input.value = '';
  popover.hidden = false;
  renderOptions();
  position(state.chip);
  // Focus without scrolling the page under the popover; phones then raise the keyboard.
  input.focus({ preventScroll: true });
}

// getGroups() -> [{ id, name, source, count, color }]; getCurrent() -> that shape or null for the node's group.
// Returns the chip element plus refresh(), which redraws it after the node's group changes.
export function createGroupPicker({ getGroups, getCurrent, onChoose }) {
  addStyles();
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'gp-chip';
  chip.setAttribute('aria-haspopup', 'listbox');
  chip.setAttribute('aria-expanded', 'false');
  const refresh = () => {
    const current = getCurrent();
    chip.classList.toggle('empty', !current);
    const dot = document.createElement('span');
    dot.className = 'gp-dot';
    if (current) dot.style.setProperty('--gp-color', current.color || '#8a93a6');
    const name = document.createElement('span');
    name.className = 'gp-name';
    name.textContent = current ? current.name : 'Add to group';
    const parts = [dot, name];
    if (current && current.source === 'ai') {
      const spark = document.createElement('span');
      spark.className = 'gp-spark';
      spark.textContent = '✦';
      parts.push(spark);
    }
    parts.push(chevron());
    chip.replaceChildren(...parts);
    chip.title = current ? 'Group: ' + current.name + (current.source === 'ai' ? ' (suggested by Elarion)' : '') : 'Add to a group';
    chip.setAttribute('aria-label', chip.title);
  };
  refresh();
  // Presses on the chip must not select the card underneath or start a board drag.
  ['pointerdown', 'touchstart'].forEach(type => chip.addEventListener(type, event => event.stopPropagation(), { passive: type === 'touchstart' }));
  chip.addEventListener('click', event => {
    event.stopPropagation();
    openFor({ chip, getGroups, getCurrent, onChoose });
  });
  return { element: chip, refresh };
}

export function closeGroupPicker() {
  close(false);
}
