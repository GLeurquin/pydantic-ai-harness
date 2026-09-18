import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { ApprovalView } from '../api/types';
import { ApprovalBanner } from './ApprovalBanner';

function makeApproval(): ApprovalView {
  return {
    id: 'ap1',
    agentId: 'a1',
    sessionId: 'main',
    toolCall: {
      toolCallId: 'tc1',
      title: 'rm -rf build',
      kind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
    ],
  };
}

describe('ApprovalBanner', () => {
  it('shows the tool title and kind', () => {
    render(<ApprovalBanner approval={makeApproval()} onResolve={vi.fn()} />);
    expect(screen.getByRole('alertdialog', { name: 'Approval needed: rm -rf build' })).toBeInTheDocument();
    expect(screen.getByText('rm -rf build')).toHaveClass('approval-tool');
    expect(screen.getByText('wants to run (execute)')).toBeInTheDocument();
  });

  it('shows the agent name only when given', () => {
    const { rerender } = render(<ApprovalBanner approval={makeApproval()} onResolve={vi.fn()} />);
    expect(document.querySelector('.approval-agent')).toBeNull();
    rerender(<ApprovalBanner approval={makeApproval()} agentName="Alpha" onResolve={vi.fn()} />);
    expect(screen.getByText('Alpha')).toHaveClass('approval-agent');
  });

  it('renders one button per option with primary/danger classes', () => {
    render(<ApprovalBanner approval={makeApproval()} onResolve={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => [button.textContent, button.className])).toEqual([
      ['Allow once', 'primary'],
      ['Always allow', 'primary'],
      ['Reject', 'danger'],
      ['Always reject', 'danger'],
    ]);
  });

  it('resolves with the approval and option ids on click', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(<ApprovalBanner approval={makeApproval()} onResolve={onResolve} />);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('ap1', 'reject-once');
  });
});
