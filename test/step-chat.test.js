import { describe, expect, it } from 'vitest';
import { humanTitle, looksLikeRawId, stepMapSteps, stepPrompt } from '../public/js/engine/step-chat.js';

describe('step-chat helpers', () => {
  it('never shows a raw id as a title', () => {
    expect(looksLikeRawId('Wf_2aa95528')).toBe(true);
    expect(looksLikeRawId('Bp_Ba7a9a2a_1791182033292')).toBe(true);
    expect(humanTitle({ project: 'Bp_Ba7a9a2a_1', goal: 'Local AI Business Audit - City Barber Shop' })).toBe('Local AI Business Audit - City Barber Shop');
    expect(humanTitle({ project: 'City Barber Shop site' })).toBe('City Barber Shop site');
    expect(humanTitle({ project: 'wf_abc123' }, 'Workflow')).toBe('Workflow');
  });
  it('builds the step map with pending steps', () => {
    const steps = stepMapSteps({ status: 'RUNNING', total_steps: 3, results: [{ step_id: 'plan' }, { step_id: 'phase-1' }] }, (id) => id);
    expect(steps.map((s) => s.state)).toEqual(['done', 'running', 'todo']);
  });
  it('prefills with the step number', () => {
    expect(stepPrompt(3, 'Build page', 'Use the local skill.')).toBe('@step(3) Build page: Use the local skill.');
  });
});
