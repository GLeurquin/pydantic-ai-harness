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
