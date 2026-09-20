import * as path from "node:path";

import { createDurableJsonStore, createStoreCarryOver, jsonFileExists } from "@fleet-console/infra";

import type { CompactCeiling } from "../downstream/harness/claude-code/context.js";
import {
  normalizeAiGatewaySettings,
  type AiGatewayStoredSettings,
  type AiGatewayUpdateValue,
  type XaiEndpointPreference,
} from "./index.js";

// AI Gateway 설정은 Console 슬롯의 단일 파일(`<dataDir>/ai-gateway.json`)이 소유한다.
// Console 설정 화면에서 고르는 값이므로 그 Console 인스턴스와 수명을 같이한다 — 호스트가
// 자기 슬롯을 넘기고, 이 패키지는 그 자리가 어디인지 알지 못한다.

const AI_GATEWAY_SETTINGS_FILE_NAME = "ai-gateway.json";
const LOCK_DIR_NAME = `${AI_GATEWAY_SETTINGS_FILE_NAME}.lock`;
const LOCK_OWNER_FILE_NAME = "owner";
// 고아 temp 파일 정리 prefix. writeAtomicSync은 `<파일명>.<pid>.<ts>.<rand>.<host>.tmp`로 쓰므로
// 접두는 파일명 뒤에 점을 붙인 형태여야 한다. 같은 접두의 락 디렉터리(`ai-gateway.json.lock`)도
// 걸리지만 cleanupTempFiles는 일반 파일만 지우므로 디렉터리인 락은 건드리지 않는다.
const TEMP_FILE_PREFIX = `${AI_GATEWAY_SETTINGS_FILE_NAME}.`;

export interface AiGatewaySettingsStore {
  readonly path: string;
  readonly read: () => AiGatewayStoredSettings;
  /** 진단 opt-in은 보존하고 모델 선별만 교체한다. */
  readonly write: (value: AiGatewayUpdateValue | undefined) => AiGatewayStoredSettings;
  /** 모델 선별은 보존하고 진단 opt-in만 갱신한다. */
  readonly writeCursorDiagnosticsEnabled: (enabled: boolean) => AiGatewayStoredSettings;
  /** `undefined`는 wireLogEnabled 키를 제거해 env 폴백으로 돌아간다. */
  readonly writeWireLogEnabled: (enabled: boolean | undefined) => AiGatewayStoredSettings;
  readonly writeDelegationRoutingEnabled: (enabled: boolean) => AiGatewayStoredSettings;
  /** `undefined`는 Auto(키 제거). models 선별은 보존한다. */
  readonly writeCompactCeiling: (ceiling: CompactCeiling | undefined) => AiGatewayStoredSettings;
  /** `undefined`는 xaiEndpoint 키를 제거해 기본(direct)으로 돌아간다. */
  readonly writeXaiEndpoint: (endpoint: XaiEndpointPreference | undefined) => AiGatewayStoredSettings;
}

export interface CreateAiGatewaySettingsStoreDeps {
  /**
   * 이 설정이 사는 디렉터리 — 호스트의 Console 슬롯. 생략할 수 없다: 기본값을 두면 슬롯을
   * 넘기는 것을 잊은 호출자가 조용히 사용자의 다른 자리를 읽고 덮어쓴다.
   */
  readonly dataDir: string;
  /**
   * 이 설정이 예전에 살던 디렉터리들. 가장 최근 자리를 앞에 둔다. 그 안의
   * `ai-gateway.json`을 한 번만 승계한다. 빈 목록은 "승계할 과거가 없다"는 뜻이다.
   * 호스트가 자기 환경(published / local 등)에 맞는 경로를 넘기므로 이 패키지는
   * 어떤 호스트 경로도 알지 못한다.
   */
  readonly legacyDirs?: readonly string[];
  readonly now?: () => number;
  readonly staleLockMs?: number;
  readonly timeoutMs?: number;
}

