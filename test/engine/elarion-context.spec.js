import { expect, it } from 'vitest';
import { projectContext, studioContext } from '../../public/js/engine/elarion-context.js';

const WORKFLOW = {
	title: 'Competitor research',
	goal: 'Research rivals and report back',
	nodes: [
		{ id: 't1', kind: 'trigger', label: 'Manual start', role: 'Run from the Studio console' },
		{ id: 'a1', kind: 'agent', label: 'Researcher', role: 'Gathers sources', instructions: 'Gather the facts   and sources.' },
		{ id: 'a2', kind: 'agent', label: 'Marketing', role: 'Writes the report' },
	],
	cables: [{ id: 'c1', from: 't1', to: 'a1', kind: 'start' }, { id: 'c2', from: 'a1', to: 'a2', kind: 'a2a' }],
};

it('tells Elarion what is on the Studio canvas: the workflow, its nodes by name, the wiring, the last run and the selected node', () => {
	const context = studioContext({ workflow: WORKFLOW, selected: { type: 'node', id: 'a1' }, run: { status: 'COMPLETED', node_status: { a1: 'done' } }, editable: true });
	expect(context.page).toBe('Studio');
	expect(context.workflow.title).toBe('Competitor research');
	expect(context.workflow.node_count).toBe(3);
	expect(context.workflow.nodes.map((n) => n.name)).toEqual(['Manual start', 'Researcher', 'Marketing']);
	expect(context.workflow.nodes[1]).toMatchObject({ kind: 'agent', last_run: 'done', instructions: 'Gather the facts and sources.' });
	expect(context.workflow.cables).toEqual([{ from: 'Manual start', to: 'Researcher', kind: 'start' }, { from: 'Researcher', to: 'Marketing', kind: 'a2a' }]);
	expect(context.selected).toMatchObject({ node: 'Researcher', kind: 'agent' });
	expect(context.run.status).toBe('COMPLETED');
});

it('names a selected cable by the two nodes it joins, and says plainly when no workflow is open', () => {
	expect(studioContext({ workflow: WORKFLOW, selected: { type: 'cable', id: 'c2' } }).selected).toEqual({ cable: 'Researcher to Marketing', kind: 'a2a' });
	expect(studioContext({ workflow: WORKFLOW, selected: null }).selected).toBe(null);
	expect(studioContext({ workflow: null })).toMatchObject({ page: 'Studio', workflow: null });
	expect(studioContext(null).note).toMatch(/No workflow/);
});

it('keeps the context small however big the workflow is', () => {
	const nodes = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, kind: 'agent', label: 'Agent ' + i, instructions: 'x'.repeat(1000) }));
	const context = studioContext({ workflow: { title: 't', goal: 'g', nodes, cables: [] } });
	expect(context.workflow.nodes).toHaveLength(40);
	expect(context.workflow.node_count).toBe(200);
	expect(JSON.stringify(context).length).toBeLessThan(12000);
});

it('the open project carries where it stands, so Elarion can say what is next', () => {
	const lifecycle = { stage: 'test', steps: [{ label: 'Plan', state: 'done', detail: 'ok' }, { label: 'Test', state: 'current', detail: 'Not tested yet.' }], next: { question: 'Run a test now?' } };
	const context = projectContext({ project_name: 'Bakery', blueprint_id: 'bp_1', execution_phases: [{ phase_index: 1, phase_name: 'Research', agent_role: 'Researcher', prompt_template: 'Find rivals.' }] }, 'Projects', lifecycle);
	expect(context.where_it_stands).toEqual({ stage: 'test', steps: ['Plan: done', 'Test: current (Not tested yet.)'], next_step: 'Run a test now?' });
	expect(context.phases[0]).toEqual({ name: 'Research', agent: 'Researcher', what: 'Find rivals.' });
});

it('a project is described by its phases and who does each', () => {
	const context = projectContext({ project_name: 'Bakery', blueprint_id: 'bp_1', status: 'APPROVED_FOR_EXECUTION', execution_phases: [{ phase_name: 'Research', agent_persona: 'Researcher', description: 'Read the market' }] });
	expect(context).toEqual({ page: 'Projects', project: 'Bakery', blueprint_id: 'bp_1', status: 'APPROVED_FOR_EXECUTION', phases: [{ name: 'Research', agent: 'Researcher', what: 'Read the market' }] });
	expect(projectContext(null)).toEqual({ page: 'Projects' });
});
