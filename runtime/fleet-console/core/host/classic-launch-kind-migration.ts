import fs from "node:fs";

import type { DurableConsoleState, DurableDeletionTombstone } from "./durable-state.js";
import type { OperationNode } from "./operations/operations-domain.js";

/** 퇴역한 Classic launch kind / Agent CLI id. */
export const CLASSIC_LAUNCH_KIND_ID = "claude";
/** Classic을 대체하는 Gateway launch kind / Agent CLI id. */
export const GATEWAY_LAUNCH_KIND_ID = "claude-gateway";

/** 이주 대상 payload 필드. launchKindId는 표시 축, cliId는 실행 축이라 함께 옮겨야 한다. */
const MIGRATED_PAYLOAD_KEYS = ["launchKindId", "cliId"] as const;

const BACKUP_FILE_SUFFIX = ".classic-backup";

export interface ClassicLaunchKindMigrationResult {
  /** 이주가 반영된 state. 변경이 없으면 입력과 동일한 참조를 돌려준다. */
  readonly state: DurableConsoleState;
  /** 값이 하나라도 바뀌었는지 — 디스크 재기록 여부를 이 값으로만 판단한다. */
  readonly changed: boolean;
  /** 이주된 Operation 수(live + tombstone 내장). 로그·테스트용. */
  readonly migratedOperations: number;
}

/**
 * 퇴역한 Classic launch kind를 Gateway로 옮기는 1회 콘텐츠 마이그레이션(순수 함수).
 *
 * live operations뿐 아니라 삭제 유예 tombstone에 내장된 Operation까지 변환한다 — 복원된
 * Operation이 사라진 kind를 가리키면 launch kind 표시가 붕괴하기 때문이다. 스키마 버전은
 * 올리지 않는다(v3 내부 콘텐츠 이주).
 *
 * 정확 일치(`=== "claude"`)만 옮긴다. 부분 문자열 매칭은 `claude-native`/`claude-gateway`를
 * 함께 집어삼킨다.
 */
export function migrateClassicLaunchKinds(state: DurableConsoleState): ClassicLaunchKindMigrationResult {
  let migratedOperations = 0;

  const operations = state.operations.map((operation) => {
    const migrated = migrateOperation(operation);
    if (migrated !== operation) migratedOperations += 1;
    return migrated;
  });

  const tombstones = state.deletionTombstones?.map((tombstone) => {
    const migrated = migrateTombstone(tombstone);
    if (migrated !== tombstone) {
      migratedOperations += countMigratedInTombstone(tombstone, migrated);
    }
    return migrated;
  });

  const operationsChanged = operations.some((operation, index) => operation !== state.operations[index]);
  const tombstonesChanged = tombstones?.some((tombstone, index) => tombstone !== state.deletionTombstones?.[index]) ?? false;
  if (!operationsChanged && !tombstonesChanged) {
    return { state, changed: false, migratedOperations: 0 };
  }

  return {
    state: {
      ...state,
      operations,
      ...(tombstones ? { deletionTombstones: tombstones } : {}),
    },
    changed: true,
    migratedOperations,
  };
}

/**
 * 마이그레이션이 처음 디스크를 건드리기 전에 원본 state.json을 1회 백업한다(best-effort).
 *
 * durable store의 원자적 교체는 찢어진 쓰기만 막고 이전 내용을 보존하지 않는다. 백업이 이미
 * 있으면 덮어쓰지 않는다 — 첫 이주 직전 상태가 되돌릴 가치가 있는 유일한 스냅샷이다.
 */
export function backupDurableStateBeforeClassicMigration(stateFilePath: string): void {
  const backupPath = `${stateFilePath}${BACKUP_FILE_SUFFIX}`;
  try {
    if (!fs.existsSync(stateFilePath) || fs.existsSync(backupPath)) return;
    fs.copyFileSync(stateFilePath, backupPath);
  } catch (error) {
    console.warn(`[fleet-console] Classic launch kind migration backup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function migrateOperation(operation: OperationNode): OperationNode {
  const payload = migratePayload(operation.payload);
  return payload === operation.payload ? operation : { ...operation, payload };
}

function migratePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const changedKeys = MIGRATED_PAYLOAD_KEYS.filter((key) => payload[key] === CLASSIC_LAUNCH_KIND_ID);
  if (changedKeys.length === 0) return payload;
  const next = { ...payload };
  for (const key of changedKeys) next[key] = GATEWAY_LAUNCH_KIND_ID;
  return next;
}

function migrateTombstone(tombstone: DurableDeletionTombstone): DurableDeletionTombstone {
  if (tombstone.kind === "operation") {
    const operation = migrateOperation(tombstone.operation);
    return operation === tombstone.operation ? tombstone : { ...tombstone, operation };
  }
  const operations = tombstone.operations.map(migrateOperation);
  const changed = operations.some((operation, index) => operation !== tombstone.operations[index]);
  return changed ? { ...tombstone, operations } : tombstone;
}

function countMigratedInTombstone(before: DurableDeletionTombstone, after: DurableDeletionTombstone): number {
  if (before.kind === "operation" || after.kind === "operation") return 1;
  return after.operations.filter((operation, index) => operation !== before.operations[index]).length;
}
