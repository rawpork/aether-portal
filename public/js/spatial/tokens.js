// Main portal design tokens (DESIGN.md, System 2), read from the page's CSS custom properties so CSS stays the
// single source of truth. Every token has a fallback, so a missing variable never hands WebGL an empty colour.

export const TOKEN_DEFAULTS = {
  bgPage: '#080c14',
  bgPanel: '#0b1320',
  text: '#dffdf7',
  textMuted: '#8a93a6',
  accent: '#00ffcc',
  accentLine: 'rgba(0,255,204,0.55)',
  accentSoft: 'rgba(0,255,204,0.14)'
};

const TOKEN_VARIABLES = {
  bgPage: '--bg-page',
  bgPanel: '--bg-panel',
  text: '--text',
  textMuted: '--text-muted',
  accent: '--accent',
  accentLine: '--accent-line',
  accentSoft: '--accent-soft'
};

// Alpha of the 1px hairline borders; CSS stores it inside a border shorthand, so it is not read back.
export const HAIRLINE_ALPHA = 0.08;

// getVariable(name) returns a custom property's raw value, e.g. from getComputedStyle(...).getPropertyValue.
export function readTokens(getVariable) {
  const tokens = { hairlineAlpha: HAIRLINE_ALPHA };
  for (const [key, name] of Object.entries(TOKEN_VARIABLES)) {
    let value = '';
    try {
      value = String(getVariable(name) || '').trim();
    } catch {
      value = '';
    }
    tokens[key] = value || TOKEN_DEFAULTS[key];
  }
  return tokens;
}

export function readDocumentTokens(root = document.documentElement) {
  const style = getComputedStyle(root);
  return readTokens(name => style.getPropertyValue(name));
}
