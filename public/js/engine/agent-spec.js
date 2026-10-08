// Agent spec generator (the rail's "Agent spec" entry; decision-center.js shows it in a popup). It writes a SPEC for an agent: its
// role, what it may do, and its guardrails, as JSON and as a readable brief. It does not start anything. In Aether an agent runs
// when a project (a blueprint) that uses it is deployed, or as a Studio workflow agent; a spec is what you define first and then
// paste into a project brief or a workflow's agent, or give to Claude Code to build.
//
// The access levels are the engine's own role contracts (Aether_Engine/src/a2a.ts ROLE_CONTRACTS), so what the spec says an agent
// may do is what the engine actually enforces for guest agents. Keep the two in step.

export const SPEC_SCHEMA = 'aether.agent-spec/1';
export const NAME_MAX_CHARS = 60;
export const ROLE_MAX_CHARS = 120;
export const INSTRUCTIONS_MAX_CHARS = 2000; // the engine clips a workflow agent's instructions here

export const ACTIONS = {
  prompt: 'prompt: a model turn (spends model usage)',
  echo: 'echo: returns its input unchanged (no model call)',
  wait: 'wait: pauses between steps',
  choice: 'choice: asks the operator to pick an option',
  build: 'build: builds and tests in the sandbox',
};

// Mirror of the engine's role contracts.
export const TIERS = [
  { value: 'observer', label: 'Observer', description: 'Read-only: can be listed and discovered, runs no steps and proposes no lessons.', allowedActions: [], maxSteps: 0, mayProposeLessons: false },
  { value: 'reviewer', label: 'Reviewer', description: 'Runs echo and wait steps and can propose lessons (always through the approval gate).', allowedActions: ['echo', 'wait'], maxSteps: 10, mayProposeLessons: true },
  { value: 'collaborator', label: 'Collaborator', description: 'Runs prompt, echo and wait steps (model spend counts against the engine) and can propose lessons.', allowedActions: ['prompt', 'echo', 'wait'], maxSteps: 25, mayProposeLessons: true },
];
export const tierByValue = (value) => TIERS.find((t) => t.value === value) || TIERS[2];

// What a model call is for; the engine's MODEL_ROUTES picks the provider per purpose.
export const PURPOSES = [
  { value: 'step', label: 'Routine steps', description: 'Everyday prompt steps: the cheapest sensible route.' },
  { value: 'agent', label: 'Workflow agent', description: 'A Studio workflow agent taking its turn.' },
  { value: 'plan', label: 'Planning', description: 'Designing or changing a workflow.' },
  { value: 'chat', label: 'Conversation', description: 'Talking with the operator, like Elarion in Mission Control.' },
];

// Starting points. The first five are the roles Studio already builds workflows from; Custom starts empty.
export const TEMPLATES = [
  {
    id: 'researcher',
    label: 'Researcher',
    role: 'Gathers sources and facts',
    instructions: 'Find and read the sources the goal needs. Report what each one says, with its link, and mark anything you could not confirm. Do not draw conclusions the sources do not support.',
    tier: 'collaborator',
    purpose: 'step',
    namePlaceholder: 'e.g. Market Researcher',
  },
  {
    id: 'planner',
    label: 'Planner',
    role: 'Breaks the goal into steps',
    instructions: 'Turn the goal and the brief into a numbered plan: each step small enough to check, in the order it must happen, with what done looks like. List what is still unknown before the plan can be trusted.',
    tier: 'collaborator',
    purpose: 'plan',
    namePlaceholder: 'e.g. Launch Planner',
  },
  {
    id: 'builder',
    label: 'Builder',
    role: 'Produces the main deliverable',
    instructions: 'Produce the deliverable the plan calls for, complete and ready to review: no TODOs or placeholders. Follow the conventions of the project you are working in, and say what you assumed.',
    tier: 'collaborator',
    purpose: 'agent',
    namePlaceholder: 'e.g. Landing Page Builder',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    role: 'Checks the work before it ships',
    instructions: 'Review the deliverable against the goal and the plan. List what is wrong or missing, most serious first, each with the fix. Say plainly when it is ready.',
    tier: 'collaborator',
    purpose: 'step',
    namePlaceholder: 'e.g. QA Reviewer',
  },
  {
    id: 'publisher',
    label: 'Publisher',
    role: 'Prepares the hand-off for release',
    instructions: 'Prepare exactly what is needed to release: the final files, the settings and secrets still to supply, and the steps to publish. Prepare only; the operator approves before anything goes out.',
    tier: 'collaborator',
    purpose: 'step',
    namePlaceholder: 'e.g. Release Publisher',
  },
  {
    id: 'custom',
    label: 'Custom agent',
    role: '',
    instructions: '',
    tier: 'collaborator',
    purpose: 'step',
    namePlaceholder: 'Give the agent a name',
  },
];
export const DEFAULT_TEMPLATE = 'custom';
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE);

