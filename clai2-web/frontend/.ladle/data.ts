/** Sample-data factories shared by the Ladle stories. Lives outside src/ so app coverage is unaffected. */

import type {
  AgentSummary,
  ApprovalView,
  PermissionOption,
  RedactedProfile,
  SessionSummary,
  ToolCallView,
  TranscriptItem,
  WorktreeDiff,
  WorktreeInfo,
} from '../src/api/types';

export function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    repoRoot: '/home/dev/projects/clai',
    path: '/home/dev/projects/clai-worktrees/fix-auth-bug',
    branch: 'clai/fix-auth-bug',
    baseBranch: 'main',
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-main',
    acpSessionId: 'acp-0001',
    label: 'Main',
    isMain: true,
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'agent-1',
    name: 'fix-auth-bug',
    status: 'idle',
    approvalMode: 'always_ask',
    worktree: null,
    cwd: '/home/dev/projects/clai',
    sessions: [makeSession()],
    pendingApprovals: 0,
    forkedFrom: null,
    modelProfileId: null,
    modelLabel: null,
    lastError: null,
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'profile-1',
    label: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
    ...overrides,
  };
}

export const sampleProfiles: RedactedProfile[] = [
  makeProfile(),
  makeProfile({ id: 'profile-2', label: 'GPT', provider: 'openai', model: 'gpt-6' }),
  makeProfile({
    id: 'profile-3',
    label: 'Vertex Gemini',
    provider: 'google_vertex',
    model: 'gemini-2.5-pro',
    hasApiKey: false,
    projectId: 'my-project',
    region: 'us-central1',
    hasCredentials: true,
    extraEnv: [
      { name: 'HTTP_PROXY', value: 'http://proxy:8080', secret: false },
      { name: 'VERTEX_TOKEN', value: null, secret: true },
    ],
  }),
];

export function makeToolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: 'tool-1',
    title: 'pytest tests/auth -x',
    kind: 'execute',
    status: 'pending',
    content: [],
    locations: [],
    ...overrides,
  };
}

export const fourOptions: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

export function makeApproval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'approval-1',
    agentId: 'agent-1',
    sessionId: 'session-main',
    toolCall: makeToolCall(),
    options: fourOptions,
    ...overrides,
  };
}

export const editDiffToolCall: ToolCallView = makeToolCall({
  toolCallId: 'tool-edit',
  title: 'Edit src/auth/session.py',
  kind: 'edit',
  status: 'completed',
  content: [
    {
      type: 'diff',
      path: 'src/auth/session.py',
      oldText: 'def refresh(token):\n    return decode(token)\n',
      newText: 'def refresh(token: str) -> Session:\n    return decode(token, verify_exp=True)\n',
    },
  ],
});

/** A rich transcript for an idle agent: user, thought, assistant, tool with diff, plan, turn end. */
export function richTranscript(): TranscriptItem[] {
  return [
    { type: 'userMessage', text: 'Fix the session refresh bug: expired tokens are accepted after refresh.' },
    {
      type: 'thoughtChunk',
      text: 'The refresh path decodes the token without checking expiry. ',
    },
    { type: 'thoughtChunk', text: 'I should pass verify_exp and add a regression test.' },
    { type: 'messageChunk', text: 'Found it: `refresh` decodes without expiry verification. ' },
    { type: 'messageChunk', text: 'Applying the fix and adding a test.' },
    { type: 'toolCall', toolCall: editDiffToolCall },
    {
      type: 'plan',
      entries: [
        { content: 'Reproduce the expired-token refresh', priority: 'high', status: 'completed' },
        { content: 'Fix decode() to verify expiry', priority: 'high', status: 'completed' },
        { content: 'Add regression test', priority: 'medium', status: 'in_progress' },
      ],
    },
    { type: 'turnEnded', stopReason: 'end_turn' },
  ];
}

/** A transcript mid-stream: the assistant is still typing and a tool is running. */
export function streamingTranscript(): TranscriptItem[] {
  return [
    { type: 'userMessage', text: 'Run the auth test suite and fix anything red.' },
    { type: 'thoughtChunk', text: 'Running the suite first to see the failures.' },
    {
      type: 'toolCall',
      toolCall: makeToolCall({
        toolCallId: 'tool-run',
        title: 'pytest tests/auth',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'text', text: 'collected 42 items\n\ntests/auth/test_session.py ....F' }],
      }),
    },
    { type: 'messageChunk', text: 'One failure in test_refresh_expired, digging in' },
  ];
}

export const sampleDiff: WorktreeDiff = {
  status: ' M src/auth/session.py\n M tests/auth/test_session.py\n?? tests/auth/test_refresh.py',
  diff: [
    'diff --git a/src/auth/session.py b/src/auth/session.py',
    'index 3f1a2bc..9e04d71 100644',
    '--- a/src/auth/session.py',
    '+++ b/src/auth/session.py',
    '@@ -12,7 +12,7 @@ class SessionStore:',
    ' def refresh(token: str) -> Session:',
    '-    payload = decode(token)',
    '+    payload = decode(token, verify_exp=True)',
    '     return Session.from_payload(payload)',
    '',
    'diff --git a/tests/auth/test_session.py b/tests/auth/test_session.py',
    'index 88ac001..b71f3aa 100644',
    '--- a/tests/auth/test_session.py',
    '+++ b/tests/auth/test_session.py',
    '@@ -30,6 +30,10 @@ def test_refresh_valid():',
    '     assert session.user_id == "u1"',
    '+',
    '+def test_refresh_expired():',
    '+    with pytest.raises(ExpiredToken):',
    '+        refresh(EXPIRED_TOKEN)',
  ].join('\n'),
  untrackedDiff: [
    'diff --git a/tests/auth/test_refresh.py b/tests/auth/test_refresh.py',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/tests/auth/test_refresh.py',
    '@@ -0,0 +1,3 @@',
    '+def test_refresh_roundtrip():',
    '+    session = refresh(issue("u1"))',
    '+    assert session.user_id == "u1"',
  ].join('\n'),
};

export const emptyDiff: WorktreeDiff = { diff: '', untrackedDiff: '', status: '' };
