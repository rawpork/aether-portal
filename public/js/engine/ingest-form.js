// The "+ Skill" ingest form (decision-center.js shows it in the Learn a skill popup): a template picks sensible defaults, the
// operator fills Title, Category / Tag, the content, and a target agent and priority, and the form compiles to what the engine's
// POST /api/skills/ingest takes: { source, name? }. The engine reads `source` as a link (fetched as it is) or as pasted text (up to
// 40,000 characters), and `name` as a hint for the skill's name.
//
// A link has to go to the engine alone (anything added to it would no longer be a link), so for a link only the title (as the
// name hint) travels with it; the template, tag, agent and priority shape pasted text, which carries them as a short header.

export const SOURCE_MAX_CHARS = 40000; // the engine's limit on `source`
export const CONTENT_MAX_CHARS = 30000; // leaves room for the header
export const TITLE_MAX_CHARS = 80;
export const CATEGORY_MAX_CHARS = 40;
export const NAME_MAX_CHARS = 64; // the engine's limit on `name`

export const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export const AGENTS = [
  { value: '', label: 'Any agent' },
  { value: 'master-brain', label: 'Elarion' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
];

// Built-in presets. `guide` is one line telling Elarion what kind of source this is, so the skill it drafts fits the use.
export const TEMPLATES = [
  {
    id: 'code',
    label: 'Code Snippet',
    category: 'code',
    priority: 'normal',
    agent: '',
    hint: 'A reusable pattern. Elarion keeps how to use it, its pitfalls and a short example.',
    titlePlaceholder: 'What it does, e.g. Retry a fetch with backoff',
    contentLabel: 'Code',
    contentPlaceholder: 'Paste the code here, with the language and any imports.',
    guide: 'A code snippet. Capture what it does, how to use it correctly, its inputs and outputs, and its pitfalls.',
  },
  {
    id: 'log',
    label: 'System Log / Stack Trace',
    category: 'incident',
    priority: 'high',
    agent: '',
    hint: 'A failure and how it was handled. Elarion writes a runbook: the symptom, the cause and the fix.',
    titlePlaceholder: 'What failed, e.g. D1 migration fails with error 7403',
    contentLabel: 'Log or stack trace',
    contentPlaceholder: 'Paste the error output with a few lines around it.',
    guide: 'An error log or stack trace. Capture the symptom, the likely cause, and the steps that fix or avoid it, as a runbook.',
  },
  {
    id: 'task',
    label: 'Task Directive',
    category: 'task',
    priority: 'normal',
    agent: 'master-brain',
    hint: 'A standing instruction. Elarion keeps the goal, the steps in order and what done looks like.',
    titlePlaceholder: 'e.g. Weekly dependency audit',
    contentLabel: 'Directive',
    contentPlaceholder: 'State what to do, the steps in order, and what done looks like.',
    guide: 'A standing instruction for agents. Capture the goal, the steps in order, the constraints, and the definition of done.',
  },
  {
    id: 'doc',
    label: 'Plain Text / Document',
    category: 'reference',
    priority: 'normal',
    agent: '',
    hint: 'Anything else: paste text, or a link to a page or a GitHub repo, and Elarion reads it.',
    titlePlaceholder: 'Optional name for the skill',
    contentLabel: 'Text or link',
    contentPlaceholder: 'Paste text, or a link to a documentation page or GitHub repo.',
    guide: '',
  },
  {
    id: 'spec',
    label: 'Architecture Spec',
    category: 'architecture',
    priority: 'normal',
    agent: '',
    hint: 'How a system fits together. Elarion keeps the components, the interfaces, the constraints and the decisions.',
    titlePlaceholder: 'e.g. Realtime hub design',
    contentLabel: 'Specification',
    contentPlaceholder: 'Describe the components, how they connect, the constraints, and the key decisions with their reasons.',
    guide: 'An architecture specification. Capture the components and their responsibilities, the interfaces between them, the constraints, and the decisions with their reasons.',
  },
];

export const DEFAULT_TEMPLATE = 'doc';
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE);

// The form's values for a template, before the operator types anything.
export function defaultsFor(id) {
  const t = templateById(id);
  return { template: t.id, title: '', category: t.category, content: '', agent: t.agent, priority: t.priority };
}

const clean = (value) => String(value == null ? '' : value).trim();
const oneLine = (value) => clean(value).replace(/\s+/g, ' ');

