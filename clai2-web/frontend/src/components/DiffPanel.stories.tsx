import type { Story } from '@ladle/react';

import { emptyDiff, sampleDiff } from '../../.ladle/data';
import type { WorktreeDiff } from '../api/types';
import { DiffPanel } from './DiffPanel';

const loadSample = (): Promise<WorktreeDiff> => Promise.resolve(sampleDiff);
const loadEmpty = (): Promise<WorktreeDiff> => Promise.resolve(emptyDiff);
const loadError = (): Promise<WorktreeDiff> => Promise.reject(new Error('git diff failed: worktree is locked'));

export const MultiFileDiff: Story = () => (
  <div style={{ height: '80vh', display: 'flex', maxWidth: 860, border: '1px solid var(--border)' }}>
    <DiffPanel agentId="agent-1" loadDiff={loadSample} onCommit={() => undefined} />
  </div>
);

export const EmptyDiff: Story = () => (
  <div style={{ maxWidth: 860, border: '1px solid var(--border)' }}>
    <DiffPanel agentId="agent-1" loadDiff={loadEmpty} onCommit={() => undefined} />
  </div>
);

export const LoadError: Story = () => (
  <div style={{ maxWidth: 860, border: '1px solid var(--border)' }}>
    <DiffPanel agentId="agent-1" loadDiff={loadError} onCommit={() => undefined} />
  </div>
);
