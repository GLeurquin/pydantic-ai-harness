import { describe, expect, it } from 'vitest';

import type { ToolCallView, TranscriptItem } from '../api/types';
import { appendItem, buildBlocks, transcriptKey } from './transcript';

function toolCall(toolCallId: string, title: string): ToolCallView {
  return { toolCallId, title, kind: 'execute', status: 'pending', content: [], locations: [] };
}

describe('appendItem', () => {
  it('appends a non-toolCall item at the end', () => {
    const items: TranscriptItem[] = [{ type: 'userMessage', text: 'hi' }];
    const result = appendItem(items, { type: 'messageChunk', text: 'yo' });
    expect(result).toEqual([
      { type: 'userMessage', text: 'hi' },
      { type: 'messageChunk', text: 'yo' },
    ]);
  });

  it('does not mutate the input array', () => {
    const items: TranscriptItem[] = [];
    appendItem(items, { type: 'userMessage', text: 'hi' });
    expect(items).toEqual([]);
  });

  it('appends a toolCall with an unseen toolCallId', () => {
    const items: TranscriptItem[] = [{ type: 'toolCall', toolCall: toolCall('a', 'first') }];
    const result = appendItem(items, { type: 'toolCall', toolCall: toolCall('b', 'second') });
    expect(result).toEqual([
      { type: 'toolCall', toolCall: toolCall('a', 'first') },
      { type: 'toolCall', toolCall: toolCall('b', 'second') },
    ]);
  });

  it('replaces the entry with the same toolCallId in place', () => {
    const items: TranscriptItem[] = [
      { type: 'toolCall', toolCall: toolCall('a', 'v1') },
      { type: 'messageChunk', text: 'between' },
    ];
    const updated: ToolCallView = { ...toolCall('a', 'v2'), status: 'completed' };
    const result = appendItem(items, { type: 'toolCall', toolCall: updated });
    expect(result).toEqual([
      { type: 'toolCall', toolCall: updated },
      { type: 'messageChunk', text: 'between' },
    ]);
    expect(items[0]).toEqual({ type: 'toolCall', toolCall: toolCall('a', 'v1') });
  });

  it('replaces the latest entry when several share a toolCallId', () => {
    const items: TranscriptItem[] = [
      { type: 'toolCall', toolCall: toolCall('a', 'oldest') },
      { type: 'userMessage', text: 'mid' },
      { type: 'toolCall', toolCall: toolCall('a', 'newer') },
    ];
    const result = appendItem(items, { type: 'toolCall', toolCall: toolCall('a', 'final') });
    expect(result).toEqual([
      { type: 'toolCall', toolCall: toolCall('a', 'oldest') },
      { type: 'userMessage', text: 'mid' },
      { type: 'toolCall', toolCall: toolCall('a', 'final') },
    ]);
  });
});

describe('buildBlocks', () => {
  it('returns no blocks for an empty transcript', () => {
    expect(buildBlocks([])).toEqual([]);
  });

  it('maps every item type to its block kind', () => {
    const tc = toolCall('t1', 'run tests');
    const entries = [{ content: 'step', priority: 'high', status: 'pending' }];
    const items: TranscriptItem[] = [
      { type: 'userMessage', text: 'ask' },
      { type: 'messageChunk', text: 'answer' },
      { type: 'thoughtChunk', text: 'hmm' },
      { type: 'toolCall', toolCall: tc },
      { type: 'plan', entries },
      { type: 'turnEnded', stopReason: 'end_turn' },
      { type: 'error', message: 'boom' },
    ];
    expect(buildBlocks(items)).toEqual([
      { kind: 'user', text: 'ask' },
      { kind: 'assistant', text: 'answer' },
      { kind: 'thought', text: 'hmm' },
      { kind: 'tool', toolCall: tc },
      { kind: 'plan', entries },
      { kind: 'turnEnd', stopReason: 'end_turn' },
      { kind: 'error', message: 'boom' },
    ]);
  });

  it('coalesces consecutive messageChunks into one assistant block', () => {
    const items: TranscriptItem[] = [
      { type: 'messageChunk', text: 'Hel' },
      { type: 'messageChunk', text: 'lo' },
      { type: 'messageChunk', text: '!' },
    ];
    expect(buildBlocks(items)).toEqual([{ kind: 'assistant', text: 'Hello!' }]);
  });

  it('coalesces consecutive thoughtChunks into one thought block', () => {
    const items: TranscriptItem[] = [
      { type: 'thoughtChunk', text: 'a' },
      { type: 'thoughtChunk', text: 'b' },
    ];
    expect(buildBlocks(items)).toEqual([{ kind: 'thought', text: 'ab' }]);
  });

  it('does not coalesce across a different block in between', () => {
    const items: TranscriptItem[] = [
      { type: 'messageChunk', text: 'one' },
      { type: 'toolCall', toolCall: toolCall('t', 'x') },
      { type: 'messageChunk', text: 'two' },
    ];
    expect(buildBlocks(items)).toEqual([
      { kind: 'assistant', text: 'one' },
      { kind: 'tool', toolCall: toolCall('t', 'x') },
      { kind: 'assistant', text: 'two' },
    ]);
  });

  it('does not merge assistant chunks into thought blocks or vice versa', () => {
    const items: TranscriptItem[] = [
      { type: 'thoughtChunk', text: 'think' },
      { type: 'messageChunk', text: 'say' },
      { type: 'thoughtChunk', text: 'again' },
    ];
    expect(buildBlocks(items)).toEqual([
      { kind: 'thought', text: 'think' },
      { kind: 'assistant', text: 'say' },
      { kind: 'thought', text: 'again' },
    ]);
  });

  it('starts a fresh assistant block after a user block', () => {
    const items: TranscriptItem[] = [
      { type: 'userMessage', text: 'q' },
      { type: 'messageChunk', text: 'a' },
    ];
    expect(buildBlocks(items)).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'a' },
    ]);
  });

  it('keeps consecutive user messages as separate blocks', () => {
    const items: TranscriptItem[] = [
      { type: 'userMessage', text: 'first' },
      { type: 'userMessage', text: 'second' },
    ];
    expect(buildBlocks(items)).toEqual([
      { kind: 'user', text: 'first' },
      { kind: 'user', text: 'second' },
    ]);
  });
});

describe('transcriptKey', () => {
  it('joins agent and session ids with a slash', () => {
    expect(transcriptKey('agent-1', 'sess-2')).toBe('agent-1/sess-2');
  });

  it('produces distinct keys for swapped ids', () => {
    expect(transcriptKey('a', 'b')).not.toBe(transcriptKey('b', 'a'));
  });
});