// Content that is a single link (nothing else) is fetched by the engine as it is.
export const isLinkContent = (content) => /^https?:\/\/\S+$/i.test(clean(content));

// "Retry a fetch with backoff!" -> "retry-a-fetch-with-backoff": the name hint the engine turns into the skill's name.
export function nameFromTitle(title) {
  return oneLine(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX_CHARS)
    .replace(/-+$/, '');
}

// A tag: one line, lower case, letters, digits and a few separators.
export const normalizeCategory = (value) => oneLine(value).toLowerCase().replace(/[^a-z0-9 _/.-]+/g, '').slice(0, CATEGORY_MAX_CHARS).trim();

const label = (list, value, fallback) => (list.find((x) => x.value === value) || { label: fallback }).label;

// The text the engine reads: a short header (what this is, how to file it) and then the content untouched.
export function composeSource(form) {
  const t = templateById(form.template);
  const lines = [];
  const title = oneLine(form.title).slice(0, TITLE_MAX_CHARS);
  const category = normalizeCategory(form.category);
  if (title) lines.push('Title: ' + title);
  lines.push('Type: ' + t.label);
  if (category) lines.push('Tag: ' + category);
  if (clean(form.agent)) lines.push('Target agent: ' + label(AGENTS, form.agent, form.agent));
  lines.push('Priority: ' + label(PRIORITIES, form.priority, 'Normal'));
  if (t.guide) lines.push('Intended use: ' + t.guide);
  return lines.join('\n') + '\n\n' + clean(form.content);
}

// { ok: true, payload: { source, name?, isLink } } or { ok: false, errors: { field: message } } (the first problem per field).
export function validateIngest(form) {
  const errors = {};
  const content = clean(form.content);
  if (!content) errors.content = 'Add the content to learn from: paste text, or a link.';
  else if (content.length > CONTENT_MAX_CHARS) errors.content = 'That is ' + content.length.toLocaleString('en-US') + ' characters; the limit is ' + CONTENT_MAX_CHARS.toLocaleString('en-US') + '. Paste the relevant part.';
  if (oneLine(form.title).length > TITLE_MAX_CHARS) errors.title = 'Keep the title to ' + TITLE_MAX_CHARS + ' characters.';
  if (oneLine(form.category).length > CATEGORY_MAX_CHARS) errors.category = 'Keep the tag to ' + CATEGORY_MAX_CHARS + ' characters.';
  if (!PRIORITIES.some((p) => p.value === form.priority)) errors.priority = 'Pick a priority.';
  if (!AGENTS.some((a) => a.value === (form.agent || ''))) errors.agent = 'Pick a target agent.';
  if (Object.keys(errors).length) return { ok: false, errors };

  const name = nameFromTitle(form.title) || undefined;
  if (isLinkContent(content)) return { ok: true, payload: { source: content, ...(name ? { name } : {}), isLink: true } };
  const source = composeSource(form);
  if (source.length > SOURCE_MAX_CHARS) return { ok: false, errors: { content: 'With its header this is over the ' + SOURCE_MAX_CHARS.toLocaleString('en-US') + ' character limit. Paste a shorter part.' } };
  return { ok: true, payload: { source, ...(name ? { name } : {}), isLink: false } };
}

// ---- the form's DOM ----

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

let counter = 0;

