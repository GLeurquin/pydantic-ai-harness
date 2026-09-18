import type { AgentStatus } from '../api/types';
import { STATUS_LABELS } from '../state/grouping';

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`status-dot ${status}`} role="img" aria-label={STATUS_LABELS[status]} />;
}
