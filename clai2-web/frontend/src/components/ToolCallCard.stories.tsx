import type { Story } from '@ladle/react';

import { editDiffToolCall, makeToolCall } from '../../.ladle/data';
import { ToolCallCard } from './ToolCallCard';

export const PendingExecute: Story = () => (
  <ToolCallCard toolCall={makeToolCall({ title: 'rm -rf build/', kind: 'execute', status: 'pending' })} />
);

export const InProgressRead: Story = () => (
  <ToolCallCard
    toolCall={makeToolCall({
      toolCallId: 'tool-read',
      title: 'Read src/auth/session.py',
      kind: 'read',
      status: 'in_progress',
    })}
  />
);

export const CompletedEditWithDiff: Story = () => <ToolCallCard toolCall={editDiffToolCall} />;

export const FailedExecuteWithOutput: Story = () => (
  <ToolCallCard
    toolCall={makeToolCall({
      toolCallId: 'tool-fail',
      title: 'pytest tests/auth -x',
      kind: 'execute',
      status: 'failed',
      content: [
        {
          type: 'text',
          text: 'FAILED tests/auth/test_session.py::test_refresh_expired\nE   ExpiredToken: token expired 3600s ago\n1 failed, 41 passed in 4.12s',
        },
      ],
    })}
  />
);

export const WithLocations: Story = () => (
  <ToolCallCard
    toolCall={makeToolCall({
      toolCallId: 'tool-search',
      title: 'Search for decode(',
      kind: 'search',
      status: 'completed',
      locations: [
        { path: 'src/auth/session.py', line: 12 },
        { path: 'src/auth/tokens.py', line: 48 },
        { path: 'tests/auth/test_session.py' },
      ],
    })}
  />
);
