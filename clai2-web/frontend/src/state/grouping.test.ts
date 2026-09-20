import { describe, expect, it } from 'vitest';

import type { AgentStatus, AgentSummary, FolderSummary } from '../api/types';
import { filterByProject, groupAgents, groupByFolder, liveCount, STATUS_LABELS } from './grouping';

function agent(
  id: string,
  name: string,
  status: AgentStatus,
  projectId = 'project-1',
  folderId: string | null = null,
): AgentSummary {
  return {
    id,
    name,
    projectId,
    status,
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/repo',
    sessions: [],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    goal: null,
    ciTracking: null,
    folderId,
    isStub: false,
  };
}

function folder(id: string, name: string): FolderSummary {
  return { id, name };
}

describe('groupAgents', () => {
  it('routes every status to its group', () => {
    const starting = agent('1', 'starting', 'starting');
    const idle = agent('2', 'idle', 'idle');
    const working = agent('3', 'working', 'working');
    const waiting = agent('4', 'waiting', 'waiting_approval');
    const errored = agent('5', 'errored', 'error');
    const archived = agent('6', 'archived', 'archived');
    expect(groupAgents([starting, idle, working, waiting, errored, archived], '')).toEqual({
      needsAttention: [waiting, errored],
      working: [starting, working],
      idle: [idle],
      archived: [archived],
    });
  });

  it('returns empty groups for no agents', () => {
    expect(groupAgents([], '')).toEqual({ needsAttention: [], working: [], idle: [], archived: [] });
  });

  it('preserves input order within each group', () => {
    const a = agent('1', 'a', 'working');
    const b = agent('2', 'b', 'starting');
    const c = agent('3', 'c', 'working');
    expect(groupAgents([a, b, c], '').working).toEqual([a, b, c]);
  });

  it('filters by case-insensitive substring of the name', () => {
    const alpha = agent('1', 'Alpha One', 'idle');
    const beta = agent('2', 'beta', 'idle');
    const gamma = agent('3', 'ALPHABET', 'working');
    const groups = groupAgents([alpha, beta, gamma], 'aLpH');
    expect(groups.idle).toEqual([alpha]);
    expect(groups.working).toEqual([gamma]);
    expect(groups.needsAttention).toEqual([]);
    expect(groups.archived).toEqual([]);
  });

  it('matches a substring in the middle of the name', () => {
    const a = agent('1', 'refactor-auth', 'idle');
    const b = agent('2', 'fix-ci', 'idle');
    expect(groupAgents([a, b], 'or-au').idle).toEqual([a]);
  });

  it('trims surrounding whitespace from the filter', () => {
    const a = agent('1', 'alpha', 'idle');
    expect(groupAgents([a], '  alpha  ').idle).toEqual([a]);
  });

  it('treats a whitespace-only filter as no filter', () => {
    const a = agent('1', 'alpha', 'idle');
    const b = agent('2', 'beta', 'archived');
    expect(groupAgents([a, b], '   ')).toEqual({ needsAttention: [], working: [], idle: [a], archived: [b] });
  });

  it('excludes agents whose name does not contain the filter', () => {
    const a = agent('1', 'alpha', 'error');
    expect(groupAgents([a], 'omega')).toEqual({ needsAttention: [], working: [], idle: [], archived: [] });
  });

  it('skips a non-archived agent filed into a folder', () => {
    const filed = agent('1', 'filed', 'waiting_approval', 'project-1', 'f1');
    const unfiled = agent('2', 'unfiled', 'idle');
    expect(groupAgents([filed, unfiled], '')).toEqual({
      needsAttention: [],
      working: [],
      idle: [unfiled],
      archived: [],
    });
  });

  it('keeps an archived agent in Archived even when it is filed into a folder', () => {
    const filedArchived = agent('1', 'filed', 'archived', 'project-1', 'f1');
    expect(groupAgents([filedArchived], '')).toEqual({
      needsAttention: [],
      working: [],
      idle: [],
      archived: [filedArchived],
    });
  });
});

