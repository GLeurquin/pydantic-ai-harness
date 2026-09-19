import { useEffect, useRef, useState } from 'react';

import type { AgentSummary, ApprovalView, TranscriptItem } from '../api/types';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = buildBlocks(items);
  const busy = agent.status === 'working' || agent.status === 'waiting_approval';
  const archived = agent.status === 'archived';
  const sessionApprovals = approvals.filter(
    (approval) => approval.agentId === agent.id && approval.sessionId === sessionId,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length]);

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
        {blocks.map((block, index) => {
          switch (block.kind) {
            case 'user':
              return (
                <div key={index} className="block-user">
                  {block.text}
                </div>
              );
            case 'assistant':
              return (
                <div key={index} className="block-assistant">
                  <Markdown text={block.text} />
                </div>
              );
            case 'thought':
              return (
                <div key={index} className="block-thought">
                  <Markdown text={block.text} />
                </div>
              );
            case 'tool':
              return <ToolCallCard key={index} toolCall={block.toolCall} />;
            case 'plan':
              return (
                <div key={index} className="plan-card">
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
                <div key={index} className="block-turn-end">
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
              return (
                <div key={index} className="block-error">
                  {block.message}
                </div>
              );
          }
        })}
      </div>
      {sessionApprovals.map((approval) => (
        <ApprovalBanner key={approval.id} approval={approval} onResolve={onResolveApproval} />
      ))}
      <div className="composer">
        {archived ? null : (
          <div className="composer-actions">
            <button onClick={onSideSession} title="Open a side conversation with this agent">
              Side conversation
            </button>
            <button onClick={onFork} title="Fork this agent into a new worktree">
              Fork
            </button>
          </div>
        )}
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
