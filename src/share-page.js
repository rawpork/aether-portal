// The /share page opened by the PWA share sheet: a card for the shared link, one textarea for the note and
// commands, a row of quick-insert command chips, then one tap to save. The HTML is a template literal, so the
// client script below avoids backslashes and template placeholders; the shared values reach it as escaped JSON.

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
  <meta name="theme-color" content="#08090A">
  <link rel="manifest" href="/manifest.json">
  <style>
    /* Aether dark sheet: a flat #0E0F11 sheet, #1A1C1E surfaces, hairline borders, 6-8px radii, no accent colour
       and no shadows. Every control keeps a 44pt hit area and presses down to scale(0.98) on pointer-down. */
    :root {
      color-scheme: dark;
      --bg-page: #08090A;
      --bg-base: #0E0F11;
      --bg-surface: #1A1C1E;
      --hairline: 1px solid rgba(255, 255, 255, 0.08);
      --hairline-strong: rgba(255, 255, 255, 0.24);
      --text-primary: rgba(255, 255, 255, 0.9);
      --text-secondary: rgba(255, 255, 255, 0.5);
      --text-tertiary: rgba(255, 255, 255, 0.3);
      --danger: #E5484D;
      --radius-s: 6px;
      --radius-m: 8px;
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
      font-size: 15px;
      line-height: 1.4;
      color: var(--text-primary);
      background: var(--bg-page);
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
    }
    .sheet {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      border: var(--hairline);
      border-radius: var(--radius-m);
      background: var(--bg-base);
    }
    @media (max-width: 520px) {
      body { align-items: flex-end; padding: 0; }
      .sheet { max-width: none; border-width: 1px 0 0; border-radius: var(--radius-m) var(--radius-m) 0 0; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
    }
    button, .button { font: inherit; color: inherit; cursor: pointer; transition: transform 300ms var(--ease-settle), color 300ms var(--ease-settle); }
    button:active:not(:disabled), .button:active { transform: scale(0.98); transition-duration: 0s; }
    :focus-visible { outline: 1px solid rgba(255, 255, 255, 0.5); outline-offset: 2px; }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; margin: -8px -12px -8px 0; }
    .sheet-head h1 { margin: 0; font-size: 15px; font-weight: 600; }
    .close { width: 44px; height: 44px; flex: none; padding: 0; border: 0; background: none; color: var(--text-secondary); font-size: 20px; line-height: 1; }
    .link { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px 12px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-surface); }
    .link[hidden] { display: none; }
    .link-domain, .link-url { font-size: 12px; color: var(--text-secondary); }
    .link-title { font-size: 15px; overflow-wrap: anywhere; }
    .link-url { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .compose { position: relative; }
    .input { display: block; width: 100%; min-height: 72px; max-height: 40vh; padding: 0; border: 0; background: transparent; color: var(--text-primary); caret-color: #ffffff; font: inherit; font-size: 17px; line-height: 1.35; resize: none; outline: none; }
    .input::placeholder { color: var(--text-tertiary); }
    .suggestions { position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); display: flex; flex-direction: column; padding: 4px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-surface); z-index: 2; }
    .suggestions[hidden] { display: none; }
    .suggestions button { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; font-size: 15px; text-align: left; }
    .suggestions button:hover, .suggestions button.active { background: rgba(255, 255, 255, 0.06); }
    .suggestions button span { color: var(--text-secondary); font-size: 13px; }
    /* One row that scrolls sideways and runs to the sheet edges, with no visible scrollbar. Each chip is a 44px
       hit area; the visible 32px chip is drawn by ::before so the row stays compact. */
    .ribbon { display: flex; gap: 8px; margin: -8px -16px; padding: 0 16px; overflow-x: auto; overscroll-behavior-x: contain; scroll-behavior: smooth; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; }
    .ribbon::-webkit-scrollbar { display: none; }
    .ribbon button { position: relative; z-index: 0; flex: none; height: 44px; padding: 0 10px; border: 0; background: none; color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
    .ribbon button::before { content: ""; position: absolute; inset: 6px 0; z-index: -1; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-surface); }
    .ribbon button:active:not(:disabled), .ribbon button[aria-pressed="true"] { color: var(--text-primary); }
    .ribbon button[aria-pressed="true"]::before { border-color: var(--hairline-strong); }
    .ribbon button:disabled { opacity: 0.4; cursor: not-allowed; }
    .primary { display: flex; align-items: center; justify-content: center; width: 100%; height: 44px; padding: 0 16px; border: 0; border-radius: var(--radius-m); background: #ffffff; color: #000000; font-size: 15px; font-weight: 600; text-decoration: none; }
    .primary:disabled { opacity: 0.4; cursor: progress; }
    .status { min-height: 16px; margin: -8px 0 0; font-size: 13px; text-align: center; color: var(--text-secondary); }
    .status.error { color: var(--danger); }
    .done { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 8px; text-align: center; }
    .done[hidden] { display: none; }
    .done-mark { width: 40px; height: 40px; color: var(--text-primary); }
    .done-title { margin: 8px 0 0; font-size: 17px; font-weight: 600; }
    .done-text { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary); }
    .secondary { display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; color: var(--text-secondary); font-size: 13px; text-decoration: none; }
    @media (prefers-reduced-motion: reduce) {
      button, .button { transition: none; }
      button:active:not(:disabled), .button:active { transform: none; }
      .ribbon { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <main class="sheet" aria-labelledby="sheet-title">
    <div class="sheet-head">
      <h1 id="sheet-title">Save to Aether</h1>
      <button type="button" class="close" id="close" aria-label="Close">×</button>
    </div>
    <div id="form-area" style="display: contents">
      <div class="link" id="link">
        <span class="link-domain" id="link-domain"></span>
        <span class="link-title" id="link-title"></span>
        <span class="link-url" id="link-url"></span>
      </div>
      <div class="compose">
        <div class="suggestions" id="suggestions" role="listbox" hidden></div>
        <textarea class="input" id="input" rows="3" aria-label="Note and commands" placeholder="Add a note, or type / for commands"></textarea>
      </div>
      <div class="ribbon" id="ribbon" role="group" aria-label="Insert command">
        <button type="button" data-insert="/research">/research</button>
        <button type="button" data-insert="/learn">/learn</button>
        <button type="button" data-insert="/ask">/ask</button>
        <button type="button" data-insert="#task">#task</button>
        <button type="button" data-insert="#done">#done</button>
        <button type="button" data-insert="/summary">/summary</button>
        <button type="button" data-insert="/event">/event</button>
        <button type="button" data-insert="/pro">/pro</button>
        <button type="button" data-insert="/claude">/claude</button>
      </div>
      <button type="button" class="primary" id="ingest">Ingest</button>
      <p class="status" id="status" role="status"></p>
    </div>
    <div class="done" id="done" hidden>
      <svg class="done-mark" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 20.5l5 5L28 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2 class="done-title">Saved</h2>
      <p class="done-text" id="done-text">It's in your Aether inbox.</p>
      <a class="primary button" id="view-node" href="/">View Node</a>
      <a class="secondary button" href="/">Open Aether Portal</a>
    </div>
  </main>
  <script type="application/json" id="share-data">${escapeJson(data)}</script>
  <script>
    const data = JSON.parse(document.getElementById('share-data').textContent);
    const input = document.getElementById('input');
    const ribbon = document.getElementById('ribbon');
    const suggestions = document.getElementById('suggestions');
    const ingest = document.getElementById('ingest');
    const statusLine = document.getElementById('status');
    const NEWLINE = String.fromCharCode(10);
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
    const PRESET_RESULTS = { summarize: 'The summary', event: 'The event details', branch: 'Ideas to explore', task: 'The action task' };
    const findCommand = token => COMMANDS.find(command => command.name === token.toLowerCase());
    const isLink = token => token.toLowerCase().startsWith('http://') || token.toLowerCase().startsWith('https://');
    const lineTokens = line => line.split(' ').filter(Boolean);

    const setStatus = (text, isError) => {
      statusLine.textContent = text || '';
      statusLine.classList.toggle('error', Boolean(isError));
    };

    // One textarea holds the note, commands and an optional replacement link. Model and action follow the last
    // matching command in the text, so deleting a command undoes it.
    const parseInput = () => {
      let url = '';
      const lines = input.value.split(NEWLINE).map(line => lineTokens(line).filter(token => {
        if (findCommand(token)) return false;
        if (!url && isLink(token)) {
          url = token;
          return false;
        }
        return true;
      }).join(' '));
      return { url, note: lines.filter(Boolean).join(NEWLINE) };
    };
    const applyCommands = () => {
      state.tier = 'flash';
      state.preset = null;
      let claudeBlocked = false;
      input.value.split(NEWLINE).forEach(line => lineTokens(line).forEach(token => {
        const command = findCommand(token);
        if (!command) return;
        if (command.tier === 'claude' && !data.claudeAvailable) claudeBlocked = true;
        else if (command.tier) state.tier = command.tier;
        if (command.preset) state.preset = command.preset;
      }));
      setStatus(claudeBlocked ? 'Claude Sonnet is not set up yet, so this will use Gemini.' : '', claudeBlocked);
      ribbon.querySelectorAll('[data-insert]').forEach(button => {
        const command = findCommand(button.dataset.insert);
        const on = Boolean(command && ((command.tier && command.tier === state.tier && state.tier !== 'flash') || (command.preset && command.preset === state.preset)));
        button.setAttribute('aria-pressed', String(on));
      });
    };

    const renderLink = () => {
      const url = parseInput().url || data.url;
      let domain = '';
      try { domain = url ? new URL(url).hostname.replace(/^www[.]/, '') : ''; } catch (err) { domain = ''; }
      document.getElementById('link').hidden = !domain;
      document.getElementById('link-domain').textContent = domain;
      document.getElementById('link-title').textContent = (url === data.url && data.title) || domain;
      document.getElementById('link-url').textContent = url;
    };
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    };
    const refresh = () => {
      applyCommands();
      renderLink();
      grow();
    };

    const claudeChip = ribbon.querySelector('[data-insert="/claude"]');
    if (!data.claudeAvailable) {
      claudeChip.disabled = true;
      claudeChip.title = 'Add an ANTHROPIC_API_KEY secret to enable Claude';
    }

    // Suggestions complete the word just before the caret.
    let activeSuggestion = 0;
    const wordBeforeCaret = () => {
      const before = input.value.slice(0, input.selectionStart);
      const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf(NEWLINE)) + 1;
      return { start, word: before.slice(start) };
    };
    const renderSuggestions = () => {
      const token = wordBeforeCaret().word.toLowerCase();
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
      const { start } = wordBeforeCaret();
      const end = input.selectionStart;
      input.value = input.value.slice(0, start) + name + ' ' + input.value.slice(end);
      const caret = start + name.length + 1;
      input.setSelectionRange(caret, caret);
      refresh();
      renderSuggestions();
      input.focus();
    };

    // A chip appends its text, space-separated, and leaves the caret at the end.
    ribbon.addEventListener('click', event => {
      const button = event.target.closest('[data-insert]');
      if (!button || button.disabled) return;
      const current = input.value;
      const gap = current && current.trimEnd() === current ? ' ' : '';
      input.value = current + gap + button.dataset.insert + ' ';
      refresh();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });

    input.addEventListener('input', () => {
      activeSuggestion = 0;
      refresh();
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
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    input.addEventListener('blur', () => { suggestions.hidden = true; });

    // /api/share answers with the new node's id; View Node deep-links to its card at /node/<id>.
    const finish = id => {
      document.getElementById('form-area').style.display = 'none';
      document.getElementById('done').hidden = false;
      const result = state.preset ? PRESET_RESULTS[state.preset] : '';
      document.getElementById('done-text').textContent = result ? result + ' will appear on the card shortly.' : "It's in your Aether inbox.";
      const viewNode = document.getElementById('view-node');
      if (id) viewNode.href = '/node/' + encodeURIComponent(id);
      viewNode.focus();
    };

    async function submit() {
      applyCommands();
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
        ingest.textContent = 'Ingest';
      }
    }

    ingest.addEventListener('click', submit);
    document.getElementById('close').addEventListener('click', () => {
      window.close();
      setTimeout(() => { window.location.href = '/'; }, 200);
    });
    // iOS Safari only applies :active while a touch listener exists; this makes presses show on touch-start.
    document.addEventListener('touchstart', () => {}, { passive: true });
    input.value = data.note;
    refresh();
  </script>
</body>
</html>`;
}
