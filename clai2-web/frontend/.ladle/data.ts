/** Sample-data factories shared by the Ladle stories. Lives outside src/ so app coverage is unaffected. */

import type {
  AgentSummary,
  ApprovalView,
  PermissionOption,
  ProjectSummary,
  RedactedProfile,
  SessionSummary,
  ToolCallView,
  TranscriptItem,
  WorktreeDiff,
  WorktreeInfo,
} from '../src/api/types';

export function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1',
    name: 'clai',
    repoRoot: '/home/dev/projects/clai',
    ...overrides,
  };
}

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
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'agent-1',
    name: 'fix-auth-bug',
    projectId: 'project-1',
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
    goal: null,
    ciTracking: null,
    folderId: null,
    isStub: false,
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'model-anthropic',
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
  makeProfile({
    id: 'model-openai',
    label: 'GPT-6',
    provider: 'openai',
    model: 'gpt-6',
    hasApiKey: true,
  }),
  makeProfile({
    id: 'model-vertex',
    label: 'Vertex Gemini',
    provider: 'google_vertex',
    model: 'gemini-2.5-pro',
    hasApiKey: false,
    projectId: 'my-gcp-project',
    region: 'us-central1',
    hasCredentials: true,
    extraEnv: [
      { name: 'GOOGLE_CLOUD_QUOTA_PROJECT', value: 'billing-project', secret: false },
      { name: 'VERTEX_API_TOKEN', value: null, secret: true },
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
    {
      type: 'turnEnded',
      stopReason: 'end_turn',
      usage: { inputTokens: 4200, outputTokens: 860, totalTokens: 5060, cachedReadTokens: 0, cachedWriteTokens: 0 },
    },
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

/** A transcript exercising markdown rendering: a fenced code block, a table, a task list, and a link. */
export function markdownTranscript(): TranscriptItem[] {
  return [
    { type: 'userMessage', text: 'Summarize the fix and show me the patch.' },
    {
      type: 'messageChunk',
      text:
        "Here's the fix:\n\n" +
        '```python\n' +
        'def decode(token: str) -> Claims:\n' +
        '    return jwt.decode(token, KEY, algorithms=["HS256"], options={"verify_exp": True})\n' +
        '```\n\n' +
        '| Check | Status |\n' +
        '| --- | --- |\n' +
        '| Expiry verified | done |\n' +
        '| Regression test | done |\n\n' +
        '- [x] Fix `decode()`\n' +
        '- [ ] Backport to the 1.x branch\n\n' +
        'See the [JWT spec](https://www.rfc-editor.org/rfc/rfc7519) for background.',
    },
    {
      type: 'turnEnded',
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, cachedReadTokens: 0, cachedWriteTokens: 0 },
    },
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
