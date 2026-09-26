// The /share page opened by the PWA share sheet: a preview of the shared link, a model tier, action presets and a
// command input, then one tap to save. The HTML is a template literal, so the client script below avoids
// backslashes and template placeholders; the shared values reach it as escaped JSON.

// Android usually puts the link inside "text"; pull the first http(s) URL out and keep the rest as a note.
export function normalizeSharedInput({ url = "", title = "", text = "" }) {
  let link = String(url).trim();
  let note = String(text).trim();
  if (!link) {
    const match = /https?:\/\/[^\s<>"']+/i.exec(note);
    if (match) {
      link = match[0].replace(/[).,;!?]+$/, "");
      note = (note.slice(0, match.index) + note.slice(match.index + match[0].length)).replace(/\s+/g, " ").trim();
    }
  } else if (note === link) {
    note = "";
  }
  let cleanTitle = String(title).trim();
  if (cleanTitle === link) cleanTitle = "";
  let domain = "";
  try {
    domain = link ? new URL(link).hostname.replace(/^www\./, "") : "";
  } catch {
    link = "";
  }
  return { url: link, title: cleanTitle, note, domain };
}

const escapeJson = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export function renderSharePage(shared, { claudeAvailable = false } = {}) {
  const data = { ...normalizeSharedInput(shared), claudeAvailable };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Save to Aether</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <link rel="manifest" href="/manifest.json">
  <style>
    /* DESIGN.md: system type on the Dynamic Type scale, an 8pt grid, one accent reserved for the primary action,
       44pt targets that press down to scale(0.98) on pointer-down and settle back with a critically damped ease. */
    :root {
      color-scheme: dark;
      --bg-primary: #000000;
      --bg-elevated: rgba(28, 28, 30, 0.82);
      --fill-secondary: rgba(120, 120, 128, 0.24);
      --fill-tertiary: rgba(118, 118, 128, 0.18);
      --text-primary: #ffffff;
      --text-secondary: rgba(235, 235, 245, 0.6);
      --text-tertiary: rgba(235, 235, 245, 0.3);
      --separator: rgba(255, 255, 255, 0.08);
      --accent: #0a84ff;
      --on-accent: #ffffff;
      --destructive: #ff453a;
      --success: #30d158;
      --ease-settle: cubic-bezier(0.25, 1, 0.5, 1);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      font-size: 17px;
      line-height: 1.29;
      color: var(--text-primary);
      background: var(--bg-primary);
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
    }
    .sheet {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      padding: 16px 16px 24px;
      border-radius: 16px;
      border: 1px solid var(--separator);
      background: var(--bg-elevated);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    @media (max-width: 520px) {
      body { align-items: flex-end; padding: 0; }
      .sheet { max-width: none; border-radius: 16px 16px 0 0; border-width: 1px 0 0; padding-bottom: max(24px, env(safe-area-inset-bottom)); }
    }
    button, .button { font: inherit; color: inherit; cursor: pointer; transition: transform 300ms var(--ease-settle), background-color 300ms var(--ease-settle); }
    button:active:not(:disabled), .button:active { transform: scale(0.98); transition-duration: 0s; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -4px -8px -4px 0; }
    .sheet-head h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.02em; }
    .close { width: 44px; height: 44px; flex: none; display: grid; place-items: center; padding: 0; border: none; background: none; }
    .close::before { content: "×"; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: var(--fill-secondary); color: var(--text-secondary); font-size: 20px; line-height: 1; }
    .preview { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-bottom: 16px; border-bottom: 1px solid var(--separator); }
    .preview-domain { font-size: 13px; color: var(--text-secondary); }
    .preview-title { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
    .preview-url { font-size: 13px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .section-label { margin: 0 0 8px; font-size: 13px; color: var(--text-secondary); }
    .segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; border-radius: 10px; background: var(--fill-tertiary); }
    .segments button { min-width: 0; min-height: 44px; padding: 4px; border: none; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 13px; line-height: 1.2; }
    .segments button span { display: block; font-size: 11px; color: var(--text-tertiary); }
    .segments button[aria-pressed="true"] { background: var(--fill-secondary); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.24); }
    .segments button:disabled { opacity: 0.4; cursor: not-allowed; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { min-height: 44px; padding: 0 16px; border-radius: 22px; border: 1px solid var(--separator); background: var(--fill-tertiary); color: var(--text-primary); font-size: 15px; }
    .chips button[aria-pressed="true"] { background: var(--text-primary); border-color: var(--text-primary); color: var(--bg-primary); }
    .palette { position: relative; }
    .palette input { width: 100%; min-height: 44px; padding: 12px 16px; border-radius: 10px; border: 1px solid transparent; background: var(--fill-tertiary); color: var(--text-primary); font: inherit; font-size: 17px; outline: none; }
    .palette input::placeholder { color: var(--text-tertiary); }
    .palette input:focus { border-color: var(--separator); background: var(--fill-secondary); }
    .suggestions { position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); display: flex; flex-direction: column; padding: 4px; border-radius: 12px; border: 1px solid var(--separator); background: var(--bg-elevated); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 2; }
    .suggestions[hidden] { display: none; }
    .suggestions button { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 0 12px; border: none; border-radius: 8px; background: transparent; font-size: 15px; text-align: left; }
    .suggestions button:hover, .suggestions button.active { background: var(--fill-tertiary); }
    .suggestions button span { color: var(--text-secondary); }
    .hint { margin: 8px 4px 0; font-size: 12px; color: var(--text-secondary); }
    .primary { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 50px; padding: 0 16px; border: none; border-radius: 12px; background: var(--accent); color: var(--on-accent); font-size: 17px; font-weight: 600; text-decoration: none; }
    .primary:disabled { opacity: 0.5; cursor: progress; }
    .status { min-height: 16px; margin: -16px 0 0; font-size: 13px; text-align: center; color: var(--text-secondary); }
    .status.error { color: var(--destructive); }
    .done { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 8px; text-align: center; }
    .done[hidden] { display: none; }
    .done-mark { width: 56px; height: 56px; color: var(--success); }
    .done-title { margin: 8px 0 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .done-text { margin: 0 0 16px; font-size: 15px; color: var(--text-secondary); }
    .secondary { display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; color: var(--text-secondary); font-size: 15px; text-decoration: none; }
    @media (prefers-reduced-motion: reduce) {
      button, .button { transition: none; }
      button:active:not(:disabled), .button:active { transform: none; }
    }
  </style>
</head>
<body>
  <main class="sheet" aria-labelledby="sheet-title">
    <div class="sheet-head">
      <h1 id="sheet-title">Save to Aether</h1>
      <button type="button" class="close" id="close" aria-label="Close"></button>
    </div>
    <div id="form-area" style="display: contents">
      <div class="preview">
        <span class="preview-domain" id="preview-domain"></span>
        <span class="preview-title" id="preview-title"></span>
        <span class="preview-url" id="preview-url"></span>
      </div>
      <div>
        <p class="section-label">Model</p>
        <div class="segments" id="tiers" role="group" aria-label="Model tier">
          <button type="button" data-tier="flash" aria-pressed="true">⚡ Gemini Flash<span>Free</span></button>
          <button type="button" data-tier="pro" aria-pressed="false">🧠 Gemini Pro<span>Sovereign</span></button>
          <button type="button" data-tier="claude" aria-pressed="false">🎭 Claude Sonnet<span id="claude-sub">Anthropic</span></button>
        </div>
      </div>
      <div>
        <p class="section-label">Action</p>
        <div class="chips" id="presets" role="group" aria-label="Action preset">
          <button type="button" data-preset="summarize" aria-pressed="false">📝 Summarize</button>
          <button type="button" data-preset="event" aria-pressed="false">📅 Event</button>
          <button type="button" data-preset="branch" aria-pressed="false">🌳 Branch</button>
          <button type="button" data-preset="task" aria-pressed="false">📌 Action Task</button>
        </div>
      </div>
      <div class="palette">
        <div class="suggestions" id="suggestions" role="listbox" hidden></div>
        <input id="command" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Link, note and commands" placeholder="Paste a link, add a note, or type / for commands">
        <p class="hint">Type <b>/</b> for commands: /pro, /claude, /summary, /event, /branch, /task. Other words are saved as a note.</p>
      </div>
      <button type="button" class="primary" id="ingest">Ingest to Aether</button>
      <p class="status" id="status" role="status"></p>
    </div>
    <div class="done" id="done" hidden>
      <svg class="done-mark" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" stroke-width="3"/><path d="M17 29l7.5 7.5L39 21" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2 class="done-title">Saved</h2>
      <p class="done-text" id="done-text">It's in your Aether inbox.</p>
      <a class="primary button" id="view-node" href="/">View Node</a>
      <a class="secondary button" href="/">Open Aether Portal</a>
    </div>
  </main>
  <script type="application/json" id="share-data">${escapeJson(data)}</script>
  <script>
    const data = JSON.parse(document.getElementById('share-data').textContent);
    const tiers = document.getElementById('tiers');
    const presets = document.getElementById('presets');
    const input = document.getElementById('command');
    const suggestions = document.getElementById('suggestions');
    const ingest = document.getElementById('ingest');
    const statusLine = document.getElementById('status');
    const state = { tier: 'flash', preset: null };

    const COMMANDS = [
      { name: '/flash', label: 'Gemini Flash', tier: 'flash' },
      { name: '/pro', label: 'Gemini Pro', tier: 'pro' },
      { name: '/claude', label: 'Claude Sonnet', tier: 'claude' },
      { name: '/sonnet', label: 'Claude Sonnet', tier: 'claude' },
      { name: '/summary', label: 'Summarize', preset: 'summarize' },
      { name: '/summarize', label: 'Summarize', preset: 'summarize' },
      { name: '/event', label: 'Event', preset: 'event' },
      { name: '/branch', label: 'Branch', preset: 'branch' },
      { name: '/task', label: 'Action Task', preset: 'task' }
    ];
    const findCommand = token => COMMANDS.find(command => command.name === token.toLowerCase());
    const isLink = token => token.toLowerCase().startsWith('http://') || token.toLowerCase().startsWith('https://');

    document.getElementById('preview-domain').textContent = data.domain || 'Note';
    document.getElementById('preview-title').textContent = data.title || data.domain || 'Untitled';
    document.getElementById('preview-url').textContent = data.url || 'No link shared';
    input.value = [data.url, data.note].filter(Boolean).join(' ');

    const claudeButton = tiers.querySelector('[data-tier="claude"]');
    if (!data.claudeAvailable) {
      claudeButton.disabled = true;
      claudeButton.title = 'Add an ANTHROPIC_API_KEY secret to enable Claude';
      document.getElementById('claude-sub').textContent = 'Not set up';
    }

    const render = () => {
      tiers.querySelectorAll('[data-tier]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tier === state.tier)));
      presets.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset)));
    };
    const setStatus = (text, isError) => {
      statusLine.textContent = text || '';
      statusLine.classList.toggle('error', Boolean(isError));
    };
    const setTier = tier => {
      if (tier === 'claude' && !data.claudeAvailable) {
        setStatus('Claude Sonnet is not set up yet.', true);
        return;
      }
      state.tier = tier;
      render();
    };

    tiers.addEventListener('click', event => {
      const button = event.target.closest('[data-tier]');
      if (button && !button.disabled) setTier(button.dataset.tier);
    });
    presets.addEventListener('click', event => {
      const button = event.target.closest('[data-preset]');
      if (!button) return;
      state.preset = state.preset === button.dataset.preset ? null : button.dataset.preset;
      render();
    });

    // Link, note and commands all live in one input; complete commands take effect as they are typed.
    const parseInput = () => {
      const tokens = input.value.split(' ').filter(Boolean);
      let url = '';
      const noteWords = [];
      tokens.forEach(token => {
        const command = findCommand(token);
        if (command) return;
        if (!url && isLink(token)) url = token;
        else noteWords.push(token);
      });
      return { url, note: noteWords.join(' ') };
    };
    const applyCommands = () => {
      input.value.split(' ').filter(Boolean).forEach(token => {
        const command = findCommand(token);
        if (!command) return;
        if (command.tier) setTier(command.tier);
        if (command.preset) state.preset = command.preset;
      });
      render();
    };

    let activeSuggestion = 0;
    const currentToken = () => {
      const words = input.value.split(' ');
      return words[words.length - 1] || '';
    };
    const renderSuggestions = () => {
      const token = currentToken().toLowerCase();
      const matches = token.startsWith('/') ? COMMANDS.filter(command => command.name.startsWith(token) && command.name !== token) : [];
      suggestions.hidden = !matches.length;
      activeSuggestion = Math.min(activeSuggestion, Math.max(matches.length - 1, 0));
      suggestions.replaceChildren(...matches.map((command, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.className = index === activeSuggestion ? 'active' : '';
        const name = document.createElement('b');
        name.textContent = command.name;
        const label = document.createElement('span');
        label.textContent = command.label;
        button.append(name, label);
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          completeCommand(command.name);
        });
        return button;
      }));
      return matches;
    };
    const completeCommand = name => {
      const words = input.value.split(' ');
      words[words.length - 1] = name;
      input.value = words.join(' ') + ' ';
      applyCommands();
      renderSuggestions();
      input.focus();
    };

    input.addEventListener('input', () => {
      activeSuggestion = 0;
      applyCommands();
      renderSuggestions();
    });
    input.addEventListener('keydown', event => {
      const matches = suggestions.hidden ? [] : renderSuggestions();
      if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        activeSuggestion = (activeSuggestion + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        renderSuggestions();
        return;
      }
      if (matches.length && (event.key === 'Tab' || event.key === 'Enter')) {
        event.preventDefault();
        completeCommand(matches[activeSuggestion].name);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    input.addEventListener('blur', () => { suggestions.hidden = true; });

    // /api/share answers with the new node's id; View Node deep-links to its card at /node/<id>.
    const finish = id => {
      document.getElementById('form-area').style.display = 'none';
      document.getElementById('done').hidden = false;
      const label = state.preset ? presets.querySelector('[data-preset="' + state.preset + '"]').textContent : '';
      document.getElementById('done-text').textContent = label ? label + ' will appear on the card shortly.' : "It's in your Aether inbox.";
      const viewNode = document.getElementById('view-node');
      if (id) viewNode.href = '/node/' + encodeURIComponent(id);
      viewNode.focus();
    };

    async function submit() {
      const parsed = parseInput();
      const url = parsed.url || data.url;
      if (!url && !parsed.note) {
        setStatus('Add a link or a note first.', true);
        input.focus();
        return;
      }
      ingest.disabled = true;
      ingest.textContent = 'Saving…';
      setStatus('');
      try {
        const res = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, title: url === data.url ? data.title : '', note: parsed.note, tier: state.tier, preset: state.preset })
        });
        if (res.status === 401) {
          window.location.href = '/?next=' + encodeURIComponent(window.location.pathname + window.location.search);
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('Saving failed: ' + res.status));
        finish(typeof body.id === 'string' ? body.id : '');
      } catch (err) {
        setStatus(err.message || 'Saving failed.', true);
        ingest.disabled = false;
        ingest.textContent = 'Ingest to Aether';
      }
    }

    ingest.addEventListener('click', submit);
    document.getElementById('close').addEventListener('click', () => {
      window.close();
      setTimeout(() => { window.location.href = '/'; }, 200);
    });
    // iOS Safari only applies :active while a touch listener exists; this makes presses show on touch-start.
    document.addEventListener('touchstart', () => {}, { passive: true });
    render();
  </script>
</body>
</html>`;
}
