import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

import type { ConsoleSnapshotPayload } from "./chat-session.js";

/**
 * 실험 "부관의 Console 읽기"의 브라우저 몫. 설치 컨텍스트의 콘솔 상태와 실험 설정을 기억해 두고,
 * 메시지를 보낼 때 켜져 있으면 스냅샷(Theater 이름·Operation 제목·활동)을 싣는다. 부유 위젯의
 * 컨텍스트에는 이 두 능력이 없으므로 설치 시점에 한 번 받아 둔다.
 */

let consoleState: PluginInstallContext["consoleState"] | null = null;
let experiments: PluginInstallContext["experiments"] | null = null;

export function connectConsoleRead(context: PluginInstallContext): void {
  consoleState = context.consoleState;
  experiments = context.experiments;
}

export function isConsoleReadEnabled(): boolean {
  return experiments?.read()?.aideConsoleRead === true;
}

export function subscribeConsoleRead(listener: () => void): () => void {
  return experiments?.subscribe(listener) ?? (() => undefined);
}

export function readConsoleSnapshot(): ConsoleSnapshotPayload | null {
  if (!isConsoleReadEnabled() || !consoleState) return null;
  return {
    theaters: consoleState.getTheaters().map((theater) => ({ id: theater.id, label: theater.label })),
    operations: consoleState.getOperations().map((operation) => ({
      id: operation.id,
      theaterId: operation.theaterId,
      type: operation.type,
      title: operation.title,
      activity: operation.activity,
    })),
  };
}

/** 코어가 experiments 필드를 저장 중이면 true — 그동안 이 행의 스위치는 잠긴다. */
export function isExperimentsSaving(): boolean {
  return experiments?.saving() === true;
}

/** 설정 카드가 읽는 실험 설정 전체 — 없으면(호스트가 아직 안 실었으면) null. */
export function readExperiments(): ConsoleExperimentSettings | null {
  return experiments?.read() ?? null;
}

/** 부관의 Console 읽기 행 저장 — 코어 general 설정의 experiments 필드를 통째로 넘긴다. */
export async function writeConsoleRead(enabled: boolean): Promise<boolean> {
  const current = experiments?.read();
  if (!experiments || !current) return false;
  return experiments.update({ ...current, aideConsoleRead: enabled });
}
