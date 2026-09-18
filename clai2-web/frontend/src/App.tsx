import { useCallback, useEffect, useState } from 'react';

import { api } from './api/client';
import type { CreateAgentRequest } from './api/types';
import { Header } from './components/Header';
import { MainPane } from './components/MainPane';
import { ModelsDialog } from './components/ModelsDialog';
import { NameDialog } from './components/NameDialog';
import { NewAgentDialog } from './components/NewAgentDialog';
import { Sidebar } from './components/Sidebar';
import { transcriptKey } from './state/transcript';
import { useAppStore } from './state/store';
import { connectWs, wsUrl } from './ws';

export const MAX_AGENTS = 50;

type Dialog = 'none' | 'new-agent' | 'fork' | 'side-session' | 'models';

export function App() {
  const store = useAppStore();
  const [dialog, setDialog] = useState<Dialog>('none');
  const selected = store.agents.find((agent) => agent.id === store.selectedAgentId) ?? null;

  useEffect(() => {
    const connection = connectWs(wsUrl(window.location), {
      onSnapshot: useAppStore.getState().applySnapshot,
      onEvent: useAppStore.getState().applyEvent,
      onConnected: useAppStore.getState().setConnected,
    });
    void api.listModels().then(useAppStore.getState().setModels, () => undefined);
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
    void api.resolveApproval(approvalId, optionId);
  }, []);

  const loadDiff = useCallback((agentId: string) => api.diff(agentId), []);

  const createAgent = async (request: CreateAgentRequest) => {
    const agent = await api.createAgent(request);
    useAppStore.getState().applyEvent({ type: 'agentAdded', agent });
    useAppStore.getState().selectAgent(agent.id);
  };

  return (
    <div className="app">
      <Header
        connected={store.connected}
        approvals={store.approvals}
        agents={store.agents}
        onResolveApproval={resolveApproval}
        onManageModels={() => setDialog('models')}
      />
      <Sidebar
        agents={store.agents}
        selectedAgentId={store.selectedAgentId}
        maxAgents={MAX_AGENTS}
        onSelect={store.selectAgent}
        onNewAgent={() => setDialog('new-agent')}
      />
      {selected ? (
        <MainPane
          agent={selected}
          view={store.view}
          approvals={store.approvals}
          transcriptFor={(sessionId) => store.transcripts[transcriptKey(selected.id, sessionId)] ?? []}
          onSetView={store.setView}
          onPrompt={(sessionId, text) => void api.prompt(selected.id, sessionId, text)}
          onCancel={() => void api.cancel(selected.id)}
          onResolveApproval={resolveApproval}
          onFork={() => setDialog('fork')}
          onSideSession={() => setDialog('side-session')}
          loadDiff={loadDiff}
          models={store.models}
          onSetApprovalMode={(mode) => void api.setApprovalMode(selected.id, mode)}
          onSetModel={(modelProfileId) => void api.setAgentModel(selected.id, modelProfileId)}
          onManageModels={() => setDialog('models')}
          onArchive={(removeWorktree) => void api.archiveAgent(selected.id, removeWorktree)}
        />
      ) : (
        <main className="main">
          <div className="main-empty">Start an agent to get going.</div>
        </main>
      )}
      {dialog === 'new-agent' ? (
        <NewAgentDialog
          models={store.models}
          onCreate={createAgent}
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
