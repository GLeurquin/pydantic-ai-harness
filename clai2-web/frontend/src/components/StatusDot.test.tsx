import { render } from '@testing-library/react';

import type { AgentStatus } from '../api/types';
import { StatusDot } from './StatusDot';

const CASES: [AgentStatus, string][] = [
  ['starting', 'Starting'],
  ['idle', 'Idle'],
  ['working', 'Working'],
  ['waiting_approval', 'Needs approval'],
  ['error', 'Error'],
  ['archived', 'Archived'],
];

describe('StatusDot', () => {
  it.each(CASES)('renders %s with its label and class', (status, label) => {
    const { getByRole } = render(<StatusDot status={status} />);
    const dot = getByRole('img');
    expect(dot).toHaveAttribute('aria-label', label);
    expect(dot.className).toBe(`status-dot ${status}`);
  });
});
