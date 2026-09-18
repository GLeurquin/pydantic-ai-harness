import type { AgentSummary } from '../api/types';
import { StatusDot } from './StatusDot';

export interface AgentRowProps {
  agent: AgentSummary;
  selected: boolean;
  onSelect: (agentId: string) => void;
}

export function AgentRow({ agent, selected, onSelect }: AgentRowProps) {
  return (
    <button
      className={selected ? 'agent-row selected' : 'agent-row'}
      onClick={() => onSelect(agent.id)}
      aria-current={selected}
    >
      <StatusDot status={agent.status} />
      <span className="agent-row-name">
        {agent.name}
        {agent.worktree ? <span className="agent-row-branch">{agent.worktree.branch}</span> : null}
      </span>
      {agent.pendingApprovals > 0 ? <span className="badge">{agent.pendingApprovals}</span> : null}
    </button>
  );
}
