/** Wire contract with the backend. Mirrors the server's serde model exactly. */

export type ApprovalMode = 'always_ask' | 'accept_edits' | 'auto';

export type AgentStatus = 'starting' | 'idle' | 'working' | 'waiting_approval' | 'error' | 'archived';

export interface WorktreeInfo {
  repoRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
}

/** A repository agents can be created in. */
export interface ProjectSummary {
  id: string;
  name: string;
  repoRoot: string;
}

export interface SessionSummary {
  id: string;
  acpSessionId: string | null;
  label: string;
  isMain: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

/** Token usage for one completed turn, reported by the model provider. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  projectId: string;
  status: AgentStatus;
  approvalMode: ApprovalMode;
  worktree: WorktreeInfo | null;
  cwd: string;
  sessions: SessionSummary[];
  pendingApprovals: number;
  forkedFrom: string | null;
  modelProfileId: string | null;
  modelLabel: string | null;
  lastError: string | null;
  goal: GoalConfig | null;
}

/** An autonomous goal an agent works toward turn-over-turn on its own. */
export interface GoalConfig {
  goal: string;
  maxTurns: number;
  turnsUsed: number;
}

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'google_gla'
  | 'google_vertex'
  | 'bedrock'
  | 'azure'
  | 'custom';

export interface RedactedEnvVar {
  name: string;
  /** Present only for non-secret entries. */
  value: string | null;
  secret: boolean;
}

export interface RedactedProfile {
  id: string;
  label: string;
  provider: Provider;
  model: string;
  hasApiKey: boolean;
  projectId: string | null;
  region: string | null;
  hasCredentials: boolean;
  extraEnv: RedactedEnvVar[];
}

/** One env entry in a create/edit request. Omit `value` to keep a stored secret. */
export interface EnvEdit {
  name: string;
  value?: string;
  secret: boolean;
}

/** Body for creating or editing a model profile. Secret fields are optional. */
export interface ProfileEdit {
  label: string;
  provider: Provider;
  model: string;
  apiKey?: string;
  projectId?: string;
  region?: string;
  credentialsJson?: string;
  extraEnv: EnvEdit[];
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
}

export interface ApprovalView {
  id: string;
  agentId: string;
  sessionId: string;
  toolCall: ToolCallView;
  options: PermissionOption[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export type TranscriptItem =
  | { type: 'userMessage'; text: string }
  | { type: 'messageChunk'; text: string }
  | { type: 'thoughtChunk'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallView }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'turnEnded'; stopReason: StopReason; usage: TurnUsage | null }
  | { type: 'error'; message: string };

export type ServerEvent =
  | { type: 'agentAdded'; agent: AgentSummary }
  | { type: 'agentUpdated'; agent: AgentSummary }
  | { type: 'agentRemoved'; agentId: string }
  | { type: 'projectAdded'; project: ProjectSummary }
  | { type: 'projectRemoved'; projectId: string }
  | { type: 'userMessage'; agentId: string; sessionId: string; text: string }
  | { type: 'messageChunk'; agentId: string; sessionId: string; text: string }
  | { type: 'thoughtChunk'; agentId: string; sessionId: string; text: string }
  | { type: 'toolCall'; agentId: string; sessionId: string; toolCall: ToolCallView }
  | { type: 'plan'; agentId: string; sessionId: string; entries: PlanEntry[] }
  | { type: 'approvalRequested'; approval: ApprovalView }
  | { type: 'approvalResolved'; approvalId: string; agentId: string; optionId: string | null }
  | { type: 'turnEnded'; agentId: string; sessionId: string; stopReason: StopReason; usage: TurnUsage | null }
  | { type: 'agentError'; agentId: string; message: string };

export interface CreateAgentRequest {
  name: string;
  projectId: string;
  useWorktree: boolean;
  baseBranch?: string;
  approvalMode: ApprovalMode;
  modelProfileId?: string;
}

export interface CreateProjectRequest {
  name: string;
  path: string;
}

export interface ForkAgentRequest {
  name: string;
}

export interface WorktreeDiff {
  diff: string;
  untrackedDiff: string;
  status: string;
}
