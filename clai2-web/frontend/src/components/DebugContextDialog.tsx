import { useEffect, useState } from 'react';

import type { DebugContext, DebugMessage, DebugMessagePart } from '../api/types';
import { errorMessage } from '../errors';

export interface DebugContextDialogProps {
  agentId: string;
  sessionId: string;
  agentName: string;
  sessionLabel: string;
  loadDebugContext: (agentId: string, sessionId: string) => Promise<DebugContext>;
  onClose: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: DebugContext };

const TRUNCATE_AT = 800;

const PART_LABELS: Record<string, string> = {
  'system-prompt': 'System',
  'user-prompt': 'User',
  text: 'Assistant',
  thinking: 'Thinking',
};

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** A part's content can be arbitrarily long (a whole file read back, a large diff), so this
 * clips it by default rather than blowing up the dialog -- "Show more" reveals the rest. */
function Truncatable({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TRUNCATE_AT;
  return (
    <>
      <pre className="debug-part-content">{long && !expanded ? `${text.slice(0, TRUNCATE_AT)}...` : text}</pre>
      {long ? (
        <button className="link-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Show less' : `Show ${text.length - TRUNCATE_AT} more characters`}
        </button>
      ) : null}
    </>
  );
}

function PartView({ part }: { part: DebugMessagePart }) {
  switch (part.part_kind) {
    case 'system-prompt':
    case 'user-prompt':
    case 'text':
    case 'thinking':
      return (
        <div className="debug-part">
          <div className="debug-part-label">{PART_LABELS[part.part_kind]}</div>
          <Truncatable text={stringify(part.content)} />
        </div>
      );
    case 'tool-call':
      return (
        <div className="debug-part">
          <div className="debug-part-label">Tool call: {part.tool_name}</div>
          <Truncatable text={stringify(part.args)} />
        </div>
      );
    case 'tool-return':
      return (
        <div className="debug-part">
          <div className="debug-part-label">Tool result: {part.tool_name}</div>
          <Truncatable text={stringify(part.content)} />
        </div>
      );
    default:
      return (
        <div className="debug-part">
          <div className="debug-part-label">{part.part_kind}</div>
          <Truncatable text={JSON.stringify(part, null, 2)} />
        </div>
      );
  }
}

function MessageView({ message, index }: { message: DebugMessage; index: number }) {
  return (
    <div className="debug-message">
      <div className="debug-message-header">
        #{index + 1} &middot; {message.kind}
      </div>
      {message.parts.map((part, partIndex) => (
        <PartView key={partIndex} part={part} />
      ))}
    </div>
  );
}

/** The exact messages the agent process last sent to the model for one session, read on demand
 * from the snapshot file `clai_agent.py` writes on every model request (via
 * `pydantic_ai_harness.compaction.ReportModelRequest` and an `@agent.on_event` listener). A stale
 * read just means no request has happened yet since the last one -- this is a point-in-time
 * snapshot, not a live view. */
export function DebugContextDialog({
  agentId,
  sessionId,
  agentName,
  sessionLabel,
  loadDebugContext,
  onClose,
}: DebugContextDialogProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let stale = false;
    setState({ status: 'loading' });
    loadDebugContext(agentId, sessionId).then(
      (data) => {
        if (!stale) {
          setState({ status: 'loaded', data });
        }
      },
      (failure: unknown) => {
        if (!stale) {
          setState({ status: 'error', message: errorMessage(failure) });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [agentId, sessionId, loadDebugContext]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-label="Debug context" onClick={(click) => click.stopPropagation()}>
        <h2>Debug context</h2>
        <p className="hint">
          The exact messages {agentName} last sent to the model for &ldquo;{sessionLabel}&rdquo;, after compaction.
        </p>
        {state.status === 'loading' ? <p>Loading...</p> : null}
        {state.status === 'error' ? <div className="form-error">{state.message}</div> : null}
        {state.status === 'loaded' && state.data === null ? (
          <p className="hint">No snapshot yet -- {agentName} hasn&apos;t made a model request for this session.</p>
        ) : null}
        {state.status === 'loaded' && state.data !== null ? (
          <>
            <div className="dialog-row">
              <button onClick={() => setShowRaw((current) => !current)}>
                {showRaw ? 'Show formatted' : 'Show raw JSON'}
              </button>
            </div>
            {showRaw ? (
              <pre className="debug-raw">{JSON.stringify(state.data, null, 2)}</pre>
            ) : (
              <div className="debug-messages">
                {state.data.map((message, index) => (
                  <MessageView key={index} message={message} index={index} />
                ))}
              </div>
            )}
          </>
        ) : null}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
