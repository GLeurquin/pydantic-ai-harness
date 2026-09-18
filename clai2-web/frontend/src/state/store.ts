/** Application state: one zustand store fed by the WebSocket event stream. */

import { create } from 'zustand';

import type { AgentSummary, ApprovalView, ServerEvent, TranscriptItem } from '../api/types';
import { appendItem, transcriptKey } from './transcript';

export interface Snapshot {
  agents: AgentSummary[];
  approvals: ApprovalView[];
}

export type MainView = { kind: 'session'; sessionId: string } | { kind: 'changes' } | { kind: 'settings' };

export interface AppState {
  connected: boolean;
  agents: AgentSummary[];
  approvals: ApprovalView[];
  transcripts: Record<string, TranscriptItem[]>;
  selectedAgentId: string | null;
  view: MainView;

  setConnected: (connected: boolean) => void;
  applySnapshot: (snapshot: Snapshot) => void;
  applyEvent: (event: ServerEvent) => void;
  selectAgent: (agentId: string) => void;
  setView: (view: MainView) => void;
  setTranscript: (agentId: string, sessionId: string, items: TranscriptItem[]) => void;
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
      // The agent status change arrives separately as agentUpdated.
      return {};
  }
}

export const useAppStore = create<AppState>((set) => ({
  connected: false,
  agents: [],
  approvals: [],
  transcripts: {},
  selectedAgentId: null,
  view: { kind: 'session', sessionId: 'main' },

  setConnected: (connected) => set({ connected }),
  applySnapshot: (snapshot) =>
    set((state) => ({
      agents: snapshot.agents,
      approvals: snapshot.approvals,
      selectedAgentId:
        state.selectedAgentId && snapshot.agents.some((agent) => agent.id === state.selectedAgentId)
          ? state.selectedAgentId
          : (snapshot.agents[0]?.id ?? null),
    })),
  applyEvent: (event) => set((state) => reduceEvent(state, event)),
  selectAgent: (agentId) => set({ selectedAgentId: agentId, view: { kind: 'session', sessionId: 'main' } }),
  setView: (view) => set({ view }),
  setTranscript: (agentId, sessionId, items) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [transcriptKey(agentId, sessionId)]: items },
    })),
}));