export function defaultsFor(id) {
  const t = templateById(id);
  const tier = tierByValue(t.tier);
  return { template: t.id, name: '', role: t.role, instructions: t.instructions, tier: tier.value, maxSteps: tier.maxSteps, purpose: t.purpose, askBeforeOutward: true };
}

const clean = (value) => String(value == null ? '' : value).trim();
const oneLine = (value) => clean(value).replace(/\s+/g, ' ');

export function slugify(value) {
  return oneLine(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

// { ok: true, form } with the fields tidied, or { ok: false, errors: { field: message } }.
export function validateAgentSpec(form) {
  const errors = {};
  const tier = TIERS.find((t) => t.value === form.tier);
  const name = oneLine(form.name);
  const role = oneLine(form.role);
  const instructions = clean(form.instructions);
  if (!name) errors.name = 'Give the agent a name.';
  else if (name.length > NAME_MAX_CHARS) errors.name = 'Keep the name to ' + NAME_MAX_CHARS + ' characters.';
  else if (!slugify(name)) errors.name = 'Use letters or numbers in the name.';
  if (!role) errors.role = 'Say in one line what the agent is for.';
  else if (role.length > ROLE_MAX_CHARS) errors.role = 'Keep the role to ' + ROLE_MAX_CHARS + ' characters.';
  if (!tier) errors.tier = 'Pick an access level.';
  // An observer runs no steps; anyone else needs at least one, and no more than their level allows.
  const maxSteps = Number(form.maxSteps);
  if (tier && !errors.tier) {
    if (!Number.isInteger(maxSteps) || maxSteps < 0) errors.maxSteps = 'Use a whole number of steps.';
    else if (tier.maxSteps === 0 ? maxSteps !== 0 : maxSteps < 1) errors.maxSteps = tier.maxSteps === 0 ? 'An observer runs no steps.' : 'Allow at least 1 step.';
    else if (maxSteps > tier.maxSteps) errors.maxSteps = tier.label + ' agents are limited to ' + tier.maxSteps + ' steps.';
  }
  if (!PURPOSES.some((p) => p.value === form.purpose)) errors.purpose = 'Pick what its model calls are for.';
  // An observer never calls a model, so it needs no instructions; everyone else does.
  if (tier && tier.allowedActions.length === 0) {
    if (instructions.length > INSTRUCTIONS_MAX_CHARS) errors.instructions = 'Keep the instructions to ' + INSTRUCTIONS_MAX_CHARS + ' characters.';
  } else if (!instructions) errors.instructions = 'Say how the agent should work.';
  else if (instructions.length > INSTRUCTIONS_MAX_CHARS) errors.instructions = 'Keep the instructions to ' + INSTRUCTIONS_MAX_CHARS + ' characters.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, form: { ...form, name, role, instructions, maxSteps } };
}

// The spec document. `now` is injectable for tests.
export function buildAgentSpec(form, now = new Date()) {
  const tier = tierByValue(form.tier);
  return {
    schema: SPEC_SCHEMA,
    name: oneLine(form.name),
    id: slugify(form.name),
    role: oneLine(form.role),
    instructions: clean(form.instructions),
    permissions: {
      access_level: tier.value,
      allowed_actions: [...tier.allowedActions],
      max_steps: Number(form.maxSteps),
      may_propose_lessons: tier.mayProposeLessons,
      ask_before_outward_steps: Boolean(form.askBeforeOutward),
    },
    model_purpose: form.purpose,
    status: 'spec only: not running',
    created_at: new Date(now).toISOString(),
  };
}

export const specToJson = (spec) => JSON.stringify(spec, null, 2) + '\n';
export const specFileName = (spec) => 'agent-spec-' + (spec.id || 'agent') + '.json';

// The same spec as a short brief a person (or Claude Code) can read.
export function specToMarkdown(spec) {
  const p = spec.permissions;
  const tier = tierByValue(p.access_level);
  const purpose = PURPOSES.find((x) => x.value === spec.model_purpose);
  const lines = [
    '# Agent spec: ' + spec.name,
    '',
    '**Role:** ' + spec.role,
    '',
    '## How it works',
    spec.instructions || '(No instructions: this agent runs no steps.)',
    '',
    '## What it may do',
    '- Access level: ' + tier.label + ' (' + tier.description + ')',
    '- Allowed steps: ' + (p.allowed_actions.length ? p.allowed_actions.map((a) => ACTIONS[a] || a).join('; ') : 'none'),
    '- Most steps in one run: ' + p.max_steps,
    '- May propose lessons: ' + (p.may_propose_lessons ? 'yes, through the approval gate' : 'no'),
    '- Outward-facing or irreversible steps (publishing, sending, spending): ' + (p.ask_before_outward_steps ? 'asks the operator first' : 'does not ask first'),
    '- Model calls are for: ' + (purpose ? purpose.label + ' (' + spec.model_purpose + ')' : spec.model_purpose),
    '',
    '## Status',
    'A spec only: nothing is running. An agent runs when a project that uses it is deployed, or as an agent in a Studio workflow.',
    '',
    '_Spec ' + SPEC_SCHEMA + ', created ' + spec.created_at + '._',
    '',
  ];
  return lines.join('\n');
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

// Builds the form. Returns { element, elements, read(), validate(), setValues(form) }. validate() shows the first problem on its field.
export function mountAgentSpecForm(doc, { template = DEFAULT_TEMPLATE, values = null } = {}) {
  const id = 'agentspec-' + ++counter;
  const select = (name, options) => el(doc, 'select', { id: id + '-' + name, 'data-field': name }, options.map((o) => el(doc, 'option', { value: o.value, text: o.label })));
  const templateSelect = select('template', TEMPLATES.map((t) => ({ value: t.id, label: t.label })));
  const nameInput = el(doc, 'input', { id: id + '-name', 'data-field': 'name', 'data-autofocus': '', type: 'text', maxlength: String(NAME_MAX_CHARS), autocomplete: 'off' });
  const roleInput = el(doc, 'input', { id: id + '-role', 'data-field': 'role', type: 'text', maxlength: String(ROLE_MAX_CHARS), autocomplete: 'off', placeholder: 'One line: what the agent is for' });
  const instructions = el(doc, 'textarea', { id: id + '-instructions', 'data-field': 'instructions', rows: '6', maxlength: String(INSTRUCTIONS_MAX_CHARS), placeholder: 'How the agent should work, in plain language: what it looks at, what it produces, and what it must never do.' });
  const tierSelect = select('tier', TIERS.map((t) => ({ value: t.value, label: t.label })));
  const tierHint = el(doc, 'p', { class: 'dc-hint' });
  const maxSteps = el(doc, 'input', { id: id + '-maxSteps', 'data-field': 'maxSteps', type: 'number', inputmode: 'numeric', min: '0', step: '1' });
  const purposeSelect = select('purpose', PURPOSES.map((p) => ({ value: p.value, label: p.label })));
  const purposeHint = el(doc, 'p', { class: 'dc-hint' });
  const templateHint = el(doc, 'p', { class: 'dc-hint', text: 'Pick a starting point; everything can be changed.' });
  const askBox = el(doc, 'input', { id: id + '-ask', 'data-field': 'askBeforeOutward', type: 'checkbox' });
  const errorBox = el(doc, 'p', { class: 'dc-warn dc-ingest-error', role: 'alert', hidden: true });

  const wrapSelect = (control) => el(doc, 'div', { class: 'dc-select' }, [control]);
  const field = (labelText, control, extra = []) => el(doc, 'div', { class: 'dc-field' }, [el(doc, 'label', { for: control.id, text: labelText }), control.tagName === 'SELECT' ? wrapSelect(control) : control, ...extra]);
  const element = el(doc, 'div', { class: 'dc-ingest dc-agentspec' }, [
    field('Start from', templateSelect, [templateHint]),
    field('Agent name', nameInput),
    field('Role', roleInput),
    field('Instructions', instructions),
    field('Access level', tierSelect, [tierHint]),
    el(doc, 'div', { class: 'dc-row' }, [field('Most steps per run', maxSteps), field('Model calls are for', purposeSelect)]),
    purposeHint,
    el(doc, 'label', { class: 'dc-check', for: askBox.id }, [askBox, el(doc, 'span', { text: 'Ask me before any outward-facing or irreversible step (publishing, sending, spending)' })]),
    errorBox,
  ]);

  const controls = { name: nameInput, role: roleInput, instructions, tier: tierSelect, maxSteps, purpose: purposeSelect };
  const touched = new Set();

  function clearErrors() {
    errorBox.hidden = true;
    errorBox.textContent = '';
    for (const control of Object.values(controls)) control.removeAttribute('aria-invalid');
  }

  function applyTier() {
    const tier = tierByValue(tierSelect.value);
    tierHint.textContent = tier.description + ' Allowed steps: ' + (tier.allowedActions.length ? tier.allowedActions.join(', ') : 'none') + '. Up to ' + tier.maxSteps + ' steps.';
    maxSteps.max = String(tier.maxSteps);
    const none = tier.maxSteps === 0;
    maxSteps.disabled = none;
    // Follow the level's limit unless the person set their own and it still fits.
    const current = Number(maxSteps.value);
    if (none) maxSteps.value = '0';
    else if (!touched.has('maxSteps') || !(current >= 1 && current <= tier.maxSteps)) maxSteps.value = String(tier.maxSteps);
  }

  function applyPurpose() {
    const p = PURPOSES.find((x) => x.value === purposeSelect.value);
    purposeHint.textContent = p ? p.description : '';
  }

  function applyTemplate(templateId, { keepTouched = true } = {}) {
    const defaults = defaultsFor(templateId);
    templateSelect.value = defaults.template;
    const t = templateById(templateId);
    nameInput.placeholder = t.namePlaceholder;
    templateHint.textContent = t.id === 'custom' ? 'Start empty and describe the agent yourself.' : 'Starts you off with a ' + t.label.toLowerCase() + ': ' + t.role.toLowerCase() + '. Everything can be changed.';
    for (const key of ['role', 'instructions']) if (!keepTouched || !touched.has(key)) controls[key].value = defaults[key];
    if (!keepTouched || !touched.has('tier')) tierSelect.value = defaults.tier;
    if (!keepTouched || !touched.has('purpose')) purposeSelect.value = defaults.purpose;
    applyTier();
    applyPurpose();
    clearErrors();
  }

  for (const [key, control] of Object.entries({ role: roleInput, instructions, tier: tierSelect, purpose: purposeSelect, maxSteps })) {
    for (const type of ['input', 'change']) control.addEventListener(type, () => touched.add(key));
  }
  templateSelect.addEventListener('change', () => applyTemplate(templateSelect.value));
  tierSelect.addEventListener('change', () => {
    touched.delete('maxSteps');
    applyTier();
    clearErrors();
  });
  purposeSelect.addEventListener('change', applyPurpose);
  for (const control of [nameInput, roleInput, instructions, maxSteps]) control.addEventListener('input', () => (errorBox.hidden ? null : clearErrors()));

  const initial = defaultsFor(template);
  applyTemplate(initial.template, { keepTouched: false });
  askBox.checked = initial.askBeforeOutward;

  const api = {
    element,
    elements: { templateSelect, nameInput, roleInput, instructions, tierSelect, tierHint, maxSteps, purposeSelect, purposeHint, askBox, errorBox },
    read: () => ({ template: templateSelect.value, name: nameInput.value, role: roleInput.value, instructions: instructions.value, tier: tierSelect.value, maxSteps: maxSteps.value, purpose: purposeSelect.value, askBeforeOutward: askBox.checked }),
    // Puts earlier answers back (after going back from the preview).
    setValues(v) {
      templateSelect.value = v.template;
      nameInput.value = v.name;
      roleInput.value = v.role;
      instructions.value = v.instructions;
      tierSelect.value = v.tier;
      purposeSelect.value = v.purpose;
      askBox.checked = Boolean(v.askBeforeOutward);
      for (const key of ['role', 'instructions', 'tier', 'purpose']) touched.add(key);
      touched.add('maxSteps');
      applyTier();
      maxSteps.value = String(v.maxSteps);
      applyPurpose();
    },
    validate() {
      clearErrors();
      const result = validateAgentSpec(api.read());
      if (!result.ok) {
        const first = ['name', 'role', 'instructions', 'tier', 'maxSteps', 'purpose'].find((key) => result.errors[key]);
        for (const key of Object.keys(result.errors)) controls[key].setAttribute('aria-invalid', 'true');
        errorBox.textContent = result.errors[first];
        errorBox.hidden = false;
        controls[first].focus({ preventScroll: false });
      }
      return result;
    },
  };
  if (values) api.setValues(values);
  return api;
}
