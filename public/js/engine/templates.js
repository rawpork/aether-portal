// Create / Templates (Mission Control -> Create): ready-made project templates. Picking one opens a short project
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

const CF = 'https://developers.cloudflare.com/';
export const TEMPLATES = [
  {
    id: 'saas-auditor',
    name: 'SaaS cost auditor',
    summary: 'Paste your tool stack, get the overlap, savings and an ROI number, with paid plans through Stripe.',
    website: true,
    defaults: { auth: 'api_keys', database: 'cloudflare_d1', hosting: 'cloudflare_workers' },
    links: [
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
      { url: 'https://docs.stripe.com/billing/subscriptions/overview', title: 'Stripe subscriptions' },
    ],
  },
  {
    id: 'landing-waitlist',
    name: 'Landing page + waitlist',
    summary: 'A fast product landing page with a waitlist form that stores sign-ups and blocks spam.',
    website: true,
    defaults: { auth: 'none', database: 'cloudflare_d1', hosting: 'cloudflare_pages' },
    links: [
      { url: CF + 'pages/', title: 'Cloudflare Pages' },
      { url: CF + 'd1/', title: 'Cloudflare D1' },
    ],
  },
  {
    id: 'ai-assistant',
    name: 'AI chat assistant',
    summary: 'A chat assistant on the Claude API with streaming replies, saved conversations and a spend cap.',
    website: true,
    defaults: { auth: 'magic_link', database: 'cloudflare_d1', hosting: 'cloudflare_workers' },
    links: [
      { url: 'https://docs.claude.com/en/api/messages', title: 'Claude Messages API' },
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
    ],
  },
  {
    id: 'team-dashboard',
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
    name: 'API + webhook worker',
    summary: 'A small JSON API that receives webhooks, checks their signatures and keeps state at the edge.',
    website: false,
    defaults: { auth: 'api_keys', database: 'cloudflare_kv', hosting: 'cloudflare_workers' },
    links: [
      { url: CF + 'workers/', title: 'Cloudflare Workers' },
      { url: CF + 'kv/', title: 'Cloudflare KV' },
    ],
  },
];

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
      database: brief.database || template.defaults.database,
      hosting: template.defaults.hosting,
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
  let modal = null;

  const cards = TEMPLATES.map((template) => {
    const button = el(doc, 'button', { type: 'button', class: 'tp-card', 'data-template': template.id }, [
      el(doc, 'span', { class: 'tp-name', text: template.name }),
      el(doc, 'span', { class: 'tp-summary', text: template.summary }),
      el(doc, 'span', { class: 'tp-tags' }, [
        el(doc, 'span', { class: 'mc-chip', text: labelOf(AUTH_TYPES, template.defaults.auth) }),
        el(doc, 'span', { class: 'mc-chip', text: labelOf(DATABASES, template.defaults.database) }),
        template.website ? el(doc, 'span', { class: 'mc-chip', text: 'Website' }) : null,
      ]),
    ]);
    button.addEventListener('click', () => openBrief(template, button));
    return el(doc, 'li', {}, [button]);
  });
  const blank = el(doc, 'button', { type: 'button', class: 'tp-card tp-blank', 'data-template': 'blank' }, [
    el(doc, 'span', { class: 'tp-name', text: 'Start from scratch' }),
    el(doc, 'span', { class: 'tp-summary', text: 'Paste your own links and settings as a blueprint spec under Projects.' }),
  ]);
  blank.addEventListener('click', () => onBlank());
  cards.push(el(doc, 'li', {}, [blank]));

  const status = el(doc, 'p', { class: 'mc-muted tp-status', 'aria-live': 'polite' });
  container.replaceChildren(el(doc, 'section', { class: 'bp-card tp', 'aria-labelledby': 'tp-title' }, [
    el(doc, 'div', { class: 'bp-card-head' }, [el(doc, 'h2', { id: 'tp-title', text: 'Create from a template' })]),
    el(doc, 'p', { class: 'mc-muted', text: 'Pick a starting point. A short brief comes next, and nothing runs until you press Deploy & Execute under Projects.' }),
    el(doc, 'ul', { class: 'tp-grid', 'aria-label': 'Project templates' }, cards),
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
    const name = el(doc, 'input', { type: 'text', class: 'tp-input', name: 'projectName', maxlength: '80', 'aria-label': 'Project name' });
    name.value = template.name;
    const domain = el(doc, 'input', { type: 'text', class: 'tp-input', name: 'domain', inputmode: 'url', placeholder: 'www.example.com (leave empty for free staging)', autocomplete: 'off', 'aria-describedby': 'tp-domain-note' });
    const domainNote = el(doc, 'p', { id: 'tp-domain-note', class: 'tp-note' });
    const notes = el(doc, 'textarea', { class: 'tp-input', name: 'notes', rows: '3', maxlength: '1200', placeholder: 'Pricing, brand, must-have pages, anything to avoid…' });
    const error = el(doc, 'p', { class: 'tp-error', role: 'alert', hidden: true });
    const submit = el(doc, 'button', { type: 'submit', class: 'bp-primary tp-submit', text: 'Create project' });
    const cancel = el(doc, 'button', { type: 'button', class: 'toggle-button tp-cancel', text: 'Cancel' });
    const form = el(doc, 'form', { class: 'dc-modal tp-brief', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tp-brief-title', autocomplete: 'off' }, [
      el(doc, 'h2', { id: 'tp-brief-title', class: 'dc-title', text: 'Project brief · ' + template.name }),
      el(doc, 'label', { class: 'tp-q tp-name-row' }, [el(doc, 'span', { class: 'tp-q-title', text: 'Project name' }), name]),
      el(doc, 'label', { class: 'tp-q' }, [el(doc, 'span', { class: 'tp-q-title', text: '1. Which domain will it live on?' }), domain, domainNote]),
      choiceQuestion(2, 'How do people sign in?', 'auth', AUTH_TYPES, template.defaults.auth),
      choiceQuestion(3, 'Where is the data kept?', 'database', DATABASES, template.defaults.database),
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
      auth: (form.querySelector('input[name="auth"]:checked') || {}).value || template.defaults.auth,
      database: (form.querySelector('input[name="database"]:checked') || {}).value || template.defaults.database,
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
