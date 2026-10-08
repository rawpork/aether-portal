// The + Skill ingest form: templates, the fields, and how they compile to the engine's { source, name }.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENTS,
  CONTENT_MAX_CHARS,
  PRIORITIES,
  SOURCE_MAX_CHARS,
  TEMPLATES,
  composeSource,
  defaultsFor,
  isLinkContent,
  mountIngestForm,
  nameFromTitle,
  normalizeCategory,
  templateById,
  validateIngest,
} from '../../public/js/engine/ingest-form.js';

const form = (over = {}) => ({ ...defaultsFor('doc'), content: 'Always sign requests with HMAC.', ...over });

describe('templates', () => {
  it('has the five presets, in order', () => {
    expect(TEMPLATES.map((t) => t.label)).toEqual(['Code Snippet', 'System Log / Stack Trace', 'Task Directive', 'Plain Text / Document', 'Architecture Spec']);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(5);
  });

  it('gives each one its own defaults, placeholders and hint', () => {
    for (const t of TEMPLATES) {
      expect(t.category, t.id).toBeTruthy();
      expect(PRIORITIES.map((p) => p.value), t.id).toContain(t.priority);
      expect(AGENTS.map((a) => a.value), t.id).toContain(t.agent);
      expect(t.titlePlaceholder.length, t.id).toBeGreaterThan(3);
      expect(t.contentPlaceholder.length, t.id).toBeGreaterThan(10);
      expect(t.hint.length, t.id).toBeGreaterThan(10);
    }
    expect(defaultsFor('log')).toMatchObject({ template: 'log', category: 'incident', priority: 'high', content: '', title: '' });
    expect(defaultsFor('task')).toMatchObject({ category: 'task', agent: 'master-brain' });
    expect(defaultsFor('code')).toMatchObject({ category: 'code', priority: 'normal', agent: '' });
  });

  it('falls back to Plain Text / Document for an unknown template', () => {
    expect(templateById('nope').id).toBe('doc');
    expect(defaultsFor(undefined).template).toBe('doc');
  });
});

