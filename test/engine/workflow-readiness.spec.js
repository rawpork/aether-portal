import { describe, expect, it } from 'vitest';
import { issuesFor, workflowReadiness } from '../../public/js/engine/workflow-readiness.js';

const node = (id, kind, label, extra = {}) => ({ id, kind, label, ...extra });
const cable = (id, from, to, kind) => ({ id, from, from_port: 'out', to, to_port: 'in', kind });

const connectors = [
  { id: 'telegram', name: 'Telegram', status: 'ready', status_detail: 'Ready.', actions: [{ id: 'send_message', outward: true, fields: [{ id: 'text', label: 'Message', required: true }] }] },
  { id: 'gmail', name: 'Gmail', status: 'coming_soon', status_detail: 'Needs your Google connection.', actions: [{ id: 'send_email', outward: true, fields: [] }] },
];
const mcp = [{ name: 'notion', status: 'missing_keys', missing_env: ['NOTION_TOKEN'] }, { name: 'slack', status: 'ready', missing_env: [] }];

describe('workflow readiness', () => {
  const base = () => ({
    nodes: [node('t', 'trigger', 'Start'), node('a', 'agent', 'Writer'), node('g', 'human', 'Approve'), node('b', 'agent', 'Sender'), node('x', 'action', 'Publish plan to Notion'), node('n', 'mcp', 'notion', { server: 'notion' })],
    cables: [cable('c1', 't', 'a', 'start'), cable('c2', 'a', 'g', 'action'), cable('c3', 'g', 'b', 'start'), cable('c4', 'b', 'x', 'action'), cable('c5', 'a', 'n', 'mcp_read')],
  });

  it('says an unbound action only proposes, and a tool without its key is not ready', () => {
    const issues = workflowReadiness(base(), connectors, mcp);
    expect(issuesFor(issues, 'x')[0].problem).toMatch(/only be proposed/);
    expect(issuesFor(issues, 'n')[0].problem).toContain('NOTION_TOKEN');
    expect(issuesFor(issues, 'a')).toHaveLength(0);
  });

  it('checks the connector state, required fields and that an outward action sits behind an approval', () => {
    const wf = base();
    wf.nodes.find((n) => n.id === 'x').connector = 'telegram';
    wf.nodes.find((n) => n.id === 'x').action = 'send_message';
    expect(issuesFor(workflowReadiness(wf, connectors, mcp), 'x').map((i) => i.problem)).toEqual(['Fill in: Message.']);
    wf.nodes.find((n) => n.id === 'x').params = { text: 'Done' };
    expect(issuesFor(workflowReadiness(wf, connectors, mcp), 'x')).toHaveLength(0);
    wf.cables = wf.cables.filter((c) => c.id !== 'c3').concat(cable('c6', 'a', 'b', 'a2a'));
    expect(issuesFor(workflowReadiness(wf, connectors, mcp), 'x')[0].problem).toMatch(/nothing asks you first/);
    wf.nodes.find((n) => n.id === 'x').connector = 'gmail';
    wf.nodes.find((n) => n.id === 'x').action = 'send_email';
    expect(issuesFor(workflowReadiness(wf, connectors, mcp), 'x')[0].problem).toContain('Gmail is not ready');
  });

  it('has nothing to say about a workflow with no loose ends', () => {
    expect(workflowReadiness({ nodes: [node('t', 'trigger', 'Start'), node('a', 'agent', 'Writer')], cables: [cable('c1', 't', 'a', 'start')] }, connectors, mcp)).toEqual([]);
    expect(workflowReadiness(null)).toEqual([]);
  });
});
