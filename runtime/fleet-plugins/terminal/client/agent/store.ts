import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { AgentClientState, AgentCliMetadata, SessionInfo, TurnState } from "./types.js";

type Listener = () => void;

const listeners = new Set<Listener>();

let state: AgentClientState = {
  connection: "connecting",
  connectionError: null,
  agentClis: [],
  sessions: {},
  sessionOrder: [],
  activeTerminalSessionId: null,
  turnState: {},
};

export function useAgentState(): AgentClientState {
  return useStoreSnapshot(subscribe, getAgentState);
}

export function getAgentState(): AgentClientState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAgentState(patch: Partial<AgentClientState>): void {
  state = { ...state, ...patch };
  emit();
}

export function hydrateAgentClis(agentClis: readonly AgentCliMetadata[]): void {
  setAgentState({ agentClis });
}

export function hydrateSessions(sessions: readonly SessionInfo[]): void {
  const byId: Record<string, SessionInfo> = {};
  for (const session of sessions) byId[session.sessionId] = session;
  setAgentState({
    sessions: byId,
    sessionOrder: [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId),
  });
}

export function applySessionUpdate(session: SessionInfo): void {
  const known = Boolean(state.sessions[session.sessionId]);
  setAgentState({
    sessions: { ...state.sessions, [session.sessionId]: session },
    sessionOrder: known ? state.sessionOrder : [session.sessionId, ...state.sessionOrder],
    turnState: { ...state.turnState, [session.sessionId]: session.turnState },
  });
}

export function removeSession(sessionId: string): void {
  const { [sessionId]: _removed, ...sessions } = state.sessions;
  const { [sessionId]: _turnRemoved, ...turnState } = state.turnState;
  setAgentState({
    sessions,
    sessionOrder: state.sessionOrder.filter((id) => id !== sessionId),
    activeTerminalSessionId: state.activeTerminalSessionId === sessionId ? null : state.activeTerminalSessionId,
    turnState,
  });
}

export function selectSession(sessionId: string | null): void {
  setAgentState({ activeTerminalSessionId: sessionId });
}

function emit(): void {
  for (const listener of listeners) listener();
}

