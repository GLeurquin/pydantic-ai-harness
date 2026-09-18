/** Sidebar grouping and status presentation, kept pure for testing. */

import type { AgentStatus, AgentSummary } from '../api/types';

export interface AgentGroups {
  needsAttention: AgentSummary[];
  working: AgentSummary[];
  idle: AgentSummary[];
  archived: AgentSummary[];
}

const ATTENTION: readonly AgentStatus[] = ['waiting_approval', 'error'];
const WORKING: readonly AgentStatus[] = ['working', 'starting'];

/** Attention first, then working, idle, archived; order within groups kept. */
export function groupAgents(agents: readonly AgentSummary[], filter: string): AgentGroups {
  const groups: AgentGroups = { needsAttention: [], working: [], idle: [], archived: [] };
  const needle = filter.trim().toLowerCase();
  for (const agent of agents) {
    if (needle && !agent.name.toLowerCase().includes(needle)) {
      continue;
    }
    if (agent.status === 'archived') {
      groups.archived.push(agent);
    } else if (ATTENTION.includes(agent.status)) {
      groups.needsAttention.push(agent);
    } else if (WORKING.includes(agent.status)) {
      groups.working.push(agent);
    } else {
      groups.idle.push(agent);
    }
  }
  return groups;
}

/** Count of live (non-archived) agents, for the n/50 capacity indicator. */
export function liveCount(agents: readonly AgentSummary[]): number {
  return agents.filter((agent) => agent.status !== 'archived').length;
}

export const STATUS_LABELS: Record<AgentStatus, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting_approval: 'Needs approval',
  error: 'Error',
  archived: 'Archived',
};