// Builds the form. Returns { element, read(), validate(), focus() }: read() is the current values, validate() shows the first
// problems on the fields and returns validateIngest's result.
export function mountIngestForm(doc, { template = DEFAULT_TEMPLATE } = {}) {
  const id = 'ingest-' + ++counter;
  const initial = defaultsFor(template);

  const select = el(doc, 'select', { id: id + '-template', 'data-field': 'template' }, TEMPLATES.map((t) => el(doc, 'option', { value: t.id, text: t.label })));
  const hint = el(doc, 'p', { class: 'dc-hint', id: id + '-hint' });
  const titleInput = el(doc, 'input', { id: id + '-title', 'data-field': 'title', type: 'text', maxlength: String(TITLE_MAX_CHARS), autocomplete: 'off' });
  const categoryInput = el(doc, 'input', { id: id + '-category', 'data-field': 'category', type: 'text', maxlength: String(CATEGORY_MAX_CHARS), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const contentLabel = el(doc, 'label', { for: id + '-content' });
  const contentArea = el(doc, 'textarea', { id: id + '-content', 'data-field': 'content', 'data-autofocus': '', rows: '8', maxlength: String(CONTENT_MAX_CHARS), spellcheck: 'false' });
  const linkNote = el(doc, 'p', { class: 'dc-hint', hidden: true, text: 'This is a link, so Elarion fetches it as it is. The title names the skill; the type, tag, agent and priority apply to pasted text.' });
  const agentSelect = el(doc, 'select', { id: id + '-agent', 'data-field': 'agent' }, AGENTS.map((a) => el(doc, 'option', { value: a.value, text: a.label })));
  const prioritySelect = el(doc, 'select', { id: id + '-priority', 'data-field': 'priority' }, PRIORITIES.map((p) => el(doc, 'option', { value: p.value, text: p.label })));
  const errorBox = el(doc, 'p', { class: 'dc-warn dc-ingest-error', role: 'alert', hidden: true });

  // A select is drawn without the browser's own arrow (appearance: none); its .dc-select box draws a themed chevron instead.
  const box = (control) => (control.tagName === 'SELECT' ? el(doc, 'div', { class: 'dc-select' }, [control]) : control);
  const field = (labelText, control, extra = []) => el(doc, 'div', { class: 'dc-field' }, [typeof labelText === 'string' ? el(doc, 'label', { for: control.id, text: labelText }) : labelText, box(control), ...extra]);
  const element = el(doc, 'div', { class: 'dc-ingest' }, [
    field('Template', select, [hint]),
    field('Title / Subject', titleInput),
    field('Category / Tag', categoryInput),
    field(contentLabel, contentArea, [linkNote]),
    el(doc, 'div', { class: 'dc-row' }, [field('Target agent', agentSelect), field('Priority', prioritySelect)]),
    errorBox,
  ]);

  // A field the operator has changed keeps their value when the template changes; the others follow the template.
  const touched = new Set();
  for (const control of [categoryInput, agentSelect, prioritySelect]) {
    for (const type of ['input', 'change']) control.addEventListener(type, () => touched.add(control.dataset.field));
  }

  function applyTemplate(templateId) {
    const t = templateById(templateId);
    select.value = t.id;
    hint.textContent = t.hint;
    titleInput.placeholder = t.titlePlaceholder;
    categoryInput.placeholder = t.category;
    contentLabel.textContent = t.contentLabel;
    contentArea.placeholder = t.contentPlaceholder;
    if (!touched.has('category')) categoryInput.value = t.category;
    if (!touched.has('agent')) agentSelect.value = t.agent;
    if (!touched.has('priority')) prioritySelect.value = t.priority;
    clearErrors();
  }

  function clearErrors() {
    errorBox.hidden = true;
    errorBox.textContent = '';
    for (const control of [titleInput, categoryInput, contentArea, agentSelect, prioritySelect]) control.removeAttribute('aria-invalid');
  }

  select.addEventListener('change', () => applyTemplate(select.value));
  contentArea.addEventListener('input', () => {
    linkNote.hidden = !isLinkContent(contentArea.value);
    if (!errorBox.hidden) clearErrors();
  });

  titleInput.value = initial.title;
  categoryInput.value = initial.category;
  agentSelect.value = initial.agent;
  prioritySelect.value = initial.priority;
  applyTemplate(initial.template);

  const controls = { title: titleInput, category: categoryInput, content: contentArea, agent: agentSelect, priority: prioritySelect };

  return {
    element,
    elements: { select, titleInput, categoryInput, contentArea, agentSelect, prioritySelect, errorBox, linkNote },
    read: () => ({ template: select.value, title: titleInput.value, category: categoryInput.value, content: contentArea.value, agent: agentSelect.value, priority: prioritySelect.value }),
    validate() {
      clearErrors();
      const result = validateIngest(this.read());
      if (!result.ok) {
        const first = ['content', 'title', 'category', 'agent', 'priority'].find((name) => result.errors[name]);
        for (const name of Object.keys(result.errors)) controls[name].setAttribute('aria-invalid', 'true');
        errorBox.textContent = result.errors[first];
        errorBox.hidden = false;
        controls[first].focus({ preventScroll: false });
      }
      return result;
    },
    focus: () => contentArea.focus({ preventScroll: true }),
  };
}
