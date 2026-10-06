// Create / Templates (Mission Control -> Create): ready-made project templates, with a "Popular & Recommended" shelf
// (the starters used most in this browser, recommended ones until then) above collapsible category sections for the
// rest; skill-based blueprints are marked. Picking one opens a short project
// brief (target domain, sign-in, database, anything else Elarion must know) before anything runs; the answers are
// compiled into a blueprint on the engine (POST /api/blueprint/compile) and the blueprint opens under Projects, one
// Deploy & Execute away from its run.
// The brief travels in fields the engine's compile contract already has: the database goes to
// interviewResponses.database, and the whole brief becomes a source ("aether:brief") whose summary Elarion reads with
// the other sources when it plans the run.
import { getEngineApi } from '../engine-api.bundle.js';
import { validateCompileRequest } from './blueprint-spec.js';
import { describeEngineError } from './operator-console.js';

export const BRIEF_SOURCE_URL = 'aether:brief';

export const AUTH_TYPES = [
  { id: 'none', label: 'No sign-in', hint: 'Public pages only' },
  { id: 'magic_link', label: 'Email magic link', hint: 'Passwordless sign-in by email' },
  { id: 'oauth', label: 'Google / GitHub sign-in', hint: 'OAuth with existing accounts' },
  { id: 'api_keys', label: 'API keys', hint: 'For developer tools and APIs' },
];

export const DATABASES = [
  { id: 'cloudflare_d1', label: 'Cloudflare D1', hint: 'SQLite at the edge, free tier' },
  { id: 'supabase_postgres', label: 'Supabase Postgres', hint: 'Postgres with auth and storage' },
  { id: 'cloudflare_kv', label: 'Cloudflare KV', hint: 'Key-value only, for settings and caches' },
  { id: 'none', label: 'No database', hint: 'Static content' },
];

// Template groups, in display order. A category's defaults pre-fill the brief for its templates; a template's own
// defaults win where it sets them.
export const CATEGORIES = [
  { id: 'commerce', name: 'E-Commerce & Fleet Management', defaults: { auth: 'magic_link', database: 'supabase_postgres', hosting: 'cloudflare_pages' }, notesHint: 'What you sell or rent, prices and deposits, payment provider, pickup or shipping…' },
  { id: 'ai', name: 'AI Skills & Workflow Automation', defaults: { auth: 'api_keys', database: 'cloudflare_d1', hosting: 'cloudflare_workers' }, notesHint: 'Which models and tools, the tasks to automate, a monthly spend cap…' },
  { id: 'hardware', name: '3D & Hardware Pipelines', defaults: { auth: 'magic_link', database: 'cloudflare_d1', hosting: 'cloudflare_workers' }, notesHint: 'Printers and materials, file types, max part size, turnaround times…' },
  { id: 'saas', name: 'SaaS & Web Applications', defaults: { auth: 'magic_link', database: 'cloudflare_d1', hosting: 'cloudflare_workers' }, notesHint: 'Pricing, brand, must-have pages, anything to avoid…' },
];

// The starters on the Popular & Recommended shelf until this browser has used others more.
export const POPULAR_IDS = ['saas-auditor', 'landing-waitlist', 'ai-assistant'];
export const POPULAR_COUNT = 3;
export const USAGE_KEY = 'aether.templates.used';

