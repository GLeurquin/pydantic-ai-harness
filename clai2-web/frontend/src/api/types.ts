/** Wire contract with the backend. Mirrors the server's serde model exactly. */

export type ApprovalMode = 'always_ask' | 'accept_edits' | 'auto';

export type AgentStatus = 'starting' | 'idle' | 'working' | 'waiting_approval' | 'error' | 'archived';

export interface WorktreeInfo {
  repoRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
}

export interface SessionSummary {
  id: string;
  acpSessionId: string | null;
  label: string;
  isMain: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  approvalMode: ApprovalMode;
  worktree: WorktreeInfo | null;
  cwd: string;
  sessions: SessionSummary[];
  pendingApprovals: number;
  forkedFrom: string | null;
  lastError: string | null;
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
  | { type: 'turnEnded'; stopReason: StopReason }
  | { type: 'error'; message: string };

export type ServerEvent =
  | { type: 'agentAdded'; agent: AgentSummary }
  | { type: 'agentUpdated'; agent: AgentSummary }
  | { type: 'agentRemoved'; agentId: string }
  | { type: 'userMessage'; agentId: string; sessionId: string; text: string }
  | { type: 'messageChunk'; agentId: string; sessionId: string; text: string }
  | { type: 'thoughtChunk'; agentId: string; sessionId: string; text: string }
  | { type: 'toolCall'; agentId: string; sessionId: string; toolCall: ToolCallView }
  | { type: 'plan'; agentId: string; sessionId: string; entries: PlanEntry[] }
  | { type: 'approvalRequested'; approval: ApprovalView }
  | { type: 'approvalResolved'; approvalId: string; agentId: string; optionId: string | null }
  | { type: 'turnEnded'; agentId: string; sessionId: string; stopReason: StopReason }
  | { type: 'agentError'; agentId: string; message: string };

export interface CreateAgentRequest {
  name: string;
  useWorktree: boolean;
  baseBranch?: string;
  approvalMode: ApprovalMode;
}

export interface ForkAgentRequest {
  name: string;
}

export interface WorktreeDiff {
  diff: string;
  untrackedDiff: string;
  status: string;
}
