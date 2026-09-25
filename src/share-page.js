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
  <meta name="theme-color" content="#09090b">
  <link rel="manifest" href="/manifest.json">
  <style>
    :root { color-scheme: dark; --accent: #00ffcc; --text: #fafafa; --muted: #a1a1aa; --faint: #71717a; --line: rgba(255,255,255,0.1); }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      color: var(--text);
      background: radial-gradient(circle at 20% 10%, rgba(0,255,204,0.16), transparent 45%), radial-gradient(circle at 85% 90%, rgba(99,102,241,0.18), transparent 50%), #09090b;
      -webkit-font-smoothing: antialiased;
    }
    /* backdrop-blur-2xl bg-zinc-900/90 border border-white/10 rounded-3xl */
    .sheet {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 20px;
      border-radius: 24px;
      border: 1px solid var(--line);
      background: rgba(24, 24, 27, 0.9);
      backdrop-filter: blur(40px) saturate(1.4);
      -webkit-backdrop-filter: blur(40px) saturate(1.4);
      box-shadow: 0 30px 80px rgba(0,0,0,0.55);
    }
    @media (max-width: 520px) {
      body { align-items: flex-end; padding: 0; }
      .sheet { max-width: none; border-radius: 24px 24px 0 0; border-bottom: none; padding-bottom: max(20px, env(safe-area-inset-bottom)); }
    }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; }
    .sheet-head h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
    .close { width: 30px; height: 30px; border-radius: 50%; border: none; background: rgba(255,255,255,0.08); color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; }
    .preview { display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--line); min-width: 0; }
    .preview-domain { font-size: 12px; color: var(--accent); font-weight: 600; letter-spacing: 0.02em; }
    .preview-title { font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
    .preview-url { font-size: 12px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .section-label { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
    .segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; border-radius: 14px; background: rgba(255,255,255,0.06); }
    .segments button { min-width: 0; padding: 8px 4px; border: none; border-radius: 10px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; line-height: 1.25; cursor: pointer; }
    .segments button span { display: block; font-size: 10px; color: var(--faint); }
    .segments button[aria-pressed="true"] { background: rgba(255,255,255,0.14); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
    .segments button:disabled { opacity: 0.35; cursor: not-allowed; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.04); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .chips button[aria-pressed="true"] { border-color: var(--accent); background: rgba(0,255,204,0.14); }
    .palette { position: relative; }
    .palette input { width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: rgba(0,0,0,0.35); color: var(--text); font: inherit; font-size: 14px; outline: none; }
    .palette input:focus { border-color: rgba(0,255,204,0.6); }
    .suggestions { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); display: flex; flex-direction: column; padding: 6px; border-radius: 14px; border: 1px solid var(--line); background: rgba(24,24,27,0.98); box-shadow: 0 12px 30px rgba(0,0,0,0.5); z-index: 2; }
    .suggestions[hidden] { display: none; }
    .suggestions button { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border: none; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .suggestions button:hover, .suggestions button.active { background: rgba(255,255,255,0.08); }
    .suggestions button span { color: var(--faint); }
    .hint { margin: 6px 2px 0; font-size: 11px; color: var(--faint); }
    .ingest { width: 100%; padding: 14px; border: none; border-radius: 16px; background: var(--accent); color: #04221c; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
    .ingest:disabled { opacity: 0.6; cursor: progress; }
    .status { min-height: 1.2em; margin: -6px 0 0; font-size: 12px; text-align: center; color: var(--muted); }
    .status.error { color: #fb7185; }
    .done { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0 6px; text-align: center; }
    .done[hidden] { display: none; }
    .done-mark { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,255,204,0.16); color: var(--accent); font-size: 26px; }
    .done a { color: var(--accent); font-size: 14px; }
  </style>
</head>
<body>
  <main class="sheet" aria-labelledby="sheet-title">
    <div class="sheet-head">
      <h1 id="sheet-title">Save to Aether</h1>
      <button type="button" class="close" id="close" aria-label="Close">×</button>
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
      <button type="button" class="ingest" id="ingest">Ingest to Aether</button>
      <p class="status" id="status" role="status"></p>
    </div>
    <div class="done" id="done" hidden>
      <div class="done-mark">✓</div>
      <div id="done-text">Saved to your Aether inbox.</div>
      <a href="/">Open Aether Portal</a>
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

    const finish = () => {
      document.getElementById('form-area').style.display = 'none';
      document.getElementById('done').hidden = false;
      const label = state.preset ? presets.querySelector('[data-preset="' + state.preset + '"]').textContent : '';
      document.getElementById('done-text').textContent = label ? 'Saved. ' + label + ' will appear on the card shortly.' : 'Saved to your Aether inbox.';
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
        ingest.textContent = '✓ Saved';
        // Share-sheet windows can close themselves; anywhere else the confirmation stays up.
        window.close();
        setTimeout(finish, 350);
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
    render();
  </script>
</body>
</html>`;
}
