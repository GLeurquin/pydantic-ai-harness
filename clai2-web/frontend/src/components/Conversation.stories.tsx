import type { Story } from '@ladle/react';
import type { ReactNode } from 'react';

import { makeAgent, makeApproval, richTranscript, streamingTranscript } from '../../.ladle/data';
import { Conversation } from './Conversation';

const noop = () => undefined;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: '80vh', maxWidth: 860, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)' }}>
      {children}
    </div>
  );
}

export const RichTranscript: Story = () => (
  <Frame>
    <Conversation
      agent={makeAgent({ status: 'idle' })}
      sessionId="session-main"
      items={richTranscript()}
      approvals={[]}
      onPrompt={noop}
      onCancel={noop}
      onResolveApproval={noop}
      onFork={noop}
      onSideSession={noop}
    />
  </Frame>
);

export const WorkingMidStream: Story = () => (
  <Frame>
    <Conversation
      agent={makeAgent({ status: 'working' })}
      sessionId="session-main"
      items={streamingTranscript()}
      approvals={[]}
      onPrompt={noop}
      onCancel={noop}
      onResolveApproval={noop}
      onFork={noop}
      onSideSession={noop}
    />
  </Frame>
);

export const PendingApproval: Story = () => (
  <Frame>
    <Conversation
      agent={makeAgent({ status: 'waiting_approval', pendingApprovals: 1 })}
      sessionId="session-main"
      items={streamingTranscript()}
      approvals={[makeApproval()]}
      onPrompt={noop}
      onCancel={noop}
      onResolveApproval={noop}
      onFork={noop}
      onSideSession={noop}
    />
  </Frame>
);
