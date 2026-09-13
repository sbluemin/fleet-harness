import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { ExperimentModelOption } from "@fleet-console/sdk/settings";

import type { ConsoleSnapshotPayload } from "./chat-session.js";

/**
 * 콘솔 사용의 보조 스냅샷. 설치 컨텍스트의 콘솔 상태와 실험 설정을 기억해 두고,
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
  return experiments?.read()?.consoleControl === true;
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

/** 모델 선택지 — Claude 별칭 + Gateway 모델. 호스트가 아직 없으면 빈 목록. */
export function readModelOptions(): Promise<readonly ExperimentModelOption[]> {
  return experiments?.modelOptions() ?? Promise.resolve([]);
}
