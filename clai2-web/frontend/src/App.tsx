import { useCallback, useEffect, useState } from 'react';

import { api } from './api/client';
import type { CreateAgentRequest } from './api/types';
import { errorMessage } from './errors';
import { GoalDialog } from './components/GoalDialog';
import { Header } from './components/Header';
import { MainPane } from './components/MainPane';
import { ModelsDialog } from './components/ModelsDialog';
import { NameDialog } from './components/NameDialog';
import { NewAgentDialog } from './components/NewAgentDialog';
import { NotificationTray } from './components/NotificationTray';
import { Sidebar } from './components/Sidebar';
import { transcriptKey } from './state/transcript';
import { useAppStore } from './state/store';
import { connectWs, wsUrl } from './ws';

type Dialog = 'none' | 'new-agent' | 'fork' | 'side-session' | 'models' | 'goal';

/** Fire a write action; a rejection surfaces as a notification instead of
 * vanishing. The rest of the UI does not wait on it. */
function runAction(promise: Promise<unknown>): void {
  promise.catch((failure: unknown) => useAppStore.getState().notifyError(errorMessage(failure)));
}

export function App() {
  const store = useAppStore();
  const [dialog, setDialog] = useState<Dialog>('none');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const selected = store.agents.find((agent) => agent.id === store.selectedAgentId) ?? null;

  useEffect(() => {
    const connection = connectWs(wsUrl(window.location), {
      onSnapshot: useAppStore.getState().applySnapshot,
      onEvent: useAppStore.getState().applyEvent,
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

  const setGithubToken = async (token: string) => {
    const settings = await api.setGithubToken(token);
    useAppStore.getState().setGithubSettings(settings);
  };

  return (
    <div className="app">
      <NotificationTray notifications={store.notifications} onDismiss={store.dismissNotification} />
      <Header
        connected={store.connected}
        approvals={store.approvals}
        agents={store.agents}
        onResolveApproval={resolveApproval}
        onManageModels={() => setDialog('models')}
        onToggleSidebar={() => setSidebarOpen((current) => !current)}
      />
      <div className={sidebarOpen ? 'sidebar-backdrop open' : 'sidebar-backdrop'} onClick={() => setSidebarOpen(false)} />
      <Sidebar
        agents={store.agents}
        projects={store.projects}
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
          models={store.models}
          onSetApprovalMode={(mode) => runAction(api.setApprovalMode(selected.id, mode))}
          onSetModel={(modelProfileId) => runAction(api.setAgentModel(selected.id, modelProfileId))}
          onManageModels={() => setDialog('models')}
          onArchive={(removeWorktree) => runAction(api.archiveAgent(selected.id, removeWorktree))}
          onRename={(name) => runAction(api.rename(selected.id, name))}
          onSetGoal={() => setDialog('goal')}
          onClearGoal={() => runAction(api.clearGoal(selected.id))}
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
          onSetGithubToken={setGithubToken}
          onClose={() => setDialog('none')}
          onManageModels={() => setDialog('models')}
        />
      ) : null}
      {dialog === 'models' ? (
        <ModelsDialog onClose={() => setDialog('none')} onChanged={useAppStore.getState().setModels} />
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
