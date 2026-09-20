/** Sidebar grouping and status presentation, kept pure for testing. */

import type { AgentStatus, AgentSummary, FolderSummary } from '../api/types';

export interface AgentGroups {
  needsAttention: AgentSummary[];
  working: AgentSummary[];
  idle: AgentSummary[];
  archived: AgentSummary[];
}

export interface FolderGroup {
  folder: FolderSummary;
  agents: AgentSummary[];
}

const ATTENTION: readonly AgentStatus[] = ['waiting_approval', 'error'];
const WORKING: readonly AgentStatus[] = ['working', 'starting'];

/** Keep only agents in `projectId`; `'all'` keeps every agent. */
export function filterByProject(agents: readonly AgentSummary[], projectId: string | 'all'): AgentSummary[] {
  return projectId === 'all' ? [...agents] : agents.filter((agent) => agent.projectId === projectId);
}

/** Attention first, then working, idle, archived; order within groups kept.
 * An agent manually filed into a folder (see `groupByFolder`) is grouped
 * there instead, unless it's archived -- archived always wins, so filing an
 * agent into a folder before archiving it never hides it from Archived. */
export function groupAgents(agents: readonly AgentSummary[], filter: string): AgentGroups {
  const groups: AgentGroups = { needsAttention: [], working: [], idle: [], archived: [] };
  const needle = filter.trim().toLowerCase();
  for (const agent of agents) {
    if (needle && !agent.name.toLowerCase().includes(needle)) {
      continue;
    }
    if (agent.status === 'archived') {
      groups.archived.push(agent);
    } else if (agent.folderId) {
      continue;
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

/** Group non-archived agents manually filed into a folder, in folder order;
 * only non-empty folders are included. Archived agents always stay in
 * `groupAgents`'s Archived group instead, regardless of their folder. */
export function groupByFolder(
  agents: readonly AgentSummary[],
  folders: readonly FolderSummary[],
  filter: string,
): FolderGroup[] {
  const needle = filter.trim().toLowerCase();
  const groups = folders.map((folder) => ({
    folder,
    agents: agents.filter(
      (agent) =>
        agent.folderId === folder.id &&
        agent.status !== 'archived' &&
        (!needle || agent.name.toLowerCase().includes(needle)),
    ),
  }));
  return groups.filter((group) => group.agents.length > 0);
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
