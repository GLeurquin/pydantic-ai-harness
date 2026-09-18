import type { Story } from '@ladle/react';

import { makeApproval } from '../../.ladle/data';
import { ApprovalBanner } from './ApprovalBanner';

const noop = () => undefined;

export const ExecuteApproval: Story = () => (
  <div style={{ maxWidth: 520 }}>
    <ApprovalBanner approval={makeApproval()} onResolve={noop} />
  </div>
);

export const WithAgentName: Story = () => (
  <div style={{ maxWidth: 520 }}>
    <ApprovalBanner approval={makeApproval()} agentName="fix-auth-bug" onResolve={noop} />
  </div>
);