describe('helpers', () => {
  it('recognises a lone link', () => {
    expect(isLinkContent('https://github.com/owner/repo')).toBe(true);
    expect(isLinkContent('  http://example.com/docs?x=1  ')).toBe(true);
    expect(isLinkContent('see https://example.com for details')).toBe(false);
    expect(isLinkContent('https://a.test and https://b.test')).toBe(false);
    expect(isLinkContent('')).toBe(false);
  });

  it('turns a title into a name hint the engine accepts', () => {
    expect(nameFromTitle('Retry a fetch with backoff!')).toBe('retry-a-fetch-with-backoff');
    expect(nameFromTitle('  Élan: D1   migration  ')).toBe('elan-d1-migration');
    expect(nameFromTitle('')).toBe('');
    expect(nameFromTitle('!!!')).toBe('');
    expect(nameFromTitle('x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it('keeps a tag to one tidy line', () => {
    expect(normalizeCategory('  Cloud  Flare\nD1 ')).toBe('cloud flare d1');
    expect(normalizeCategory('infra/db_ops-1.2 <b>')).toBe('infra/db_ops-1.2 b');
    expect(normalizeCategory('x'.repeat(80)).length).toBe(40);
  });
});

describe('composeSource', () => {
  it('puts a short header above the content, which is left untouched', () => {
    const source = composeSource({ template: 'log', title: 'D1 migration fails', category: 'Incident', content: 'Error 7403\n  at line 3', agent: 'master-brain', priority: 'high' });
    const [header, content] = source.split('\n\n');
    expect(header.split('\n')).toEqual([
      'Title: D1 migration fails',
      'Type: System Log / Stack Trace',
      'Tag: incident',
      'Target agent: Elarion',
      'Priority: High',
      'Intended use: ' + templateById('log').guide,
    ]);
    expect(content).toBe('Error 7403\n  at line 3');
  });

  it('leaves out what was not given', () => {
    const source = composeSource(form());
    expect(source).toContain('Type: Plain Text / Document');
    expect(source).toContain('Tag: reference');
    expect(source).toContain('Priority: Normal');
    expect(source).not.toContain('Title:');
    expect(source).not.toContain('Target agent:');
    expect(source).not.toContain('Intended use:'); // the plain document template has no guide
    expect(source.endsWith('\n\nAlways sign requests with HMAC.')).toBe(true);
  });
});

describe('validateIngest', () => {
  it('needs content', () => {
    expect(validateIngest(form({ content: '   ' }))).toEqual({ ok: false, errors: { content: 'Add the content to learn from: paste text, or a link.' } });
  });

  it('sends pasted text as a header and the content, with the title as the name hint', () => {
    const result = validateIngest(form({ template: 'code', title: 'Retry a fetch with backoff', category: 'code', content: 'async function retry() {}' }));
    expect(result.ok).toBe(true);
    expect(result.payload.name).toBe('retry-a-fetch-with-backoff');
    expect(result.payload.isLink).toBe(false);
    expect(result.payload.source.startsWith('Title: Retry a fetch with backoff\nType: Code Snippet\n')).toBe(true);
    expect(result.payload.source.endsWith('\n\nasync function retry() {}')).toBe(true);
  });

  it('sends a link on its own, so the engine still fetches it; only the title travels as the name', () => {
    const result = validateIngest(form({ template: 'spec', title: 'Realtime hub', content: ' https://github.com/owner/repo ' }));
    expect(result).toEqual({ ok: true, payload: { source: 'https://github.com/owner/repo', name: 'realtime-hub', isLink: true } });
    expect(validateIngest(form({ content: 'https://example.com/docs' })).payload).toEqual({ source: 'https://example.com/docs', isLink: true });
  });

  it('omits the name when there is no usable title', () => {
    expect(validateIngest(form({ title: '' })).payload).not.toHaveProperty('name');
    expect(validateIngest(form({ title: '???' })).payload).not.toHaveProperty('name');
  });

  it('reports every field that is wrong', () => {
    const result = validateIngest(form({ title: 't'.repeat(81), category: 'c'.repeat(41), content: '', priority: 'whenever', agent: 'nobody' }));
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual(['agent', 'category', 'content', 'priority', 'title']);
  });

  it('refuses content over the limit, and a header that tips the total over the engine limit', () => {
    expect(validateIngest(form({ content: 'x'.repeat(CONTENT_MAX_CHARS + 1) })).errors.content).toContain('the limit is');
    const exact = validateIngest(form({ content: 'x'.repeat(CONTENT_MAX_CHARS) }));
    expect(exact.ok).toBe(true);
    expect(exact.payload.source.length).toBeLessThanOrEqual(SOURCE_MAX_CHARS);
  });
});

describe('the form', () => {
  let ui;
  afterEach(() => {
    document.body.replaceChildren();
    ui = null;
  });
  const mount = (opts) => {
    ui = mountIngestForm(document, opts);
    document.body.append(ui.element);
    return ui;
  };
  const choose = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('has the dedicated fields, each with a label', () => {
    mount();
    const labels = [...document.querySelectorAll('.dc-field > label')].map((l) => l.textContent);
    expect(labels).toEqual(['Template', 'Title / Subject', 'Category / Tag', 'Text or link', 'Target agent', 'Priority']);
    for (const label of document.querySelectorAll('.dc-field > label')) expect(document.getElementById(label.getAttribute('for')), label.textContent).not.toBeNull();
    expect([...ui.elements.select.options].map((o) => o.textContent)).toEqual(['Code Snippet', 'System Log / Stack Trace', 'Task Directive', 'Plain Text / Document', 'Architecture Spec']);
    expect(ui.elements.contentArea.tagName).toBe('TEXTAREA');
    expect(ui.elements.titleInput.type).toBe('text');
  });

  it('puts each dropdown in a .dc-select box, which draws its chevron; text fields are not boxed', () => {
    mount();
    const selects = [...document.querySelectorAll('.dc-ingest select')];
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select.parentElement.className, select.id).toBe('dc-select');
      expect(select.parentElement.children).toHaveLength(1);
    }
    for (const control of document.querySelectorAll('.dc-ingest input, .dc-ingest textarea')) expect(control.parentElement.className).not.toBe('dc-select');
    // The label still points at the select itself.
    for (const select of selects) expect(document.querySelector('label[for="' + select.id + '"]')).not.toBeNull();
  });

  it('starts on Plain Text / Document with its defaults', () => {
    mount();
    expect(ui.elements.select.value).toBe('doc');
    expect(ui.read()).toEqual({ template: 'doc', title: '', category: 'reference', content: '', agent: '', priority: 'normal' });
  });

  it('picking a template rewrites the placeholders, the labels and the defaults', () => {
    mount();
    choose(ui.elements.select, 'log');
    expect(ui.elements.titleInput.placeholder).toBe(templateById('log').titlePlaceholder);
    expect(ui.elements.contentArea.placeholder).toBe(templateById('log').contentPlaceholder);
    expect(document.querySelector('label[for="' + ui.elements.contentArea.id + '"]').textContent).toBe('Log or stack trace');
    expect(document.querySelector('.dc-hint').textContent).toBe(templateById('log').hint);
    expect(ui.read()).toMatchObject({ template: 'log', category: 'incident', priority: 'high' });
    choose(ui.elements.select, 'task');
    expect(ui.read()).toMatchObject({ template: 'task', category: 'task', priority: 'normal', agent: 'master-brain' });
    expect(document.querySelector('label[for="' + ui.elements.contentArea.id + '"]').textContent).toBe('Directive');
  });

  it('keeps what the operator typed when the template changes, and never touches the content or title', () => {
    mount();
    type(ui.elements.contentArea, 'my notes');
    type(ui.elements.titleInput, 'My title');
    type(ui.elements.categoryInput, 'mine');
    choose(ui.elements.prioritySelect, 'urgent');
    choose(ui.elements.select, 'spec');
    expect(ui.read()).toMatchObject({ template: 'spec', title: 'My title', content: 'my notes', category: 'mine', priority: 'urgent' });
    // The agent was not touched, so it still follows the template.
    choose(ui.elements.select, 'task');
    expect(ui.read().agent).toBe('master-brain');
  });

  it('says so when the content is a link', () => {
    mount();
    expect(ui.elements.linkNote.hidden).toBe(true);
    type(ui.elements.contentArea, 'https://github.com/owner/repo');
    expect(ui.elements.linkNote.hidden).toBe(false);
    type(ui.elements.contentArea, 'https://github.com/owner/repo and more');
    expect(ui.elements.linkNote.hidden).toBe(true);
  });

  it('validate() shows the problem, marks the field, focuses it and returns the failure', () => {
    mount();
    const result = ui.validate();
    expect(result.ok).toBe(false);
    expect(ui.elements.errorBox.hidden).toBe(false);
    expect(ui.elements.errorBox.getAttribute('role')).toBe('alert');
    expect(ui.elements.errorBox.textContent).toContain('Add the content');
    expect(ui.elements.contentArea.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(ui.elements.contentArea);
    // Typing clears it.
    type(ui.elements.contentArea, 'x');
    expect(ui.elements.errorBox.hidden).toBe(true);
    expect(ui.elements.contentArea.hasAttribute('aria-invalid')).toBe(false);
  });

  it('validate() on a good form returns the payload and shows nothing', () => {
    mount({ template: 'code' });
    type(ui.elements.titleInput, 'Retry helper');
    type(ui.elements.contentArea, 'const x = 1;');
    const result = ui.validate();
    expect(result.ok).toBe(true);
    expect(result.payload.name).toBe('retry-helper');
    expect(result.payload.source).toContain('Type: Code Snippet');
    expect(ui.elements.errorBox.hidden).toBe(true);
  });

  it('limits what can be typed to what the engine accepts', () => {
    mount();
    expect(ui.elements.titleInput.maxLength).toBe(80);
    expect(ui.elements.categoryInput.maxLength).toBe(40);
    expect(ui.elements.contentArea.maxLength).toBe(CONTENT_MAX_CHARS);
  });

  it('gives every form its own ids, so two can exist at once', () => {
    const a = mountIngestForm(document);
    const b = mountIngestForm(document);
    expect(a.elements.contentArea.id).not.toBe(b.elements.contentArea.id);
  });
});
