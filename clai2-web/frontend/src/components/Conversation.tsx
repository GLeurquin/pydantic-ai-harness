import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { AgentSummary, ApprovalView, TranscriptItem } from '../api/types';
import type { TranscriptBlock } from '../state/transcript';
import { buildBlocks } from '../state/transcript';
import { ApprovalBanner } from './ApprovalBanner';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';

export interface ConversationProps {
  agent: AgentSummary;
  sessionId: string;
  items: TranscriptItem[];
  approvals: ApprovalView[];
  onPrompt: (text: string) => void;
  onCancel: () => void;
  onResolveApproval: (approvalId: string, optionId: string) => void;
  onFork: () => void;
  onSideSession: () => void;
}

const STOP_LABELS: Record<string, string> = {
  end_turn: 'turn finished',
  max_tokens: 'stopped: token limit',
  max_turn_requests: 'stopped: request limit',
  refusal: 'stopped: refused',
  cancelled: 'cancelled',
};

/** A guess at a typical block's height in pixels, used only until the
 * virtualizer measures the real one -- see `measureElement` below. Blocks
 * vary wildly (a one-line user message vs. a large diff), so this is just a
 * reasonable starting point for scroll math, not a target. */
const ESTIMATED_BLOCK_HEIGHT = 96;

function renderBlock(block: TranscriptBlock) {
  switch (block.kind) {
    case 'user':
      return <div className="block-user">{block.text}</div>;
    case 'assistant':
      return (
        <div className="block-assistant">
          <Markdown text={block.text} />
        </div>
      );
    case 'thought':
      return (
        <div className="block-thought">
          <Markdown text={block.text} />
        </div>
      );
    case 'tool':
      return <ToolCallCard toolCall={block.toolCall} />;
    case 'plan':
      return (
        <div className="plan-card">
          {block.entries.map((entry, entryIndex) => (
            <div key={entryIndex} className="plan-entry">
              <span className="plan-status">[{entry.status}]</span>
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      );
    case 'turnEnd':
      return (
        <div className="block-turn-end">
          {STOP_LABELS[block.stopReason]}
          {block.usage ? (
            <span className="turn-usage">
              {' '}
              &middot; {block.usage.inputTokens.toLocaleString()} in / {block.usage.outputTokens.toLocaleString()} out
            </span>
          ) : null}
        </div>
      );
    case 'error':
      return <div className="block-error">{block.message}</div>;
  }
}

export function Conversation({
  agent,
  sessionId,
  items,
  approvals,
  onPrompt,
  onCancel,
  onResolveApproval,
  onFork,
  onSideSession,
}: ConversationProps) {
  const [draft, setDraft] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = buildBlocks(items);
  const busy = agent.status === 'working' || agent.status === 'waiting_approval';
  const archived = agent.status === 'archived';
  const sessionApprovals = approvals.filter(
    (approval) => approval.agentId === agent.id && approval.sessionId === sessionId,
  );

  // Only the blocks near the viewport are mounted, so a very long transcript
  // stays cheap to render; `measureElement` corrects each block's estimated
  // height once it's actually in the DOM.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (blocks.length > 0) {
      virtualizer.scrollToIndex(blocks.length - 1, { align: 'end' });
    }
  }, [blocks.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onPrompt(text);
    setDraft('');
  };

  return (
    <div className="conversation">
      <div className="transcript" ref={scrollRef} aria-label="Transcript">
        <div className="transcript-spacer" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            // getVirtualItems() is derived from the same `count: blocks.length`
            // passed into useVirtualizer above on this same render, so its
            // indices are always in range.
            const block = blocks[virtualItem.index]!;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className="transcript-block"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {renderBlock(block)}
              </div>
            );
          })}
        </div>
      </div>
      {sessionApprovals.map((approval) => (
        <ApprovalBanner key={approval.id} approval={approval} onResolve={onResolveApproval} />
      ))}
      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? 'Agent is working...' : `Message ${agent.name}`}
          onChange={(change) => setDraft(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter' && !key.shiftKey) {
              key.preventDefault();
              submit();
            }
          }}
          aria-label="Prompt"
        />
        {archived ? null : (
          <div className="composer-menu">
            <button
              type="button"
              onClick={() => setActionsOpen((value) => !value)}
              aria-expanded={actionsOpen}
              aria-label="More actions"
              title="More actions"
            >
              &#8942;
            </button>
            {actionsOpen ? (
              <div className="composer-menu-panel" role="menu" aria-label="Conversation actions">
                <button
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    onSideSession();
                  }}
                >
                  Side conversation
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    onFork();
                  }}
                >
                  Fork
                </button>
              </div>
            ) : null}
          </div>
        )}
        {busy ? (
          <button className="danger" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button className="primary" onClick={submit} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
