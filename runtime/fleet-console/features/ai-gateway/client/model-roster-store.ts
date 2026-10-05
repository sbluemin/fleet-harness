import { MODEL_ROSTER_CHANGED_CHANNEL, MODEL_ROSTER_PATH, type ModelRoster, type ModelRosterTarget } from "@fleet-console/sdk/models";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import { OPERATION_CATALOG_CHANGED_EVENT } from "@fleet-console/sdk/operations/browser";
import { launchProviderFromGroupId } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { ExperimentModelOption } from "@fleet-console/sdk/settings";

import { subscribeConsoleChannel, subscribeConsoleReconnect } from "../../../core/client/src/integration/operations-sse.js";

/**
 * 모델 로스터의 브라우저 캐시 — 호스트 번들 안에 하나다. 플러그인은 `ctx.models`로, 코어 화면은 이 모듈로 읽는다.
 *
 * 다시 읽는 때는 넷이다: Gateway를 저장한 이 탭의 카탈로그 변경 이벤트, 서버 브로드캐스트(다른 탭·기기의 저장),
 * 스트림 재접속(단절 중 놓친 브로드캐스트), 화면 복귀. 새 값이 오기 전까지는 지난 값을 그대로 보인다.
 */

const cache = new Map<ModelRosterTarget, ModelRoster>();
const inflight = new Map<ModelRosterTarget, Promise<ModelRoster>>();
const stale = new Set<ModelRosterTarget>();
const listeners = new Set<() => void>();
let wired = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function load(target: ModelRosterTarget): Promise<ModelRoster> {
  const running = inflight.get(target);
  if (running) {
    // 읽는 중에 바뀌었다는 신호가 오면 끝난 뒤 한 번 더 읽는다 — 이미 떠난 요청은 옛 값을 들고 올 수 있다.
    stale.add(target);
    return running;
  }
  const request = fetch(`${MODEL_ROSTER_PATH}?target=${target}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Model roster request failed: ${response.status}`);
      const body = await response.json() as { readonly roster?: unknown };
      const roster = readLaunchVariantGroups(body.roster);
      cache.set(target, roster);
      emit();
      return roster;
    })
    .catch(() => cache.get(target) ?? [])
    .finally(() => {
      inflight.delete(target);
      if (stale.delete(target)) void load(target);
    });
  inflight.set(target, request);
  return request;
}

/** 읽은 적 있는 대상만 다시 읽는다 — 아무도 보지 않는 대상까지 미리 당기지 않는다. */
export function refreshModelRoster(): void {
  for (const target of cache.keys()) void load(target);
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  // 다른 탭·기기에서 저장한 변경. 운영 카탈로그(Quick Launch·캔버스)도 같은 이벤트로 다시 읽게 창 이벤트로 넘긴다 —
  // 이 탭의 저장 경로가 이미 쓰는 신호라 받는 쪽은 출처를 가리지 않는다.
  subscribeConsoleChannel(MODEL_ROSTER_CHANGED_CHANNEL, () => window.dispatchEvent(new Event(OPERATION_CATALOG_CHANGED_EVENT)));
  window.addEventListener(OPERATION_CATALOG_CHANGED_EVENT, refreshModelRoster);
  subscribeConsoleReconnect(refreshModelRoster);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshModelRoster();
  });
}

/** 지금 캐시된 로스터. 처음 읽는 대상이면 읽기를 시작하고 null을 돌려준다. */
export function readModelRoster(target: ModelRosterTarget): ModelRoster | null {
  wire();
  const cached = cache.get(target);
  if (!cached && !inflight.has(target)) void load(target);
  return cached ?? null;
}

export function loadModelRoster(target: ModelRosterTarget): Promise<ModelRoster> {
  wire();
  const cached = cache.get(target);
  return cached ? Promise.resolve(cached) : load(target);
}

export function subscribeModelRoster(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 옛 `ExperimentModelOption` 모양 — deprecated `experiments.modelOptions()`와 이행 중인 화면만 쓴다. */
export function rosterModelOptions(roster: ModelRoster): readonly ExperimentModelOption[] {
  return roster.flatMap((group) => {
    const provider = launchProviderFromGroupId(group.id) ?? undefined;
    return group.rows.map((row) => ({
      id: row.launch.model ?? row.id,
      label: row.label,
      ...(provider ? { provider } : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      effortLevels: row.chips?.map((chip) => chip.id) ?? [],
    }));
  });
}
