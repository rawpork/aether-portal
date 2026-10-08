// The Agent spec generator: the rules, the form, and the popup flow. It writes a spec and starts nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineApi } from '../../public/js/engine-api.bundle.js';
import { mountDecisionCenter } from '../../public/js/engine/decision-center.js';
import {
  INSTRUCTIONS_MAX_CHARS,
  PURPOSES,
  SPEC_SCHEMA,
  TEMPLATES,
  TIERS,
  buildAgentSpec,
  defaultsFor,
  mountAgentSpecForm,
  slugify,
  specFileName,
  specToJson,
  specToMarkdown,
  templateById,
  tierByValue,
  validateAgentSpec,
} from '../../public/js/engine/agent-spec.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const form = (over = {}) => ({ ...defaultsFor('researcher'), name: 'Market Researcher', ...over });

describe('the access levels', () => {
  it('are the engine\'s three role contracts', () => {
    expect(TIERS.map((t) => [t.value, t.allowedActions, t.maxSteps, t.mayProposeLessons])).toEqual([
      ['observer', [], 0, false],
      ['reviewer', ['echo', 'wait'], 10, true],
      ['collaborator', ['prompt', 'echo', 'wait'], 25, true],
    ]);
    expect(tierByValue('nope').value).toBe('collaborator');
  });
});

describe('templates', () => {
  it('start from the five roles Studio builds workflows from, plus a custom one', () => {
    expect(TEMPLATES.map((t) => t.label)).toEqual(['Researcher', 'Planner', 'Builder', 'Reviewer', 'Publisher', 'Custom agent']);
    for (const t of TEMPLATES.filter((x) => x.id !== 'custom')) {
      expect(t.role.length, t.id).toBeGreaterThan(5);
      expect(t.instructions.length, t.id).toBeGreaterThan(40);
      expect(t.instructions.length, t.id).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
      expect(PURPOSES.map((p) => p.value), t.id).toContain(t.purpose);
    }
    expect(defaultsFor('custom')).toMatchObject({ role: '', instructions: '', askBeforeOutward: true });
    expect(defaultsFor('planner').purpose).toBe('plan');
    expect(defaultsFor('builder').purpose).toBe('agent');
    expect(templateById('nope').id).toBe('custom');
  });

  it('start with the engine\'s own limit for the level, and the outward-step guardrail on', () => {
    const d = defaultsFor('publisher');
    expect(d.maxSteps).toBe(25);
    expect(d.askBeforeOutward).toBe(true);
    expect(d.instructions).toMatch(/the operator approves before anything goes out/);
  });
});

