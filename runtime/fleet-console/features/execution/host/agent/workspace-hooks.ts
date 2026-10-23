import { randomUUID } from "node:crypto";
import path from "node:path";

export interface WorkspaceHookBinding {
  readonly env: Readonly<Record<string, string>>;
  readonly revision: number;
  observe(cwd: string, revision: number): void;
  dispose(): void;
}

/** 위치 보고만 받는 실행별 바인딩. 활동 hook의 세션 식별자를 Chat에 물려주지 않는다. */
export function createWorkspaceHookRegistry(onCwd: (objectiveId: string, cwd: string) => void) {
  const bindings = new Map<string, {
    runId: string;
    providerSessionId: string;
    active: () => boolean;
    observedAt: number;
    revision: number;
  }>();

  function bind(objectiveId: string, providerSessionId: string, active: () => boolean): WorkspaceHookBinding {
    const state = { runId: randomUUID(), providerSessionId, active, observedAt: 0, revision: 0 };
    bindings.set(objectiveId, state);
    const current = () => bindings.get(objectiveId) === state && active();
    return {
      env: {
        FLEET_CONSOLE_WORKSPACE_SESSION_ID: objectiveId,
        FLEET_CONSOLE_WORKSPACE_RUN_ID: state.runId,
      },
      get revision() { return state.revision; },
      observe(cwd, revision) {
        // transcript를 읽는 사이 hook이 도착했으면 옛 꼬리로 위치를 되돌리지 않는다.
        if (!current() || revision !== state.revision || !path.isAbsolute(cwd)) return;
        onCwd(objectiveId, cwd);
      },
      dispose() {
        if (bindings.get(objectiveId) === state) bindings.delete(objectiveId);
      },
    };
  }

  function report(objectiveId: string, runId: unknown, input: unknown, observedAt: unknown): boolean {
    const state = bindings.get(objectiveId);
    if (!state || state.runId !== runId || !state.active()) return false;
    const hook = readWorkspaceHook(input);
    if (!hook || hook.sessionId !== state.providerSessionId) return false;
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= state.observedAt) return false;
    state.observedAt = observedAt;
    state.revision += 1;
    onCwd(objectiveId, hook.cwd);
    return true;
  }

  return { bind, report, has: (objectiveId: string) => bindings.has(objectiveId), dispose: () => bindings.clear() };
}

function readWorkspaceHook(input: unknown): { sessionId: string; cwd: string } | null {
  if (typeof input !== "string") return null;
  try {
    const hook = JSON.parse(input);
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return null;
    // 서브에이전트는 부모와 session_id를 공유할 수 있다. 별도 cwd는 부모 Objective의 위치가 아니다.
    if (hook.agent_id) return null;
    if (typeof hook.session_id !== "string") return null;
    const event = hook.hook_event_name;
    if (event !== "CwdChanged" && event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "Stop"
      && !(event === "PostToolUse" && (hook.tool_name === "EnterWorktree" || hook.tool_name === "ExitWorktree"))) return null;
    const cwd = event === "CwdChanged" ? hook.new_cwd : hook.cwd;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? { sessionId: hook.session_id, cwd } : null;
  } catch {
    return null;
  }
}
