import { render, screen } from '@testing-library/react';

import type { ToolCallStatus, ToolCallView } from '../api/types';
import { simpleDiffLines, ToolCallCard } from './ToolCallCard';

function makeToolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: 'tc1',
    title: 'Edit file',
    kind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    ...overrides,
  };
}

describe('simpleDiffLines', () => {
  it('marks every line of a new file as an addition', () => {
    expect(simpleDiffLines(null, 'one\ntwo')).toEqual([
      { sign: '+', line: 'one' },
      { sign: '+', line: 'two' },
    ]);
  });

  it('emits deletions before additions for a modified file', () => {
    expect(simpleDiffLines('keep\nold', 'keep\nnew')).toEqual([
      { sign: '-', line: 'old' },
      { sign: '+', line: 'new' },
    ]);
  });

  it('excludes unchanged lines', () => {
    expect(simpleDiffLines('same\nalso same', 'same\nalso same')).toEqual([]);
  });
});

describe('ToolCallCard', () => {
  const STATUS_CASES: [ToolCallStatus, string][] = [
    ['pending', 'waiting for approval'],
    ['in_progress', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
  ];

  it.each(STATUS_CASES)('header shows kind, title, and %s status text', (status, text) => {
    const { container } = render(<ToolCallCard toolCall={makeToolCall({ status })} />);
    expect(container.querySelector('.tool-kind')).toHaveTextContent('edit');
    expect(container.querySelector('.tool-title')).toHaveTextContent('Edit file');
    const statusNode = container.querySelector('.tool-status');
    expect(statusNode).toHaveTextContent(text);
    expect(statusNode).toHaveClass(status);
  });

  it('renders text content', () => {
    render(<ToolCallCard toolCall={makeToolCall({ content: [{ type: 'text', text: 'hello output' }] })} />);
    expect(screen.getByText('hello output')).toBeInTheDocument();
  });

  it('renders diff content with added and removed line classes', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          content: [{ type: 'diff', path: 'src/a.ts', oldText: 'keep\nold', newText: 'keep\nnew' }],
        })}
      />,
    );
    const pre = screen.getByLabelText('diff of src/a.ts');
    const spans = Array.from(pre.querySelectorAll('span'));
    expect(spans.map((span) => [span.className, span.textContent])).toEqual([
      ['diff-line-del', '-old'],
      ['diff-line-add', '+new'],
    ]);
  });

  it('renders a new-file diff as additions only', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({ content: [{ type: 'diff', path: 'b.txt', oldText: null, newText: 'fresh' }] })}
      />,
    );
    const spans = Array.from(screen.getByLabelText('diff of b.txt').querySelectorAll('span'));
    expect(spans.map((span) => [span.className, span.textContent])).toEqual([['diff-line-add', '+fresh']]);
  });

  it('renders terminal content', () => {
    render(<ToolCallCard toolCall={makeToolCall({ content: [{ type: 'terminal', terminalId: 'term-9' }] })} />);
    expect(screen.getByText('terminal term-9')).toBeInTheDocument();
  });

  it('renders locations with and without line numbers', () => {
    const { container } = render(
      <ToolCallCard
        toolCall={makeToolCall({ locations: [{ path: 'src/a.ts', line: 12 }, { path: 'src/b.ts' }] })}
      />,
    );
    const pres = Array.from(container.querySelectorAll('pre'));
    expect(pres.map((pre) => pre.textContent)).toEqual(['src/a.ts:12\nsrc/b.ts']);
  });

  it('omits the locations block when there are none', () => {
    const { container } = render(<ToolCallCard toolCall={makeToolCall()} />);
    expect(container.querySelectorAll('pre')).toHaveLength(0);
  });
});