describe('validateAgentSpec', () => {
  it('accepts a complete form and tidies it', () => {
    const result = validateAgentSpec(form({ name: '  Market   Researcher ', role: ' Gathers  facts ', maxSteps: '12' }));
    expect(result.ok).toBe(true);
    expect(result.form).toMatchObject({ name: 'Market Researcher', role: 'Gathers facts', maxSteps: 12 });
  });

  it('needs a name, a role and instructions', () => {
    const result = validateAgentSpec(form({ name: '', role: '', instructions: '' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({ name: 'Give the agent a name.', role: 'Say in one line what the agent is for.', instructions: 'Say how the agent should work.' });
  });

  it('keeps names, roles and instructions to their limits, and the name usable as an id', () => {
    expect(validateAgentSpec(form({ name: 'x'.repeat(61) })).errors.name).toMatch(/60 characters/);
    expect(validateAgentSpec(form({ name: '???' })).errors.name).toMatch(/letters or numbers/);
    expect(validateAgentSpec(form({ role: 'r'.repeat(121) })).errors.role).toMatch(/120 characters/);
    expect(validateAgentSpec(form({ instructions: 'i'.repeat(INSTRUCTIONS_MAX_CHARS + 1) })).errors.instructions).toMatch(/2000 characters/);
    expect(validateAgentSpec(form({ instructions: 'i'.repeat(INSTRUCTIONS_MAX_CHARS) })).ok).toBe(true);
  });

  it('holds the step limit to the access level, as the engine does', () => {
    expect(validateAgentSpec(form({ tier: 'collaborator', maxSteps: '26' })).errors.maxSteps).toBe('Collaborator agents are limited to 25 steps.');
    expect(validateAgentSpec(form({ tier: 'reviewer', maxSteps: '11' })).errors.maxSteps).toBe('Reviewer agents are limited to 10 steps.');
    expect(validateAgentSpec(form({ tier: 'collaborator', maxSteps: '0' })).errors.maxSteps).toBe('Allow at least 1 step.');
    expect(validateAgentSpec(form({ maxSteps: '2.5' })).errors.maxSteps).toBe('Use a whole number of steps.');
    expect(validateAgentSpec(form({ maxSteps: 'many' })).errors.maxSteps).toBe('Use a whole number of steps.');
    expect(validateAgentSpec(form({ tier: 'reviewer', maxSteps: '10' })).ok).toBe(true);
  });

  it('lets an observer, which runs no steps, have no instructions and exactly 0 steps', () => {
    expect(validateAgentSpec(form({ tier: 'observer', maxSteps: '0', instructions: '' })).ok).toBe(true);
    expect(validateAgentSpec(form({ tier: 'observer', maxSteps: '3', instructions: '' })).errors.maxSteps).toBe('An observer runs no steps.');
  });

  it('rejects an access level or purpose that does not exist', () => {
    expect(validateAgentSpec(form({ tier: 'admin' })).errors.tier).toBeTruthy();
    expect(validateAgentSpec(form({ purpose: 'everything' })).errors.purpose).toBeTruthy();
  });
});

describe('the spec', () => {
  const spec = buildAgentSpec(validateAgentSpec(form({ maxSteps: '12', askBeforeOutward: true })).form, NOW);

  it('is a document with the schema, the role and what the agent may do, and says nothing is running', () => {
    expect(spec).toEqual({
      schema: SPEC_SCHEMA,
      name: 'Market Researcher',
      id: 'market-researcher',
      role: 'Gathers sources and facts',
      instructions: templateById('researcher').instructions,
      permissions: { access_level: 'collaborator', allowed_actions: ['prompt', 'echo', 'wait'], max_steps: 12, may_propose_lessons: true, ask_before_outward_steps: true },
      model_purpose: 'step',
      status: 'spec only: not running',
      created_at: '2026-10-08T12:00:00.000Z',
    });
  });

  it('records the guardrail the person chose', () => {
    expect(buildAgentSpec({ ...form(), askBeforeOutward: false }, NOW).permissions.ask_before_outward_steps).toBe(false);
  });

  it('renders as JSON and as a readable brief, and names its file', () => {
    expect(JSON.parse(specToJson(spec))).toEqual(spec);
    expect(specToJson(spec).endsWith('}\n')).toBe(true);
    expect(specFileName(spec)).toBe('agent-spec-market-researcher.json');
    const brief = specToMarkdown(spec);
    expect(brief).toContain('# Agent spec: Market Researcher');
    expect(brief).toContain('**Role:** Gathers sources and facts');
    expect(brief).toContain('- Access level: Collaborator');
    expect(brief).toContain('- Most steps in one run: 12');
    expect(brief).toContain('asks the operator first');
    expect(brief).toContain('A spec only: nothing is running.');
  });

  it('describes an observer as running no steps', () => {
    const observer = buildAgentSpec(validateAgentSpec(form({ tier: 'observer', maxSteps: '0', instructions: '' })).form, NOW);
    expect(specToMarkdown(observer)).toContain('(No instructions: this agent runs no steps.)');
    expect(specToMarkdown(observer)).toContain('- Allowed steps: none');
  });

  it('makes a safe id', () => {
    expect(slugify('  Ünïcode Agent #1! ')).toBe('unicode-agent-1');
    expect(slugify('???')).toBe('');
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe('the form', () => {
  let ui;
  afterEach(() => {
    document.body.replaceChildren();
    ui = null;
  });
  const mount = (opts) => {
    ui = mountAgentSpecForm(document, opts);
    document.body.append(ui.element);
    return ui;
  };
  const change = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('has the fields, each labelled, and the dropdowns boxed for their chevron', () => {
    mount();
    expect([...document.querySelectorAll('.dc-field > label')].map((l) => l.textContent)).toEqual(['Start from', 'Agent name', 'Role', 'Instructions', 'Access level', 'Most steps per run', 'Model calls are for']);
    for (const label of document.querySelectorAll('.dc-field > label')) expect(document.getElementById(label.getAttribute('for')), label.textContent).not.toBeNull();
    expect(document.querySelectorAll('.dc-select > select')).toHaveLength(3);
    expect(ui.elements.askBox.checked).toBe(true);
    expect(document.querySelector('label.dc-check').textContent).toMatch(/Ask me before any outward-facing or irreversible step/);
  });

  it('picking a template fills the role, instructions, level and purpose, and the name placeholder', () => {
    mount();
    change(ui.elements.templateSelect, 'planner');
    expect(ui.read()).toMatchObject({ template: 'planner', role: 'Breaks the goal into steps', purpose: 'plan', tier: 'collaborator', maxSteps: '25' });
    expect(ui.elements.instructions.value).toBe(templateById('planner').instructions);
    expect(ui.elements.nameInput.placeholder).toBe('e.g. Launch Planner');
    change(ui.elements.templateSelect, 'custom');
    expect(ui.read()).toMatchObject({ role: '', instructions: '' });
  });

  it('keeps what the person wrote when the template changes, and never touches the name', () => {
    mount();
    type(ui.elements.nameInput, 'My agent');
    type(ui.elements.roleInput, 'My own role');
    change(ui.elements.templateSelect, 'builder');
    expect(ui.read()).toMatchObject({ name: 'My agent', role: 'My own role' });
    // Untouched fields still follow the template.
    expect(ui.elements.instructions.value).toBe(templateById('builder').instructions);
    expect(ui.read().purpose).toBe('agent');
  });

  it('the access level sets the step limit, explains itself, and an observer gets 0 and a disabled field', () => {
    mount();
    change(ui.elements.tierSelect, 'reviewer');
    expect(ui.elements.maxSteps.max).toBe('10');
    expect(ui.elements.maxSteps.value).toBe('10');
    expect(ui.elements.tierHint.textContent).toMatch(/Allowed steps: echo, wait\. Up to 10 steps\./);
    change(ui.elements.tierSelect, 'observer');
    expect(ui.elements.maxSteps.disabled).toBe(true);
    expect(ui.elements.maxSteps.value).toBe('0');
    expect(ui.elements.tierHint.textContent).toMatch(/Allowed steps: none/);
    change(ui.elements.tierSelect, 'collaborator');
    expect(ui.elements.maxSteps.disabled).toBe(false);
    expect(ui.elements.maxSteps.value).toBe('25');
  });

  it('keeps a step limit the person set while it still fits the level', () => {
    mount();
    type(ui.elements.maxSteps, '7');
    change(ui.elements.purposeSelect, 'plan');
    expect(ui.elements.maxSteps.value).toBe('7');
  });

  it('explains the model purpose', () => {
    mount();
    change(ui.elements.purposeSelect, 'chat');
    expect(ui.elements.purposeHint.textContent).toMatch(/Talking with the operator/);
  });

  it('validate() marks the first problem, focuses it, and clears when typing', () => {
    mount();
    const result = ui.validate();
    expect(result.ok).toBe(false);
    expect(ui.elements.errorBox.textContent).toBe('Give the agent a name.');
    expect(ui.elements.errorBox.getAttribute('role')).toBe('alert');
    expect(ui.elements.nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(ui.elements.nameInput);
    type(ui.elements.nameInput, 'A');
    expect(ui.elements.errorBox.hidden).toBe(true);
  });

  it('puts earlier answers back after going back from the preview', () => {
    const first = mountAgentSpecForm(document);
    first.elements.nameInput.value = 'Release Bot';
    change(first.elements.templateSelect, 'publisher');
    change(first.elements.tierSelect, 'reviewer');
    first.elements.maxSteps.value = '4';
    first.elements.askBox.checked = false;
    const answers = validateAgentSpec(first.read()).form;
    const again = mountAgentSpecForm(document, { values: answers });
    expect(again.read()).toEqual({ template: 'publisher', name: 'Release Bot', role: answers.role, instructions: answers.instructions, tier: 'reviewer', maxSteps: '4', purpose: 'step', askBeforeOutward: false });
  });
});

describe('the Agent spec popup', () => {
  let center;
  let slot;
  afterEach(() => {
    center && center.destroy();
    document.body.replaceChildren();
    center = slot = null;
  });
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const mount = (extra = {}) => {
    slot = document.createElement('section');
    document.body.append(slot);
    const api = createEngineApi({ baseUrl: 'http://localhost:3333', fetch: async () => json({ tasks: [], counts: {} }) });
    center = mountDecisionCenter(document, { api, slot, pollMs: 1e9, storage: { getItem: () => null }, ...extra });
    return center;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const modal = () => document.querySelector('.dc-modal');
  const title = () => modal().querySelector('.dc-title').textContent;
  const option = (n) => document.querySelector('.dc-option[data-option="' + n + '"]');
  const field = (name) => modal().querySelector('[data-field="' + name + '"]');
  const fill = (name, value) => {
    field(name).value = value;
    field(name).dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('opens a form that says nothing starts, focused on the name', async () => {
    mount();
    const done = center.askAgentSpec();
    await settle();
    expect(title()).toBe('Agent spec');
    expect(modal().textContent).toMatch(/Nothing starts: an agent runs when a project that uses it is deployed/);
    expect(document.activeElement).toBe(field('name'));
    expect([...document.querySelectorAll('.dc-option-label')].map((n) => n.textContent)).toEqual(['Generate spec', 'Cancel']);
    expect(document.querySelector('.dc-option-hint').textContent).toBe('Starts nothing');
    option(2).click();
    expect(await done).toBeNull();
  });

  it('keeps the form open with the problem showing, and the answers kept, until it is valid', async () => {
    mount();
    const done = center.askAgentSpec();
    await settle();
    const scrim = modal().closest('.dc-scrim');
    fill('role', 'Does a thing');
    option(1).click();
    await settle();
    expect(modal().closest('.dc-scrim')).toBe(scrim);
    expect(title()).toBe('Agent spec');
    expect(modal().querySelector('.dc-ingest-error').textContent).toBe('Give the agent a name.');
    expect(field('role').value).toBe('Does a thing');
    option(2).click();
    expect(await done).toBeNull();
  });

  it('generates the spec, shows the brief, and copies it as a brief or as JSON without closing', async () => {
    const copied = [];
    mount({ copyText: async (text) => { copied.push(text); return true; } });
    const done = center.askAgentSpec();
    await settle();
    fill('name', 'Market Researcher');
    modal().querySelector('select[data-field="template"]').value = 'researcher';
    modal().querySelector('select[data-field="template"]').dispatchEvent(new Event('change', { bubbles: true }));
    option(1).click();
    await settle();
    expect(title()).toBe('Agent spec: Market Researcher');
    expect(modal().querySelector('.dc-preview').textContent).toContain('# Agent spec: Market Researcher');
    expect(modal().textContent).toMatch(/Nothing has been started/);
    expect([...document.querySelectorAll('.dc-option-label')].map((n) => n.textContent)).toEqual(['Copy as brief', 'Copy as JSON', 'Download JSON', 'Edit', 'Done']);

    option(1).click();
    await settle();
    expect(copied[0]).toContain('# Agent spec: Market Researcher');
    expect(modal().querySelector('.dc-spec-status').textContent).toBe('Copied the brief.');
    option(2).click();
    await settle();
    expect(JSON.parse(copied[1])).toMatchObject({ schema: SPEC_SCHEMA, name: 'Market Researcher', status: 'spec only: not running' });
    expect(modal().querySelector('.dc-spec-status').textContent).toBe('Copied the JSON.');
    expect(title()).toBe('Agent spec: Market Researcher'); // still open

    option(5).click();
    const spec = await done;
    expect(spec).toMatchObject({ name: 'Market Researcher', id: 'market-researcher', permissions: { access_level: 'collaborator', ask_before_outward_steps: true } });
  });

  it('says so when copying does not work, instead of failing silently', async () => {
    mount({ copyText: async () => false });
    const done = center.askAgentSpec();
    await settle();
    fill('name', 'Bot');
    fill('role', 'Does a thing');
    fill('instructions', 'Do the thing carefully.');
    option(1).click();
    await settle();
    option(1).click();
    await settle();
    expect(modal().querySelector('.dc-spec-status').textContent).toBe('Could not copy automatically. Select the text above and copy it.');
    option(5).click();
    await done;
  });

  it('downloads the JSON under a name made from the agent, and reports a failed download', async () => {
    const saved = [];
    mount({ saveFile: (name, text, type) => { saved.push({ name, text, type }); return true; } });
    let done = center.askAgentSpec();
    await settle();
    fill('name', 'Release Bot');
    fill('role', 'Ships things');
    fill('instructions', 'Prepare the release.');
    option(1).click();
    await settle();
    option(3).click();
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('agent-spec-release-bot.json');
    expect(saved[0].type).toBe('application/json');
    expect(JSON.parse(saved[0].text).name).toBe('Release Bot');
    expect(modal().querySelector('.dc-spec-status').textContent).toBe('Downloaded agent-spec-release-bot.json.');
    option(5).click();
    await done;

    center.destroy();
    mount({ saveFile: () => false });
    done = center.askAgentSpec();
    await settle();
    fill('name', 'Bot');
    fill('role', 'Does a thing');
    fill('instructions', 'Do it.');
    option(1).click();
    await settle();
    option(3).click();
    await settle();
    expect(modal().querySelector('.dc-spec-status').textContent).toBe('Could not start the download.');
    option(5).click();
    await done;
  });

  it('Edit goes back to the form with every answer kept, and the new answers produce a new spec', async () => {
    mount({ copyText: async () => true });
    const done = center.askAgentSpec();
    await settle();
    fill('name', 'Release Bot');
    fill('role', 'Ships things');
    fill('instructions', 'Prepare the release.');
    modal().querySelector('select[data-field="tier"]').value = 'reviewer';
    modal().querySelector('select[data-field="tier"]').dispatchEvent(new Event('change', { bubbles: true }));
    option(1).click();
    await settle();
    expect(title()).toBe('Agent spec: Release Bot');
    option(4).click();
    await settle();
    expect(title()).toBe('Agent spec');
    expect(field('name').value).toBe('Release Bot');
    expect(field('role').value).toBe('Ships things');
    expect(field('tier').value).toBe('reviewer');
    expect(field('maxSteps').value).toBe('10');
    fill('name', 'Release Bot 2');
    option(1).click();
    await settle();
    expect(title()).toBe('Agent spec: Release Bot 2');
    option(5).click();
    expect(await done).toMatchObject({ name: 'Release Bot 2', permissions: { access_level: 'reviewer', max_steps: 10 } });
  });

  it('the number keys work in the preview, and typing a number in a field does not pick an option', async () => {
    mount();
    const done = center.askAgentSpec();
    await settle();
    field('name').dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    field('maxSteps').dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    expect(title()).toBe('Agent spec');
    fill('name', 'Bot');
    fill('role', 'Does a thing');
    fill('instructions', 'Do it.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    await settle();
    expect(title()).toBe('Agent spec: Bot');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
    expect(await done).toMatchObject({ name: 'Bot' });
  });
});
