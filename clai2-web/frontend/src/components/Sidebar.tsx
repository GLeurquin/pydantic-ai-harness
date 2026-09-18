import { useState } from 'react';

import type { AgentSummary } from '../api/types';
import { groupAgents, liveCount } from '../state/grouping';
import { AgentRow } from './AgentRow';

export interface SidebarProps {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  maxAgents: number;
  onSelect: (agentId: string) => void;
  onNewAgent: () => void;
}

const GROUP_TITLES = [
  ['needsAttention', 'Needs attention'],
  ['working', 'Working'],
  ['idle', 'Idle'],
  ['archived', 'Archived'],
] as const;

export function Sidebar({ agents, selectedAgentId, maxAgents, onSelect, onNewAgent }: SidebarProps) {
  const [filter, setFilter] = useState('');
  const groups = groupAgents(agents, filter);
  const live = liveCount(agents);
  const atCapacity = live >= maxAgents;
  return (
    <nav className="sidebar" aria-label="Agents">
      <div className="sidebar-tools">
        <input
          type="search"
          placeholder="Filter agents"
          value={filter}
          onChange={(change) => setFilter(change.target.value)}
          aria-label="Filter agents"
        />
        <button className="primary" onClick={onNewAgent} disabled={atCapacity} title="Start a new agent">
          New
        </button>
      </div>
      {GROUP_TITLES.map(([key, title]) =>
        groups[key].length > 0 ? (
          <section key={key} aria-label={title}>
            <div className="sidebar-group-title">{title}</div>
            {groups[key].map((agent) => (
              <AgentRow key={agent.id} agent={agent} selected={agent.id === selectedAgentId} onSelect={onSelect} />
            ))}
          </section>
        ) : null,
      )}
      <div className="capacity">
        {live}/{maxAgents} agents
      </div>
    </nav>
  );
}
