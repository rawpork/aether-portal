// Connection setup for Mission Control: choose a Local engine (your computer, reached from other devices through a
// Cloudflare quick tunnel) or a Dedicated Cloud engine (an always-on server at your own domain), follow the steps,
// and connect. On the computer running a local engine it detects the tunnel (engine GET /api/public-url) and shows a
// QR code with a pairing link (/mission-control?engine=<url>) so a phone can connect without typing. Opening a
// pairing link always asks before switching engines: the portal sends its engine token to whatever engine it uses.
import { DEFAULT_ENGINE_BASE_URL, createEngineApi } from '../engine-api.bundle.js';
import { renderQrSvg } from '../qr.bundle.js';
import { checkEngineUrl, describeAuthError, persistEngineUrl } from './connection.js';

export const MODE_STORAGE_KEY = 'aether.engine.mode';
export const ENGINE_PARAM = 'engine';

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Local: this computer or a quick tunnel to it. Anything else is treated as a cloud engine.
export function guessMode(baseUrl) {
  const host = hostOf(baseUrl).split(':')[0];
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.trycloudflare.com') ? 'local' : 'cloud';
}

export function pairingLink(portalOrigin, engineUrl) {
  return portalOrigin.replace(/\/+$/, '') + '/mission-control?' + ENGINE_PARAM + '=' + encodeURIComponent(engineUrl) + '#connect';
}

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Only a remembered preference.
  }
}

