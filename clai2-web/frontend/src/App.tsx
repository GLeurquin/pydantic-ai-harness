import { useCallback, useEffect, useState } from 'react';

import { api } from './api/client';
import type { AgentSummary, CreateAgentRequest, ProfileEdit, ServerEvent } from './api/types';
import { errorMessage } from './errors';
import { notify } from './notify';
import { CiTrackingDialog } from './components/CiTrackingDialog';
import { CommitDialog } from './components/CommitDialog';
import { DebugContextDialog } from './components/DebugContextDialog';
import { FoldersDialog } from './components/FoldersDialog';
import { GithubSettingsDialog } from './components/GithubSettingsDialog';
import { GoalDialog } from './components/GoalDialog';
import { Header } from './components/Header';
import { MainPane } from './components/MainPane';
import { ModelsDialog } from './components/ModelsDialog';
import { NameDialog } from './components/NameDialog';
import { NewAgentDialog } from './components/NewAgentDialog';
import { NotificationTray } from './components/NotificationTray';
import { ProjectsDialog } from './components/ProjectsDialog';
import { Sidebar } from './components/Sidebar';
import { transcriptKey } from './state/transcript';
import { useAppStore } from './state/store';
import { connectWs, wsUrl } from './ws';

type Dialog =
  | 'none'
  | 'new-agent'
  | 'fork'
  | 'side-session'
  | 'models'
  | 'goal'
  | 'github'
  | 'ci-tracking'
  | 'projects'
  | 'folders'
  | 'debug-context'
  | 'commit';

/** Fire a write action; a rejection surfaces as a notification instead of
 * vanishing. The rest of the UI does not wait on it. */
function runAction(promise: Promise<unknown>): void {
  promise.catch((failure: unknown) => useAppStore.getState().notifyError(errorMessage(failure)));
}

/** Browser-notification side effect for a subset of server events, run against the state as
 * it stood *before* this event applies (so an agentUpdated can tell whether the goal it just
 * cleared was actually active). Kept outside the store: `notify()` reaches out to a genuine
 * browser API, unlike `reduceEvent`'s pure state transitions. */
function notifyOnServerEvent(event: ServerEvent, agentsBeforeUpdate: AgentSummary[]): void {
  if (event.type === 'approvalRequested') {
    const agentName = agentsBeforeUpdate.find((agent) => agent.id === event.approval.agentId)?.name ?? 'An agent';
    notify('Approval needed', `${agentName} is waiting for a decision.`);
    return;
  }
  if (event.type === 'agentUpdated') {
    const previous = agentsBeforeUpdate.find((agent) => agent.id === event.agent.id);
    if (previous?.goal && !event.agent.goal) {
      notify('Goal finished', `${event.agent.name}'s autonomous goal loop stopped.`);
    }
  }
}

