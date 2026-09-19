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
  /** Whether the off-canvas drawer is open. No effect above the mobile breakpoint. */
  open: boolean;
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

const COLLAPSED_GROUPS_KEY = 'clai2:sidebar-collapsed-groups';

/** Which sidebar groups are collapsed is a per-viewer preference, not app
 * data -- kept in localStorage rather than passed down from App.tsx. */
function loadCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveCollapsedGroups(collapsed: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsed));
  } catch {
    // Best-effort; losing this preference isn't worth failing the UI over.
  }
}

export function Sidebar({
  agents,
  projects,
  selectedProjectId,
  selectedAgentId,
  maxAgents,
  open,
  onSelect,
  onSelectProject,
  onNewAgent,
}: SidebarProps) {
  const [filter, setFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(loadCollapsedGroups);
  const groups = groupAgents(filterByProject(agents, selectedProjectId), filter);
  const live = liveCount(agents);
  const atCapacity = live >= maxAgents;

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = { ...current, [key]: !current[key] };
      saveCollapsedGroups(next);
      return next;
    });
  };
  return (
    <nav className={open ? 'sidebar open' : 'sidebar'} aria-label="Agents">
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
      {GROUP_TITLES.map(([key, title]) => {
        if (groups[key].length === 0) {
          return null;
        }
        const collapsed = collapsedGroups[key] ?? false;
        return (
          <section key={key} aria-label={title}>
            <button
              type="button"
              className="sidebar-group-title"
              onClick={() => toggleGroup(key)}
              aria-expanded={!collapsed}
            >
              <span className="sidebar-group-arrow">{collapsed ? '▸' : '▾'}</span>
              {title}
            </button>
            {collapsed
              ? null
              : groups[key].map((agent) => (
                  <AgentRow key={agent.id} agent={agent} selected={agent.id === selectedAgentId} onSelect={onSelect} />
                ))}
          </section>
        );
      })}
      <div className="capacity">
        {live}/{maxAgents} agents
      </div>
    </nav>
  );
}
