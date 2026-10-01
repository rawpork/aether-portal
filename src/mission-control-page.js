// /mission-control: the one place the portal talks to the local Aether_Engine. The emergency breaker sits in the
// top-right corner, the agent task loop monitor fills the main column, and the Elaron chat and voice dock sits beside
// it; a Blueprints tab holds blueprint ingestion and the artifact dashboard. All behaviour lives in
// public/js/engine/mission-control.js; this template is markup and styles only, so it carries no inline script (and,
// being a template literal, avoids backslashes). The user's tier and the optional upgrade URL reach the script as
// meta tags.

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMissionControlPage({ assetVersion = 'dev', tier = 'free', upgradeUrl = '' } = {}) {
	const v = encodeURIComponent(assetVersion);
	const safeUpgradeUrl = /^https:[/][/]/i.test(upgradeUrl) ? upgradeUrl : '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mission Control - Aether Portal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#080c14">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <meta name="aether-tier" content="${escapeAttr(tier)}">
  <meta name="aether-upgrade-url" content="${escapeAttr(safeUpgradeUrl)}">
  <style>
    /* DESIGN.md, System 2 (teal accent hybrid): navy surfaces, teal accent, hairline borders, 6-8px corners, no glow.
       Red is reserved for the circuit breaker. */
    :root {
      --bg-page: #080c14;
      --bg-panel: #0b1320;
      --bg-raised: rgba(255,255,255,0.04);
      --hairline: 1px solid rgba(255,255,255,0.08);
      --text: #dffdf7;
      --text-muted: #8a93a6;
      --accent: #00ffcc;
      --accent-line: rgba(0,255,204,0.55);
      --accent-soft: rgba(0,255,204,0.14);
      --on-accent: #041016;
      --danger: #ff4d6d;
      --ok: #2ee59d;
      --warn: #ffb627;
      --radius-s: 6px;
      --radius-m: 8px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; background: var(--bg-page); color: var(--text); font-family: system-ui, -apple-system, sans-serif; font-size: 14px; }
    button { font: inherit; }
    a { color: inherit; }

    /* Header: tabs on the left, the breaker in the top-right corner. */
    .mc-top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 16px; border-bottom: var(--hairline); background: var(--bg-panel); }
    .mc-tabs { display: flex; gap: 4px; }
    .mc-tabs a { display: inline-flex; align-items: center; height: 34px; padding: 0 12px; border: 1px solid transparent; border-radius: var(--radius-s); color: var(--text-muted); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .mc-tabs a:hover, .mc-tabs a:focus-visible { color: var(--text); border-color: rgba(255,255,255,0.12); outline: none; }
    .mc-tabs a[aria-current="page"] { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
    .mc-spacer { flex: 1; }

    /* Breaker (public/js/engine/breaker-bar.js). HALTED pulses its fill, static under reduced motion. */
    .mc-breaker { display: flex; flex: none; align-items: center; gap: 6px; }
    .engine-badge { appearance: none; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: var(--hairline); border-radius: 17px; background: var(--bg-raised); color: var(--text-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; cursor: pointer; }
    .engine-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
    .engine-badge[data-state="ACTIVE"] { color: var(--ok); border-color: rgba(46,229,157,0.5); background: rgba(46,229,157,0.1); }
    .engine-badge[data-state="HALTED"] { color: #fff; border-color: var(--danger); background: rgba(255,77,109,0.35); animation: engine-pulse 1.1s ease-in-out infinite; }
    .engine-badge[data-state="AUTH"], .engine-badge[data-state="ERROR"] { color: var(--warn); border-color: rgba(255,182,39,0.5); }
    @keyframes engine-pulse { 0%, 100% { background-color: rgba(255,77,109,0.35); } 50% { background-color: rgba(255,77,109,0.85); } }
    .bar-btn { appearance: none; display: inline-flex; align-items: center; height: 34px; padding: 0 14px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--text); font-size: 12px; white-space: nowrap; cursor: pointer; }
    .engine-trip, .engine-trip-confirm { border-color: var(--danger); background: #d7263d; color: #fff; font-weight: 800; letter-spacing: 0.04em; }
    .engine-trip:hover:not(:disabled), .engine-trip:focus-visible { background: #ef3350; outline: none; }
    .engine-trip:disabled { opacity: 0.4; cursor: default; }
    .engine-trip-short { display: none; }
    .engine-reset { border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 800; letter-spacing: 0.04em; }
    .engine-reset:disabled { opacity: 0.5; cursor: progress; }

    /* Dialogs */
    .modal-backdrop { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.55); }
    .modal-backdrop[hidden] { display: none; }
    .modal-panel { width: min(420px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 18px; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-panel); }
    .modal-panel h3 { margin: 0 0 4px; font-size: 16px; color: var(--accent); }
    .engine-danger-title { color: #ff6b81 !important; }
    .engine-modal-text { margin: 0; font-size: 13px; line-height: 1.45; color: rgba(223,253,247,0.8); overflow-wrap: anywhere; }
    .modal-error { margin: 0; min-height: 1em; font-size: 12px; color: #ff6b81; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .toggle-button { appearance: none; height: 34px; padding: 0 14px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--text); cursor: pointer; }

    /* Workspace */
    .mc-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 420px); gap: 16px; height: calc(100% - 57px); padding: 16px; }
    .mc-panel { min-height: 0; display: flex; flex-direction: column; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-panel); }
    .mc-monitor { overflow-y: auto; }
    .mc-panel-head { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 6px; }
    .mc-panel-head h1, .mc-panel-head h2 { margin: 0; font-size: 15px; color: var(--accent); }
    .mc-muted { color: var(--text-muted); font-size: 12px; }
    .mc-section { padding: 6px 16px 14px; }
    .mc-section h2 { margin: 8px 0; font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }

    /* Task monitor (public/js/engine/task-monitor.js) */
    .mc-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; padding: 6px 16px 10px; }
    .mc-stat { padding: 10px 12px; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-raised); }
    .mc-stat-value { display: block; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .mc-stat-label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .mc-stat[data-kind="running"] .mc-stat-value { color: var(--accent); }
    .mc-stat[data-kind="completed"] .mc-stat-value { color: var(--ok); }
    .mc-stat[data-kind="halted"] .mc-stat-value, .mc-stat[data-kind="failed"] .mc-stat-value { color: #ff8095; }
    .mc-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .mc-empty { padding: 18px; border: 1px dashed rgba(255,255,255,0.12); border-radius: var(--radius-m); color: var(--text-muted); font-size: 13px; text-align: center; }
    .mc-task { border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-raised); }
    .mc-task[data-status="RUNNING"] { border-color: var(--accent-line); }
    .mc-task[data-status="HALTED"], .mc-task[data-status="FAILED"] { border-color: rgba(255,77,109,0.45); }
    .mc-task-head { appearance: none; width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; padding: 10px 12px; border: none; background: none; color: inherit; text-align: left; cursor: pointer; }
    .mc-task-head:focus-visible { outline: 1px solid var(--accent-line); outline-offset: -1px; border-radius: var(--radius-m); }
    .mc-task-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .mc-task-agent { color: var(--text-muted); font-weight: 400; }
    .mc-task-time { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
    .mc-task-line { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text-muted); font-size: 12px; }
    .mc-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 10px; font-size: 10px; font-weight: 800; letter-spacing: 0.05em; background: rgba(255,255,255,0.08); color: var(--text-muted); }
    .mc-chip[data-status="RUNNING"] { background: var(--accent-soft); color: var(--accent); }
    .mc-chip[data-status="COMPLETED"], .mc-chip[data-status="APPROVED_FOR_EXECUTION"] { background: rgba(46,229,157,0.14); color: var(--ok); }
    .mc-chip[data-status="HALTED"], .mc-chip[data-status="FAILED"] { background: rgba(255,77,109,0.18); color: #ff8095; }
    .mc-chip[data-status="EXECUTING"] { background: var(--accent-soft); color: var(--accent); }
    .mc-progress { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
    .mc-progress-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.3s; }
    .mc-task[data-status="COMPLETED"] .mc-progress-fill { background: var(--ok); }
    .mc-task[data-status="HALTED"] .mc-progress-fill, .mc-task[data-status="FAILED"] .mc-progress-fill { background: var(--danger); }
    .mc-steps { margin: 0; padding: 0 12px 12px 12px; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .mc-step { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; color: var(--text-muted); }
    .mc-step-mark { text-align: center; }
    .mc-step[data-state="done"] .mc-step-mark { color: var(--ok); }
    .mc-step[data-state="running"] { color: var(--text); }
    .mc-step[data-state="running"] .mc-step-mark { color: var(--accent); }
    .mc-step[data-state="halted"] .mc-step-mark, .mc-step[data-state="failed"] .mc-step-mark { color: #ff8095; }
    .mc-step-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-project { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 10px 12px; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-raised); }
    .mc-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .mc-project-meta { grid-column: 1 / -1; color: var(--text-muted); font-size: 12px; }

    /* Engine connection (public/js/engine/connection.js) */
    .mc-connection { margin: auto 16px 16px; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-raised); }
    .mc-connection summary { padding: 10px 12px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
    .mc-connection-body { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; font-size: 12px; }
    .mc-connection-body p { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
    .mc-connection textarea { width: 100%; padding: 8px 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-page); color: var(--text); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16px; word-break: break-all; resize: vertical; }
    .mc-connection-actions { display: flex; flex-wrap: wrap; gap: 6px; }

    /* Elaron dock (public/js/engine/brain-dock.js), embedded in the right column. */
    .brain-dock { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .brain-head { display: flex; align-items: center; gap: 10px; padding: 12px; border-bottom: var(--hairline); }
    .brain-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .brain-title h2 { margin: 0; font-size: 15px; color: var(--accent); }
    .brain-status { font-size: 12px; color: var(--text-muted); }
    .elaron[data-mode="halted"] ~ .brain-title .brain-status { color: #ff6b81; }
    .brain-icon-btn { appearance: none; flex: none; min-width: 36px; height: 36px; padding: 0 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--text); font-size: 13px; cursor: pointer; }
    .brain-icon-btn:disabled, .brain-send:disabled { opacity: 0.45; cursor: default; }
    .brain-mic[aria-pressed="true"] { border-color: var(--danger); background: rgba(255,77,109,0.2); }
    .brain-log { flex: 1; min-height: 0; margin: 0; padding: 12px; list-style: none; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .brain-empty { margin: auto 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; text-align: center; }
    .brain-msg { max-width: 88%; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: var(--radius-m); font-size: 14px; line-height: 1.45; }
    .brain-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .brain-meta { font-size: 11px; color: var(--text-muted); }
    .brain-user { align-self: flex-end; border: 1px solid var(--accent-line); background: var(--accent-soft); }
    .brain-assistant { align-self: flex-start; border: var(--hairline); background: var(--bg-raised); }
    .brain-system { align-self: center; max-width: 100%; padding: 2px 8px; color: var(--text-muted); font-size: 12px; text-align: center; }
    .brain-error { align-self: stretch; max-width: 100%; border-left: 3px solid var(--danger); background: rgba(255,77,109,0.08); color: #ffb3c1; font-size: 13px; }
    .brain-interim { margin: 0 12px 6px; color: var(--text-muted); font-size: 13px; font-style: italic; }
    .brain-interim[hidden] { display: none; }
    .brain-form { display: flex; align-items: flex-end; gap: 6px; padding: 10px 12px 4px; border-top: var(--hairline); }
    .brain-input { flex: 1; min-width: 0; max-height: 140px; padding: 8px 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-raised); color: var(--text); font: inherit; font-size: 16px; resize: none; }
    .brain-input:focus { outline: none; border-color: var(--accent-line); }
    .brain-send { appearance: none; height: 36px; padding: 0 14px; border: 1px solid var(--accent); border-radius: var(--radius-s); background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 700; cursor: pointer; }
    .brain-hint { min-height: 1em; margin: 0; padding: 4px 12px 10px; color: var(--text-muted); font-size: 11px; }
    .elaron { position: relative; flex: none; width: 40px; height: 40px; }
    .elaron-core, .elaron-ring { position: absolute; border-radius: 50%; }
    .elaron-core { inset: 9px; background: radial-gradient(circle at 35% 30%, #b8fff1, #00d4a8 55%, #0b4a52); }
    .elaron-ring { inset: 2px; border: 2px solid var(--accent-line); opacity: 0.4; }
    .elaron[data-mode="connecting"] .elaron-ring { border-style: dashed; opacity: 0.8; animation: elaron-spin 2.4s linear infinite; }
    .elaron[data-mode="listening"] .elaron-ring { border-color: var(--accent); animation: elaron-listen 1.2s ease-out infinite; }
    .elaron[data-mode="thinking"] .elaron-ring { border-color: transparent; border-top-color: var(--accent); opacity: 1; animation: elaron-spin 0.9s linear infinite; }
    .elaron[data-mode="speaking"] .elaron-core { animation: elaron-speak 0.5s ease-in-out infinite alternate; }
    .elaron[data-mode="speaking"] .elaron-ring { opacity: 0.8; }
    .elaron[data-mode="halted"] .elaron-core { background: radial-gradient(circle at 35% 30%, #ffc2cc, #ff4d6d 55%, #5a1020); }
    .elaron[data-mode="halted"] .elaron-ring { border-color: var(--danger); opacity: 0.9; }
    .elaron[data-mode="offline"] .elaron-core { background: radial-gradient(circle at 35% 30%, #d0d5df, #6b7385 55%, #262b36); }
    .elaron[data-mode="offline"] .elaron-ring { border-color: rgba(255,255,255,0.2); }
    @keyframes elaron-spin { to { transform: rotate(360deg); } }
    @keyframes elaron-listen { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.18); opacity: 0; } }
    @keyframes elaron-speak { from { transform: scale(0.9); } to { transform: scale(1.06); } }

    /* Workspace tabs (main column) */
    .mc-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .mc-tabbar { display: flex; align-items: center; gap: 4px; padding: 10px 12px 0; border-bottom: var(--hairline); }
    .mc-tabbar [role="tab"] { appearance: none; height: 36px; padding: 0 14px; border: 1px solid transparent; border-bottom: none; border-radius: var(--radius-s) var(--radius-s) 0 0; background: none; color: var(--text-muted); font-weight: 600; cursor: pointer; }
    .mc-tabbar [role="tab"][aria-selected="true"] { color: var(--accent); border-color: rgba(255,255,255,0.08); background: var(--bg-raised); }
    .mc-tabbar [role="tab"]:focus-visible { outline: 1px solid var(--accent-line); outline-offset: -1px; }
    .mc-tabbar .mc-muted { margin-left: auto; padding-bottom: 8px; }
    .mc-view { padding-top: 8px; }
    .mc-view[hidden] { display: none; }

    /* Blueprints (public/js/engine/blueprints.js) */
    .bp-card { margin: 8px 16px 16px; padding: 14px; border: var(--hairline); border-radius: var(--radius-m); background: var(--bg-raised); display: flex; flex-direction: column; gap: 10px; }
    .bp-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .bp-card-head h2 { margin: 0; font-size: 14px; color: var(--accent); }
    .bp-tier { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: rgba(255,255,255,0.08); color: var(--text-muted); }
    .bp-tier[data-tier="pro"] { background: rgba(255,182,39,0.16); color: var(--warn); }
    .bp-editor { width: 100%; min-height: 180px; padding: 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-page); color: var(--text); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; resize: vertical; }
    .bp-editor:focus { outline: none; border-color: var(--accent-line); }
    .bp-editor[aria-invalid="true"] { border-color: rgba(255,77,109,0.6); }
    .bp-editor.bp-drop { border-style: dashed; border-color: var(--accent); }
    .bp-actions, .bp-deploy-row, .bp-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .bp-primary { appearance: none; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border: 1px solid var(--accent); border-radius: var(--radius-s); background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; }
    .bp-primary:disabled { opacity: 0.5; cursor: progress; }
    .bp-pro-badge { padding: 1px 6px; border-radius: 4px; background: var(--warn); color: #241600; font-size: 10px; font-weight: 800; letter-spacing: 0.06em; }
    .bp-result { margin: 0; padding: 10px 12px; border-radius: var(--radius-s); border-left: 3px solid var(--accent); background: var(--accent-soft); font-size: 13px; }
    .bp-result[data-kind="error"] { border-left-color: var(--danger); background: rgba(255,77,109,0.08); color: #ffb3c1; }
    .bp-result[data-kind="note"] { border-left-color: rgba(255,255,255,0.2); background: var(--bg-raised); }
    .bp-result-title { margin: 0; font-weight: 600; }
    .bp-issues { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
    .bp-issues li[data-level="warning"] { color: var(--warn); }
    .bp-issues li[data-level="note"] { color: var(--text-muted); }
    .bp-issues code { font-family: ui-monospace, Menlo, Consolas, monospace; }
    .bp-browser { display: grid; grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); gap: 12px; align-items: start; }
    .bp-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 70vh; overflow-y: auto; }
    .bp-list-item { appearance: none; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 8px 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-page); color: var(--text); text-align: left; cursor: pointer; }
    .bp-list-item[aria-current="true"] { border-color: var(--accent-line); background: var(--accent-soft); }
    .bp-list-item:focus-visible { outline: 1px solid var(--accent-line); }
    .bp-list-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .bp-list-meta { grid-column: 1 / -1; color: var(--text-muted); font-size: 11px; }
    .bp-viewer { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .bp-viewer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .bp-viewer-head h3 { margin: 0; font-size: 16px; }
    .bp-viewer-head p { margin: 2px 0 0; overflow-wrap: anywhere; }
    .bp-viewer h4 { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .bp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .bp-fact { padding: 8px 10px; border: var(--hairline); border-radius: var(--radius-s); background: var(--bg-page); }
    .bp-fact-value { display: block; font-weight: 700; overflow-wrap: anywhere; }
    .bp-fact-label { color: var(--text-muted); font-size: 11px; }
    .bp-confirm { padding: 10px 12px; border: 1px solid var(--accent-line); border-radius: var(--radius-s); font-size: 13px; }
    .bp-confirm[hidden] { display: none; }
    .bp-deploy-status { margin: 0; }
    .bp-table-wrap { overflow-x: auto; }
    .bp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .bp-table caption { text-align: left; color: var(--text-muted); font-size: 11px; padding-bottom: 4px; }
    .bp-table th, .bp-table td { padding: 6px 8px; border-bottom: var(--hairline); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .bp-table th { color: var(--text-muted); font-weight: 600; }
    .bp-table a { color: var(--accent); }
    .bp-warning { margin: 0; color: var(--warn); font-size: 12px; }
    .bp-raw summary { cursor: pointer; color: var(--text-muted); font-size: 12px; }
    .bp-raw pre { max-height: 320px; overflow: auto; margin: 6px 0 0; padding: 10px; border-radius: var(--radius-s); background: var(--bg-page); font-size: 11px; }
    .mc-project.mc-project-link { appearance: none; width: 100%; color: inherit; text-align: left; cursor: pointer; }
    .mc-project.mc-project-link:hover, .mc-project.mc-project-link:focus-visible { border-color: var(--accent-line); outline: none; }

    @media (prefers-reduced-motion: reduce) {
      .engine-badge[data-state="HALTED"] { animation: none; background: rgba(255,77,109,0.7); }
      .elaron-ring, .elaron-core { animation: none !important; }
      .elaron[data-mode="listening"] .elaron-ring, .elaron[data-mode="thinking"] .elaron-ring { opacity: 1; border-color: var(--accent); }
      .mc-progress-fill { transition: none; }
    }
    /* Narrow screens: one column (breaker stays in the header), the dock below the monitor. */
    @media (max-width: 900px) {
      .mc-grid { grid-template-columns: minmax(0, 1fr); height: auto; }
      .mc-elaron { height: 75vh; }
      .mc-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .bp-browser { grid-template-columns: minmax(0, 1fr); }
      .bp-list { max-height: 240px; }
    }
    @media (max-width: 600px) {
      .mc-top { padding: 8px 10px; gap: 8px; }
      .mc-tabs a { padding: 0 8px; }
      .engine-badge:not([data-state="HALTED"]) .engine-badge-label { display: none; }
      .engine-trip-long { display: none; }
      .engine-trip-short { display: inline; }
      .mc-grid { padding: 10px; gap: 10px; }
      .mc-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header class="mc-top">
    <nav class="mc-tabs" aria-label="Aether">
      <a href="/">Portal</a>
      <a href="/mission-control" aria-current="page">Mission Control</a>
    </nav>
    <span class="mc-spacer"></span>
    <div id="mc-breaker" class="mc-breaker" role="group" aria-label="Emergency circuit breaker"></div>
  </header>
  <main class="mc-grid">
    <section class="mc-panel mc-monitor" aria-label="Workspace">
      <h1 class="mc-visually-hidden">Mission Control</h1>
      <div class="mc-tabbar" role="tablist" aria-label="Workspace">
        <button type="button" role="tab" id="mc-tab-monitor" aria-controls="mc-view-monitor" aria-selected="true">Task Loop Monitor</button>
        <button type="button" role="tab" id="mc-tab-blueprints" aria-controls="mc-view-blueprints" aria-selected="false" tabindex="-1">Blueprints</button>
        <span id="mc-monitor-status" class="mc-muted" aria-live="polite"></span>
      </div>
      <div class="mc-view" id="mc-view-monitor" role="tabpanel" aria-labelledby="mc-tab-monitor"><div id="mc-monitor"></div></div>
      <div class="mc-view" id="mc-view-blueprints" role="tabpanel" aria-labelledby="mc-tab-blueprints" hidden><div id="mc-blueprints"></div></div>
      <details id="mc-connection" class="mc-connection"></details>
    </section>
    <section class="mc-panel mc-elaron" id="mc-elaron" aria-label="Elaron chat and voice"></section>
  </main>
  <noscript><p class="mc-section">Mission Control needs JavaScript.</p></noscript>
  <script type="module" src="/js/engine/mission-control.js?v=${v}"></script>
</body>
</html>`;
}
