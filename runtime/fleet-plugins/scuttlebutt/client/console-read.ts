import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { ModelRoster } from "@fleet-console/sdk/models";

import type { ConsoleSnapshotPayload } from "./chat-session.js";

/**
 * 콘솔 사용의 보조 스냅샷. 설치 컨텍스트의 콘솔 상태와 실험 설정을 기억해 두고,
 * 메시지를 보낼 때 스냅샷(Theater 이름·Operation 제목·활동)을 싣는다. 부유 위젯의
 * 컨텍스트에는 이 두 능력이 없으므로 설치 시점에 한 번 받아 둔다. Console Use 자체는
 * 전역으로 항상 열려 있고, 부관 자신의 grant가 실제 허용이다.
 */

let consoleState: PluginInstallContext["consoleState"] | null = null;
let experiments: PluginInstallContext["experiments"] | null = null;
let models: PluginInstallContext["models"] | null = null;

export function connectConsoleRead(context: PluginInstallContext): void {
  consoleState = context.consoleState;
  experiments = context.experiments;
  models = context.models ?? null;
}

/** Console Use는 전역으로 항상 열려 있다 — 부관 메뉴의 grant 행도 항상 선다. */
export function isConsoleReadEnabled(): boolean {
  return true;
}

/** 컴퓨터 사용 실험 스위치 — 켜져 있어야 부관 메뉴에 「컴퓨터 사용」 행이 선다(Operation 메뉴와 같다). */
export function isComputerUseExperimentEnabled(): boolean {
  return experiments?.read()?.computerUse === true;
}

export function subscribeConsoleRead(listener: () => void): () => void {
  return experiments?.subscribe(listener) ?? (() => undefined);
}

export function readConsoleSnapshot(): ConsoleSnapshotPayload | null {
  if (!consoleState) return null;
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

/**
 * 부관 좌표의 선택지 — Console의 모델 로스터(Agent SDK 대상). 첫 읽기가 로스터 읽기를 시작하고, 아직이면 null이다.
 * Settings › AI Gateway에서 모델을 켜고 끄면(다른 탭·기기 포함) 구독으로 다시 그린다.
 */
export function readAideRoster(): ModelRoster | null {
  return models?.read("agent") ?? null;
}

export function subscribeAideRoster(listener: () => void): () => void {
  return models?.subscribe(listener) ?? (() => undefined);
}
