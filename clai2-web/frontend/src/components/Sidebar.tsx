import { useState } from 'react';

import type { AgentSummary, ProjectSummary } from '../api/types';
import { filterByProject, groupAgents, liveCount } from '../state/grouping';
import type { ProjectFilter } from '../state/store';
import { AgentRow } from './AgentRow';

export interface SidebarProps {
  agents: AgentSummary[];
  projects: ProjectSummary[];
  selectedProjectId: ProjectFilter;
  selectedAgentId: string | null;
  maxAgents: number;
  onSelect: (agentId: string) => void;
  onSelectProject: (projectId: ProjectFilter) => void;
  onNewAgent: () => void;
}

const GROUP_TITLES = [
  ['needsAttention', 'Needs attention'],
  ['working', 'Working'],
  ['idle', 'Idle'],
  ['archived', 'Archived'],
] as const;

export function Sidebar({
  agents,
  projects,
  selectedProjectId,
  selectedAgentId,
  maxAgents,
  onSelect,
  onSelectProject,
  onNewAgent,
}: SidebarProps) {
  const [filter, setFilter] = useState('');
  const groups = groupAgents(filterByProject(agents, selectedProjectId), filter);
  const live = liveCount(agents);
  const atCapacity = live >= maxAgents;
  return (
    <nav className="sidebar" aria-label="Agents">
      <div className="sidebar-tools">
        <div className="sidebar-tools-row">
          <select
            value={selectedProjectId}
            onChange={(change) => onSelectProject(change.target.value)}
            aria-label="Filter by project"
          >
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={onNewAgent} disabled={atCapacity} title="Start a new agent">
            New
          </button>
        </div>
        <div className="sidebar-tools-row">
          <input
            type="search"
            placeholder="Filter agents"
            value={filter}
            onChange={(change) => setFilter(change.target.value)}
            aria-label="Filter agents"
          />
        </div>
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
