import * as fs from "node:fs";
import * as path from "node:path";

import { createDurableJsonStore, getFleetDataDir } from "@dotobokuri/core-infra";

import {
  normalizeAiGatewaySettings,
  type AiGatewayStoredSettings,
  type AiGatewayUpdateValue,
} from "./index.js";

// AI Gateway 설정은 Fleet 데이터 루트의 단일 파일(`<dataDir>/ai-gateway.json`)이 소유한다.
// 전역 옵션(`settings.json`)과 같은 축이라 호스트·채널이 달라도 한 벌만 존재한다.

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
}

export interface CreateAiGatewaySettingsStoreDeps {
  /** Fleet 데이터 루트. 호스트가 자기 유효 루트를 넘긴다. 기본값은 `~/.fleet`. */
  readonly dataDir?: string;
  /**
   * 이 설정이 예전에 살던 호스트 소유 디렉터리. 그 안의 `ai-gateway.json`을 한 번만
   * 승계한다. 부재는 "승계할 과거가 없다"는 뜻이고, 승계 자체가 일어나지 않는다.
   * 호스트가 자기 환경(published / local 등)에 맞는 경로를 넘기므로 이 패키지는
   * 어떤 호스트 경로도 알지 못한다.
   */
  readonly legacyDir?: string;
  readonly now?: () => number;
  readonly staleLockMs?: number;
  readonly timeoutMs?: number;
}

export function createAiGatewaySettingsStore(
  deps: CreateAiGatewaySettingsStoreDeps = {},
): AiGatewaySettingsStore {
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const settingsPath = path.join(dataDir, AI_GATEWAY_SETTINGS_FILE_NAME);
  const legacyPath = deps.legacyDir === undefined
    ? undefined
    : path.join(deps.legacyDir, AI_GATEWAY_SETTINGS_FILE_NAME);

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

  // 과거 파일 조사는 프로세스당 한 번이면 충분하지만, **결론이 났을 때만** 한 번으로 끝난다.
  // 일시적 I/O 실패를 "승계할 것 없음"으로 굳히면 그 뒤의 어떤 쓰기든 목적지 파일을 만들어
  // 승계를 영구히 막아버린다 — 사용자 선별이 조용히 사라지는 경로다.
  let carriedOver: AiGatewayStoredSettings | undefined;
  let probeSettled = legacyPath === undefined;

  const probeLegacySettings = (): void => {
    if (probeSettled) return;
    const probe = readLegacySettings(legacyPath!);
    // 결론 보류 — 다음 접근이 다시 조사한다.
    if (probe.kind === "unavailable") return;
    carriedOver = probe.kind === "adopt" ? probe.settings : undefined;
    probeSettled = true;
  };

  /**
   * 잠금 안에서 이번 갱신의 시작점을 정한다. 목적지에 파일이 이미 있으면 그쪽이 사실이다 —
   * 사용자가 선별을 비운 상태와 "아직 승계 전"을 구분할 수 있는 건 파일 존재 여부뿐이라,
   * 정규형이 비었는지로 판정하면 의도적으로 비운 선택을 과거 값으로 되살리게 된다.
   */
  const adoptedBase = (current: AiGatewayStoredSettings): AiGatewayStoredSettings => (
    carriedOver && !fileExists(settingsPath) ? carriedOver : current
  );

  // 승계와 요청된 갱신을 같은 잠금 안에서 끝낸다. 둘을 나누면 승계가 실패한 직후의 부분 갱신이
  // 목적지 파일을 먼저 만들어, 아직 옮기지 못한 선별을 영영 고아로 만든다.
  //
  // 과거 파일을 아직 **읽지 못한** 상태에서도 같은 일이 벌어진다. 목적지 파일이 생기는 순간
  // 그것이 "승계 끝"의 유일한 표식이 되므로, 조사에 결론이 나기 전에는 쓰지 않고 거절한다.
  // 조용히 잃는 것보다 실패를 보이는 편이 낫다 — 저장은 다시 시도할 수 있지만 사라진 선별은
  // 되돌릴 수 없다. 되돌아오지 못할 상태(디렉터리·심링크 루프 등)는 애초에 `nothing`으로
  // 결론지으므로, 이 거절이 영구히 설정 저장을 막는 상태로 굳지 않는다.
  const update = (
    mutate: (current: AiGatewayStoredSettings) => AiGatewayStoredSettings,
  ): AiGatewayStoredSettings => {
    probeLegacySettings();
    if (!probeSettled) {
      throw new Error(
        `AI Gateway settings were not written: the previous settings file at ${legacyPath!} could not be read, `
        + "and writing now would strand it. Make that file readable or remove it, then retry.",
      );
    }
    return store.update((current) => mutate(adoptedBase(current)));
  };

  return {
    path: settingsPath,
    read: () => {
      probeLegacySettings();
      if (carriedOver && !fileExists(settingsPath)) {
        try {
          store.update(adoptedBase);
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
      ...(value ?? {}),
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
  };
}

function fileExists(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

type LegacyProbe =
  /** 옮길 값이 있다. */
  | { readonly kind: "adopt"; readonly settings: AiGatewayStoredSettings }
  /** 부재하거나 손상됐거나 비어 있다 — 옮길 것이 없다는 결론. */
  | { readonly kind: "nothing" }
  /** 읽지 못했다. 결론이 아니므로 다음 접근이 다시 조사해야 한다. */
  | { readonly kind: "unavailable" };

/**
 * 다시 읽어도 결과가 달라지지 않는 실패들. 그 자리에 읽을 수 있는 과거 파일이 **없다**는
 * 결론이므로 재시도 대상이 아니다. 이걸 `unavailable`로 두면 승계를 기다리느라 설정 저장이
 * 영구히 막히는데, 그건 원래 막으려던 손실보다 나쁘다.
 */
const CONCLUSIVE_LEGACY_READ_ERRORS = new Set(["ENOENT", "EISDIR", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function readLegacySettings(legacyPath: string): LegacyProbe {
  let raw: string;
  try {
    raw = fs.readFileSync(legacyPath, "utf-8");
  } catch (error) {
    // 권한·I/O 실패는 결론이 아니다 — 지금 못 읽었을 뿐 값은 그대로 있을 수 있다.
    return CONCLUSIVE_LEGACY_READ_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")
      ? { kind: "nothing" }
      : { kind: "unavailable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "nothing" };
  }
  const settings = normalizeAiGatewaySettings(parsed);
  return hasStoredValue(settings) ? { kind: "adopt", settings } : { kind: "nothing" };
}

function hasStoredValue(settings: AiGatewayStoredSettings): boolean {
  return (settings.models?.length ?? 0) > 0
    || settings.defaultModel !== undefined
    || settings.cursorDiagnosticsEnabled !== undefined
    || settings.wireLogEnabled !== undefined;
}
