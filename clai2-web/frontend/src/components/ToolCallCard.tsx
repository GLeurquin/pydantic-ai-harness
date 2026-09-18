import type { ToolCallContent, ToolCallView } from '../api/types';

const STATUS_TEXT = {
  pending: 'waiting for approval',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
} as const;

/** Render a unified-style diff from old and new text, additions and deletions only. */
export function simpleDiffLines(oldText: string | null, newText: string): { sign: '+' | '-'; line: string }[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText.split('\n');
  const result: { sign: '+' | '-'; line: string }[] = [];
  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      result.push({ sign: '-', line });
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      result.push({ sign: '+', line });
    }
  }
  return result;
}

function ContentBlock({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case 'text':
      return <pre>{content.text}</pre>;
    case 'diff':
      return (
        <pre aria-label={`diff of ${content.path}`}>
          {simpleDiffLines(content.oldText, content.newText).map((entry, index) => (
            <span key={index} className={entry.sign === '+' ? 'diff-line-add' : 'diff-line-del'}>
              {entry.sign}
              {entry.line}
            </span>
          ))}
        </pre>
      );
    case 'terminal':
      return <pre>terminal {content.terminalId}</pre>;
  }
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCallView }) {
  return (
    <div className="tool-card">
      <div className="tool-card-header">
        <span className="tool-kind">{toolCall.kind}</span>
        <span className="tool-title">{toolCall.title}</span>
        <span className={`tool-status ${toolCall.status}`}>{STATUS_TEXT[toolCall.status]}</span>
      </div>
      {toolCall.content.map((content, index) => (
        <ContentBlock key={index} content={content} />
      ))}
      {toolCall.locations.length > 0 ? (
        <pre>
          {toolCall.locations
            .map((location) => (location.line !== undefined ? `${location.path}:${location.line}` : location.path))
            .join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
