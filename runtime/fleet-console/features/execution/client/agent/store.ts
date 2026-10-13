import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { AgentClientState, AgentCliMetadata, SessionInfo, SessionStep, TurnState } from "./types.js";

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
  for (const incoming of sessions) {
    const session = splitSessionStep(incoming);
    byId[session.sessionId] = session;
  }
  setAgentState({
    sessions: byId,
    sessionOrder: [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId),
  });
}

export function applySessionUpdate(incoming: SessionInfo): void {
  const session = splitSessionStep(incoming);
  // 지금 하는 일(step)만 바뀐 프레임은 세션 목록을 갈아 끼우지 않는다 — 목록을 구독하는 모든 표면이 다시 그려지지 않게,
  // 계열은 Operation 별 구독(`useSessionStep`)으로만 흐른다. Chat 턴 동안 이 프레임이 대부분이다.
  const current = state.sessions[session.sessionId];
  if (current && sameSessionInfo(current, session)) return;
  const known = Boolean(current);
  setAgentState({
    sessions: { ...state.sessions, [session.sessionId]: session },
    sessionOrder: known ? state.sessionOrder : [session.sessionId, ...state.sessionOrder],
    turnState: { ...state.turnState, [session.sessionId]: session.turnState },
  });
}

export function removeSession(sessionId: string): void {
  setSessionStep(sessionId, undefined);
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


// ── 지금 하는 일(step) — 세션 목록과 따로 산다. 몽글 아바타만 Operation 하나씩 구독한다. ──

const steps = new Map<string, SessionStep>();
const stepListeners = new Map<string, Set<Listener>>();

function setSessionStep(sessionId: string, step: SessionStep | undefined): void {
  if (steps.get(sessionId) === step) return;
  if (step) steps.set(sessionId, step);
  else steps.delete(sessionId);
  for (const listener of stepListeners.get(sessionId) ?? []) listener();
}

/** 세션 정보에서 step 을 떼어 계열 상점에 싣고, 나머지를 돌려준다. */
function splitSessionStep(incoming: SessionInfo): SessionInfo {
  setSessionStep(incoming.sessionId, incoming.step);
  if (incoming.step === undefined) return incoming;
  const { step: _step, ...session } = incoming;
  return session;
}

export function getSessionStep(sessionId: string): SessionStep | undefined {
  return steps.get(sessionId);
}

export function subscribeSessionStep(sessionId: string, listener: Listener): () => void {
  const set = stepListeners.get(sessionId) ?? new Set<Listener>();
  set.add(listener);
  stepListeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) stepListeners.delete(sessionId);
  };
}

function sameSessionInfo(left: SessionInfo, right: SessionInfo): boolean {
  const leftKeys = Object.keys(left) as (keyof SessionInfo)[];
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    const a = left[key];
    const b = right[key];
    if (a === b) continue;
    if (key === "workspace" && a && b && typeof a === "object" && typeof b === "object") {
      const wa = a as SessionInfo["workspace"] & object;
      const wb = b as SessionInfo["workspace"] & object;
      if (wa.folder === wb.folder && wa.outside === wb.outside && wa.branch === wb.branch) continue;
    }
    return false;
  }
  return true;
}
