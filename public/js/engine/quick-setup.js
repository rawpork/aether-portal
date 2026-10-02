// Quick Setup (Settings tab): pair an engine and give Elarion its Miserly.io client key in one step. "Test & Pair
// Engine" checks the engine's GET /health, then sends the key over the authenticated POST /api/engine/config, where
// the engine verifies it with Miserly.io and saves it without a restart. The header's "Elarion Ready" badge shows the
// result (GET /api/engine/config on load). Pairing a different address saves it for this browser and reloads, since
// every engine client reads the address at page load.
import { createEngineApi } from '../engine-api.bundle.js';
import { checkEngineUrl, describeAuthError, persistEngineUrl } from './connection.js';

export const STEPS = [
  ['reach', 'Engine reachable'],
  ['auth', 'Mission Control authorized'],
  ['key', 'Miserly key verified'],
];

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

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// A stable https address is worth saving as the engine's public URL (used for pairing other devices). Quick tunnel
// addresses change on every restart, and the engine already detects them, so they are not saved.
export function publicUrlFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.hostname.endsWith('.trycloudflare.com') || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null;
    return u.origin;
  } catch {
    return null;
  }
}

// Header badge: green "Elarion Ready", amber "Set up Elarion" (opens Settings), or hidden when the engine can't say.
export function badgeState(summary) {
  if (!summary) return { hidden: true };
  if (summary.elarion_ready) return { hidden: false, kind: 'running', text: 'Elarion Ready', title: 'Engine paired and Miserly key ' + (summary.miserly_key_hint || '') + ' verified' };
  const why = summary.miserly_key_status === 'missing' ? 'No Miserly client key on the engine' : summary.miserly_key_detail || 'Miserly key not verified';
  return { hidden: false, kind: 'alert', text: 'Set up Elarion', title: why };
}