export function createAiGatewaySettingsStore(
  deps: CreateAiGatewaySettingsStoreDeps,
): AiGatewaySettingsStore {
  const dataDir = deps.dataDir;
  const settingsPath = path.join(dataDir, AI_GATEWAY_SETTINGS_FILE_NAME);

  const store = createDurableJsonStore<AiGatewayStoredSettings>({
    filePath: settingsPath,
    lockDir: path.join(dataDir, LOCK_DIR_NAME),
    lockOwnerFileName: LOCK_OWNER_FILE_NAME,
    sanitize: (value) => normalizeAiGatewaySettings(value),
    sensitivity: "sensitive",
    timeoutMs: deps.timeoutMs,
    staleLockMs: deps.staleLockMs,
    tempCleanupPrefix: TEMP_FILE_PREFIX,
    now: deps.now,
  });

  const carryOver = createStoreCarryOver<AiGatewayStoredSettings>({
    adopted: () => jsonFileExists(settingsPath),
    sourcePaths: (deps.legacyDirs ?? []).map((dir) => path.join(dir, AI_GATEWAY_SETTINGS_FILE_NAME)),
    adopt: (parsed) => {
      const settings = normalizeAiGatewaySettings(parsed);
      return hasStoredValue(settings) ? settings : undefined;
    },
  });

  // 승계와 요청된 갱신을 같은 잠금 안에서 끝낸다. 둘을 나누면 승계가 실패한 직후의 부분 갱신이
  // 목적지 파일을 먼저 만들어, 아직 옮기지 못한 선별을 영영 고아로 만든다.
  //
  // 과거 파일을 아직 **읽지 못한** 상태에서도 같은 일이 벌어진다. 목적지 파일이 생기는 순간
  // 그것이 "승계 끝"의 유일한 표식이 되므로, 조사에 결론이 나기 전에는 쓰지 않고 거절한다.
  // 조용히 잃는 것보다 실패를 보이는 편이 낫다 — 저장은 다시 시도할 수 있지만 사라진 선별은
  // 되돌릴 수 없다.
  const update = (
    mutate: (current: AiGatewayStoredSettings) => AiGatewayStoredSettings,
  ): AiGatewayStoredSettings => {
    carryOver.probe();
    if (!carryOver.settled()) {
      throw new Error(
        `AI Gateway settings were not written: a previous settings file (${carryOver.sourcePaths.join(", ")}) `
        + "could not be read, and writing now would strand it. Make that file readable or remove it, then retry.",
      );
    }
    return store.update((current) => mutate(carryOver.base(current)));
  };

  return {
    path: settingsPath,
    read: () => {
      carryOver.probe();
      if (carryOver.pending()) {
        try {
          store.update(carryOver.base);
        } catch {
          // 락 경합·쓰기 실패는 결론이 아니다. 이번 읽기는 미구성으로 답하고 다음 접근이 다시 시도한다.
        }
      }
      return store.load();
    },
    write: (value) => update((current) => normalizeAiGatewaySettings({
      version: 1,
      ...(current.cursorDiagnosticsEnabled === true ? { cursorDiagnosticsEnabled: true } : {}),
      ...(typeof current.wireLogEnabled === "boolean" ? { wireLogEnabled: current.wireLogEnabled } : {}),
      ...(current.delegationRoutingEnabled === false ? { delegationRoutingEnabled: false } : {}),
      // 우선순위는 이 update 계약이 나르지 않는 별도 표면의 설정이다. 이월하지 않으면
      // 무관한 모델 노출 저장 한 번이 사용자의 소진 순서를 지운다.
      ...(current.providerPriority ? { providerPriority: current.providerPriority } : {}),
      ...(current.compactCeiling !== undefined ? { compactCeiling: current.compactCeiling } : {}),
      ...(current.xaiEndpoint !== undefined ? { xaiEndpoint: current.xaiEndpoint } : {}),
      ...(value ?? {}),
    })),
    writeDelegationRoutingEnabled: (enabled) => update((current) => normalizeAiGatewaySettings({
      ...current,
      delegationRoutingEnabled: enabled,
    })),
    writeCursorDiagnosticsEnabled: (enabled) => update((current) => normalizeAiGatewaySettings({
      ...current,
      cursorDiagnosticsEnabled: enabled,
    })),
    writeWireLogEnabled: (enabled) => update((current) => {
      const next = normalizeAiGatewaySettings({
        ...current,
        ...(enabled === undefined ? {} : { wireLogEnabled: enabled }),
      });
      if (enabled !== undefined) return next;
      const withoutWireLog = { ...next } as { wireLogEnabled?: boolean };
      delete withoutWireLog.wireLogEnabled;
      return withoutWireLog as AiGatewayStoredSettings;
    }),
    writeCompactCeiling: (ceiling) => update((current) => {
      const next = normalizeAiGatewaySettings({
        ...current,
        ...(ceiling === undefined ? {} : { compactCeiling: ceiling }),
      });
      if (ceiling !== undefined) return next;
      const withoutCeiling = { ...next } as { compactCeiling?: CompactCeiling };
      delete withoutCeiling.compactCeiling;
      return withoutCeiling as AiGatewayStoredSettings;
    }),
    writeXaiEndpoint: (endpoint) => update((current) => {
      const next = normalizeAiGatewaySettings({
        ...current,
        ...(endpoint === undefined ? {} : { xaiEndpoint: endpoint }),
      });
      if (endpoint !== undefined) return next;
      const withoutEndpoint = { ...next } as { xaiEndpoint?: XaiEndpointPreference };
      delete withoutEndpoint.xaiEndpoint;
      return withoutEndpoint as AiGatewayStoredSettings;
    }),
  };
}

function hasStoredValue(settings: AiGatewayStoredSettings): boolean {
  return (settings.models?.length ?? 0) > 0
    || settings.cursorDiagnosticsEnabled !== undefined
    || settings.wireLogEnabled !== undefined
    || settings.providerPriority !== undefined
    || settings.delegationRoutingEnabled !== undefined
    || settings.compactCeiling !== undefined;
}
