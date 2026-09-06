import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

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
