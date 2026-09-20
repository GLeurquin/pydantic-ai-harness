/** Thin fetch wrapper over the backend REST surface. */

import type {
  AgentSummary,
  ApprovalView,
  CreateAgentRequest,
  CreateProjectRequest,
  FetchedIssue,
  FolderSummary,
  ForkAgentRequest,
  ApprovalMode,
  ProfileEdit,
  ProjectSummary,
  RedactedGithubSettings,
  RedactedProfile,
  TranscriptItem,
  WorktreeDiff,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body || response.statusText);
  }
  return (await response.json()) as T;
}

export const api = {
  listAgents: () => request<AgentSummary[]>('/api/agents'),

  createAgent: (body: CreateAgentRequest) =>
    request<AgentSummary>('/api/agents', { method: 'POST', body: JSON.stringify(body) }),

  getAgent: (agentId: string) => request<AgentSummary>(`/api/agents/${agentId}`),

  archiveAgent: (agentId: string, removeWorktree: boolean) =>
    request<AgentSummary>(`/api/agents/${agentId}?removeWorktree=${removeWorktree}`, {
      method: 'DELETE',
    }),

  prompt: (agentId: string, sessionId: string, text: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  cancel: (agentId: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/cancel`, { method: 'POST' }),

  fork: (agentId: string, body: ForkAgentRequest) =>
    request<AgentSummary>(`/api/agents/${agentId}/fork`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  openSideSession: (agentId: string, label: string) =>
    request<AgentSummary>(`/api/agents/${agentId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  setApprovalMode: (agentId: string, approvalMode: ApprovalMode) =>
    request<AgentSummary>(`/api/agents/${agentId}/approval-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ approvalMode }),
    }),

  rename: (agentId: string, name: string) =>
    request<AgentSummary>(`/api/agents/${agentId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  listProjects: () => request<ProjectSummary[]>('/api/projects'),

  createProject: (body: CreateProjectRequest) =>
    request<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),

  deleteProject: (projectId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  listFolders: () => request<FolderSummary[]>('/api/folders'),

  createFolder: (name: string) => request<FolderSummary>('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }),

  deleteFolder: (folderId: string) =>
    request<{ ok: boolean }>(`/api/folders/${folderId}`, { method: 'DELETE' }),

  setAgentFolder: (agentId: string, folderId: string | null) =>
    request<AgentSummary>(`/api/agents/${agentId}/folder`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    }),

  pendingApprovals: () => request<ApprovalView[]>('/api/approvals'),

  resolveApproval: (approvalId: string, optionId: string) =>
    request<{ ok: boolean }>(`/api/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    }),

  transcript: (agentId: string, sessionId: string) =>
    request<TranscriptItem[]>(`/api/agents/${agentId}/sessions/${sessionId}/transcript`),

  diff: (agentId: string) => request<WorktreeDiff>(`/api/agents/${agentId}/diff`),

  listModels: () => request<RedactedProfile[]>('/api/models'),

  createModel: (body: ProfileEdit) =>
    request<RedactedProfile>('/api/models', { method: 'POST', body: JSON.stringify(body) }),

  updateModel: (modelId: string, body: ProfileEdit) =>
    request<RedactedProfile>(`/api/models/${modelId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteModel: (modelId: string) =>
    request<{ ok: boolean }>(`/api/models/${modelId}`, { method: 'DELETE' }),

  setAgentModel: (agentId: string, modelProfileId: string | null) =>
    request<AgentSummary>(`/api/agents/${agentId}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ modelProfileId }),
    }),

  setGoal: (agentId: string, goal: string, maxTurns: number) =>
    request<AgentSummary>(`/api/agents/${agentId}/goal`, {
      method: 'POST',
      body: JSON.stringify({ goal, maxTurns }),
    }),

  clearGoal: (agentId: string) =>
    request<AgentSummary>(`/api/agents/${agentId}/goal`, { method: 'DELETE' }),

  setCiTracking: (agentId: string, prRef: string) =>
    request<AgentSummary>(`/api/agents/${agentId}/ci-tracking`, {
      method: 'POST',
      body: JSON.stringify({ prRef }),
    }),

  clearCiTracking: (agentId: string) =>
    request<AgentSummary>(`/api/agents/${agentId}/ci-tracking`, { method: 'DELETE' }),

  githubSettings: () => request<RedactedGithubSettings>('/api/github'),

  setGithubToken: (token: string) =>
    request<RedactedGithubSettings>('/api/github', { method: 'PATCH', body: JSON.stringify({ token }) }),

  clearGithubToken: () => request<RedactedGithubSettings>('/api/github', { method: 'DELETE' }),

  setGithubPollInterval: (pollIntervalSecs: number) =>
    request<RedactedGithubSettings>('/api/github/poll-interval', {
      method: 'PATCH',
      body: JSON.stringify({ pollIntervalSecs }),
    }),

  fetchGithubIssue: (issueRef: string) =>
    request<FetchedIssue>('/api/github/issue', { method: 'POST', body: JSON.stringify({ issueRef }) }),
};
