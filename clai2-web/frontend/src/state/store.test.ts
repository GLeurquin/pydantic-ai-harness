import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentSummary, ApprovalView, RedactedProfile, ServerEvent, ToolCallView, TranscriptItem } from '../api/types';
import { reduceEvent, useAppStore, type AppState } from './store';

function agent(id: string, name = id): AgentSummary {
  return {
    id,
    name,
    projectId: 'project-1',
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
  };
}

function profile(id: string, label = id): RedactedProfile {
  return {
    id,
    label,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
  };
}

function toolCall(toolCallId: string, title = 'run'): ToolCallView {
  return { toolCallId, title, kind: 'execute', status: 'pending', content: [], locations: [] };
}

function approval(id: string, agentId = 'a1'): ApprovalView {
  return {
    id,
    agentId,
    sessionId: 'main',
    toolCall: toolCall(`tc-${id}`),
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };
}

function resetStore(partial: Partial<AppState> = {}): void {
  useAppStore.setState({
    connected: false,
    agents: [],
    approvals: [],
    models: [],
    projects: [],
    selectedProjectId: 'all',
    transcripts: {},
    selectedAgentId: null,
    view: { kind: 'session', sessionId: 'main' },
    ...partial,
  });
}

function state(): AppState {
  return useAppStore.getState();
}

beforeEach(() => {
  resetStore();
});

