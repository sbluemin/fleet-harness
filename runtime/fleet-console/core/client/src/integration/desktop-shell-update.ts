import { useEffect, useSyncExternalStore } from "react";

/**
 * 창을 들고 있는 셸이 자기 자신의 갱신에 대해 알려 주는 것. 수행자는 셸이고 화면은 읽기만 한다 —
 * 렌더러는 샌드박스이므로 셸에게 말을 거는 길은 이 콘솔을 거치는 것뿐이다.
 *
 * 설치본은 미리 받아 두지 않는다. 그래서 `available`과 `ready` 사이에 `downloading`이 있고,
 * 그 기다림은 사용자가 업데이트를 누른 뒤에야 시작한다.
 */
export type DesktopShellUpdateStage = "idle" | "available" | "downloading" | "ready" | "error";

export interface DesktopShellUpdate {
  readonly stage: DesktopShellUpdateStage;
  readonly version: string | null;
  readonly percent: number | null;
  readonly failure: string | null;
}

const SHELL_UPDATE_PATH = "/api/v1/desktop/shell-update";
const SHELL_UPDATE_COMMAND_PATH = "/api/v1/desktop/shell-update/command";
const STAGES: readonly DesktopShellUpdateStage[] = ["idle", "available", "downloading", "ready", "error"];

const idle: DesktopShellUpdate = { stage: "idle", version: null, percent: null, failure: null };

type Listener = () => void;

let snapshot: DesktopShellUpdate = idle;
const listeners = new Set<Listener>();

function publish(next: DesktopShellUpdate): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): DesktopShellUpdate {
  return snapshot;
}

/**
 * `reloadToken`이 바뀌면 다시 읽는다. 상태 변화는 스트림으로도 오지만, 도움말 메뉴가 열리는
 * 순간의 값은 그 창이 붙기 전에 정해졌을 수 있다.
 */
export function useDesktopShellUpdate(reloadToken = 0): DesktopShellUpdate {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(SHELL_UPDATE_PATH, { signal: controller.signal })
      .then(async (response) => (response.ok ? (await response.json() as unknown) : null))
      .then((body) => {
        const parsed = readShellUpdate(body);
        if (parsed !== null) publish(parsed);
      })
      // 셸이 없으면 이 경로는 빈손이거나 401이다 — 그때 화면에 설 줄도 없다.
      .catch(() => undefined);
    return () => controller.abort();
  }, [reloadToken]);

  return state;
}

/** 스트림으로 도착한 상태. 읽을 수 없는 프레임은 아는 것을 지우지 않는다. */
export function applyDesktopShellUpdateSnapshot(value: unknown): void {
  const parsed = readShellUpdate(value);
  if (parsed !== null) publish(parsed);
}

export type DesktopShellUpdateCommand = "check" | "download" | "restart";

/**
 * 셸에게 시키는 일. 응답은 "전달됐다"는 사실일 뿐이고, 무슨 일이 일어났는지는 상태가 말한다 —
 * 그래서 여기서 낙관적으로 단계를 앞당기지 않는다.
 */
export async function requestDesktopShellUpdate(command: DesktopShellUpdateCommand): Promise<boolean> {
  try {
    const response = await fetch(SHELL_UPDATE_COMMAND_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readShellUpdate(value: unknown): DesktopShellUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const stage = entry.stage;
  if (typeof stage !== "string" || !STAGES.includes(stage as DesktopShellUpdateStage)) return null;
  const version = typeof entry.version === "string" && entry.version.length > 0 ? entry.version : null;
  const percent = typeof entry.percent === "number" && Number.isFinite(entry.percent)
    ? Math.max(0, Math.min(100, Math.round(entry.percent)))
    : null;
  const failure = typeof entry.failure === "string" && entry.failure.length > 0 ? entry.failure : null;
  return { stage: stage as DesktopShellUpdateStage, version, percent, failure };
}
