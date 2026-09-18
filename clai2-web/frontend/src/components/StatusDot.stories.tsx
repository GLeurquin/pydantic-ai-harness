import type { Story } from '@ladle/react';

import type { AgentStatus } from '../api/types';
import { StatusDot } from './StatusDot';

const ALL_STATUSES: AgentStatus[] = ['starting', 'idle', 'working', 'waiting_approval', 'error', 'archived'];

export const AllStatuses: Story = () => (
  <div style={{ display: 'flex', gap: 24 }}>
    {ALL_STATUSES.map((status) => (
      <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <StatusDot status={status} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{status}</span>
      </span>
    ))}
  </div>
);