describe('reduceEvent', () => {
  it('agentAdded appends a new agent', () => {
    resetStore({ agents: [agent('a1')] });
    expect(reduceEvent(state(), { type: 'agentAdded', agent: agent('a2') })).toEqual({
      agents: [agent('a1'), agent('a2')],
    });
  });

  it('agentAdded with an existing id replaces that agent in place', () => {
    resetStore({ agents: [agent('a1', 'old'), agent('a2')] });
    expect(reduceEvent(state(), { type: 'agentAdded', agent: agent('a1', 'new') })).toEqual({
      agents: [agent('a1', 'new'), agent('a2')],
    });
  });

  it('agentUpdated replaces the agent with the same id', () => {
    resetStore({ agents: [agent('a1'), agent('a2', 'before')] });
    const updated = { ...agent('a2', 'after'), status: 'working' as const };
    expect(reduceEvent(state(), { type: 'agentUpdated', agent: updated })).toEqual({
      agents: [agent('a1'), updated],
    });
  });

  it('agentUpdated for an unknown id appends the agent', () => {
    resetStore({ agents: [agent('a1')] });
    expect(reduceEvent(state(), { type: 'agentUpdated', agent: agent('a3') })).toEqual({
      agents: [agent('a1'), agent('a3')],
    });
  });

  it('agentRemoved filters the agent and clears a matching selection', () => {
    resetStore({ agents: [agent('a1'), agent('a2')], selectedAgentId: 'a1' });
    expect(reduceEvent(state(), { type: 'agentRemoved', agentId: 'a1' })).toEqual({
      agents: [agent('a2')],
      selectedAgentId: null,
    });
  });

  it('agentRemoved keeps a selection pointing at another agent', () => {
    resetStore({ agents: [agent('a1'), agent('a2')], selectedAgentId: 'a2' });
    expect(reduceEvent(state(), { type: 'agentRemoved', agentId: 'a1' })).toEqual({
      agents: [agent('a2')],
      selectedAgentId: 'a2',
    });
  });

  const project1 = { id: 'p1', name: 'clai', repoRoot: '/repo' };
  const project2 = { id: 'p2', name: 'other', repoRoot: '/other' };

  it('projectAdded appends a new project', () => {
    resetStore({ projects: [project1] });
    expect(reduceEvent(state(), { type: 'projectAdded', project: project2 })).toEqual({
      projects: [project1, project2],
    });
  });

  it('projectAdded with an existing id replaces that project in place', () => {
    resetStore({ projects: [project1] });
    const renamed = { ...project1, name: 'renamed' };
    expect(reduceEvent(state(), { type: 'projectAdded', project: renamed })).toEqual({ projects: [renamed] });
  });

  it('projectRemoved filters the project and clears a matching selection', () => {
    resetStore({ projects: [project1, project2], selectedProjectId: 'p1' });
    expect(reduceEvent(state(), { type: 'projectRemoved', projectId: 'p1' })).toEqual({
      projects: [project2],
      selectedProjectId: 'all',
    });
  });

  it('projectRemoved keeps a selection pointing at another project', () => {
    resetStore({ projects: [project1, project2], selectedProjectId: 'p2' });
    expect(reduceEvent(state(), { type: 'projectRemoved', projectId: 'p1' })).toEqual({
      projects: [project2],
      selectedProjectId: 'p2',
    });
  });

  const transcriptCases: ReadonlyArray<[string, ServerEvent, TranscriptItem]> = [
    ['userMessage', { type: 'userMessage', agentId: 'a1', sessionId: 's1', text: 'hi' }, { type: 'userMessage', text: 'hi' }],
    ['messageChunk', { type: 'messageChunk', agentId: 'a1', sessionId: 's1', text: 'chunk' }, { type: 'messageChunk', text: 'chunk' }],
    ['thoughtChunk', { type: 'thoughtChunk', agentId: 'a1', sessionId: 's1', text: 'hm' }, { type: 'thoughtChunk', text: 'hm' }],
    ['toolCall', { type: 'toolCall', agentId: 'a1', sessionId: 's1', toolCall: toolCall('tc1') }, { type: 'toolCall', toolCall: toolCall('tc1') }],
    [
      'plan',
      { type: 'plan', agentId: 'a1', sessionId: 's1', entries: [{ content: 'c', priority: 'p', status: 's' }] },
      { type: 'plan', entries: [{ content: 'c', priority: 'p', status: 's' }] },
    ],
    ['turnEnded', { type: 'turnEnded', agentId: 'a1', sessionId: 's1', stopReason: 'end_turn' }, { type: 'turnEnded', stopReason: 'end_turn' }],
  ];

  it.each(transcriptCases)('%s appends its item under agentId/sessionId', (_name, event, item) => {
    resetStore({ transcripts: { 'a1/s1': [{ type: 'userMessage', text: 'earlier' }] } });
    expect(reduceEvent(state(), event)).toEqual({
      transcripts: { 'a1/s1': [{ type: 'userMessage', text: 'earlier' }, item] },
    });
  });

  it('transcript events start a new transcript for an unseen key', () => {
    resetStore({ transcripts: { 'a1/s1': [{ type: 'userMessage', text: 'keep' }] } });
    expect(reduceEvent(state(), { type: 'messageChunk', agentId: 'a2', sessionId: 'side', text: 'x' })).toEqual({
      transcripts: {
        'a1/s1': [{ type: 'userMessage', text: 'keep' }],
        'a2/side': [{ type: 'messageChunk', text: 'x' }],
      },
    });
  });

  it('toolCall events upsert by toolCallId within the transcript', () => {
    const existing: TranscriptItem = { type: 'toolCall', toolCall: toolCall('tc1', 'v1') };
    resetStore({ transcripts: { 'a1/s1': [existing] } });
    const updated = { ...toolCall('tc1', 'v2'), status: 'completed' as const };
    expect(reduceEvent(state(), { type: 'toolCall', agentId: 'a1', sessionId: 's1', toolCall: updated })).toEqual({
      transcripts: { 'a1/s1': [{ type: 'toolCall', toolCall: updated }] },
    });
  });

  it('approvalRequested appends the approval', () => {
    resetStore({ approvals: [approval('ap1')] });
    expect(reduceEvent(state(), { type: 'approvalRequested', approval: approval('ap2') })).toEqual({
      approvals: [approval('ap1'), approval('ap2')],
    });
  });

  it('approvalResolved removes only the matching approval', () => {
    resetStore({ approvals: [approval('ap1'), approval('ap2')] });
    expect(
      reduceEvent(state(), { type: 'approvalResolved', approvalId: 'ap1', agentId: 'a1', optionId: 'allow' }),
    ).toEqual({ approvals: [approval('ap2')] });
  });

  it('approvalResolved with a null optionId still removes the approval', () => {
    resetStore({ approvals: [approval('ap1')] });
    expect(
      reduceEvent(state(), { type: 'approvalResolved', approvalId: 'ap1', agentId: 'a1', optionId: null }),
    ).toEqual({ approvals: [] });
  });

  it('agentError changes nothing', () => {
    resetStore({ agents: [agent('a1')] });
    expect(reduceEvent(state(), { type: 'agentError', agentId: 'a1', message: 'boom' })).toEqual({});
  });
});