describe('groupByFolder', () => {
  it('groups agents by their folder, preserving folder order', () => {
    const inBackend = agent('1', 'a', 'idle', 'project-1', 'f-backend');
    const inFrontend = agent('2', 'b', 'idle', 'project-1', 'f-frontend');
    const folders = [folder('f-backend', 'Backend'), folder('f-frontend', 'Frontend')];
    expect(groupByFolder([inBackend, inFrontend], folders, '')).toEqual([
      { folder: folders[0], agents: [inBackend] },
      { folder: folders[1], agents: [inFrontend] },
    ]);
  });

  it('omits folders with no matching agents', () => {
    const inBackend = agent('1', 'a', 'idle', 'project-1', 'f-backend');
    const folders = [folder('f-backend', 'Backend'), folder('f-empty', 'Empty')];
    expect(groupByFolder([inBackend], folders, '')).toEqual([{ folder: folders[0], agents: [inBackend] }]);
  });

  it('excludes an archived agent even if it is filed into the folder', () => {
    const archived = agent('1', 'a', 'archived', 'project-1', 'f-backend');
    expect(groupByFolder([archived], [folder('f-backend', 'Backend')], '')).toEqual([]);
  });

  it('excludes agents with no folder or an unknown folder', () => {
    const unfiled = agent('1', 'a', 'idle');
    const otherFolder = agent('2', 'b', 'idle', 'project-1', 'f-other');
    expect(groupByFolder([unfiled, otherFolder], [folder('f-backend', 'Backend')], '')).toEqual([]);
  });

  it('filters by case-insensitive substring of the name', () => {
    const alpha = agent('1', 'Alpha One', 'idle', 'project-1', 'f1');
    const beta = agent('2', 'beta', 'idle', 'project-1', 'f1');
    expect(groupByFolder([alpha, beta], [folder('f1', 'Team')], 'aLpH')).toEqual([
      { folder: folder('f1', 'Team'), agents: [alpha] },
    ]);
  });

  it('returns no groups for no folders', () => {
    expect(groupByFolder([agent('1', 'a', 'idle', 'project-1', 'f1')], [], '')).toEqual([]);
  });
});

describe('filterByProject', () => {
  it('keeps every agent when the filter is "all"', () => {
    const a = agent('1', 'a', 'idle', 'p1');
    const b = agent('2', 'b', 'idle', 'p2');
    expect(filterByProject([a, b], 'all')).toEqual([a, b]);
  });

  it('keeps only agents in the given project', () => {
    const a = agent('1', 'a', 'idle', 'p1');
    const b = agent('2', 'b', 'idle', 'p2');
    const c = agent('3', 'c', 'idle', 'p1');
    expect(filterByProject([a, b, c], 'p1')).toEqual([a, c]);
  });

  it('returns an empty array for a project with no agents', () => {
    const a = agent('1', 'a', 'idle', 'p1');
    expect(filterByProject([a], 'p2')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const agents = [agent('1', 'a', 'idle', 'p1')];
    const filtered = filterByProject(agents, 'all');
    expect(filtered).not.toBe(agents);
    expect(filtered).toEqual(agents);
  });
});

describe('liveCount', () => {
  it('counts only non-archived agents', () => {
    const agents = [
      agent('1', 'a', 'idle'),
      agent('2', 'b', 'archived'),
      agent('3', 'c', 'working'),
      agent('4', 'd', 'waiting_approval'),
      agent('5', 'e', 'archived'),
      agent('6', 'f', 'error'),
      agent('7', 'g', 'starting'),
    ];
    expect(liveCount(agents)).toBe(5);
  });

  it('is zero for no agents', () => {
    expect(liveCount([])).toBe(0);
  });

  it('is zero when all agents are archived', () => {
    expect(liveCount([agent('1', 'a', 'archived')])).toBe(0);
  });
});

describe('STATUS_LABELS', () => {
  it('labels every status exactly', () => {
    expect(STATUS_LABELS).toEqual({
      starting: 'Starting',
      idle: 'Idle',
      working: 'Working',
      waiting_approval: 'Needs approval',
      error: 'Error',
      archived: 'Archived',
    });
  });
});
