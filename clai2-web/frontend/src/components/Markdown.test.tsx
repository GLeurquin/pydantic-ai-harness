import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders a paragraph', () => {
    const { container } = render(<Markdown text="hello there" />);
    expect(container.querySelector('p')).toHaveTextContent('hello there');
  });

  it('renders bold and italic', () => {
    const { container } = render(<Markdown text="a **bold** and *italic* word" />);
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
  });

  it('renders an inline code span without a code-block wrapper', () => {
    const { container } = render(<Markdown text="call `refresh()` first" />);
    expect(container.querySelector('code')).toHaveTextContent('refresh()');
    expect(container.querySelector('.code-block')).toBeNull();
  });

  it('renders a fenced code block with a registered language as highlighted', () => {
    const { container } = render(<Markdown text={'```python\ndef f():\n    return 1\n```'} />);
    expect(container.querySelector('.code-block-lang')).toHaveTextContent('python');
    const code = container.querySelector('.code-block code');
    expect(code).toHaveClass('hljs');
    expect(code?.querySelector('.hljs-keyword')).toHaveTextContent('def');
    expect(code).toHaveTextContent('return 1');
  });

  it('falls back to a plain block for an unregistered language, without crashing', () => {
    const { container } = render(<Markdown text={'```cobol\nDISPLAY "HI".\n```'} />);
    expect(container.querySelector('.code-block-lang')).toHaveTextContent('cobol');
    const code = container.querySelector('.code-block code');
    expect(code).not.toHaveClass('hljs');
    expect(code).toHaveTextContent('DISPLAY "HI".');
  });

  it('treats a language-less multi-line fence as a code block too', () => {
    const { container } = render(<Markdown text={'```\nline one\nline two\n```'} />);
    const block = container.querySelector('.code-block');
    expect(block).not.toBeNull();
    expect(container.querySelector('.code-block-lang')).toHaveTextContent('code');
    expect(block).toHaveTextContent('line one');
    expect(block).toHaveTextContent('line two');
  });

  it('renders an empty fence without crashing', () => {
    const { container } = render(<Markdown text={'```\n```'} />);
    expect(container.querySelector('code')).toHaveTextContent('');
  });

  it('opens links in a new tab without leaking a referrer', () => {
    const { container } = render(<Markdown text="[docs](https://example.com/docs)" />);
    const link = container.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a GFM table', () => {
    const { container } = render(<Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelector('td')).toHaveTextContent('1');
  });

  it('renders a GFM task list', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [ ] todo'} />);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it('never renders embedded raw HTML as live markup', () => {
    const { container } = render(<Markdown text={'before <img src=x onerror="window.__pwned = true()"> after'} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  describe('copy button', () => {
    it('copies the code text and shows Copied, then reverts after the timeout', async () => {
      // userEvent.setup() installs its own clipboard polyfill on `navigator`,
      // overwriting anything set beforehand -- so the mock must be installed
      // after setup(), not in a beforeEach.
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      });
      render(<Markdown text={'```python\nprint(1)\n```'} />);

      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('print(1)');
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

      expect(await screen.findByRole('button', { name: 'Copy' }, { timeout: 3000 })).toBeInTheDocument();
    });

    it('resets the revert timer when clicked again before it fires', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      });
      render(<Markdown text={'```python\nprint(1)\n```'} />);

      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Copied' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });
});
