import type { Story } from '@ladle/react';

import type { DebugContext, DebugMessage } from '../api/types';
import { DebugContextDialog } from './DebugContextDialog';

const noop = () => undefined;

const sampleMessages: DebugMessage[] = [
  {
    kind: 'request',
    parts: [
      { part_kind: 'system-prompt', content: 'You are a coding agent working in a git repository.' },
      { part_kind: 'user-prompt', content: 'Fix the failing auth tests.' },
    ],
  },
  {
    kind: 'response',
    parts: [
      { part_kind: 'thinking', content: 'The tests reference a renamed fixture, so I should update the import.' },
      { part_kind: 'text', content: "I'll update the fixture import and re-run the suite." },
      { part_kind: 'tool-call', tool_name: 'run_shell', args: { command: 'pytest tests/test_auth.py' }, tool_call_id: 'tc1' },
    ],
  },
  {
    kind: 'request',
    parts: [{ part_kind: 'tool-return', tool_name: 'run_shell', content: '3 passed in 0.42s', tool_call_id: 'tc1' }],
  },
];

export const Populated: Story = () => (
  <DebugContextDialog
    agentId="a1"
    sessionId="main"
    agentName="triage-issues"
    sessionLabel="Main"
    loadDebugContext={(): Promise<DebugContext> => Promise.resolve(sampleMessages)}
    onClose={noop}
  />
);

export const NoSnapshotYet: Story = () => (
  <DebugContextDialog
    agentId="a1"
    sessionId="main"
    agentName="triage-issues"
    sessionLabel="Main"
    loadDebugContext={(): Promise<DebugContext> => Promise.resolve(null)}
    onClose={noop}
  />
);

export const LoadFailed: Story = () => (
  <DebugContextDialog
    agentId="a1"
    sessionId="main"
    agentName="triage-issues"
    sessionLabel="Main"
    loadDebugContext={(): Promise<DebugContext> => Promise.reject(new Error('agent process is not running'))}
    onClose={noop}
  />
);
