import type { ApprovalView } from '../api/types';

export interface ApprovalBannerProps {
  approval: ApprovalView;
  /** Agent name for context in cross-agent surfaces (the inbox). */
  agentName?: string;
  onResolve: (approvalId: string, optionId: string) => void;
}

export function ApprovalBanner({ approval, agentName, onResolve }: ApprovalBannerProps) {
  return (
    <div className="approval-banner" role="alertdialog" aria-label={`Approval needed: ${approval.toolCall.title}`}>
      <div className="approval-title">
        <span className="approval-tool">{approval.toolCall.title}</span>
        <span>wants to run ({approval.toolCall.kind})</span>
        {agentName ? <span className="approval-agent">{agentName}</span> : null}
      </div>
      <div className="approval-options">
        {approval.options.map((option) => (
          <button
            key={option.optionId}
            className={option.kind.startsWith('allow') ? 'primary' : 'danger'}
            onClick={() => onResolve(approval.id, option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}
