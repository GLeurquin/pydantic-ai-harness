import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './client';
import type { CreateAgentRequest, CreateProjectRequest, ForkAgentRequest, ProfileEdit } from './types';

const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };

function okResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('listAgents GETs /api/agents', async () => {
    const payload = [{ id: 'a1' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.listAgents()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', JSON_HEADERS);
  });

  it('createAgent POSTs the request body to /api/agents', async () => {
    const body: CreateAgentRequest = { name: 'n', projectId: 'p1', useWorktree: true, baseBranch: 'main', approvalMode: 'auto' };
    const payload = { id: 'a1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.createAgent(body)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('getAgent GETs /api/agents/:id', async () => {
    const payload = { id: 'a1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.getAgent('a1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1', JSON_HEADERS);
  });

  it('archiveAgent DELETEs with the removeWorktree query flag', async () => {
    const payload = { id: 'a1', status: 'archived' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.archiveAgent('a1', true)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1?removeWorktree=true', {
      ...JSON_HEADERS,
      method: 'DELETE',
    });

    fetchMock.mockResolvedValue(okResponse(payload));
    await api.archiveAgent('a1', false);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/agents/a1?removeWorktree=false', {
      ...JSON_HEADERS,
      method: 'DELETE',
    });
  });

  it('prompt POSTs the text to the session prompt endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.prompt('a1', 's1', 'do it')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/sessions/s1/prompt', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ text: 'do it' }),
    });
  });

  it('cancel POSTs to the cancel endpoint without a body', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.cancel('a1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/cancel', { ...JSON_HEADERS, method: 'POST' });
  });

  it('fork POSTs the fork body', async () => {
    const body: ForkAgentRequest = { name: 'copy' };
    const payload = { id: 'a2' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.fork('a1', body)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/fork', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('openSideSession POSTs the label to the sessions endpoint', async () => {
    const payload = { id: 'a1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.openSideSession('a1', 'review')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/sessions', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ label: 'review' }),
    });
  });

  it('setApprovalMode PATCHes the approval mode', async () => {
    const payload = { id: 'a1', approvalMode: 'accept_edits' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setApprovalMode('a1', 'accept_edits')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/approval-mode', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ approvalMode: 'accept_edits' }),
    });
  });

  it('rename PATCHes the agent name', async () => {
    const payload = { id: 'a1', name: 'Renamed' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.rename('a1', 'Renamed')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/name', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    });
  });

  it('listProjects GETs /api/projects', async () => {
    const payload = [{ id: 'p1', name: 'clai', repoRoot: '/repo' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.listProjects()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', JSON_HEADERS);
  });

  it('createProject POSTs the project body', async () => {
    const body: CreateProjectRequest = { name: 'other', path: '/other' };
    const payload = { id: 'p2', name: 'other', repoRoot: '/other' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.createProject(body)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('deleteProject DELETEs the project', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.deleteProject('p1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1', { ...JSON_HEADERS, method: 'DELETE' });
  });

  it('listFolders GETs /api/folders', async () => {
    const payload = [{ id: 'f1', name: 'backend work' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.listFolders()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/folders', JSON_HEADERS);
  });

  it('createFolder POSTs the folder name', async () => {
    const payload = { id: 'f1', name: 'backend work' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.createFolder('backend work')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/folders', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ name: 'backend work' }),
    });
  });

  it('deleteFolder DELETEs the folder', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.deleteFolder('f1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/folders/f1', { ...JSON_HEADERS, method: 'DELETE' });
  });

  it('setAgentFolder PATCHes the chosen folder id', async () => {
    const payload = { id: 'a1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setAgentFolder('a1', 'f1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/folder', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ folderId: 'f1' }),
    });
  });

  it('setAgentFolder PATCHes a null folder id to clear it', async () => {
    const payload = { id: 'a1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setAgentFolder('a1', null)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/folder', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ folderId: null }),
    });
  });

  it('pendingApprovals GETs /api/approvals', async () => {
    const payload = [{ id: 'ap1' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.pendingApprovals()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/approvals', JSON_HEADERS);
  });

  it('resolveApproval POSTs the chosen option', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.resolveApproval('ap1', 'allow')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/approvals/ap1', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ optionId: 'allow' }),
    });
  });

  it('transcript GETs the session transcript', async () => {
    const payload = [{ type: 'userMessage', text: 'hi' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.transcript('a1', 's1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/sessions/s1/transcript', JSON_HEADERS);
  });

  it('diff GETs the worktree diff', async () => {
    const payload = { diff: 'd', untrackedDiff: 'u', status: 's' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.diff('a1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/diff', JSON_HEADERS);
  });

  it('commit POSTs the trimmed message to the commit endpoint', async () => {
    const payload = { ok: true };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.commit('a1', 'Update src/a.ts')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/commit', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ message: 'Update src/a.ts' }),
    });
  });

  it('openPullRequest POSTs the title and body to the pull-request endpoint', async () => {
    const payload = { url: 'https://github.com/o/r/pull/9', number: 9 };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.openPullRequest('a1', 'Add a file', 'Closes #1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/pull-request', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ title: 'Add a file', body: 'Closes #1' }),
    });
  });

  it('debugContext GETs the session debug context', async () => {
    const payload = [{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'hi' }] }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.debugContext('a1', 's1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/sessions/s1/debug-context', JSON_HEADERS);
  });

  it('contextUsage GETs the session context usage', async () => {
    const payload = { usedTokens: 100, windowTokens: 200000, resolved: true, fraction: 0.0005 };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.contextUsage('a1', 's1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/sessions/s1/context-usage', JSON_HEADERS);
  });

  it('listModels GETs /api/models', async () => {
    const payload = [{ id: 'm1', label: 'Sonnet' }];
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.listModels()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/models', JSON_HEADERS);
  });

  it('createModel POSTs the profile body', async () => {
    const body: ProfileEdit = { label: 'Sonnet', provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-1', extraEnv: [] };
    const payload = { id: 'm1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.createModel(body)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/models', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('updateModel PATCHes the profile body', async () => {
    const body: ProfileEdit = { label: 'Renamed', provider: 'openai', model: 'gpt-6', extraEnv: [] };
    const payload = { id: 'm1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.updateModel('m1', body)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/models/m1', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  });

  it('deleteModel DELETEs the profile', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await expect(api.deleteModel('m1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/models/m1', { ...JSON_HEADERS, method: 'DELETE' });
  });

  it('setAgentModel PATCHes the chosen profile id', async () => {
    const payload = { id: 'a1', modelProfileId: 'm1' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setAgentModel('a1', 'm1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/model', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ modelProfileId: 'm1' }),
    });
  });

  it('setAgentModel PATCHes a null profile id to clear the override', async () => {
    const payload = { id: 'a1', modelProfileId: null };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setAgentModel('a1', null)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/agents/a1/model', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ modelProfileId: null }),
    });
  });

  it('setGoal POSTs the goal text and turn limit', async () => {
    const payload = { id: 'a1', goal: { goal: 'ship it', maxTurns: 5, turnsUsed: 0 } };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setGoal('a1', 'ship it', 5)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/goal', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ goal: 'ship it', maxTurns: 5 }),
    });
  });

  it('clearGoal DELETEs the goal', async () => {
    const payload = { id: 'a1', goal: null };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.clearGoal('a1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/goal', {
      ...JSON_HEADERS,
      method: 'DELETE',
    });
  });

  it('setCiTracking POSTs the PR reference', async () => {
    const payload = { id: 'a1', ciTracking: { prRef: 'o/r#1', lastState: 'unknown' } };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setCiTracking('a1', 'o/r#1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/ci-tracking', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ prRef: 'o/r#1' }),
    });
  });

  it('clearCiTracking DELETEs the tracking', async () => {
    const payload = { id: 'a1', ciTracking: null };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.clearCiTracking('a1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/ci-tracking', {
      ...JSON_HEADERS,
      method: 'DELETE',
    });
  });

  it('githubSettings GETs /api/github', async () => {
    const payload = { hasToken: false };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.githubSettings()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/github', JSON_HEADERS);
  });

  it('setGithubToken PATCHes the token', async () => {
    const payload = { hasToken: true };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setGithubToken('ghp_secret')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/github', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ token: 'ghp_secret' }),
    });
  });

  it('clearGithubToken DELETEs the token', async () => {
    const payload = { hasToken: false };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.clearGithubToken()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/github', { ...JSON_HEADERS, method: 'DELETE' });
  });

  it('setGithubPollInterval PATCHes the interval', async () => {
    const payload = { hasToken: true, pollIntervalSecs: 120 };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.setGithubPollInterval(120)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/github/poll-interval', {
      ...JSON_HEADERS,
      method: 'PATCH',
      body: JSON.stringify({ pollIntervalSecs: 120 }),
    });
  });

  it('fetchGithubIssue POSTs the issue reference', async () => {
    const payload = { title: 't', body: 'b', url: 'u', prompt: 'p' };
    fetchMock.mockResolvedValue(okResponse(payload));
    await expect(api.fetchGithubIssue('o/r#42')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/github/issue', {
      ...JSON_HEADERS,
      method: 'POST',
      body: JSON.stringify({ issueRef: 'o/r#42' }),
    });
  });
});

describe('ApiError', () => {
  it('throws with the status and the body text on a non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => 'name already taken',
      json: async () => ({}),
    });
    const error = await api.listAgents().then(
      () => {
        throw new Error('expected rejection');
      },
      (raised: unknown) => raised,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, message: 'name already taken' });
  });

  it('falls back to statusText when the body is empty', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => '',
      json: async () => ({}),
    });
    const error = await api.getAgent('a1').then(
      () => {
        throw new Error('expected rejection');
      },
      (raised: unknown) => raised,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, message: 'Service Unavailable' });
  });
});