describe('useAppStore actions', () => {
  it('setConnected stores the flag', () => {
    state().setConnected(true);
    expect(state().connected).toBe(true);
    state().setConnected(false);
    expect(state().connected).toBe(false);
  });

  it('setModels replaces the model profile list', () => {
    resetStore({ models: [profile('m1')] });
    state().setModels([profile('m2', 'GPT'), profile('m3', 'Gemini')]);
    expect(state().models).toEqual([profile('m2', 'GPT'), profile('m3', 'Gemini')]);
  });

  it('applySnapshot keeps a selection that still exists', () => {
    resetStore({ agents: [agent('a1'), agent('a2')], selectedAgentId: 'a2' });
    state().applySnapshot({ agents: [agent('a2'), agent('a3')], approvals: [approval('ap1')], projects: [] });
    expect(state().agents).toEqual([agent('a2'), agent('a3')]);
    expect(state().approvals).toEqual([approval('ap1')]);
    expect(state().selectedAgentId).toBe('a2');
  });

  it('applySnapshot sets the project registry', () => {
    const project = { id: 'p1', name: 'demo', repoRoot: '/repo' };
    state().applySnapshot({ agents: [], approvals: [], projects: [project] });
    expect(state().projects).toEqual([project]);
  });

  it('applySnapshot falls back to the first agent when the selection is gone', () => {
    resetStore({ selectedAgentId: 'gone' });
    state().applySnapshot({ agents: [agent('a1'), agent('a2')], approvals: [], projects: [] });
    expect(state().selectedAgentId).toBe('a1');
  });

  it('applySnapshot selects the first agent when nothing was selected', () => {
    state().applySnapshot({ agents: [agent('a9')], approvals: [], projects: [] });
    expect(state().selectedAgentId).toBe('a9');
  });

  it('applySnapshot sets a null selection when there are no agents', () => {
    resetStore({ agents: [agent('a1')], selectedAgentId: 'a1' });
    state().applySnapshot({ agents: [], approvals: [], projects: [] });
    expect(state().selectedAgentId).toBeNull();
    expect(state().agents).toEqual([]);
  });

  it('applyEvent routes through reduceEvent', () => {
    state().applyEvent({ type: 'agentAdded', agent: agent('a1') });
    expect(state().agents).toEqual([agent('a1')]);
  });

  it('selectAgent sets the selection and resets the view to the main session', () => {
    resetStore({ view: { kind: 'changes' } });
    state().selectAgent('a7');
    expect(state().selectedAgentId).toBe('a7');
    expect(state().view).toEqual({ kind: 'session', sessionId: 'main' });
  });

  it('selectProjectFilter changes the project filter', () => {
    state().selectProjectFilter('p1');
    expect(state().selectedProjectId).toBe('p1');
    state().selectProjectFilter('all');
    expect(state().selectedProjectId).toBe('all');
  });

  it('setView replaces the view', () => {
    state().setView({ kind: 'settings' });
    expect(state().view).toEqual({ kind: 'settings' });
    state().setView({ kind: 'session', sessionId: 'side-1' });
    expect(state().view).toEqual({ kind: 'session', sessionId: 'side-1' });
  });

  it('setTranscript replaces one transcript and keeps the others', () => {
    resetStore({ transcripts: { 'a1/s1': [{ type: 'userMessage', text: 'old' }] } });
    state().setTranscript('a1', 's1', [{ type: 'messageChunk', text: 'fresh' }]);
    state().setTranscript('a2', 'main', [{ type: 'userMessage', text: 'other' }]);
    expect(state().transcripts).toEqual({
      'a1/s1': [{ type: 'messageChunk', text: 'fresh' }],
      'a2/main': [{ type: 'userMessage', text: 'other' }],
    });
  });
});
