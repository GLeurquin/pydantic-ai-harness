import { useState } from 'react';

import type { AgentSummary, ApprovalView } from '../api/types';
import { ApprovalBanner } from './ApprovalBanner';
import { NotificationToggle } from './NotificationToggle';

export interface HeaderProps {
  connected: boolean;
  approvals: ApprovalView[];
  agents: AgentSummary[];
  onResolveApproval: (approvalId: string, optionId: string) => void;
  onManageProjects: () => void;
  onManageModels: () => void;
  onManageGithub: () => void;
  onToggleSidebar: () => void;
}

export function Header({
  connected,
  approvals,
  agents,
  onResolveApproval,
  onManageProjects,
  onManageModels,
  onManageGithub,
  onToggleSidebar,
}: HeaderProps) {
  const [open, setOpen] = useState(false);
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <header className="header">
      <button className="sidebar-toggle" onClick={onToggleSidebar} aria-label="Toggle agent list">
        &#9776;
      </button>
      <span className="brand">
        CLAI <span className="accent">Web</span>
      </span>
      <span className="header-spacer" />
      <span className={connected ? 'connection online' : 'connection offline'}>
        {connected ? 'connected' : 'reconnecting...'}
      </span>
      <button onClick={onManageProjects} aria-label="Projects">
        Projects
      </button>
      <button onClick={onManageModels} aria-label="Model profiles">
        Models
      </button>
      <button onClick={onManageGithub} aria-label="GitHub settings">
        GitHub
      </button>
      <NotificationToggle />
      <div className="inbox">
        <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Approval inbox">
          Approvals
          {approvals.length > 0 ? <span className="inbox-badge">{approvals.length}</span> : null}
        </button>
        {open ? (
          <div className="inbox-panel" role="dialog" aria-label="Pending approvals">
            {approvals.length === 0 ? <span>Nothing waiting for you.</span> : null}
            {approvals.map((approval) => (
              <ApprovalBanner
                key={approval.id}
                approval={approval}
                agentName={agentName(approval.agentId)}
                onResolve={onResolveApproval}
              />
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}