export function App() {
  const store = useAppStore();
  const [dialog, setDialog] = useState<Dialog>('none');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [debugContextSessionId, setDebugContextSessionId] = useState<string | null>(null);
  const [commitDefaultMessage, setCommitDefaultMessage] = useState('');
  const [diffVersion, setDiffVersion] = useState(0);
  const selected = store.agents.find((agent) => agent.id === store.selectedAgentId) ?? null;

  useEffect(() => {
    const connection = connectWs(wsUrl(window.location), {
      onSnapshot: useAppStore.getState().applySnapshot,
      onEvent: (event) => {
        notifyOnServerEvent(event, useAppStore.getState().agents);
        useAppStore.getState().applyEvent(event);
      },
      onConnected: useAppStore.getState().setConnected,
    });
    void api.listModels().then(useAppStore.getState().setModels, () => undefined);
    void api.githubSettings().then(useAppStore.getState().setGithubSettings, () => undefined);
    return connection.close;
  }, []);

  // Load the selected session's persisted transcript once.
  const selectedAgentId = selected?.id ?? null;
  const viewSessionId = store.view.kind === 'session' ? store.view.sessionId : null;
  useEffect(() => {
    if (!selectedAgentId || !viewSessionId) {
      return;
    }
    const key = transcriptKey(selectedAgentId, viewSessionId);
    const { transcripts, setTranscript } = useAppStore.getState();
    const existing = transcripts[key];
    if (existing !== undefined) {
      return;
    }
    void api.transcript(selectedAgentId, viewSessionId).then(
      (items) => {
        const live = useAppStore.getState().transcripts[key] ?? [];
        // Persistence happens before publishing, so the fetched transcript is
        // a superset of live events observed before the fetch completed.
        if (items.length >= live.length) {
          setTranscript(selectedAgentId, viewSessionId, items);
        }
      },
      () => undefined,
    );
  }, [selectedAgentId, viewSessionId]);

  const resolveApproval = useCallback((approvalId: string, optionId: string) => {
    runAction(api.resolveApproval(approvalId, optionId));
  }, []);

  const loadDiff = useCallback((agentId: string) => api.diff(agentId), []);

  const loadDebugContext = useCallback((agentId: string, sessionId: string) => api.debugContext(agentId, sessionId), []);

  const loadContextUsage = useCallback((agentId: string, sessionId: string) => api.contextUsage(agentId, sessionId), []);

  const createAgent = async (request: CreateAgentRequest) => {
    const agent = await api.createAgent(request);
    useAppStore.getState().applyEvent({ type: 'agentAdded', agent });
    useAppStore.getState().selectAgent(agent.id);
  };

  const createProject = async (name: string, path: string) => {
    const project = await api.createProject({ name, path });
    useAppStore.getState().applyEvent({ type: 'projectAdded', project });
    return project;
  };

  const deleteProject = async (projectId: string) => {
    await api.deleteProject(projectId);
    useAppStore.getState().applyEvent({ type: 'projectRemoved', projectId });
  };

  const createFolder = async (name: string) => {
    const folder = await api.createFolder(name);
    useAppStore.getState().applyEvent({ type: 'folderAdded', folder });
    return folder;
  };

  const deleteFolder = async (folderId: string) => {
    await api.deleteFolder(folderId);
    useAppStore.getState().applyEvent({ type: 'folderRemoved', folderId });
  };

  const createModel = async (body: ProfileEdit) => {
    const created = await api.createModel(body);
    useAppStore.getState().setModels([...useAppStore.getState().models, created]);
    return created;
  };

  const updateModel = async (profileId: string, body: ProfileEdit) => {
    const updated = await api.updateModel(profileId, body);
    useAppStore.getState().setModels(useAppStore.getState().models.map((profile) => (profile.id === updated.id ? updated : profile)));
    return updated;
  };

  const deleteModel = async (profileId: string) => {
    await api.deleteModel(profileId);
    useAppStore.getState().setModels(useAppStore.getState().models.filter((profile) => profile.id !== profileId));
  };

  const saveGithubToken = async (token: string) => {
    useAppStore.getState().setGithubSettings(await api.setGithubToken(token));
  };

  const clearGithubToken = async () => {
    useAppStore.getState().setGithubSettings(await api.clearGithubToken());
  };

  const saveGithubPollInterval = async (pollIntervalSecs: number) => {
    useAppStore.getState().setGithubSettings(await api.setGithubPollInterval(pollIntervalSecs));
  };

  return (
    <div className="app">
      <NotificationTray notifications={store.notifications} onDismiss={store.dismissNotification} />
      <Header
        connected={store.connected}
        approvals={store.approvals}
        agents={store.agents}
        onResolveApproval={resolveApproval}
        onManageProjects={() => setDialog('projects')}
        onManageModels={() => setDialog('models')}
        onManageGithub={() => setDialog('github')}
        onToggleSidebar={() => setSidebarOpen((current) => !current)}
      />
      <div className={sidebarOpen ? 'sidebar-backdrop open' : 'sidebar-backdrop'} onClick={() => setSidebarOpen(false)} />
      <Sidebar
        agents={store.agents}
        projects={store.projects}
        folders={store.folders}
        selectedProjectId={store.selectedProjectId}
        selectedAgentId={store.selectedAgentId}
        maxAgents={store.maxAgents}
        open={sidebarOpen}
        onSelect={(agentId) => {
          store.selectAgent(agentId);
          setSidebarOpen(false);
        }}
        onSelectProject={store.selectProjectFilter}
        onNewAgent={() => setDialog('new-agent')}
      />
      {selected ? (
        <MainPane
          agent={selected}
          view={store.view}
          approvals={store.approvals}
          transcriptFor={(sessionId) => store.transcripts[transcriptKey(selected.id, sessionId)] ?? []}
          onSetView={store.setView}
          onPrompt={(sessionId, text) => runAction(api.prompt(selected.id, sessionId, text))}
          onCancel={() => runAction(api.cancel(selected.id))}
          onResolveApproval={resolveApproval}
          onFork={() => setDialog('fork')}
          onSideSession={() => setDialog('side-session')}
          loadDiff={loadDiff}
          loadContextUsage={loadContextUsage}
          diffVersion={diffVersion}
          onCommit={(defaultMessage) => {
            setCommitDefaultMessage(defaultMessage);
            setDialog('commit');
          }}
          models={store.models}
          folders={store.folders}
          onSetApprovalMode={(mode) => runAction(api.setApprovalMode(selected.id, mode))}
          onSetModel={(modelProfileId) => runAction(api.setAgentModel(selected.id, modelProfileId))}
          onManageModels={() => setDialog('models')}
          onSetFolder={(folderId) => runAction(api.setAgentFolder(selected.id, folderId))}
          onManageFolders={() => setDialog('folders')}
          onArchive={(removeWorktree) => runAction(api.archiveAgent(selected.id, removeWorktree))}
          onRename={(name) => runAction(api.rename(selected.id, name))}
          onSetGoal={() => setDialog('goal')}
          onClearGoal={() => runAction(api.clearGoal(selected.id))}
          onSetCiTracking={() => setDialog('ci-tracking')}
          onClearCiTracking={() => runAction(api.clearCiTracking(selected.id))}
          onViewDebugContext={(sessionId) => {
            setDebugContextSessionId(sessionId);
            setDialog('debug-context');
          }}
        />
      ) : (
        <main className="main">
          <div className="main-empty">Start an agent to get going.</div>
        </main>
      )}
      {dialog === 'new-agent' ? (
        <NewAgentDialog
          models={store.models}
          projects={store.projects}
          {...(store.selectedProjectId !== 'all' ? { defaultProjectId: store.selectedProjectId } : {})}
          githubSettings={store.githubSettings}
          onCreate={createAgent}
          onCreateProject={createProject}
          onFetchGithubIssue={api.fetchGithubIssue}
          onClose={() => setDialog('none')}
          onManageModels={() => setDialog('models')}
          onManageGithub={() => setDialog('github')}
        />
      ) : null}
      {dialog === 'projects' ? (
        <ProjectsDialog
          projects={store.projects}
          onCreateProject={createProject}
          onDeleteProject={deleteProject}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'folders' ? (
        <FoldersDialog
          folders={store.folders}
          onCreateFolder={createFolder}
          onDeleteFolder={deleteFolder}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'models' ? (
        <ModelsDialog
          profiles={store.models}
          onCreate={createModel}
          onUpdate={updateModel}
          onDelete={deleteModel}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'github' ? (
        <GithubSettingsDialog
          settings={store.githubSettings}
          onSaveToken={saveGithubToken}
          onClearToken={clearGithubToken}
          onSavePollInterval={saveGithubPollInterval}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'fork' && selected ? (
        <NameDialog
          title={`Fork ${selected.name}`}
          placeholder={`${selected.name} fork`}
          submitLabel="Fork agent"
          onSubmit={async (name) => {
            const fork = await api.fork(selected.id, { name });
            useAppStore.getState().applyEvent({ type: 'agentAdded', agent: fork });
            useAppStore.getState().selectAgent(fork.id);
          }}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'goal' && selected ? (
        <GoalDialog
          agentName={selected.name}
          // Applying the response directly (like fork/side-session do) would
          // race the WS stream: a goal can run and clear itself before this
          // request even returns, and a stale "just set" snapshot applied
          // after that would clobber the real, newer state back to active.
          // The WS stream alone is both sufficient and race-free here.
          onSubmit={(goal, maxTurns) => api.setGoal(selected.id, goal, maxTurns).then(() => undefined)}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'ci-tracking' && selected ? (
        <CiTrackingDialog
          agentName={selected.name}
          // Same WS-only race avoidance as the goal dialog above: don't
          // manually apply the response, rely on the broadcast update.
          onSubmit={(prRef) => api.setCiTracking(selected.id, prRef).then(() => undefined)}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'debug-context' && selected && debugContextSessionId ? (
        <DebugContextDialog
          agentId={selected.id}
          sessionId={debugContextSessionId}
          agentName={selected.name}
          sessionLabel={selected.sessions.find((session) => session.id === debugContextSessionId)?.label ?? debugContextSessionId}
          loadDebugContext={loadDebugContext}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'commit' && selected ? (
        <CommitDialog
          agentName={selected.name}
          defaultMessage={commitDefaultMessage}
          onCommit={(message) => api.commit(selected.id, message).then(() => setDiffVersion((version) => version + 1))}
          onOpenPullRequest={(title, body) => api.openPullRequest(selected.id, title, body)}
          onClose={() => setDialog('none')}
        />
      ) : null}
      {dialog === 'side-session' && selected ? (
        <NameDialog
          title="Side conversation"
          placeholder="Ask about the approach"
          submitLabel="Open"
          onSubmit={async (label) => {
            const updated = await api.openSideSession(selected.id, label);
            useAppStore.getState().applyEvent({ type: 'agentUpdated', agent: updated });
            const session = updated.sessions[updated.sessions.length - 1];
            if (session) {
              useAppStore.getState().setView({ kind: 'session', sessionId: session.id });
            }
          }}
          onClose={() => setDialog('none')}
        />
      ) : null}
    </div>
  );
}