export function mountQuickSetup(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || createEngineApi();
  const badge = options.badge || null;
  const onOpenSettings = options.onOpenSettings || (() => {});
  const storage = options.storage || globalThis.localStorage;
  const reload = options.reload || (() => win.location.reload());
  const pageProtocol = options.pageProtocol || (win.location && win.location.protocol) || 'https:';
  const engineFor = options.engineFor || ((baseUrl) => createEngineApi({ baseUrl }));
  let destroyed = false;
  let busy = false;

  const address = el(doc, 'input', { id: 'qs-address', class: 'qs-input mono', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://your-tunnel.trycloudflare.com' });
  address.value = api.baseUrl;
  const key = el(doc, 'input', { id: 'qs-key', class: 'qs-input mono', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste your Miserly client key' });
  const keyHint = el(doc, 'p', { id: 'qs-key-hint', class: 'qs-hint', text: 'Checking the engine…' });
  const reveal = el(doc, 'button', { type: 'button', class: 'qs-reveal', 'aria-controls': 'qs-key', 'aria-pressed': 'false', text: 'Show' });
  reveal.addEventListener('click', () => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    reveal.textContent = show ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(show));
  });
  const pairBtn = el(doc, 'button', { type: 'submit', class: 'bp-primary qs-pair', text: 'Test & Pair Engine' });
  const message = el(doc, 'p', { class: 'cw-msg qs-msg', 'aria-live': 'polite' });
  const stepEls = {};
  const stepList = el(doc, 'ol', { class: 'qs-steps', 'aria-label': 'Pairing checks' }, STEPS.map(([id, label]) => {
    const mark = el(doc, 'span', { class: 'qs-mark', 'aria-hidden': 'true' });
    const detail = el(doc, 'span', { class: 'qs-step-detail' });
    const li = el(doc, 'li', { class: 'qs-step', 'data-state': 'idle' }, [mark, el(doc, 'span', { class: 'qs-step-body' }, [el(doc, 'span', { class: 'qs-step-label', text: label }), detail])]);
    stepEls[id] = { li, detail };
    return li;
  }));

  const form = el(doc, 'form', { class: 'qs-form', novalidate: true }, [
    el(doc, 'div', { class: 'qs-field' }, [
      el(doc, 'label', { for: 'qs-address', text: 'Engine Address' }),
      address,
      el(doc, 'p', { class: 'qs-hint', text: 'Your tunnel or server address, or http://localhost:3333 on the computer running the engine.' }),
    ]),
    el(doc, 'div', { class: 'qs-field' }, [
      el(doc, 'label', { for: 'qs-key', text: 'Miserly Client Key' }),
      el(doc, 'div', { class: 'qs-key-row' }, [key, reveal]),
      keyHint,
    ]),
    el(doc, 'div', { class: 'qs-actions' }, [pairBtn, message]),
    stepList,
  ]);
  container.replaceChildren(
    el(doc, 'section', { class: 'surface mc-panel qs', 'aria-labelledby': 'qs-title' }, [
      el(doc, 'div', { class: 'mc-panel-head' }, [el(doc, 'h2', { id: 'qs-title', text: 'Quick Setup' }), el(doc, 'span', { class: 'mc-muted', text: 'Pair the engine and give Elarion its key' })]),
      form,
    ]),
  );

  function setStep(id, state, detail = '') {
    stepEls[id].li.dataset.state = state;
    stepEls[id].detail.textContent = detail;
  }

  function say(text, kind = '') {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function showSummary(summary) {
    const b = badgeState(summary);
    if (badge) {
      badge.hidden = b.hidden;
      if (!b.hidden) {
        badge.dataset.kind = b.kind;
        badge.querySelector('.ready-text').textContent = b.text;
        badge.title = b.title;
        badge.setAttribute('aria-label', b.text + ': ' + b.title + '. Open Quick Setup.');
      }
    }
    if (!summary) return;
    if (summary.miserly_key_configured) {
      keyHint.textContent = 'Saved on the engine: ' + summary.miserly_key_hint + ' (' + (summary.miserly_key_status === 'verified' ? 'verified' : summary.miserly_key_detail) + '). Paste a new key to replace it.';
      keyHint.dataset.kind = summary.miserly_key_status === 'verified' ? 'ok' : 'error';
    } else {
      keyHint.textContent = 'The engine has no key yet. Elarion needs one to chat and run prompt steps.';
      keyHint.dataset.kind = 'error';
    }
  }

  // Badge and key hint for the engine this page is connected to.
  async function refresh() {
    try {
      const summary = await api.getEngineConfig();
      if (!destroyed) showSummary(summary);
      return summary;
    } catch (error) {
      if (destroyed) return null;
      showSummary(null);
      keyHint.dataset.kind = '';
      if (error && error.status === 404) keyHint.textContent = 'This engine is older than Quick Setup. Update Aether_Engine (git pull) and restart it.';
      else if (error && error.isUnauthorized) keyHint.textContent = describeAuthError(error);
      else keyHint.textContent = 'Connect to the engine to see whether Elarion has a key.';
      return null;
    }
  }

  async function pair() {
    if (busy) return;
    STEPS.forEach(([id]) => setStep(id, 'idle'));
    const checked = checkEngineUrl(address.value, pageProtocol);
    if (!checked.ok) {
      setStep('reach', 'fail', checked.error);
      say('Fix the engine address and try again.', 'error');
      address.focus();
      return;
    }
    busy = true;
    pairBtn.disabled = true;
    say('Pairing with ' + hostOf(checked.url) + '…');
    const target = checked.url === api.baseUrl ? api : engineFor(checked.url);
    try {
      setStep('reach', 'busy');
      try {
        const health = await target.getEngineHealth();
        setStep('reach', 'ok', hostOf(checked.url) + ' · ' + ((health && health.system) || 'engine'));
      } catch (error) {
        setStep('reach', 'fail', (error && error.message) || 'Not reachable.');
        say('Start the engine (npm run dev) and its tunnel, then try again.', 'error');
        return;
      }

      setStep('auth', 'busy');
      setStep('key', 'busy');
      const changes = {};
      const typedKey = key.value.trim();
      if (typedKey) changes.miserly_client_key = typedKey;
      const publicUrl = publicUrlFor(checked.url);
      if (publicUrl) changes.public_url = publicUrl;
      let summary;
      try {
        summary = Object.keys(changes).length ? await target.saveEngineConfig(changes) : await target.getEngineConfig();
      } catch (error) {
        if (error && error.isUnauthorized) {
          setStep('auth', 'fail', describeAuthError(error));
          setStep('key', 'idle');
          say('The engine did not accept Mission Control’s token.', 'error');
        } else if (error && error.status === 404) {
          setStep('auth', 'fail', 'This engine has no Quick Setup route; update Aether_Engine and restart it.');
          setStep('key', 'idle');
          say('Update the engine, then try again.', 'error');
        } else {
          setStep('auth', 'ok');
          setStep('key', 'fail', (error && error.message) || 'The engine could not save the key.');
          say(error && error.status === 422 ? 'Miserly.io rejected that key. Check it and paste it again.' : 'The key was not saved.', 'error');
          key.focus();
        }
        return;
      }
      setStep('auth', 'ok');
      key.value = '';
      if (summary.miserly_key_status === 'verified') setStep('key', 'ok', 'Key ' + summary.miserly_key_hint + (typedKey ? ' saved on the engine' : ' already on the engine'));
      else if (summary.miserly_key_status === 'missing') setStep('key', 'fail', 'Paste your Miserly client key above.');
      else setStep('key', 'fail', summary.miserly_key_detail);

      if (checked.url !== api.baseUrl) {
        if (!persistEngineUrl(checked.url, storage)) {
          say('This browser didn’t let the page save the engine address (storage is blocked or full).', 'error');
          return;
        }
        say('Paired. Reconnecting to ' + hostOf(checked.url) + '…', 'ok');
        setTimeout(reload, 900);
        return;
      }
      showSummary(summary);
      say(summary.elarion_ready ? 'Paired. Elarion is ready.' : 'Engine paired; Elarion still needs a valid key.', summary.elarion_ready ? 'ok' : 'error');
    } finally {
      busy = false;
      pairBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    pair();
  });
  const onBadge = () => {
    onOpenSettings();
    (key.value || keyHint.dataset.kind === 'ok' ? address : key).focus();
  };
  if (badge) badge.addEventListener('click', onBadge);
  refresh();

  return {
    pair,
    refresh,
    elements: { form, address, key, pairBtn, message, keyHint, steps: stepEls },
    destroy() {
      destroyed = true;
      if (badge) badge.removeEventListener('click', onBadge);
    },
  };
}
