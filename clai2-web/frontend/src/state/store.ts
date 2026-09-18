/** Application state: one zustand store fed by the WebSocket event stream. */

import { create } from 'zustand';

import type { AgentSummary, ApprovalView, ProjectSummary, ServerEvent, TranscriptItem } from '../api/types';
import { addNotification, dismissNotification as removeNotification, type Notification } from './notifications';
import { appendItem, transcriptKey } from './transcript';

export interface Snapshot {
  agents: AgentSummary[];
  approvals: ApprovalView[];
  projects: ProjectSummary[];
  maxAgents: number;
}

export type MainView = { kind: 'session'; sessionId: string } | { kind: 'changes' } | { kind: 'settings' };

/** `'all'` means no project filter; the sidebar shows every agent. */
export type ProjectFilter = string | 'all';

export interface AppState {
  connected: boolean;
  agents: AgentSummary[];
  approvals: ApprovalView[];
  projects: ProjectSummary[];
  selectedProjectId: ProjectFilter;
  maxAgents: number;
  notifications: Notification[];
  transcripts: Record<string, TranscriptItem[]>;
  selectedAgentId: string | null;
  view: MainView;

  setConnected: (connected: boolean) => void;
  applySnapshot: (snapshot: Snapshot) => void;
  applyEvent: (event: ServerEvent) => void;
  selectAgent: (agentId: string) => void;
  selectProjectFilter: (projectId: ProjectFilter) => void;
  setView: (view: MainView) => void;
  setTranscript: (agentId: string, sessionId: string, items: TranscriptItem[]) => void;
  notifyError: (message: string) => void;
  dismissNotification: (id: string) => void;
}

function upsertAgent(agents: AgentSummary[], agent: AgentSummary): AgentSummary[] {
  const index = agents.findIndex((existing) => existing.id === agent.id);
  if (index < 0) {
    return [...agents, agent];
  }
  const next = agents.slice();
  next[index] = agent;
  return next;
}

function upsertProject(projects: ProjectSummary[], project: ProjectSummary): ProjectSummary[] {
  const index = projects.findIndex((existing) => existing.id === project.id);
  if (index < 0) {
    return [...projects, project];
  }
  const next = projects.slice();
  next[index] = project;
  return next;
}

function withAppended(
  transcripts: Record<string, TranscriptItem[]>,
  agentId: string,
  sessionId: string,
  item: TranscriptItem,
): Record<string, TranscriptItem[]> {
  const key = transcriptKey(agentId, sessionId);
  return { ...transcripts, [key]: appendItem(transcripts[key] ?? [], item) };
}

/** Pure event application, exported for direct testing and mutation testing. */
export function reduceEvent(state: AppState, event: ServerEvent): Partial<AppState> {
  switch (event.type) {
    case 'agentAdded':
    case 'agentUpdated':
      return { agents: upsertAgent(state.agents, event.agent) };
    case 'agentRemoved':
      return {
        agents: state.agents.filter((agent) => agent.id !== event.agentId),
        selectedAgentId: state.selectedAgentId === event.agentId ? null : state.selectedAgentId,
      };
    case 'projectAdded':
      return { projects: upsertProject(state.projects, event.project) };
    case 'projectRemoved':
      return {
        projects: state.projects.filter((project) => project.id !== event.projectId),
        selectedProjectId: state.selectedProjectId === event.projectId ? 'all' : state.selectedProjectId,
      };
    case 'userMessage':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'userMessage',
          text: event.text,
        }),
      };
    case 'messageChunk':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'messageChunk',
          text: event.text,
        }),
      };
    case 'thoughtChunk':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'thoughtChunk',
          text: event.text,
        }),
      };
    case 'toolCall':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'toolCall',
          toolCall: event.toolCall,
        }),
      };
    case 'plan':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'plan',
          entries: event.entries,
        }),
      };
    case 'turnEnded':
      return {
        transcripts: withAppended(state.transcripts, event.agentId, event.sessionId, {
          type: 'turnEnded',
          stopReason: event.stopReason,
        }),
      };
    case 'approvalRequested':
      return { approvals: [...state.approvals, event.approval] };
    case 'approvalResolved':
      return { approvals: state.approvals.filter((approval) => approval.id !== event.approvalId) };
    case 'agentError':
      // The status change arrives separately as agentUpdated; the message
      // itself is surfaced as a notification by applyEvent, outside this
      // pure reducer.
      return {};
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  connected: false,
  agents: [],
  approvals: [],
  projects: [],
  selectedProjectId: 'all',
  maxAgents: 100,
  notifications: [],
  transcripts: {},
  selectedAgentId: null,
  view: { kind: 'session', sessionId: 'main' },

  setConnected: (connected) => set({ connected }),
  applySnapshot: (snapshot) =>
    set((state) => ({
      agents: snapshot.agents,
      approvals: snapshot.approvals,
      projects: snapshot.projects,
      maxAgents: snapshot.maxAgents,
      selectedAgentId:
        state.selectedAgentId && snapshot.agents.some((agent) => agent.id === state.selectedAgentId)
          ? state.selectedAgentId
          : (snapshot.agents[0]?.id ?? null),
    })),
  applyEvent: (event) => {
    set((state) => reduceEvent(state, event));
    if (event.type === 'agentError') {
      get().notifyError(event.message);
    }
  },
  selectAgent: (agentId) => set({ selectedAgentId: agentId, view: { kind: 'session', sessionId: 'main' } }),
  selectProjectFilter: (projectId) => set({ selectedProjectId: projectId }),
  setView: (view) => set({ view }),
  setTranscript: (agentId, sessionId, items) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [transcriptKey(agentId, sessionId)]: items },
    })),
  notifyError: (message) =>
    set((state) => ({
      notifications: addNotification(state.notifications, { id: crypto.randomUUID(), message }),
    })),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: removeNotification(state.notifications, id),
    })),
}));
