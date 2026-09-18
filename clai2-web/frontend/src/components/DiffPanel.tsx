import { useEffect, useState } from 'react';

import type { WorktreeDiff } from '../api/types';
import { errorMessage } from '../errors';

export interface DiffPanelProps {
  agentId: string;
  loadDiff: (agentId: string) => Promise<WorktreeDiff>;
}

function DiffText({ text }: { text: string }) {
  return (
    <pre>
      {text.split('\n').map((line, index) => {
        const className = line.startsWith('+') ? 'diff-line-add' : line.startsWith('-') ? 'diff-line-del' : undefined;
        return (
          <span key={index} className={className}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

export function DiffPanel({ agentId, loadDiff }: DiffPanelProps) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setDiff(null);
    setError(null);
    loadDiff(agentId).then(
      (loaded) => {
        if (!stale) {
          setDiff(loaded);
        }
      },
      (failure: unknown) => {
        if (!stale) {
          setError(errorMessage(failure));
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [agentId, loadDiff]);

  if (error !== null) {
    return <div className="diff-panel block-error">{error}</div>;
  }
  if (diff === null) {
    return <div className="diff-panel">Loading diff...</div>;
  }
  const empty = !diff.diff && !diff.untrackedDiff;
  return (
    <div className="diff-panel" aria-label="Changes">
      {diff.status ? <div className="diff-meta">{diff.status}</div> : null}
      {empty ? <div>No changes against the base branch.</div> : null}
      {diff.diff ? <DiffText text={diff.diff} /> : null}
      {diff.untrackedDiff ? <DiffText text={diff.untrackedDiff} /> : null}
    </div>
  );
}
