/** Pure transcript operations: append, tool-call upsert, display blocks. */

import type { PlanEntry, StopReason, ToolCallView, TranscriptItem } from '../api/types';

/** Append an item; a toolCall item replaces the latest entry for its id. */
export function appendItem(items: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  if (item.type === 'toolCall') {
    const index = items.findLastIndex(
      (existing) => existing.type === 'toolCall' && existing.toolCall.toolCallId === item.toolCall.toolCallId,
    );
    if (index >= 0) {
      const next = items.slice();
      next[index] = item;
      return next;
    }
  }
  return [...items, item];
}

/** What the conversation view renders: chunks coalesced into blocks. */
export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; toolCall: ToolCallView }
  | { kind: 'plan'; entries: PlanEntry[] }
  | { kind: 'turnEnd'; stopReason: StopReason }
  | { kind: 'error'; message: string };

/** Coalesce consecutive chunks of the same role into single blocks. */
export function buildBlocks(items: readonly TranscriptItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    const last = blocks[blocks.length - 1];
    switch (item.type) {
      case 'userMessage':
        blocks.push({ kind: 'user', text: item.text });
        break;
      case 'messageChunk':
        if (last?.kind === 'assistant') {
          last.text += item.text;
        } else {
          blocks.push({ kind: 'assistant', text: item.text });
        }
        break;
      case 'thoughtChunk':
        if (last?.kind === 'thought') {
          last.text += item.text;
        } else {
          blocks.push({ kind: 'thought', text: item.text });
        }
        break;
      case 'toolCall':
        blocks.push({ kind: 'tool', toolCall: item.toolCall });
        break;
      case 'plan':
        blocks.push({ kind: 'plan', entries: item.entries });
        break;
      case 'turnEnded':
        blocks.push({ kind: 'turnEnd', stopReason: item.stopReason });
        break;
      case 'error':
        blocks.push({ kind: 'error', message: item.message });
        break;
    }
  }
  return blocks;
}

export function transcriptKey(agentId: string, sessionId: string): string {
  return `${agentId}/${sessionId}`;
}
