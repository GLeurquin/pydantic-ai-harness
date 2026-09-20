import { useEffect, useState } from 'react';

import type { ContextUsage } from '../api/types';

export interface ContextUsageBadgeProps {
  agentId: string;
  sessionId: string;
  loadContextUsage: (agentId: string, sessionId: string) => Promise<ContextUsage>;
}

/** Matches `_compaction()`'s `max_fraction` in `clai_agent.py`: above this, the next request
 * compacts the history, so the badge warns before that happens rather than after. */
const WARNING_FRACTION = 0.85;

const POLL_INTERVAL_MS = 5_000;

/** A live "context: 73%" readout, polled from the snapshot `clai_agent.py`'s
 * `ReportContextUsage` listener writes on every model request. Renders nothing until the first
 * reading arrives (a fresh session has made none yet) and silently keeps the last good reading
 * on a failed poll rather than flashing empty. */
export function ContextUsageBadge({ agentId, sessionId, loadContextUsage }: ContextUsageBadgeProps) {
  const [usage, setUsage] = useState<ContextUsage>(null);

  useEffect(() => {
    let stale = false;
    setUsage(null);
    const poll = () => {
      loadContextUsage(agentId, sessionId).then(
        (loaded) => {
          if (!stale) {
            setUsage(loaded);
          }
        },
        () => undefined,
      );
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stale = true;
      clearInterval(interval);
    };
  }, [agentId, sessionId, loadContextUsage]);

  if (usage === null) {
    return null;
  }
  const percent = Math.round(usage.fraction * 100);
  const warning = usage.fraction >= WARNING_FRACTION;
  return (
    <span
      className={warning ? 'tabs-context warning' : 'tabs-context'}
      title={usage.resolved ? 'Context window used' : 'Context window used (window size is a guess for this model)'}
    >
      context: {percent}%{usage.resolved ? '' : '*'}
    </span>
  );
}
