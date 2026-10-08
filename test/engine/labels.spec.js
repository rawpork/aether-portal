// Human-readable labels for statuses, ids, agents and tasks (public/js/engine/labels.js).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentName, createCopyIdButton, groupConsecutive, humanize, projectTitle, repeatsText, statusLabel, taskTitle } from '../../public/js/engine/labels.js';

describe('humanize', () => {
  it('turns machine names into sentence-case words', () => {
    expect(humanize('site-launch')).toBe('Site launch');
    expect(humanize('PENDING_REVIEW')).toBe('Pending review');
    expect(humanize('dev_task')).toBe('Dev task');
    expect(humanize('')).toBe('');
    expect(humanize(null)).toBe('');
  });
});

describe('statusLabel', () => {
  it('names the known statuses in plain words', () => {
    expect(statusLabel('APPROVED_FOR_EXECUTION')).toBe('Approved');
    expect(statusLabel('COMPLETED')).toBe('Completed');
    expect(statusLabel('HALTED')).toBe('Stopped');
    expect(statusLabel('RUNNING')).toBe('Running');
  });

  it('still reads as words for a status it has never seen', () => {
    expect(statusLabel('AWAITING_SIGN_OFF')).toBe('Awaiting sign off');
  });
});

describe('agent, project and task names', () => {
  it('names Elarion, and humanizes other agents', () => {
    expect(agentName('master-brain')).toBe('Elarion');
    expect(agentName('atlas')).toBe('Atlas');
    expect(agentName('site-builder')).toBe('Site builder');
  });

  it('falls back to a plain project title instead of the id', () => {
    expect(projectTitle({ project_name: 'Aether Knowledge Sync', blueprint_id: 'bp_1' })).toBe('Aether Knowledge Sync');
    expect(projectTitle({ blueprint_id: 'bp_ce68fdcc_1791183633914' })).toBe('Untitled project');
  });

  it('titles a deploy task by its project when known, and never shows the blueprint id', () => {
    const names = { bp_ce68fdcc_1791183633914: 'Micro SaaS' };
    expect(taskTitle('deploy-bp_ce68fdcc_1791183633914', (id) => names[id] || '')).toBe('Deploy: Micro SaaS');
    expect(taskTitle('deploy-bp_ce68fdcc_1791183633914')).toBe('Deploy project');
    expect(taskTitle('site-launch')).toBe('Site launch');
  });
});

describe('copy id button', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hides the id, copies it on click and says Copied for a moment', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const button = createCopyIdButton(document, 'bp_ce68fdcc_1791183633914');
    document.body.append(button);
    expect(button.textContent).toBe('Copy id');
    expect(document.body.textContent).not.toContain('bp_ce68fdcc');
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('bp_ce68fdcc_1791183633914');
    expect(button.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1700);
    expect(button.textContent).toBe('Copy id');
  });

  it('shows the id for selecting by hand when the clipboard is not allowed', async () => {
    vi.useFakeTimers();
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
    const button = createCopyIdButton(document, 'bp_x');
    document.body.append(button);
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe('bp_x');
  });
});

describe('groupConsecutive', () => {
  it('folds a run of identical neighbours under the first, in order', () => {
    const items = [{ n: 'a' }, { n: 'a' }, { n: 'a' }, { n: 'b' }, { n: 'a' }];
    const groups = groupConsecutive(items, (i) => i.n);
    expect(groups.map((g) => [g.key, g.rest.length])).toEqual([['a', 2], ['b', 0], ['a', 0]]);
    expect(groups[0].lead).toBe(items[0]);
    expect(groups[0].rest).toEqual([items[1], items[2]]);
  });

  it('keeps a list with no repeats as it is, and handles an empty one', () => {
    expect(groupConsecutive([{ n: 1 }, { n: 2 }], (i) => i.n).every((g) => g.rest.length === 0)).toBe(true);
    expect(groupConsecutive([], (i) => i)).toEqual([]);
  });

  it('words the fold in the singular and the plural', () => {
    expect(repeatsText(1, 'run')).toBe('1 earlier run with the same name');
    expect(repeatsText(4, 'version')).toBe('4 earlier versions with the same name');
  });
});
