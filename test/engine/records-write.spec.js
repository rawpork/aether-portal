import { expect, it, vi } from 'vitest';
import { blueprintRecord, saveBlueprintRecord } from '../../public/js/engine/records-write.js';

const BP = { project_name: 'Bakery waitlist', execution_phases: [{ phase_name: 'Research', description: 'Read the market', agent_persona: 'Researcher' }, { phase_name: 'Build', agent_persona: 'Developer' }] };

it('describes a blueprint as a searchable record', () => {
	expect(blueprintRecord('bp_1', BP)).toEqual({ id: 'bp_1', type: 'blueprint', title: 'Bakery waitlist', summary: 'Research: Read the market. Build', project_id: 'bp_1', tags: ['blueprint', 'Researcher', 'Developer'] });
});

it('adds how it was launched to the tags', () => {
	expect(blueprintRecord('bp_1', BP, { tags: ['ingest', 'template', 'roadmap'] }).tags).toEqual(['blueprint', 'ingest', 'template', 'roadmap', 'Researcher', 'Developer']);
});

it('posts it to /api/records, and never throws when the portal is unreachable', async () => {
	const portalFetch = vi.fn(async () => new Response('{}', { status: 201 }));
	expect(await saveBlueprintRecord(portalFetch, 'bp_1', BP)).toBe(true);
	expect(portalFetch.mock.calls[0][0]).toBe('/api/records');
	expect(JSON.parse(portalFetch.mock.calls[0][1].body).type).toBe('blueprint');
	expect(await saveBlueprintRecord(async () => { throw new Error('offline'); }, 'bp_1', BP)).toBe(false);
	expect(await saveBlueprintRecord(null, 'bp_1', BP)).toBe(false);
});