export function mountConnectionWizard(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const api = options.api || createEngineApi();
  const baseUrl = api.baseUrl || DEFAULT_ENGINE_BASE_URL;
  const storage = options.storage || globalThis.localStorage;
  const reload = options.reload || (() => win.location.reload());
  const pageProtocol = options.pageProtocol || (win.location && win.location.protocol) || 'https:';
  const portalOrigin = options.portalOrigin || (win.location && win.location.origin) || '';
  const renderQr = options.renderQr || renderQrSvg;
  const healthCheck = options.healthCheck || ((url) => createEngineApi({ baseUrl: url, getToken: () => null }).getEngineHealth());
  const copyText =
    options.copyText ||
    ((text) => (win.navigator && win.navigator.clipboard ? win.navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard unavailable'))));

  let mode = readStorage(storage, MODE_STORAGE_KEY) || guessMode(baseUrl);

  // --- shared pieces
  function codeBlock(text, label) {
    const copy = el(doc, 'button', { type: 'button', class: 'cw-copy', 'aria-label': 'Copy ' + label, text: 'Copy' });
    copy.addEventListener('click', async () => {
      try {
        await copyText(text);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Select and copy';
      }
      setTimeout(() => (copy.textContent = 'Copy'), 2000);
    });
    return el(doc, 'div', { class: 'cw-code' }, [el(doc, 'pre', {}, [el(doc, 'code', { text })]), copy]);
  }

  function step(n, title, children) {
    return el(doc, 'li', { class: 'cw-step' }, [
      el(doc, 'span', { class: 'cw-step-n', 'aria-hidden': 'true', text: String(n) }),
      el(doc, 'div', { class: 'cw-step-body' }, [el(doc, 'h3', { text: title }), ...children]),
    ]);
  }

  // Validates, saves and reconnects (the engine client reads the address at page load).
  function connectTo(raw, messageEl) {
    const checked = checkEngineUrl(raw, pageProtocol);
    if (!checked.ok) {
      messageEl.textContent = checked.error;
      messageEl.dataset.kind = 'error';
      return false;
    }
    if (checked.url === baseUrl) {
      messageEl.textContent = 'This device already uses ' + hostOf(checked.url) + '.';
      messageEl.dataset.kind = 'ok';
      return false;
    }
    if (!persistEngineUrl(checked.url, storage)) {
      messageEl.textContent = 'This browser didn’t let the page save the engine address (storage is blocked or full).';
      messageEl.dataset.kind = 'error';
      return false;
    }
    messageEl.textContent = 'Saved. Connecting to ' + hostOf(checked.url) + '…';
    messageEl.dataset.kind = 'ok';
    reload();
    return true;
  }

  async function testUrl(raw, messageEl) {
    const checked = checkEngineUrl(raw, pageProtocol);
    if (!checked.ok) {
      messageEl.textContent = checked.error;
      messageEl.dataset.kind = 'error';
      return false;
    }
    messageEl.textContent = 'Checking ' + hostOf(checked.url) + '…';
    messageEl.dataset.kind = '';
    try {
      const health = await healthCheck(checked.url);
      messageEl.textContent = (health && health.status === 'healthy' ? 'Reachable: ' : 'Answered: ') + hostOf(checked.url) + ' (' + ((health && health.system) || 'engine') + ').';
      messageEl.dataset.kind = 'ok';
      return true;
    } catch (error) {
      messageEl.textContent = 'Can’t reach ' + hostOf(checked.url) + (error && error.message ? ': ' + error.message : '.');
      messageEl.dataset.kind = 'error';
      return false;
    }
  }

  // --- status + pairing offer
  const statusText = el(doc, 'span', { class: 'cw-status-text', text: 'This device uses ' + hostOf(baseUrl) + '.' });
  const statusMsg = el(doc, 'span', { class: 'cw-msg', 'aria-live': 'polite' });
  const statusTest = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Test connection' });
  statusTest.addEventListener('click', () => testUrl(baseUrl, statusMsg));
  const status = el(doc, 'div', { class: 'cw-status' }, [statusText, statusTest, statusMsg]);

  const offerText = el(doc, 'p', { class: 'cw-offer-text' });
  const offerMsg = el(doc, 'p', { class: 'cw-msg', 'aria-live': 'polite' });
  const offerAccept = el(doc, 'button', { type: 'button', class: 'bp-primary cw-offer-accept', text: 'Pair this device' });
  const offerDecline = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Not now' });
  const offer = el(doc, 'div', { class: 'cw-offer', role: 'alertdialog', 'aria-labelledby': 'cw-offer-title', hidden: true }, [
    el(doc, 'h3', { id: 'cw-offer-title', text: 'Pair this device?' }),
    offerText,
    el(doc, 'p', { class: 'mc-muted', text: 'Only pair with an engine you run. Mission Control sends it your engine token.' }),
    el(doc, 'div', { class: 'cw-actions' }, [offerAccept, offerDecline]),
    offerMsg,
  ]);
  let offeredUrl = null;
  offerAccept.addEventListener('click', () => connectTo(offeredUrl, offerMsg));
  offerDecline.addEventListener('click', () => {
    offer.hidden = true;
    offeredUrl = null;
  });

  // --- mode choice
  const modeInputs = {};
  function modeCard(value, title, subtitle, text) {
    const input = el(doc, 'input', { type: 'radio', name: 'cw-mode', value, class: 'cw-mode-input' });
    modeInputs[value] = input;
    input.addEventListener('change', () => setMode(value));
    return el(doc, 'label', { class: 'cw-mode', 'data-mode': value }, [
      input,
      el(doc, 'span', { class: 'cw-mode-title', text: title }),
      el(doc, 'span', { class: 'cw-mode-sub', text: subtitle }),
      el(doc, 'span', { class: 'cw-mode-text', text }),
    ]);
  }
  const modes = el(doc, 'fieldset', { class: 'cw-modes' }, [
    el(doc, 'legend', { text: 'Where does your engine run?' }),
    modeCard('local', 'Local Engine', 'Private & Local Compute', 'Runs on your computer, so your data and compute stay with you. Your phone reaches it through a secure tunnel while the computer is on.'),
    modeCard('cloud', 'Dedicated Cloud Engine', 'Always-On SaaS', 'Runs on a server you control at your own domain, available around the clock from any device.'),
  ]);

  // --- Local panel
  const tunnelInput = el(doc, 'input', {
    type: 'text',
    class: 'mc-url-input cw-tunnel-input',
    placeholder: 'xyz.trycloudflare.com',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Tunnel address',
  });
  const detectButton = el(doc, 'button', { type: 'button', class: 'toggle-button cw-detect', text: 'Detect tunnel' });
  const detectMsg = el(doc, 'p', { class: 'cw-msg', 'aria-live': 'polite' });
  const qrBox = el(doc, 'div', { class: 'cw-qr', 'aria-hidden': 'true' });
  const pairLinkText = el(doc, 'code', { class: 'cw-pair-link' });
  const copyPair = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Copy pairing link' });
  const useTunnel = el(doc, 'button', { type: 'button', class: 'bp-primary cw-use-tunnel', text: 'Use on this device' });
  const pairMsg = el(doc, 'p', { class: 'cw-msg', 'aria-live': 'polite' });
  const pairBox = el(doc, 'div', { class: 'cw-pair', hidden: true }, [
    qrBox,
    el(doc, 'div', { class: 'cw-pair-side' }, [
      el(doc, 'p', { class: 'cw-pair-hint', text: 'Scan with your phone’s camera to pair it with this engine.' }),
      pairLinkText,
      el(doc, 'div', { class: 'cw-actions' }, [copyPair, useTunnel]),
      el(doc, 'p', {
        class: 'mc-muted',
        text: 'On iPhone, the camera opens the link in Safari. If you use Aether from your home screen, paste the address above there and tap Use on this device.',
      }),
      pairMsg,
    ]),
  ]);
  const useLocalhost = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Use this computer’s engine (localhost)', hidden: baseUrl === DEFAULT_ENGINE_BASE_URL });
  const localMsg = el(doc, 'p', { class: 'cw-msg', 'aria-live': 'polite' });
  useLocalhost.addEventListener('click', () => connectTo(DEFAULT_ENGINE_BASE_URL, localMsg));

  function showPairing(raw) {
    const checked = checkEngineUrl(raw, pageProtocol);
    if (!checked.ok || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(checked.url).hostname)) {
      pairBox.hidden = true;
      if (raw.trim()) {
        detectMsg.textContent = checked.ok ? 'Pair with the tunnel address, not localhost.' : checked.error;
        detectMsg.dataset.kind = 'error';
      }
      return null;
    }
    tunnelInput.value = checked.url;
    const link = pairingLink(portalOrigin, checked.url);
    qrBox.innerHTML = renderQr(link, { label: 'Pairing code for ' + hostOf(checked.url) });
    pairLinkText.textContent = link;
    pairBox.hidden = false;
    return link;
  }

  async function detect() {
    detectMsg.textContent = 'Looking for a tunnel…';
    detectMsg.dataset.kind = '';
    try {
      const result = await api.getPublicUrl();
      if (!result.public_url) {
        detectMsg.textContent = 'No tunnel found. Start it (step 2) on the computer running the engine, then detect again.';
        detectMsg.dataset.kind = 'error';
        return null;
      }
      detectMsg.textContent = (result.source === 'env' ? 'The engine’s public address: ' : 'Found the tunnel: ') + hostOf(result.public_url) + '.';
      detectMsg.dataset.kind = 'ok';
      return showPairing(result.public_url);
    } catch (error) {
      if (error && error.isUnreachable) detectMsg.textContent = 'Can’t reach the engine at ' + baseUrl + '. Detecting works on the computer running the engine, once step 1 is done.';
      else if (error && error.isUnauthorized) detectMsg.textContent = describeAuthError(error);
      else detectMsg.textContent = 'Detecting failed: ' + ((error && error.message) || 'engine error') + '.';
      detectMsg.dataset.kind = 'error';
      return null;
    }
  }

  detectButton.addEventListener('click', detect);
  tunnelInput.addEventListener('change', () => showPairing(tunnelInput.value));
  copyPair.addEventListener('click', async () => {
    try {
      await copyText(pairLinkText.textContent);
      pairMsg.textContent = 'Pairing link copied.';
      pairMsg.dataset.kind = 'ok';
    } catch {
      pairMsg.textContent = 'Copy didn’t work here; select the link above instead.';
      pairMsg.dataset.kind = 'error';
    }
  });
  useTunnel.addEventListener('click', () => connectTo(tunnelInput.value, pairMsg));

  const localPanel = el(doc, 'div', { class: 'cw-panel', 'data-mode': 'local' }, [
    el(doc, 'ol', { class: 'cw-steps' }, [
      step(1, 'Start the engine on your computer', [
        codeBlock('cd Aether_Engine\nnpm run dev', 'engine start commands'),
        el(doc, 'p', {
          class: 'mc-muted',
          text: 'It signs in with SUPABASE_JWT_SECRET from your environment, the same key as the portal’s ENGINE_JWT_SECRET. Set MISERLY_CLIENT_KEY too so Elarion can answer.',
        }),
        el(doc, 'div', { class: 'cw-actions' }, [useLocalhost]),
        localMsg,
      ]),
      step(2, 'Open a secure tunnel', [
        codeBlock('cloudflared tunnel --url http://localhost:3333', 'tunnel command'),
        el(doc, 'p', { class: 'mc-muted' }, ['First time on Windows: ', el(doc, 'code', { text: 'winget install --id Cloudflare.cloudflared -e' }), '. Keep the window open while you use your phone; the address changes each time it starts.']),
      ]),
      step(3, 'Pair your phone', [
        el(doc, 'p', { class: 'mc-muted', text: 'On the computer running the engine, detect the tunnel to get a pairing code. Or paste the https://….trycloudflare.com address it printed.' }),
        el(doc, 'div', { class: 'cw-row' }, [tunnelInput, detectButton]),
        detectMsg,
        pairBox,
      ]),
    ]),
  ]);

  // --- Cloud panel
  const cloudInput = el(doc, 'input', {
    type: 'text',
    class: 'mc-url-input cw-cloud-input',
    placeholder: 'engine.yourdomain.com',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Cloud engine URL',
  });
  if (guessMode(baseUrl) === 'cloud') cloudInput.value = baseUrl;
  const cloudTest = el(doc, 'button', { type: 'button', class: 'toggle-button', text: 'Test' });
  const cloudSave = el(doc, 'button', { type: 'submit', class: 'bp-primary cw-cloud-save', text: 'Save & connect' });
  const cloudMsg = el(doc, 'p', { class: 'cw-msg', 'aria-live': 'polite' });
  const cloudForm = el(doc, 'form', { class: 'cw-cloud-form', novalidate: '' }, [
    el(doc, 'label', { class: 'cw-label', text: 'Cloud Engine URL' }, [cloudInput]),
    el(doc, 'div', { class: 'cw-actions' }, [cloudTest, cloudSave]),
    cloudMsg,
  ]);
  cloudTest.addEventListener('click', () => testUrl(cloudInput.value, cloudMsg));
  cloudForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const checked = checkEngineUrl(cloudInput.value, pageProtocol);
    if (checked.ok) cloudInput.value = checked.url;
    connectTo(cloudInput.value, cloudMsg);
  });

  const cloudPanel = el(doc, 'div', { class: 'cw-panel', 'data-mode': 'cloud' }, [
    el(doc, 'ol', { class: 'cw-steps' }, [
      step(1, 'Create the engine secret', [
        el(doc, 'p', { class: 'mc-muted', text: 'Generate a long random key on the server and keep it out of chat and source control:' }),
        codeBlock("openssl rand -base64 48 | tr '+/' '-_' | tr -d '='", 'secret command'),
        el(doc, 'p', { class: 'mc-muted', text: 'The server uses it as SUPABASE_JWT_SECRET. Give the portal the same value (run in Aether_Portal and paste it when asked):' }),
        codeBlock('npx wrangler secret put ENGINE_JWT_SECRET', 'portal secret command'),
      ]),
      step(2, 'Deploy the engine', [
        el(doc, 'p', { class: 'mc-muted', text: 'With PM2 on a Linux server:' }),
        codeBlock(
          [
            'git clone https://github.com/rawpork/aether-engine.git && cd aether-engine',
            'npm ci',
            "export SUPABASE_JWT_SECRET='<secret>' MISERLY_CLIENT_KEY='<key>'",
            'export ENGINE_PUBLIC_URL=https://engine.yourdomain.com',
            'export ENGINE_OUTPUT_DIR=/var/lib/aether/outputs PROJECT_STATE_PATH=/var/lib/aether/PROJECT_STATE.md',
            'pm2 start "npx ts-node --transpile-only src/server.ts" --name aether-engine',
            'pm2 save && pm2 startup',
          ].join('\n'),
          'PM2 commands',
        ),
        el(doc, 'p', { class: 'mc-muted', text: 'Or with Docker, from the cloned folder:' }),
        codeBlock(
          [
            'docker run -d --name aether-engine --restart unless-stopped \\',
            '  -p 127.0.0.1:3333:3333 -v "$PWD":/app -w /app -v aether-data:/data \\',
            "  -e SUPABASE_JWT_SECRET='<secret>' -e MISERLY_CLIENT_KEY='<key>' \\",
            '  -e ENGINE_PUBLIC_URL=https://engine.yourdomain.com \\',
            '  -e ENGINE_OUTPUT_DIR=/data/outputs -e PROJECT_STATE_PATH=/data/PROJECT_STATE.md \\',
            '  node:24-alpine sh -c "npm ci && npx ts-node --transpile-only src/server.ts"',
          ].join('\n'),
          'Docker command',
        ),
      ]),
      step(3, 'Serve it over HTTPS at your domain', [
        el(doc, 'p', { class: 'mc-muted', text: 'Point engine.yourdomain.com at the server, then let Caddy handle HTTPS (WebSockets for voice pass through):' }),
        codeBlock('engine.yourdomain.com {\n  reverse_proxy 127.0.0.1:3333\n}', 'Caddyfile'),
        el(doc, 'p', { class: 'mc-muted' }, ['Or use a named Cloudflare Tunnel: ', el(doc, 'code', { text: 'cloudflared tunnel create aether-engine' }), ', ', el(doc, 'code', { text: 'cloudflared tunnel route dns aether-engine engine.yourdomain.com' }), ', ', el(doc, 'code', { text: 'cloudflared tunnel run --url http://localhost:3333 aether-engine' }), '.']),
      ]),
      step(4, 'Connect Mission Control', [cloudForm]),
    ]),
  ]);

  function setMode(next) {
    mode = next === 'cloud' ? 'cloud' : 'local';
    writeStorage(storage, MODE_STORAGE_KEY, mode);
    modeInputs.local.checked = mode === 'local';
    modeInputs.cloud.checked = mode === 'cloud';
    localPanel.hidden = mode !== 'local';
    cloudPanel.hidden = mode !== 'cloud';
    for (const card of modes.querySelectorAll('.cw-mode')) card.classList.toggle('active', card.dataset.mode === mode);
  }

  container.replaceChildren(el(doc, 'section', { class: 'cw', 'aria-label': 'Connection setup' }, [status, offer, modes, localPanel, cloudPanel]));
  setMode(mode);

  // A pairing link (?engine=<url>) asks before switching this device to that engine.
  function offerPairing(raw) {
    const checked = checkEngineUrl(raw, pageProtocol);
    offer.hidden = false;
    offerAccept.hidden = !checked.ok || checked.url === baseUrl;
    if (!checked.ok) {
      offerText.textContent = 'That pairing link has an unusable engine address: ' + checked.error;
      offeredUrl = null;
    } else if (checked.url === baseUrl) {
      offerText.textContent = 'This device is already paired with ' + hostOf(checked.url) + '.';
      offeredUrl = null;
    } else {
      offerText.textContent = 'Connect this device to the engine at ' + hostOf(checked.url) + '?';
      offeredUrl = checked.url;
      setMode(guessMode(checked.url));
      offerAccept.focus();
    }
    return checked;
  }

  // On the computer running a local engine, look for the tunnel right away.
  if (mode === 'local' && baseUrl === DEFAULT_ENGINE_BASE_URL && options.autoDetect !== false) detect();

  return {
    detect,
    offerPairing,
    setMode,
    getMode: () => mode,
    elements: { status, offer, offerAccept, offerDecline, modes, localPanel, cloudPanel, tunnelInput, detectButton, detectMsg, qrBox, pairBox, pairLinkText, copyPair, useTunnel, useLocalhost, cloudInput, cloudTest, cloudForm, cloudMsg, statusTest, statusMsg },
    destroy() {
      container.replaceChildren();
    },
  };
}