const CF = 'https://developers.cloudflare.com/';
export const TEMPLATES = [
  {
    id: 'saas-auditor',
    category: 'saas',
    name: 'SaaS cost auditor',
    summary: 'Paste your tool stack, get the overlap, savings and an ROI number, with paid plans through Stripe.',
    website: true,
    defaults: { auth: 'api_keys' },
    links: [
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
      { url: 'https://docs.stripe.com/billing/subscriptions/overview', title: 'Stripe subscriptions' },
    ],
  },
  {
    id: 'landing-waitlist',
    category: 'saas',
    name: 'Landing page + waitlist',
    summary: 'A fast product landing page with a waitlist form that stores sign-ups and blocks spam.',
    website: true,
    defaults: { auth: 'none', hosting: 'cloudflare_pages' },
    links: [
      { url: CF + 'pages/', title: 'Cloudflare Pages' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
    ],
  },
  {
    id: 'ai-assistant',
    category: 'ai',
    name: 'AI chat assistant',
    summary: 'A chat assistant on the Claude API with streaming replies, saved conversations and a spend cap.',
    website: true,
    defaults: { auth: 'magic_link' },
    links: [
      { url: 'https://docs.claude.com/en/api/messages', title: 'Claude Messages API' },
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
    ],
  },
  {
    id: 'team-dashboard',
    category: 'saas',
    name: 'Team dashboard',
    summary: 'An internal dashboard with team sign-in, tables and charts over your own data.',
    website: true,
    defaults: { auth: 'oauth', database: 'supabase_postgres', hosting: 'cloudflare_pages' },
    links: [
      { url: 'https://supabase.com/docs/guides/auth', title: 'Supabase Auth' },
      { url: 'https://supabase.com/docs/guides/database/overview', title: 'Supabase Database' },
    ],
  },
  {
    id: 'api-webhooks',
    category: 'ai',
    name: 'API + webhook worker',
    summary: 'A small JSON API that receives webhooks, checks their signatures and keeps state at the edge.',
    website: false,
    defaults: { database: 'cloudflare_kv' },
    links: [
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
      { url: CF + 'kv/', title: 'Cloudflare KV' },
    ],
  },
  {
    id: 'equipment-rental',
    category: 'commerce',
    skill: true,
    name: 'Equipment & Asset Rental Portal',
    summary: 'Rent out equipment by the day: an availability calendar per asset, deposits and checkout, check-out and return tracking, and a fleet view of what is out, due back or in maintenance.',
    website: true,
    defaults: {},
    links: [
      { url: 'https://docs.stripe.com/payments/checkout', title: 'Stripe Checkout' },
      { url: 'https://supabase.com/docs/guides/database/overview', title: 'Supabase Database' },
      { url: CF + 'pages/', title: 'Cloudflare Pages' },
    ],
  },
  {
    id: 'resale-listing',
    category: 'commerce',
    skill: true,
    name: 'Resale & Listing Automation Suite',
    summary: 'Turn item photos and notes into marketplace-ready listings: AI-drafted titles and descriptions, price suggestions, an inventory of what is listed and sold, and scheduled relisting.',
    website: true,
    defaults: { auth: 'oauth' },
    links: [
      { url: 'https://developer.ebay.com/api-docs/sell/inventory/overview.html', title: 'eBay Sell Inventory API' },
      { url: 'https://docs.claude.com/en/api/messages', title: 'Claude Messages API' },
      { url: CF + 'workers/configuration/cron-triggers/', title: 'Workers Cron Triggers' },
    ],
  },
  {
    id: 'skill-sandbox',
    category: 'ai',
    skill: true,
    name: 'AI Skill & Task Sandbox',
    summary: 'Write a skill (instructions plus tools), run it against test tasks, compare the runs side by side and keep the versions that pass, with a spend cap on every run.',
    website: true,
    defaults: {},
    links: [
      { url: 'https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview', title: 'Claude tool use' },
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
    ],
  },
  {
    id: 'print-cad-studio',
    category: 'hardware',
    skill: true,
    name: '3D Print & CAD Production Studio',
    summary: 'Take STL and 3MF uploads, preview them in 3D in the browser, quote by material, size and print time, and move each job through a queue from slicing to printed and shipped.',
    website: true,
    defaults: {},
    links: [
      { url: 'https://threejs.org/docs/', title: 'three.js' },
      { url: CF + 'r2/', title: 'Cloudflare R2' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
    ],
  },
];

export const categoryOf = (template) => CATEGORIES.find((c) => c.id === template.category) || CATEGORIES[CATEGORIES.length - 1];

// The brief's starting answers: the category's defaults, overridden by the template's own.
export function templateDefaults(template) {
  return { ...categoryOf(template).defaults, ...template.defaults };
}

// Times each template was used in this browser: { id: count }.
export function loadUsage(storage) {
  try {
    const value = JSON.parse((storage && storage.getItem(USAGE_KEY)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// The Popular & Recommended shelf: the most used templates in this browser, the recommended starters filling the
// rest (and breaking ties).
export function popularTemplates(usage = {}) {
  const rank = (t) => (POPULAR_IDS.includes(t.id) ? POPULAR_IDS.indexOf(t.id) : POPULAR_IDS.length);
  const count = (t) => Number(usage[t.id]) || 0;
  return [...TEMPLATES].sort((a, b) => count(b) - count(a) || rank(a) - rank(b)).slice(0, POPULAR_COUNT);
}

const labelOf = (list, id) => (list.find((o) => o.id === id) || { label: id }).label;

// "https://www.Example.com/path" -> "www.example.com"; '' for an empty or unusable answer.
export function normalizeDomain(text) {
  const host = String(text || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : '';
}

// The brief as one paragraph Elarion reads with the sources.
export function briefSummary(template, brief) {
  const domain = normalizeDomain(brief.domain);
  return [
    'Project brief from the operator for "' + (brief.projectName || template.name) + '": ' + template.summary,
    template.website ? 'Deliver a live website for it.' : '',
    'Target domain: ' + (domain ? domain + ' (custom domain on Cloudflare after staging)' : 'none yet; launch on free staging first') + '.',
    'Sign-in: ' + labelOf(AUTH_TYPES, brief.auth) + '.',
    'Database: ' + labelOf(DATABASES, brief.database) + '.',
    brief.notes && brief.notes.trim() ? 'Also: ' + brief.notes.trim().replace(/\s+/g, ' ') : '',
  ].filter(Boolean).join(' ');
}

// The compile request for a template and its answered brief.
export function briefToSpec(template, brief) {
  return {
    projectName: (brief.projectName || '').trim() || template.name,
    lodLevel: 2,
    useMiserlyProxy: true,
    links: [...template.links.map((l) => ({ ...l })), { url: BRIEF_SOURCE_URL, title: 'Project brief', rawSnippet: briefSummary(template, brief) }],
    interviewResponses: {
      database: brief.database || templateDefaults(template).database,
      hosting: templateDefaults(template).hosting,
      unresolvedConnectors: [],
    },
  };
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

export function mountTemplates(container, options = {}) {
  const doc = container.ownerDocument;
  const api = options.api || getEngineApi();
  const onCompiled = options.onCompiled || (() => {});
  const onBlank = options.onBlank || (() => {});
  const win = doc.defaultView || globalThis;
  const storage = options.storage !== undefined ? options.storage : (() => { try { return win.localStorage; } catch { return null; } })();
  let modal = null;

  function card(template) {
    const defaults = templateDefaults(template);
    const button = el(doc, 'button', { type: 'button', class: 'tp-card', 'data-template': template.id, 'data-category': template.category }, [
      el(doc, 'span', { class: 'tp-name', text: template.name }),
      el(doc, 'span', { class: 'tp-summary', text: template.summary }),
      el(doc, 'span', { class: 'tp-tags' }, [
        template.skill ? el(doc, 'span', { class: 'mc-chip tp-skill', text: 'Skill blueprint' }) : null,
        el(doc, 'span', { class: 'mc-chip', text: labelOf(AUTH_TYPES, defaults.auth) }),
        el(doc, 'span', { class: 'mc-chip', text: labelOf(DATABASES, defaults.database) }),
        template.website ? el(doc, 'span', { class: 'mc-chip', text: 'Website' }) : null,
      ]),
    ]);
    button.addEventListener('click', () => openBrief(template, button));
    return el(doc, 'li', {}, [button]);
  }

  const status = el(doc, 'p', { class: 'mc-muted tp-status', 'aria-live': 'polite' });
  const shelf = el(doc, 'section', { class: 'tp-shelf', 'aria-labelledby': 'tp-popular-title' });
  const groups = el(doc, 'div', { class: 'tp-groups' });
  const openGroups = new Set(CATEGORIES.map((c) => c.id));

  // The shelf, then every category with the templates not on the shelf (a category left empty is not shown).
  function render() {
    const popular = popularTemplates(loadUsage(storage));
    const onShelf = new Set(popular.map((t) => t.id));
    shelf.replaceChildren(
      el(doc, 'h3', { id: 'tp-popular-title', class: 'tp-section-title', text: '🌟 Popular & Recommended' }),
      el(doc, 'ul', { class: 'tp-grid', 'aria-labelledby': 'tp-popular-title' }, popular.map(card)),
    );
    groups.replaceChildren(...CATEGORIES.map((category) => {
      const list = TEMPLATES.filter((t) => t.category === category.id && !onShelf.has(t.id));
      if (!list.length) return null;
      const titleId = 'tp-cat-' + category.id;
      const group = el(doc, 'details', { class: 'tp-group', 'data-category': category.id }, [
        el(doc, 'summary', { class: 'tp-section-title' }, [el(doc, 'span', { id: titleId, text: category.name }), el(doc, 'span', { class: 'tp-count', text: String(list.length) })]),
        el(doc, 'ul', { class: 'tp-grid', 'aria-labelledby': titleId }, list.map(card)),
      ]);
      group.open = openGroups.has(category.id);
      group.addEventListener('toggle', () => (group.open ? openGroups.add(category.id) : openGroups.delete(category.id)));
      return group;
    }).filter(Boolean));
  }

  function recordUse(template) {
    const usage = loadUsage(storage);
    usage[template.id] = (Number(usage[template.id]) || 0) + 1;
    try { storage && storage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch { /* storage blocked */ }
    render();
  }

  const blank = el(doc, 'button', { type: 'button', class: 'tp-card tp-blank', 'data-template': 'blank' }, [
    el(doc, 'span', { class: 'tp-name', text: 'Start from scratch' }),
    el(doc, 'span', { class: 'tp-summary', text: 'Paste your own links and settings as a blueprint spec under Projects.' }),
  ]);
  blank.addEventListener('click', () => onBlank());

  render();
  container.replaceChildren(el(doc, 'section', { class: 'bp-card tp', 'aria-labelledby': 'tp-title' }, [
    el(doc, 'div', { class: 'bp-card-head' }, [el(doc, 'h2', { id: 'tp-title', text: 'Create from a template' })]),
    el(doc, 'p', { class: 'mc-muted', text: 'Pick a starting point. A short brief comes next, and nothing runs until you press Deploy & Execute under Projects.' }),
    shelf,
    groups,
    el(doc, 'ul', { class: 'tp-grid tp-blank-row', 'aria-label': 'Other ways to start' }, [el(doc, 'li', {}, [blank])]),
    status,
  ]));

  // One question with a set of radio options shown as chips.
  function choiceQuestion(number, title, name, list, selected) {
    return el(doc, 'fieldset', { class: 'tp-q' }, [
      el(doc, 'legend', { text: number + '. ' + title }),
      el(doc, 'div', { class: 'tp-options' }, list.map((option) => {
        const input = el(doc, 'input', { type: 'radio', name, value: option.id });
        input.checked = option.id === selected;
        return el(doc, 'label', { class: 'tp-option' }, [input, el(doc, 'span', { class: 'tp-option-label', text: option.label }), el(doc, 'span', { class: 'tp-option-hint', text: option.hint })]);
      })),
    ]);
  }

  function closeBrief(returnTo) {
    if (!modal) return;
    modal.remove();
    modal = null;
    if (returnTo && returnTo.focus && doc.contains(returnTo)) returnTo.focus();
  }

  // The project brief, asked before the blueprint is compiled. Resolves once it is closed or compiled.
  function openBrief(template, returnTo = null) {
    closeBrief();
    const defaults = templateDefaults(template);
    const category = categoryOf(template);
    const name = el(doc, 'input', { type: 'text', class: 'tp-input', name: 'projectName', maxlength: '80', 'aria-label': 'Project name' });
    name.value = template.name;
    const domain = el(doc, 'input', { type: 'text', class: 'tp-input', name: 'domain', inputmode: 'url', placeholder: 'www.example.com (leave empty for free staging)', autocomplete: 'off', 'aria-describedby': 'tp-domain-note' });
    const domainNote = el(doc, 'p', { id: 'tp-domain-note', class: 'tp-note' });
    const notes = el(doc, 'textarea', { class: 'tp-input', name: 'notes', rows: '3', maxlength: '1200', placeholder: category.notesHint });
    const error = el(doc, 'p', { class: 'tp-error', role: 'alert', hidden: true });
    const submit = el(doc, 'button', { type: 'submit', class: 'bp-primary tp-submit', text: 'Create project' });
    const cancel = el(doc, 'button', { type: 'button', class: 'toggle-button tp-cancel', text: 'Cancel' });
    const form = el(doc, 'form', { class: 'dc-modal tp-brief', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tp-brief-title', autocomplete: 'off' }, [
      el(doc, 'h2', { id: 'tp-brief-title', class: 'dc-title', text: 'Project brief · ' + template.name }),
      el(doc, 'p', { class: 'tp-note tp-brief-category', text: category.name + ' · answers start from this category\u2019s usual setup' }),
      el(doc, 'label', { class: 'tp-q tp-name-row' }, [el(doc, 'span', { class: 'tp-q-title', text: 'Project name' }), name]),
      el(doc, 'label', { class: 'tp-q' }, [el(doc, 'span', { class: 'tp-q-title', text: '1. Which domain will it live on?' }), domain, domainNote]),
      choiceQuestion(2, 'How do people sign in?', 'auth', AUTH_TYPES, defaults.auth),
      choiceQuestion(3, 'Where is the data kept?', 'database', DATABASES, defaults.database),
      el(doc, 'label', { class: 'tp-q' }, [el(doc, 'span', { class: 'tp-q-title', text: '4. Anything Elarion must know? (optional)' }), notes]),
      error,
      el(doc, 'div', { class: 'bp-preflight-actions' }, [cancel, submit]),
    ]);
    const scrim = el(doc, 'div', { class: 'dc-scrim tp-scrim' }, [form]);
    modal = scrim;

    const showDomain = () => {
      const raw = domain.value.trim();
      const host = normalizeDomain(raw);
      domainNote.textContent = !raw ? 'Empty: it launches on free staging (*.pages.dev) first.' : host ? 'Attach ' + host + ' on Cloudflare after staging.' : 'That does not look like a domain (like www.example.com).';
      domainNote.dataset.ok = !raw || host ? 'yes' : 'no';
      return !raw || Boolean(host);
    };
    showDomain();
    domain.addEventListener('input', showDomain);
    const answers = () => ({
      projectName: name.value,
      domain: domain.value,
      auth: (form.querySelector('input[name="auth"]:checked') || {}).value || defaults.auth,
      database: (form.querySelector('input[name="database"]:checked') || {}).value || defaults.database,
      notes: notes.value,
    });

    return new Promise((resolve) => {
      cancel.addEventListener('click', () => {
        closeBrief(returnTo);
        resolve(null);
      });
      scrim.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !submit.disabled) {
          event.preventDefault();
          closeBrief(returnTo);
          resolve(null);
        }
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!showDomain()) {
          domain.focus();
          return;
        }
        const brief = answers();
        const spec = briefToSpec(template, brief);
        const checked = validateCompileRequest(spec);
        if (checked.errors.length) {
          error.textContent = checked.errors.map((e) => e.path + ' ' + e.message).join('; ');
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        cancel.disabled = true;
        submit.textContent = 'Creating…';
        error.hidden = true;
        try {
          const compiled = await api.compileBlueprint(spec);
          closeBrief();
          recordUse(template);
          status.textContent = 'Created ' + compiled.blueprint_id + ' from ' + template.name + '.';
          await onCompiled(compiled.blueprint_id, compiled.blueprint, { template, brief, spec });
          resolve(compiled);
        } catch (e) {
          error.textContent = 'Could not create the project: ' + describeEngineError(e);
          error.hidden = false;
          submit.disabled = false;
          cancel.disabled = false;
          submit.textContent = 'Create project';
        }
      });
      doc.body.append(scrim);
      domain.focus();
    });
  }

  return {
    openBrief: (id) => openBrief(TEMPLATES.find((t) => t.id === id)),
    elements: { status },
    destroy() {
      closeBrief();
      container.replaceChildren();
    },
  };
}
