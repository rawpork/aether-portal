// Quick-choice chips: when an agent's reply asks a question with numbered options, the options become buttons
// ([1. Option A] [2. Option B]) that send the choice back in one tap, instead of typing it. Used by the Elarion dock
// and the dual-agent console. (Engine choice steps have their own chips in the Operator Console.)

const OPTION_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:\[(\d{1,2})\]|\((\d{1,2})\)|(\d{1,2})[.)])(?:\*\*)?\s+(.+?)\s*$/;
const ASKS = /\?|\b(which|choose|pick|prefer|select|option|would you like|do you want|reply with)\b/i;
export const MAX_CHIP_OPTIONS = 9;
const LABEL_MAX = 80;

// Cleans an option for its chip: markdown emphasis and code ticks removed, a trailing "— explanation" kept short.
function cleanLabel(text) {
  const plain = String(text).replace(/\*\*|__|`/g, '').replace(/^\*|\*$/g, '').trim();
  return plain.length > LABEL_MAX ? plain.slice(0, LABEL_MAX - 1) + '…' : plain;
}

// The numbered options of the last run of option lines numbered 1, 2, 3… (at least 2), when the reply is asking:
// a question or choice word in the two lines before the list, or in the line after it. [] otherwise, so a plain
// numbered list of steps does not turn into buttons. Returns [{ n, label }].
export function parseNumberedOptions(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let best = null;
  let run = null;
  lines.forEach((line, index) => {
    const match = OPTION_LINE.exec(line);
    const n = match ? Number(match[1] || match[2] || match[3]) : 0;
    if (match && run && n === run.options.length + 1) {
      run.options.push({ n, label: cleanLabel(match[4]) });
      run.end = index;
    } else if (match && n === 1) {
      run = { start: index, end: index, options: [{ n, label: cleanLabel(match[4]) }] };
    } else if (line.trim() && !/^\s{2,}\S/.test(line)) {
      // Indented continuation lines belong to the option above; anything else ends the run.
      run = null;
    }
    if (run && run.options.length >= 2) best = run;
  });
  if (!best) return [];
  const before = lines.slice(Math.max(0, best.start - 2), best.start).join(' ');
  const after = lines.slice(best.end + 1).find((l) => l.trim()) || '';
  const options = best.options.slice(0, MAX_CHIP_OPTIONS);
  return ASKS.test(before) || ASKS.test(after) ? options.filter((o) => o.label) : [];
}

// The text a chip sends: "2. Option B".
export const choiceReply = (option) => option.n + '. ' + option.label;

// A row of chips for the options; onPick(option) when one is tapped. Every chip disables once one is chosen, and the
// chosen one stays marked. Number keys 1-9 pick while the row has focus.
export function renderChoiceChips(doc, options, onPick) {
  const row = doc.createElement('div');
  row.className = 'qc-chips';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Quick replies');
  const chips = options.map((option) => {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'qc-chip';
    chip.dataset.option = String(option.n);
    const num = doc.createElement('span');
    num.className = 'qc-chip-num';
    num.textContent = option.n + '.';
    chip.append(num, doc.createTextNode(' ' + option.label));
    chip.addEventListener('click', () => {
      if (row.dataset.chosen) return;
      row.dataset.chosen = String(option.n);
      chips.forEach((c) => { c.disabled = true; });
      chip.classList.add('chosen');
      onPick(option);
    });
    return chip;
  });
  row.append(...chips);
  row.addEventListener('keydown', (event) => {
    const chip = chips.find((c) => c.dataset.option === event.key);
    if (!chip || chip.disabled) return;
    event.preventDefault();
    chip.click();
  });
  return row;
}
