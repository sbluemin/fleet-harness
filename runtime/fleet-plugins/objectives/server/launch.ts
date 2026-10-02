import { createHash, randomUUID } from "node:crypto";

import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import { readOperationLaunch, withOperationLaunchPreset, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { decisionTurn, humanWords, memberMessageTurn, planTurn, startTurn, steerTurn, type PromptLanguage } from "./prompts.js";
import { memberRoutingPrompt, ROUTING_ASSIGN_MAX_ITEMS, ROUTING_ASSIGN_MAX_PROMPT_SUM } from "./routing-prompt.js";
import { checkedCriteria, ObjectiveStoreError, type ObjectiveInit, type ObjectiveStore } from "./store.js";
import { COMMANDER_PRESET, ROUTING_PREVIEW_TTL_MS, type DecisionAnswer, type DecisionAnswersInput, type MemberLaunch, type MemberPatchInput, type MemberPreset, type MemberRouted, type Objective, type ObjectiveMember, type PlanInput, type RoutingDecision, type RoutingPreview, type SlotBy, type MissionAddInput, type MissionPatchInput } from "./types.js";

/**
 * 목표는 레코드로 태어난다. 첫 「개시」·「구상」에서만 같은 id 의 dormant 지휘관 Operation 을 세우고 깨운다.
 */

/** 전체 중단의 대상별 결과 — 건너뛴 이유와 실패를 숨기지 않는다. */
export interface StopTarget {
  readonly operationId: string;
  readonly outcome: "interrupted" | "skipped" | "failed";
  readonly reason?: string;
}

/** 전체 압축의 대상별 결과 — woken 은 보내기 전 휴면이었고 전달이 받아들여진 곳이다. */
export interface CompactTarget {
  readonly operationId: string;
  readonly outcome: "requested" | "rejected";
  readonly woken: boolean;
  readonly reason?: string;
}

export interface LaunchService {
  describe(): { readonly available: boolean };
  /** 목표 레코드만 만든다. 후속 후보는 안정적인 objectiveId 를 지정할 수 있다. */
  create(input: { readonly theaterId: string; readonly title: string; readonly groupId: string | null; readonly viewMode?: "terminal" | "chat"; readonly objectiveId?: string } & ObjectiveInit, options?: LaunchOptions): Promise<Objective>;
  /**
   * 고른 후속 후보와 함께 완료한다 — 완료·배치 기록을 한 번에 쓴 뒤 Core에 보관을 요청하고 후속 목표 레코드를
   * 뒤에서 만든다. 같은 배치로 다시 부르면 그대로 돌려준다.
   */
  completeWithFollowups(objectiveId: string, selection: { readonly batchId: string; readonly followups: readonly { readonly id: string; readonly rev: number }[] }, options?: LaunchOptions): Promise<Objective>;
  /** failed·confirming 배치 항목을 같은 스냅샷·같은 키로 다시 확인하거나 만든다. */
  retryFollowup(objectiveId: string, batchId: string, candidateId: string): Objective;
  /** 끝나지 않은 후속 생성(creating)을 이어 간다 — 기동 때와 원본이 복원될 때. objectiveId 가 없으면 모든 목표. */
  resumeFollowups(objectiveId?: string): void;
  /** 후속으로 만든 Operation 이 지워지거나 돌아왔다 — 그 후속을 배치에 가진 원본 화면을 다시 방송한다. */
  followupTargetChanged(operationId: string): void;
  /** 목표를 지운다 — 지휘관 Operation 을 닫는다(삭제 유예 동안 복원할 수 있고, 담당도 함께 닫힌다). */
  remove(objectiveId: string): Objective;
  /** 완료 기록과 Core 요청 의도를 저장한 뒤 지휘관 ID 하나로 보관을 요청한다. */
  complete(objectiveId: string): Promise<Objective>;
  reopen(objectiveId: string): Promise<Objective>;
  /** 재시작 때 미완료 Core 요청만 재접수한다. 완료 상태만 보고 다시 보관하지 않는다. */
  resumeOperationIntents(): Promise<void>;
  rename(objectiveId: string, title: string): Promise<Objective>;
  regroup(objectiveId: string, groupId: string | null): Promise<Objective>;
  /** 지휘관의 모델·강도 — 지휘관 Operation 에 쓴다(다음 깨움부터 쓰인다). */
  setPreset(objectiveId: string, preset: { readonly model?: string; readonly effort?: string; readonly viewMode?: "terminal" | "chat" }): Promise<Objective>;
  /**
   * 개시 — 구성원을 모은 뒤 지휘관에게 첫 알림을 보낸다. routing "preview" 는 사람이 확인 시트에서 본 판단 결과 그대로 띄운다(다시
   * 판단하지 않고, 그새 결과를 쓸 수 없게 됐으면 routing_preview_stale). 띄우지 못한 구성원은 failed 로 알리고 개시는 이어 간다.
   */
  startCommander(objectiveId: string, options?: LaunchOptions & { readonly routing?: "preview" }): Promise<{ readonly objective: Objective; readonly operationId: string; readonly failed: readonly { readonly id: string; readonly role: string; readonly error: string }[] }>;
  /**
   * 개시 전 라우팅 확인 — 라우팅으로 새로 띄울 구성원의 판단 결과. 캐시가 쓸 수 있으면 다시 판단하지 않고, rejudge 면 모두 다시 판단한다.
   * 같은 목표의 판단이 이미 진행 중이면 그 결과를 함께 기다린다(판단은 한 번).
   */
  routingPreview(objectiveId: string, options?: { readonly rejudge?: boolean }): Promise<RoutingPreview>;
  /** 「다음 재개부터」 예약을 거둔다 — 세션 좌표를 실행값으로 되돌리고 예약 전 선택으로 돌아간다. 실패 표시도 같은 길로 닫는다. */
  memberNextCancel(objectiveId: string, memberId: string): Promise<Objective>;
  /** 휴면 중 예약한 구성원이 지금 깨어 있으면 예약을 적용으로 거둔다 — 판정은 서버의 관측으로 다시 한다. */
  memberNextSettle(objectiveId: string, memberId: string): Objective;
  requestPlan(objectiveId: string, options?: LaunchOptions): Promise<{ readonly objective: Objective; readonly operationId: string }>;
  missionPatched(objectiveId: string, missionId: string, patch: MissionPatchInput): Objective;
  /** 사람이 더한 임무(`by: "human"`)는 선행을 함께 주지 않았다면 미분류로 들어간다 — 지휘관의 추가는 지휘관이 이미 자리를 안다. */
  missionAdded(objectiveId: string, input: MissionAddInput, options?: { readonly by?: SlotBy }): Objective;
  planApplied(objectiveId: string, plan: PlanInput): Objective;
  /**
   * 구성원 명단을 대기 기동하거나 휴면 세션째 재개한다. 호스트가 한 구성원의 기동·재개를 거절하면 그 구성원만 failed(코드와 함께)로
   * 알리고 나머지는 이어 간다. reviewed 는 사람이 확인한 라우팅 결과다 — 없으면 쓸 수 있는 캐시를 쓰고 나머지를 판단한다.
   */
  muster(objectiveId: string, reviewed?: ReadonlyMap<string, RoutingDecision>): Promise<readonly MusterMember[]>;
  /**
   * 사람 경로의 구성원 수정. 서브에이전트 허용이 바뀌면 다음 기동 정책만 호스트에 알리고, 떠 있는 프로세스는 건드리지 않는다.
   * 이미 띄운 구성원의 모델 선택은 「다음 재개부터」 예약이 된다.
   */
  memberPatched(objectiveId: string, memberId: string, patch: MemberPatchInput): Promise<Objective>;
  /** 구성원 일괄 모델 설정 ('지휘관과 같게' 또는 '라우팅'). 개별 지정(model)은 보존. */
  /**
   * 띄운 구성원은 개별 선택과 같다 — 「지휘관과 같게」는 다음 재개부터의 예약이고, 「라우팅」은 새로 띄울 때만 뜻이 있어 건너뛴다.
   * changed 는 선택이 바뀐 구성원 수, edits 는 그 가운데 띄우기 전 구성원(보드 편집) 수, preserved 는 직접 지정과 건너뛴 구성원 수다.
   */
  memberBatchLaunch(objectiveId: string, mode: "same" | "route"): Promise<{ readonly objective: Objective; readonly changed: number; readonly edits: number; readonly preserved: number }>;
  /** 필요하면 부모를 휴면 복원한 뒤 자식 세션을 즉시 삭제하고 명단에서 뺀다. */
  memberRemoved(objectiveId: string, memberId: string): Promise<{ readonly objective: Objective; readonly missionIds: readonly string[] }>;
  /** 지휘관 Operation 이 지금 일하고 있는가(running·background) — 그동안 사람의 편집은 허용된 것만 받는다. */
  busy(objectiveId: string): boolean;
  /**
   * 사람의 결정 답 — 지휘관에게 질문과 답을 보내고(휴면이면 깨워서), 닿았을 때만 결정으로 남기고 요청을 정리한다. 스티어링과 달리
   * 기준 제안이 남아도 보내며, 충족 판단·구상 상태를 건드리지 않고 구성원을 기동하지 않는다.
   */
  answerDecision(objectiveId: string, input: DecisionAnswersInput, options?: LaunchOptions): Promise<Objective>;
  /**
   * 지휘관이 방금 올린 요청의 답을 기다린다 — 그 안에 사람이 답하면 답을 돌려주고(프롬프트는 보내지 않고 결정으로 남긴다),
   * 요청이 그새 정리됐으면 "cleared", 시한이 지나거나 호출이 끊기면 null 이다. null 뒤의 답은 지금처럼 프롬프트로 간다.
   */
  awaitDecision(objectiveId: string, requestId: string, waitMs: number, signal?: AbortSignal): Promise<readonly DecisionAnswer[] | "cleared" | null>;
  /** 스티어링 — 지휘관에게 「바뀌었으니 보드를 다시 읽으라」는 한 줄을 보내고 쌓인 편집과 충족 판단을 비운다. */
  steer(objectiveId: string, options?: LaunchOptions): Promise<Objective>;
  /**
   * 사람의 말 — 지휘관이나 세션이 있는 구성원 하나에게 그대로 보낸다(작업 중이면 큐잉, 휴면이면 깨움, 허용 대기면 거절은 호스트가 정한다).
   * 구성원에게 갔으면 지휘관에게도 한 줄로 알린다 — 그 통지가 닿았는지는 notified 로 따로 말한다(구성원 전달은 이미 끝났다).
   */
  message(objectiveId: string, memberId: string | null, text: string, options?: LaunchOptions): Promise<{ readonly objective: Objective; readonly notified: boolean | null }>;
  /** 전체 중단 — 이미 있는 지휘관과 담당 Operation 에 인터럽트를 보낸다. */
  stop(objectiveId: string): Promise<{ readonly objective: Objective; readonly interrupted: number; readonly targets: readonly StopTarget[] }>;
  /** 전체 압축 — 지휘관과 operationId 가 있는 모든 구성원에게 "/compact" 를 보낸다. 큐잉·깨움·거절은 호스트 전달 경로가 정한다. */
  compact(objectiveId: string): Promise<{ readonly objective: Objective; readonly requested: number; readonly woken: number; readonly rejected: number; readonly excluded: number; readonly targets: readonly CompactTarget[] }>;
  /** Operation 이 삭제 유예에 들어갔다 — 지휘관이었다면 담당 Operation 도 함께 닫는다. */
  operationDeleted(operationId: string): void;
  /** Operation 이 복원 불가로 사라졌다 — 목표 레코드(지휘관)나 임무 연결(담당)을 거둔다. */
  operationPurged(operationId: string): void;
  /** 호스트의 `operation:grouped` — 지휘관이 옮겨지면 담당이 따라가고, 목표 화면을 다시 방송한다. */
  operationGrouped(event: OperationGroupedEvent): void;
  /** 제목 등 Operation 쪽 값이 바뀌었다 — 목표 화면을 다시 방송한다. */
  operationChanged(operationId: string): void;
  dispose(): void;
}

export interface MusterMember {
  readonly id: string;
  readonly role: string;
  readonly session: string;
  readonly operationId: string;
  readonly state: "live" | "launched" | "resumed" | "unknown" | "failed";
  readonly error?: string;
}

export interface LaunchOptions {
  readonly language?: PromptLanguage;
  /** 사람이 개시·스티어링에 덧붙인 말 — 그 알림 아래 인용으로 한 번 간다(저장하지 않는다). 구상의 말은 목표의 `planRequest` 에 산다. */
  readonly context?: string;
}

const languageOf = (options?: LaunchOptions): PromptLanguage => (options?.language === "ko" ? "ko" : "en");
/** 호스트가 모델·강도를 받지 않은 기동 거절 — 이때만 라우팅 구성원을 지휘관 프리셋으로 다시 띄운다. */
const MODEL_REFUSALS = new Set(["gateway_model_not_enabled", "invalid_effort", "invalid_model"]);
/** 라우팅 판단 한 번을 기다리는 상한 — Gateway 의 model 모드 판단(30초)보다 넉넉하다. */
const ROUTING_TIMEOUT_MS = 45_000;
/** Gateway 가 `because` 꼬리(`· fallback: <사유>`)로 주는 폴백 사유 → 화면이 번역할 코드. 모르는 사유는 원문만 남긴다. */
const FALLBACK_REASONS: readonly (readonly [RegExp, string])[] = [
  [/AI routing is off/i, "routing_off"],
  [/unassigned/i, "no_candidate"],
  [/routing decision failed: timeout/i, "decision_timeout"],
  [/not signed in/i, "not_signed_in"],
  [/routing decision failed/i, "decision_failed"],
  [/settings changed/i, "settings_changed"],
  [/stale or invalid routing choice/i, "invalid_choice"],
];
function fallbackReason(because: string): { readonly reason: string; readonly detail?: string } {
  const at = because.lastIndexOf("fallback:");
  const tail = (at >= 0 ? because.slice(at + "fallback:".length) : because).trim();
  return { reason: FALLBACK_REASONS.find(([pattern]) => pattern.test(tail))?.[1] ?? "gateway_fallback", ...(tail ? { detail: tail.slice(0, 300) } : {}) };
}
/** 지휘관 기본값 — Opus · high. 카탈로그가 다르면 깨울 때 호스트가 거절한다. */
/** 세션 이름 — 다른 세션이 이 세션을 부르는 주소. 담당 이름은 지휘관 이름의 머리를 잇는다. */
const commanderSession = () => `objective-${randomUUID().slice(0, 6)}-cmdr`;
/** 지휘관 이름이 없으면(따로 만든 Operation 이 지휘관) 목표 id 로 머리를 고정한다 — 한 목표의 구성원이 같은 머리를 잇는다. */
const memberSession = (objectiveId: string, commander: string | null, index: number) => `${commander ? commander.replace(/-cmdr$/, "") : `objective-${objectiveId.slice(0, 6)}`}-member-${index}`;

export function createLaunchService(ctx: FleetPluginServerContext, store: ObjectiveStore): LaunchService {
  const control = () => {
    const capability = ctx.host.consoleControl;
    if (!capability) throw new ObjectiveStoreError("launch_unavailable");
    return capability;
  };
  const objective = (objectiveId: string) => {
    const found = store.find(objectiveId);
    if (!found) throw new ObjectiveStoreError("unknown_objective");
    return found;
  };
  const referenceNode = (id: string) => ctx.host.operations.describe ? ctx.host.operations.describe(id)?.operation ?? null : ctx.host.operations.get(id);
  // 명시적인 편집·실행만 Core에 사용 의도를 전한다. metadata 조회·통지·삭제에는 쓰지 않는다.
  const accessOperation = async (id: string): Promise<void> => {
    if (ctx.host.operations.access) await ctx.host.operations.access(id, "ensure-active").catch(asStoreError);
    else if (!ctx.host.operations.get(id)) throw new ObjectiveStoreError("unknown_operation");
  };
  const editableObjective = (id: string): Objective => {
    const current = objective(id);
    if (current.done) throw new ObjectiveStoreError("objective_done");
    return current;
  };
  const patchOperation = (operationId: string, patch: { title?: string; groupId?: string | null; payload?: Record<string, unknown> }) => {
    if (!ctx.host.operations.patch(operationId, patch)) throw new ObjectiveStoreError("unknown_objective");
  };
  /**
   * 알림 문구의 언어를 그 Operation 에 남긴다. 콘솔 사용은 켜지 않는다 — 지휘관과 담당은 `fleet-objectives` 로 일하고
   * (지휘관은 읽고 쓰고, 담당은 읽기만), Console 이 필요하면 사람이 그 Operation 에서 허용한다.
   */
  const rememberLanguage = (operationId: string, language: PromptLanguage) => {
    const node = ctx.host.operations.get(operationId);
    if (node && node.payload.objectiveLanguage !== language) ctx.host.operations.patch(operationId, { payload: { ...node.payload, objectiveLanguage: language } });
  };

  /**
   * 전달됐는지를 돌려준다 — 못 닿은 알림에 기대 상태를 지우면 다음 시작이 같은 변경을 말하지 못한다.
   * `display`는 채팅 원장에 설 사람의 말이다. 프롬프트는 모델의 것이라 원장에 서지 않는다.
   */
  const send = async (operationId: string, text: string, display: string, reportFailure = false): Promise<boolean> => {
    if (!ctx.host.consoleControl || !ctx.host.operations.get(operationId)) return false;
    try { await ctx.host.consoleControl.request({ kind: "send", operationId, text, display, displayFormat: "markdown" }); return true; }
    catch (error) {
      // 개시·구상은 사람이 재시도해야 할 실패다. 알림의 best-effort 전달과 달리 원인을 보존한다.
      if (reportFailure) asStoreError(error);
      return false;
    }
  };
  // 호스트 제어 경로의 거절(invalid_launch_option 등)은 코드 그대로 호출자에게 — 뭉개지 않는다.
  const asStoreError = (error: unknown): never => {
    if (error instanceof ObjectiveStoreError) throw error;
    const code = error instanceof Error ? error.message : "";
    throw new ObjectiveStoreError(/^[a-z_]{1,64}$/.test(code) ? code : "launch_failed");
  };
  // 지워졌거나 다른 Theater 의 그룹은 미분류로 연다 — 거절하면 옛 그룹을 쥔 개시가 실패한다. 그룹을 모르는 호스트에서는 그대로 둔다.
  const liveGroupId = (theaterId: string, groupId: string | null | undefined): string | null => {
    const groups = ctx.host.operations.groups;
    if (!groupId || !groups) return groupId ?? null;
    return groups.get(groupId)?.theaterId === theaterId ? groupId : null;
  };
  const launch = async (input: { objectiveId: string; newOperationId?: string; theaterId: string; title?: string; sessionName: string; model?: string; effort?: string; groupId?: string | null; viewMode?: "terminal" | "chat"; dormant?: boolean; subagents?: boolean; parentOperationId?: string; childSessionId?: string; launchKey?: string }): Promise<string> => {
    const groupId = liveGroupId(input.theaterId, input.groupId);
    const result = await control().request({
      kind: "launch",
      theaterId: input.theaterId,
      ...(input.title ? { title: input.title } : {}),
      viewMode: input.viewMode ?? "terminal",
      sessionName: input.sessionName,
      ...(input.dormant ? { dormant: true } : {}),
      // 허용하지 않은 구성원만 태어날 때 서브에이전트(fleet:execute 포함)를 끈다. 허용은 전역 정책을 그대로 쓴다.
      ...(input.subagents === false ? { disableSubagents: true } : {}),
      // 목표의 세션은 AskUserQuestion 으로 사람에게 묻지 않는다 — 구성원은 지휘관에게 SendMessage 로, 지휘관은 보드의 결정 요청으로 묻는다.
      disableUserQuestions: true,
      ...(input.model && input.model !== "default" ? { model: input.model } : {}),
      ...(input.effort && input.effort !== "auto" ? { effort: input.effort } : {}),
      ...(groupId ? { groupId } : {}),
      // 구성원은 태어날 때부터 지휘관 아래 선다 — 코어가 목록 표면에서 빼고 지휘관이 대표한다.
      ...(input.parentOperationId && input.childSessionId ? { parentOperationId: input.parentOperationId, childSessionId: input.childSessionId } : {}),
      ...(input.launchKey ? { launchKey: input.launchKey } : {}),
      ...(input.newOperationId ? { newOperationId: input.newOperationId } : {}),
    });
    return result.operationId;
  };

  // 답을 기다리는 지휘관 도구 호출 — 목표·요청마다 하나. 답이 오면 프롬프트 대신 이 호출이 답을 받는다.
  const decisionWaiters = new Map<string, (answers: readonly DecisionAnswer[] | "cleared" | null) => void>();

  // 같은 목표에 기동 요청이 겹치면 Operation 이 둘 뜬다 — 기동이 끝날 때까지 자리를 잡아 둔다.
  const pending = new Set<string>();
  const commanderClaims = new Map<string, { readonly mode: "start" | "plan"; readonly task: Promise<unknown> }>();
  const claim = async <T,>(key: string, run: () => Promise<T>, mode?: "start" | "plan"): Promise<T> => {
    const existing = commanderClaims.get(key);
    if (existing) {
      if (existing.mode !== mode) throw new ObjectiveStoreError("slot_taken");
      return existing.task as Promise<T>;
    }
    if (pending.has(key)) throw new ObjectiveStoreError("slot_taken");
    pending.add(key);
    const task = run();
    if (mode) commanderClaims.set(key, { mode, task });
    try { return await task; } finally { pending.delete(key); commanderClaims.delete(key); }
  };

  // 최초 기동은 호스트의 영속 launchKey 와 같은 UUID 에 묶는다. 실패 후 재시도는 기존 Operation 을 되찾는다.
  const ensureCommander = async (objectiveId: string): Promise<void> => {
    // 에이전트가 지운 목표는 사람이 되돌리기 전에는 기동하지 않는다.
    if (store.find(objectiveId)?.removed) throw new ObjectiveStoreError("objective_removed");
    const pendingCommander = store.pending(objectiveId);
    const existing = referenceNode(objectiveId);
    const key = `objectives.commander:${objectiveId}`;
    if (existing) {
      await accessOperation(objectiveId);
      // 이 변경 전에 태어났거나 따로 만든 Operation 을 지휘관으로 쓰는 경우 — 다음 기동부터 사람 질문을 뺀다.
      blockUserQuestions(objectiveId);
      if (pendingCommander) {
        const marker = existing.payload.launchKey as { owner?: string; key?: string } | undefined;
        if (marker?.owner !== ctx.pluginId || marker.key !== key) throw new ObjectiveStoreError("operation_id_taken");
        store.launched(objectiveId);
      }
      return;
    }
    if (!pendingCommander) throw new ObjectiveStoreError("unknown_operation");
    const launchedId = await launch({ ...pendingCommander, objectiveId, dormant: true, launchKey: key, newOperationId: objectiveId }).catch(asStoreError);
    if (launchedId !== objectiveId) throw new ObjectiveStoreError("operation_id_taken");
    store.launched(objectiveId);
  };

  /**
   * 새로 띄울 라우팅 구성원에게 모델을 한 번에 묻는다. 판단이 자리를 준 경우만 그 모델과 그 강도를 쓰고, 폴백·실패·없는 키·
   * origin 없음은 지휘관 프리셋(모델과 강도를 함께)이다 — 그 사유를 코드로 남겨 보드가 말할 수 있게 한다. 개시를 막지 않는다.
   */
  const judgeRouting = async (current: Objective, launching: readonly ObjectiveMember[]): Promise<Map<string, RoutingDecision>> => {
    const decisions = new Map<string, RoutingDecision>();
    const settle = (members: readonly ObjectiveMember[], reason: string, detail?: string) => { for (const member of members) if (!decisions.has(member.id)) decisions.set(member.id, { via: "fallback", reason, ...(detail ? { detail } : {}) }); };
    if (launching.length === 0) return decisions;
    const origin = ctx.host.server.origin();
    if (!origin) { settle(launching, "routing_unavailable"); return decisions; }
    // 요청 한도(항목 수·prompt 합계)를 넘으면 전원이 폴백된다. 한도만큼 나누고, 항목마다 합계를 나눠 가진다(노트만 줄어든다).
    for (let start = 0; start < launching.length; start += ROUTING_ASSIGN_MAX_ITEMS) {
      const chunk = launching.slice(start, start + ROUTING_ASSIGN_MAX_ITEMS);
      const max = Math.floor(ROUTING_ASSIGN_MAX_PROMPT_SUM / chunk.length);
      try {
        const response = await fetch(`${origin}/api/v1/ai-gateway/routing-assign`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ items: chunk.map((member) => ({ key: member.id, prompt: memberRoutingPrompt(current, member, max) })) }),
          signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS),
        });
        // 라우팅이 꺼졌거나 후보가 없으면 Gateway 는 항목별 사유 없이 409 하나로 답한다.
        if (response.status === 409) { settle(chunk, "routing_disabled"); continue; }
        if (!response.ok) { settle(chunk, "routing_failed", `http ${response.status}`); continue; }
        const body = await response.json() as { decisions?: readonly { key?: string; model?: string; effort?: string; because?: string; fallback?: boolean }[] };
        if (!Array.isArray(body?.decisions)) { settle(chunk, "routing_failed", "invalid response"); continue; }
        const keys = new Set(chunk.map((member) => member.id));
        for (const decision of body.decisions) {
          if (!decision?.key || !keys.has(decision.key) || decisions.has(decision.key)) continue;
          const because = typeof decision.because === "string" ? decision.because.slice(0, 300) : "";
          if (decision.fallback === false && typeof decision.model === "string" && decision.model) {
            decisions.set(decision.key, { via: "route", model: decision.model, ...(typeof decision.effort === "string" && decision.effort ? { effort: decision.effort } : {}), because });
          } else decisions.set(decision.key, { via: "fallback", ...fallbackReason(because) });
        }
        settle(chunk, "routing_failed", "missing decision");
      } catch (error) {
        // 이 묶음은 지휘관 프리셋 그대로 — 개시를 막지 않는다.
        settle(chunk, error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "routing_timeout" : "routing_failed");
      }
    }
    return decisions;
  };

  /**
   * 라우팅 판단 캐시 — 목표마다 하나. 결과는 구성원별 라우팅 prompt 지문과 판단 시각을 지니고, 함께 판단한 집합(set)을 기억한다.
   * 지금 대상이 그 집합 안에 있고 지문이 같으며 TTL 안이면 다시 판단하지 않는다(배치 판단이라 새 대상이 끼면 전원을 다시 판단한다).
   * 메모리에만 둔다 — 재시작하면 다시 판단한다. 띄운 구성원의 결과는 쓰는 즉시 거둔다.
   */
  const routingCache = new Map<string, { set: Set<string>; results: Map<string, { readonly fingerprint: string; readonly at: number; readonly decision: RoutingDecision }> }>();
  const routingFingerprint = (current: Objective, member: ObjectiveMember) => createHash("sha256").update(memberRoutingPrompt(current, member)).digest("hex");
  const cachedRouting = (current: Objective, targets: readonly ObjectiveMember[], member: ObjectiveMember) => {
    const cache = routingCache.get(current.id);
    if (!cache || !targets.every((target) => cache.set.has(target.id))) return null;
    const entry = cache.results.get(member.id);
    return entry && entry.fingerprint === routingFingerprint(current, member) && Date.now() - entry.at < ROUTING_PREVIEW_TTL_MS ? entry : null;
  };
  /**
   * 대상의 판단 — 캐시에서 쓸 수 있는 결과는 다시 판단하지 않는다. reuse 가 "route" 이면 판단이 모델을 준 결과만 다시 쓴다(사람이 보지 않은
   * 폴백은 다시 판단한다), "any" 는 사람이 본 결과 그대로, "none" 은 모두 다시 판단한다.
   */
  const routeMembers = async (current: Objective, targets: readonly ObjectiveMember[], reuse: "route" | "any" | "none"): Promise<{ readonly decisions: Map<string, RoutingDecision>; readonly judged: boolean }> => {
    const decisions = new Map<string, RoutingDecision>();
    if (reuse !== "none") {
      for (const member of targets) {
        const entry = cachedRouting(current, targets, member);
        if (entry && (reuse === "any" || entry.decision.via === "route")) decisions.set(member.id, entry.decision);
      }
    }
    const need = targets.filter((member) => !decisions.has(member.id));
    if (need.length === 0) return { decisions, judged: false };
    const judged = await judgeRouting(current, need);
    const previous = routingCache.get(current.id);
    const cache = previous && targets.every((target) => previous.set.has(target.id)) ? previous : { set: new Set<string>(), results: new Map() };
    const at = Date.now();
    for (const member of need) {
      const decision = judged.get(member.id) ?? { via: "fallback" as const, reason: "routing_failed" };
      cache.set.add(member.id);
      cache.results.set(member.id, { fingerprint: routingFingerprint(current, member), at, decision });
      decisions.set(member.id, decision);
    }
    routingCache.set(current.id, cache);
    return { decisions, judged: true };
  };
  /** 사람이 확인 시트에서 본 결과 — 대상마다 쓸 수 있는 결과가 있어야 한다. 그새 설명이 바뀌었거나 만료됐으면 시트가 다시 판단해야 한다. */
  const reviewedRouting = (current: Objective): Map<string, RoutingDecision> => {
    const targets = routingTargets(current);
    const decisions = new Map<string, RoutingDecision>();
    for (const member of targets) {
      const entry = cachedRouting(current, targets, member);
      if (!entry) throw new ObjectiveStoreError("routing_preview_stale");
      decisions.set(member.id, entry.decision);
    }
    return decisions;
  };
  const previewTasks = new Map<string, Promise<RoutingPreview>>();
  /**
   * 루프가 새로 띄울 라우팅 구성원 — Operation 이 있으면 살렸거나 재개하거나 관측 불가로 건너뛰고, 다른 Theater 면 루프가 거기서
   * 멈춘다. 보관된 Operation(reference 만 있음)은 루프가 복원해 재개하므로 좌석을 받지 않는다.
   */
  const routingTargets = (current: Objective): ObjectiveMember[] => {
    const launching: ObjectiveMember[] = [];
    for (const member of current.members) {
      const operationId = member.id;
      const reference = operationId ? referenceNode(operationId) : null;
      if (reference && reference.theaterId !== current.theaterId) break;
      const node = operationId ? ctx.host.operations.get(operationId) : null;
      if (node && node.theaterId !== current.theaterId) break;
      if (operationId && (node || reference)) continue;
      if (member.launch.mode === "route") launching.push(member);
    }
    return launching;
  };
  /** 세션 좌표의 모델·강도를 그대로 이 값으로 — 강도가 없으면 그 모델의 기본으로 뜨도록 지운다. */
  const withSessionPreset = (payload: Record<string, unknown>, preset: MemberPreset): Record<string, unknown> => {
    const next = withOperationLaunchPreset(payload, preset);
    const session = { ...(next.session as Record<string, unknown>) };
    if (!preset.model) delete session.model;
    if (!preset.effort) delete session.effort;
    return { ...next, session };
  };
  const samePreset = (a: MemberPreset, b: MemberPreset) => (a.model ?? "") === (b.model ?? "") && (a.effort ?? "") === (b.effort ?? "");
  const presetOf = (value: MemberPreset): MemberPreset => ({ ...(value.model ? { model: value.model } : {}), ...(value.effort ? { effort: value.effort } : {}) });
  /** 호스트의 거절 코드 — 형식에 맞지 않으면 launch_failed. */
  const failureCode = (error: unknown): string => { const code = error instanceof Error ? error.message : ""; return /^[a-z_]{1,64}$/.test(code) ? code : "launch_failed"; };
  /** 다음 프로세스 기동에 쓸 정책. 세션 payload를 직접 고치지 않고, 떠 있는 프로세스는 중단하지 않는다. */
  const rememberSubagentSpawn = (operationId: string, allowed: boolean) => {
    ctx.host.consoleControl?.setSubagentSpawn?.(operationId, allowed ? "default" : "blocked");
  };
  /** 목표 세션(지휘관·구성원)의 다음 기동에서 사람 질문을 뺀다. 떠 있는 터미널은 중단하지 않고, 살아 있는 채팅은 남은 질문을 거절한다. */
  const blockUserQuestions = (operationId: string) => {
    ctx.host.consoleControl?.setUserQuestions?.(operationId, "blocked");
  };
  /**
   * 지휘관이 지금 쓰는 뷰 — 후속 목표의 지휘관이 이어받는다. 살아 있는 지휘관은 지금 보이는 표면을, 미기동·휴면이면 저장된
   * 시작 뷰를 쓴다(표식이 없는 옛 지휘관은 터미널이다).
   */
  const commanderView = (objectiveId: string): "terminal" | "chat" => {
    const observation = ctx.host.consoleControl?.observe(objectiveId);
    if (observation?.lifecycle === "live") return observation.surface;
    return objective(objectiveId).commander.viewMode ?? "terminal";
  };
  const memberPreset = (current: Objective, member: ObjectiveMember) => member.launch.mode === "model"
    ? { model: member.launch.model, effort: member.launch.effort }
    : { model: current.commander.model, effort: current.commander.effort };

  const WORKING = new Set(["running", "background"]);
  const working = (operationId: string): boolean => {
    const observation = ctx.host.consoleControl?.observe(operationId);
    return !!observation && observation.lifecycle !== "dormant" && WORKING.has(observation.activity);
  };
  const stoppable = (operationId: string) => { const observation = ctx.host.consoleControl?.observe(operationId); return !!observation && observation.lifecycle !== "dormant" && observation.activity !== "idle" && observation.activity !== "ended"; };
  // 완료·완료 해제의 순서만 지킨다. Cluster 구성·정지·복원은 Core가 소유한다.
  const operationRequests = new Map<string, Promise<unknown>>();
  const orderedOperationRequest = async <T,>(id: string, run: () => Promise<T>): Promise<T> => {
    const task = (operationRequests.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
    operationRequests.set(id, task);
    try { return await task; } finally { if (operationRequests.get(id) === task) operationRequests.delete(id); }
  };
  const operationIntent = (id: string, action: "archive" | "ensure-active") => {
    if (pending.has(id) || pending.has(`${id}:muster`)) throw new ObjectiveStoreError("objective_busy");
    if (store.pending(id)) return undefined;
    if (action === "archive" ? !ctx.host.operations.archive : !ctx.host.operations.access) throw new ObjectiveStoreError("operation_lifecycle_unavailable");
    return { requestId: randomUUID(), action };
  };
  const applyOperationIntent = async (id: string): Promise<void> => {
    const intent = store.operationIntent(id);
    if (!intent) return;
    try {
      if (intent.action === "archive") {
        if (!ctx.host.operations.archive) throw new ObjectiveStoreError("operation_lifecycle_unavailable");
        await ctx.host.operations.archive(id);
      } else {
        if (!ctx.host.operations.access) throw new ObjectiveStoreError("operation_lifecycle_unavailable");
        await ctx.host.operations.access(id, "ensure-active");
      }
      store.acknowledgeOperationIntent(id, intent.requestId);
    } catch (error) { asStoreError(error); }
  };
  /** 지휘관이 한 번도 깨지 않았다 — 보드를 처음부터 읽으므로 앞서 쌓인 편집 기록은 뜻이 없다. */
  const neverStarted = (operationId: string) => { const node = ctx.host.operations.get(operationId); return !!node && !readOperationLaunch(node.payload).started; };
  /**
   * 첫 깨움의 「깨었음」은 CLI 가 뜬 뒤 세션 좌표가 Operation 에 적힐 때(capture hook) 비동기로 켜진다. 목표 레코드는 그대로라
   * 화면에 방송이 나가지 않는다 — 그러면 화면은 개시 전 문구를 계속 보이고 사람은 개시를 다시 누르게 된다. 좌표가 적히는 대로
   * 목표를 한 번 다시 방송한다. 응답을 붙잡지 않도록 뒤에서 돌고(띠의 「보내는 중…」은 응답까지만 선다), 상한을 넘기거나
   * 지휘관이 사라지면 그만둔다.
   */
  const announceTimers = new Set<ReturnType<typeof setTimeout>>();
  const ANNOUNCE_POLL_MS = 250;
  const ANNOUNCE_DEADLINE_MS = 60_000;
  const announceStarted = (objectiveId: string) => {
    const deadline = Date.now() + ANNOUNCE_DEADLINE_MS;
    const tick = () => {
      if (!ctx.host.operations.get(objectiveId)) return;
      if (!neverStarted(objectiveId)) { store.refresh(objectiveId); return; }
      if (Date.now() >= deadline) return;
      const timer = setTimeout(() => { announceTimers.delete(timer); tick(); }, ANNOUNCE_POLL_MS);
      announceTimers.add(timer);
    };
    tick();
  };
  const muster = (objectiveId: string, reviewed?: ReadonlyMap<string, RoutingDecision>): ReturnType<LaunchService["muster"]> => claim(`${objectiveId}:muster`, async () => {
    let current = objective(objectiveId);
    if (current.planning) throw new ObjectiveStoreError("planning_only");
    if (current.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
    if (current.done) throw new ObjectiveStoreError("objective_done");
    await accessOperation(objectiveId);
    current = editableObjective(objectiveId);
    const launching = routingTargets(current);
    // 사람이 확인한 결과로 띄운다 — 그사이 새로 끼었거나 바뀐 대상이 있으면 본 것과 다르게 뜨므로 띄우기 전에 멈춘다.
    if (reviewed && launching.some((member) => !reviewed.has(member.id))) throw new ObjectiveStoreError("routing_preview_stale");
    const routed = reviewed ?? (await routeMembers(current, launching, "route")).decisions;
    const commanderPreset = presetOf(current.commander);
    const members: MusterMember[] = [];
    for (let index = 0; index < current.members.length; index += 1) {
      const member = current.members[index]!;
      const operationId = member.id;
      const reference = operationId ? referenceNode(operationId) : null;
      if (reference && reference.theaterId !== current.theaterId) throw new ObjectiveStoreError("unknown_operation");
      if (operationId && reference) await accessOperation(operationId);
      const observation = operationId ? ctx.host.consoleControl?.observe(operationId) : null;
      const node = operationId ? ctx.host.operations.get(operationId) : null;
      if (node && node.theaterId !== current.theaterId) throw new ObjectiveStoreError("unknown_operation");
      if (operationId && node && observation?.lifecycle === "live") {
        pendingNext(objectiveId, member.id);
        blockUserQuestions(operationId);
        members.push({ id: member.id, role: member.role, session: member.sessionName ?? memberSession(current.id, current.commander.sessionName, index + 1), operationId, state: "live" });
        continue;
      }
      if (operationId && node && observation?.lifecycle === "dormant") {
        // 앞선 구성원의 기동·재개를 기다리는 동안 바뀐 허용값도 이번 재개부터 반영한다.
        rememberSubagentSpawn(operationId, objective(objectiveId).members.find((candidate) => candidate.id === member.id)?.subagents === true);
        blockUserQuestions(operationId);
        const session = member.sessionName ?? memberSession(current.id, current.commander.sessionName, index + 1);
        const reserved = pendingNext(objectiveId, member.id);
        try {
          await control().request({ kind: "resume", operationId });
          // 예약한 모델로 깨었다 — 이제 그것이 실행값이고, 라우팅이 고른 모델도 아니다.
          if (reserved) store.memberLaunchState(objectiveId, member.id, { next: null, routed: null });
          members.push({ id: member.id, role: member.role, session, operationId, state: "resumed" });
        } catch (error) {
          if (error instanceof ObjectiveStoreError) throw error;
          const code = failureCode(error);
          // 예약한 모델을 호스트가 거절했을 수 있다(그새 노출이 꺼짐 등) — 그 구성원만 실행값으로 한 번 더 깨우고, 개시 전체는 멈추지 않는다.
          if (reserved && await resumeWith(operationId, reserved.from)) {
            store.memberLaunchState(objectiveId, member.id, { next: { ...reserved, failed: code } });
            members.push({ id: member.id, role: member.role, session, operationId, state: "resumed" });
            continue;
          }
          // 실행값으로도 깨지 못했다 — 예약은 그대로 두고(좌표도 예약값으로) 이 구성원만 실패로 알린다.
          if (reserved) patchMemberPreset(operationId, reserved);
          members.push({ id: member.id, role: member.role, session, operationId, state: "failed", error: code });
        }
        continue;
      }
      // 관측이 없는 Operation 은 세울지 판단할 수 없다 — 그 구성원만 건너뛰고 알린다(한 구성원 때문에 개시 전체를 막지 않는다).
      if (operationId && node) { members.push({ id: member.id, role: member.role, session: member.sessionName ?? memberSession(current.id, current.commander.sessionName, index + 1), operationId, state: "unknown" }); continue; }
      const used = new Set(current.members.flatMap((candidate) => candidate.sessionName ? [candidate.sessionName] : []));
      let number = index + 1;
      let session = memberSession(current.id, current.commander.sessionName, number);
      while (used.has(session)) session = memberSession(current.id, current.commander.sessionName, ++number);
      const decision = member.launch.mode === "route" ? routed.get(member.id) ?? { via: "fallback" as const, reason: "routing_failed" } : null;
      const preset = decision ? (decision.via === "route" ? presetOf(decision) : commanderPreset) : memberPreset(current, member);
      let provenance: MemberRouted | null = decision ? (decision.via === "route" ? { via: "route", because: decision.because } : { via: "fallback", reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) }) : null;
      // 앞선 기동을 기다리는 동안 바뀐 허용값도 이번 기동부터 반영한다.
      const allowed = objective(objectiveId).members.find((candidate) => candidate.id === member.id)?.subagents === true;
      // 새 구성원은 지휘관의 뷰와 무관하게 채팅으로 뜬다. 이미 있는 구성원의 뷰는 바꾸지 않는다.
      const spawn = (with_: MemberPreset) => launch({ objectiveId, theaterId: current.theaterId, sessionName: session, ...with_, subagents: allowed ? undefined : false, viewMode: "chat", parentOperationId: current.id, childSessionId: member.id });
      let launchedId: string;
      try { launchedId = await spawn(preset); }
      catch (error) {
        if (error instanceof ObjectiveStoreError) throw error;
        const code = failureCode(error);
        // 시한(request_timeout)은 거절이 아니다 — 호스트는 기동을 이어 가므로, 그새 자식이 섰으면 고른 모델로 뜬 것이다.
        if (ctx.host.operations.get(member.id)) launchedId = member.id;
        else if (decision?.via !== "route" || !MODEL_REFUSALS.has(code)) {
          // 아직 서지 않았다 — 이 구성원만 실패로 알린다. 늦게 서면 다음 muster 가 그 Operation 을 그대로 쓰므로 근거는 미리 남긴다.
          if (code === "request_timeout" && provenance) store.memberLaunchState(objectiveId, member.id, { routed: provenance });
          members.push({ id: member.id, role: member.role, session, operationId, state: "failed", error: code });
          continue;
        }
        // 라우팅이 고른 모델을 호스트가 거절했다(그새 노출이 꺼짐 등) — 그 구성원만 지휘관 프리셋으로 다시 띄우고 폴백으로 남긴다.
        else {
          try { launchedId = await spawn(commanderPreset); provenance = { via: "fallback", reason: "launch_rejected", detail: code }; }
          catch (retry) {
            if (retry instanceof ObjectiveStoreError) throw retry;
            members.push({ id: member.id, role: member.role, session, operationId, state: "failed", error: failureCode(retry) });
            continue;
          }
        }
      }
      rememberLanguage(launchedId, ctx.host.operations.get(objectiveId)?.payload.objectiveLanguage === "ko" ? "ko" : "en");
      routingCache.get(objectiveId)?.results.delete(member.id);
      store.memberLaunchState(objectiveId, member.id, { routed: provenance, next: null });
      // 라우팅·기동 중 변경된 허용값도 다음 기동 정책에는 반영한다. 첫 프로세스는 중단하지 않는다.
      const linked = objective(objectiveId).members.find((candidate) => candidate.id === member.id);
      if (linked) rememberSubagentSpawn(linked.id, linked.subagents === true);
      members.push({ id: member.id, role: member.role, session, operationId: launchedId, state: "launched" });
    }
    store.refresh(objectiveId);
    return members;
  });

  /** 구성원 세션 좌표를 이 값으로 — 다음 재개가 읽는다. */
  const patchMemberPreset = (operationId: string, preset: MemberPreset) => {
    const node = ctx.host.operations.get(operationId);
    if (node) patchOperation(operationId, { payload: withSessionPreset(node.payload, preset) });
  };
  /** 실행값으로 되돌려 한 번 더 깨운다 — 깨었는지를 돌려준다. */
  const resumeWith = async (operationId: string, preset: MemberPreset): Promise<boolean> => {
    patchMemberPreset(operationId, preset);
    try { await control().request({ kind: "resume", operationId }); return true; }
    catch { return false; }
  };

  /**
   * 개시한 구성원의 모델 선택 — 자식 Operation 의 세션 좌표를 바꿔 다음 재개부터 쓰게 하고, 지금 실행값과 예약 전 선택을 기억한다.
   * 실행 중인 프로세스는 건드리지 않는다(채팅·터미널 모두 다음 재개부터). 실행값과 같은 값을 고르면 예약을 거둔다.
   * 라우팅은 새로 띄울 때만 판단하므로, 띄운 구성원이 라우팅으로 돌아가면 예약만 거둔다.
   */
  const reserve = (current: Objective, memberId: string, selection: MemberLaunch | null, before: { readonly launch?: MemberLaunch; readonly next?: { readonly from: MemberPreset; readonly was?: MemberLaunch; readonly failed?: string; readonly reservedWhile?: "dormant" | "live" } }) => {
    const node = ctx.host.operations.get(memberId);
    if (!node) return;
    const pending = before.next && !before.next.failed ? before.next : null;
    const running = pending ? pending.from : presetOf(readOperationLaunch(node.payload));
    const target = selection === null ? null : presetOf(selection.mode === "same" ? current.commander : selection);
    if (!target?.model || samePreset(target, running)) {
      if (pending) patchMemberPreset(memberId, running);
      store.memberLaunchState(current.id, memberId, { next: null });
      return;
    }
    patchMemberPreset(memberId, target);
    const was = before.next ? before.next.was : before.launch;
    const reservedWhile = pending?.reservedWhile === "live" || ctx.host.consoleControl?.observe(memberId)?.lifecycle === "live" ? "live" as const : "dormant" as const;
    store.memberLaunchState(current.id, memberId, { next: { model: target.model, ...(target.effort ? { effort: target.effort } : {}), from: running, ...(was ? { was } : {}), reservedWhile } });
  };
  /**
   * 아직 쓰이지 않은 예약 — 휴면 중 예약이 live 로 관측되면 사람이 패널에서 깨웠든 지휘관이 말을 걸었든 이미 예약 좌표로 깨었으므로
   * 적용으로 거둔다. 떠 있던 중 예약이 휴면으로 관측되면 옛 프로세스가 끝났으니 다음 깨움을 같은 규칙으로 가를 수 있게 휴면 예약으로 고친다.
   */
  const pendingNext = (objectiveId: string, memberId: string) => {
    const next = store.storedMember(objectiveId, memberId)?.next;
    if (!next || next.failed) return null;
    const lifecycle = ctx.host.consoleControl?.observe(memberId)?.lifecycle;
    if (next.reservedWhile !== "live" && lifecycle === "live") { store.memberLaunchState(objectiveId, memberId, { next: null, routed: null }); return null; }
    if (next.reservedWhile === "live" && lifecycle === "dormant") { const settled = { ...next, reservedWhile: "dormant" as const }; store.memberLaunchState(objectiveId, memberId, { next: settled }); return settled; }
    return next;
  };

  // 후보 UUID 를 별도 이름 공간의 안정 UUID 로 바꾼다. 배치가 재시작되어도 같은 후보는 같은 목표다.
  const followupId = (candidateId: string): string => {
    const hex = createHash("sha256").update(`objectives.followup:${candidateId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const followupWorkers = new Set<string>();
  const runFollowup = async (objectiveId: string, batchId: string, candidateId: string): Promise<void> => {
    const workerKey = `${objectiveId}:${candidateId}`;
    if (followupWorkers.has(workerKey)) return;
    followupWorkers.add(workerKey);
    try {
      const source = store.find(objectiveId);
      const batch = source ? store.followupBatch(objectiveId, batchId) : null;
      const entry = batch?.items.find((candidate) => candidate.candidateId === candidateId);
      if (!source || !batch || !entry || entry.state !== "creating") return;
      const id = followupId(candidateId);
      try {
        const existing = store.find(id);
        if (existing && (existing.origin?.objectiveId !== objectiveId || existing.origin.candidateId !== candidateId)) throw new ObjectiveStoreError("objective_id_taken");
        const created = existing ?? await service.create({
          theaterId: source.theaterId, title: entry.snapshot.title, groupId: batch.launch.groupId, viewMode: batch.launch.viewMode,
          note: entry.snapshot.brief, criteria: entry.snapshot.criteria, addedBy: objectiveId,
          origin: { objectiveId, candidateId, batchId, userImpact: entry.snapshot.userImpact, evidence: entry.snapshot.evidence }, objectiveId: id,
        }, { language: batch.launch.language });
        if (!store.find(objectiveId)) {
          if (!existing && store.pending(created.id)) store.removePending(created.id);
          return;
        }
        store.followupSettle(objectiveId, batchId, candidateId, { state: "created", operationId: created.id, attempted: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : "record_failed";
        try { store.followupSettle(objectiveId, batchId, candidateId, { state: "failed", error: /^[a-z_]{1,64}$/.test(code) ? code : "record_failed", attempted: true }); }
        catch { /* 원본 삭제 또는 저장 실패 — 재시작 때 같은 id 로 다시 확인한다. */ }
      }
    } finally { followupWorkers.delete(workerKey); }
  };

  const service: LaunchService = {
    describe: () => ({ available: !!ctx.host.consoleControl }),

    async create(input, _options) {
      const { objectiveId, ...init } = input;
      checkedCriteria(init);
      const id = objectiveId ?? randomUUID();
      if (store.recorded(id)) return objective(id);
      if (referenceNode(id)) throw new ObjectiveStoreError("operation_id_taken");
      return store.adopt(id, init, {
        theaterId: input.theaterId, title: input.title, groupId: input.groupId, createdAt: Date.now(),
        sessionName: commanderSession(), ...COMMANDER_PRESET, viewMode: input.viewMode ?? "terminal",
      });
    },

    completeWithFollowups: (objectiveId, selection, options) => orderedOperationRequest(objectiveId, async () => {
      const current = objective(objectiveId);
      store.completeWithFollowups(objectiveId, {
        ...selection,
        launch: { groupId: current.groupId, viewMode: commanderView(objectiveId), language: languageOf(options) },
      }, current.done ? undefined : operationIntent(objectiveId, "archive"));
      await applyOperationIntent(objectiveId);
      service.resumeFollowups(objectiveId);
      return objective(objectiveId);
    }),

    retryFollowup(objectiveId, batchId, candidateId) {
      const next = store.followupRetry(objectiveId, batchId, candidateId);
      service.resumeFollowups(objectiveId);
      return next;
    },

    followupTargetChanged(operationId) {
      for (const current of store.all()) {
        if (current.followupBatches.some((batch) => batch.items.some((entry) => entry.operationId === operationId))) store.refresh(current.id);
      }
    },

    resumeFollowups(objectiveId) {
      const objectives = objectiveId ? [store.find(objectiveId)].filter((entry): entry is Objective => !!entry) : store.all();
      for (const current of objectives) {
        for (const batch of current.followupBatches) {
          for (const entry of batch.items) if (entry.state === "creating") void runFollowup(current.id, batch.id, entry.candidateId);
        }
      }
    },

    remove(objectiveId) {
      const current = objective(objectiveId);
      // 레코드는 Operation 이 복원 불가로 사라질 때(operation:purged) 거둔다 — 유예 동안 복원하면 목표도 돌아온다.
      // 기동 전 목표는 먼저 「정리됨」에 남아 되돌릴 수 있다. 이미 그 자리에 있으면(비우기) 영구 삭제한다.
      if (store.pending(objectiveId) && !current.removed) { const trashed = store.trash(objectiveId); service.followupTargetChanged(objectiveId); return trashed; }
      if (store.pending(objectiveId)) { store.removePending(objectiveId); service.followupTargetChanged(objectiveId); return current; }
      if (!ctx.host.operations.delete(objectiveId)) throw new ObjectiveStoreError("unknown_objective");
      return current;
    },

    complete: (objectiveId) => orderedOperationRequest(objectiveId, async () => {
      const current = objective(objectiveId);
      store.complete(objectiveId, current.done ? undefined : operationIntent(objectiveId, "archive"));
      await applyOperationIntent(objectiveId);
      return objective(objectiveId);
    }),

    reopen: (objectiveId) => orderedOperationRequest(objectiveId, async () => {
      const current = objective(objectiveId);
      store.reopen(objectiveId, current.done ? operationIntent(objectiveId, "ensure-active") : undefined);
      await applyOperationIntent(objectiveId);
      return objective(objectiveId);
    }),

    async resumeOperationIntents() {
      for (const current of store.all()) {
        if (!store.operationIntent(current.id)) continue;
        try { await orderedOperationRequest(current.id, () => applyOperationIntent(current.id)); }
        catch (error) { console.warn(`[objectives] Operation request remains pending: ${error instanceof Error ? error.message : "unexpected_failure"}`); }
      }
    },

    rename: (objectiveId, title) => orderedOperationRequest(objectiveId, async () => {
      editableObjective(objectiveId);
      if (store.pending(objectiveId)) return store.patchPending(objectiveId, { title });
      await accessOperation(objectiveId);
      editableObjective(objectiveId);
      patchOperation(objectiveId, { title });
      return objective(objectiveId);
    }),

    regroup: (objectiveId, groupId) => orderedOperationRequest(objectiveId, async () => {
      const current = editableObjective(objectiveId);
      // 없는 그룹이나 다른 Theater 의 그룹으로 옮기지 않는다. 잘못된 편집은 복원도 일으키지 않는다.
      if (groupId !== null && ctx.host.operations.groups?.get(groupId)?.theaterId !== current.theaterId) throw new ObjectiveStoreError("unknown_group");
      if (store.pending(objectiveId)) return store.patchPending(objectiveId, { groupId });
      await accessOperation(objectiveId);
      editableObjective(objectiveId);
      patchOperation(objectiveId, { groupId });
      // 담당 이동과 방송은 호스트의 operation:grouped 가 맡는다(operationGrouped).
      return objective(objectiveId);
    }),

    setPreset: (objectiveId, preset) => orderedOperationRequest(objectiveId, async () => {
      editableObjective(objectiveId);
      const node = referenceNode(objectiveId);
      if (!node && store.pending(objectiveId)) {
        if (pending.has(objectiveId)) throw new ObjectiveStoreError("objective_busy");
        return store.patchPending(objectiveId, preset);
      }
      if (!node) throw new ObjectiveStoreError("unknown_objective");
      // 캡처된 세션의 프리셋 금지는 복원 전에 확인한다. 복원으로 기존 제약을 우회하지 않는다.
      if (readOperationLaunch(node.payload).started || pending.has(objectiveId) || control().observe(objectiveId)?.lifecycle === "live" || service.busy(objectiveId)) throw new ObjectiveStoreError("objective_busy");
      await accessOperation(objectiveId);
      editableObjective(objectiveId);
      const active = ctx.host.operations.get(objectiveId);
      if (!active) throw new ObjectiveStoreError("unknown_objective");
      if (readOperationLaunch(active.payload).started || control().observe(objectiveId)?.lifecycle === "live") throw new ObjectiveStoreError("objective_busy");
      patchOperation(objectiveId, { payload: withOperationLaunchPreset(active.payload, preset) });
      store.refresh(objectiveId);
      return objective(objectiveId);
    }),

    startCommander: (objectiveId, options) => claim(objectiveId, async () => {
      const language = languageOf(options);
      let current = objective(objectiveId);
      if (current.done) throw new ObjectiveStoreError("objective_done");
      if (current.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
      // 본 결과를 쓸 수 없으면 지휘관을 세우거나 구상을 끝내기 전에 멈춘다 — 시트가 다시 판단한 뒤 다시 개시한다.
      const reviewed = options?.routing === "preview" ? reviewedRouting(current) : undefined;
      await ensureCommander(objectiveId);
      // 따로 만든 Operation 도 지휘관이 될 수 있다 — 보드를 읽고 쓰려면 콘솔 사용이 켜져 있어야 한다.
      rememberLanguage(objectiveId, language);
      // 개시는 구상을 끝내고 구성원을 먼저 대기 기동·재개한다.
      if (current.planning) current = store.setPlanning(objectiveId, false);
      if (current.criteriaOpen) current = store.setCriteriaOpen(objectiveId, false);
      const failed = (await muster(objectiveId, reviewed)).flatMap((member) => (member.state === "failed" ? [{ id: member.id, role: member.role, error: member.error ?? "launch_failed" }] : []));
      current = objective(objectiveId);
      // 새 지휘관은 보드를 처음부터 읽는다 — 앞서 쌓인 변경 기록은 뜻이 없다.
      const firstWake = neverStarted(objectiveId);
      if (firstWake) current = store.setEdited(objectiveId, null);
      const delivered = await send(objectiveId, startTurn(current, language, options?.context), humanWords(options?.context), true);
      if (!delivered) throw new ObjectiveStoreError("launch_failed");
      if (firstWake) announceStarted(objectiveId);
      // 개시가 닿은 목표는 「진행 중」에 선다.
      store.recordStage(objectiveId, "commenced");
      // 알림이 닿았을 때만 지운다 — 못 닿았으면 다음 시작이 다시 말한다.
      return { objective: store.setEdited(objectiveId, null), operationId: objectiveId, failed };
    }, "start"),

    routingPreview(objectiveId, options) {
      const running = previewTasks.get(objectiveId);
      if (running) return running;
      const task = (async (): Promise<RoutingPreview> => {
        const current = objective(objectiveId);
        if (current.done) throw new ObjectiveStoreError("objective_done");
        if (current.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
        const targets = routingTargets(current);
        const { decisions, judged } = await routeMembers(current, targets, options?.rejudge ? "none" : "any");
        // 판단을 기다리는 동안 지휘관 프리셋이 바뀌었을 수 있다 — 폴백이 뜰 모델은 지금 값으로 보인다.
        const latest = objective(objectiveId);
        const times = targets.map((member) => routingCache.get(objectiveId)?.results.get(member.id)?.at ?? Date.now());
        const at = times.length ? Math.min(...times) : Date.now();
        return {
          judged, at, expiresAt: at + ROUTING_PREVIEW_TTL_MS,
          members: targets.map((member) => {
            const decision = decisions.get(member.id) ?? { via: "fallback" as const, reason: "routing_failed" };
            return decision.via === "route" ? { id: member.id, ...decision } : { id: member.id, ...decision, ...presetOf(latest.commander) };
          }),
        };
      })();
      previewTasks.set(objectiveId, task);
      void task.finally(() => { if (previewTasks.get(objectiveId) === task) previewTasks.delete(objectiveId); }).catch(() => undefined);
      return task;
    },

    memberNextSettle(objectiveId, memberId) {
      pendingNext(objectiveId, memberId);
      return objective(objectiveId);
    },

    memberNextCancel: (objectiveId, memberId) => orderedOperationRequest(objectiveId, async () => {
      editableObjective(objectiveId);
      pendingNext(objectiveId, memberId);
      const record = store.storedMember(objectiveId, memberId);
      if (!record) throw new ObjectiveStoreError("unknown_member");
      if (!record.next) return objective(objectiveId);
      if (referenceNode(memberId)) await accessOperation(memberId);
      editableObjective(objectiveId);
      // 실패한 예약은 좌표를 이미 실행값으로 되돌렸다 — 표시만 닫는다.
      if (!record.next.failed) patchMemberPreset(memberId, record.next.from);
      return store.memberLaunchState(objectiveId, memberId, { next: null, launch: record.next.was ?? null });
    }),

    requestPlan: (objectiveId, options) => claim(objectiveId, async () => {
      const language = languageOf(options);
      let current = objective(objectiveId);
      if (current.done) throw new ObjectiveStoreError("objective_done");
      await ensureCommander(objectiveId);
      rememberLanguage(objectiveId, language);
      store.recordStage(objectiveId, "planned");
      // 구상은 계획과 메모만이다 — 임무 수행도, 담당 기동도 「시작」이 한다.
      if (!current.planning) current = store.setPlanning(objectiveId, true);
      current = store.setCriteriaOpen(objectiveId, true);
      const firstWake = neverStarted(objectiveId);
      if (firstWake) current = store.setEdited(objectiveId, null);
      if (!(await send(objectiveId, planTurn(current, language), humanWords(current.planRequest), true))) throw new ObjectiveStoreError("launch_failed");
      if (firstWake) announceStarted(objectiveId);
      return { objective: current, operationId: objectiveId };
    }, "plan"),

    missionPatched: (objectiveId, missionId, patch) => store.missionPatch(objectiveId, missionId, patch),
    missionAdded: (objectiveId, input, options) => store.missionAdd(objectiveId, input, { unplaced: options?.by === "human", ...(options?.by === "human" ? { by: "human" as const } : {}) }),
    planApplied: (objectiveId, plan) => store.plan(objectiveId, plan),

    muster,
    memberPatched: (objectiveId, memberId, patch) => orderedOperationRequest(objectiveId, async () => {
      const current = editableObjective(objectiveId);
      const member = current.members.find((member) => member.id === memberId);
      if (!member) throw new ObjectiveStoreError("unknown_member");
      if ((patch.subagents !== undefined || patch.launch !== undefined) && referenceNode(member.id)) await accessOperation(member.id);
      const latest = editableObjective(objectiveId);
      pendingNext(objectiveId, memberId);
      const before = store.storedMember(objectiveId, memberId) ?? {};
      let next = store.memberPatch(objectiveId, memberId, patch);
      if (patch.subagents !== undefined) {
        if (ctx.host.operations.get(memberId)) rememberSubagentSpawn(memberId, patch.subagents === true);
      }
      if (patch.launch !== undefined && ctx.host.operations.get(memberId)) {
        reserve(latest, memberId, patch.launch, before);
        next = objective(objectiveId);
      }
      return next;
    }),

    memberBatchLaunch: (objectiveId, mode) => orderedOperationRequest(objectiveId, async () => {
      const current = editableObjective(objectiveId);
      const launched = current.members.filter((member) => !!referenceNode(member.id));
      const launchedIds = new Set(launched.map((member) => member.id));
      // 띄운 구성원 가운데 바꿀 대상 — 직접 지정은 개별 선택이 이기고, 이미 그 방식이면 그대로다.
      const eligible = launched.filter((member) => member.launch.mode !== "model" && member.launch.mode !== mode);
      const result = store.memberBatchLaunch(objectiveId, mode, launchedIds);
      let reserved = 0;
      if (mode === "same") {
        for (const member of eligible) {
          await accessOperation(member.id);
          const latest = editableObjective(objectiveId);
          pendingNext(objectiveId, member.id);
          const before = store.storedMember(objectiveId, member.id) ?? {};
          store.memberLaunchState(objectiveId, member.id, { launch: { mode: "same" } });
          reserve(latest, member.id, { mode: "same" }, before);
          reserved += 1;
        }
      }
      const final = objective(objectiveId);
      const preserved = final.members.filter((member) => member.launch.mode === "model").length + (mode === "route" ? eligible.length : 0);
      return { objective: final, changed: result.changed + reserved, edits: result.changed, preserved };
    }),

    memberRemoved: (objectiveId, memberId) => orderedOperationRequest(objectiveId, async () => {
      const current = editableObjective(objectiveId);
      if (!current.members.some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      if (!store.pending(objectiveId)) await accessOperation(objectiveId);
      editableObjective(objectiveId);
      if (ctx.host.operations.get(memberId)) {
        if (!ctx.host.operations.deleteChild) throw new ObjectiveStoreError("capability_unavailable");
        if (!ctx.host.operations.deleteChild(memberId)) throw new ObjectiveStoreError("child_delete_failed");
      }
      const result = store.memberRemove(objectiveId, memberId);
      return { objective: result.objective, missionIds: result.missionIds };
    }),

    busy: (objectiveId) => working(objective(objectiveId).id),

    async answerDecision(objectiveId, input, options) {
      // 같은 요청의 답이 이미 가는 중이다 — 두 번 보내면 지휘관이 같은 답을 두 번 받는다.
      const key = `${objectiveId}:decision`;
      if (pending.has(key)) throw new ObjectiveStoreError("decision_delivering");
      pending.add(key);
      try {
        const accepted = store.decisionAccept(objectiveId, input);
        if (accepted.recorded) return accepted.objective;
        // 지휘관이 이 요청의 답을 기다리는 중이다 — 도구 응답으로 건네고 결정으로 남긴다. 프롬프트는 보내지 않는다.
        const waiter = decisionWaiters.get(`${objectiveId}:${accepted.request.id}`);
        if (waiter) {
          decisionWaiters.delete(`${objectiveId}:${accepted.request.id}`);
          const settled = store.decisionSettle(objectiveId, accepted.request.id, true);
          waiter(accepted.answers);
          return settled;
        }
        try {
          await accessOperation(objectiveId);
          await control().request({ kind: "send", operationId: objectiveId, text: decisionTurn(accepted.objective, accepted.request, accepted.answers, languageOf(options)), display: "", displayFormat: "markdown" });
        } catch (error) {
          // 닿지 않았다 — 요청과 답은 화면에 그대로 남고 결정은 쌓이지 않는다. 호스트의 거절 사유는 함께 돌려준다.
          store.decisionSettle(objectiveId, accepted.request.id, false);
          const reason = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : undefined;
          throw new ObjectiveStoreError("decision_delivery_failed", undefined, reason ? { reason } : {});
        }
        return store.decisionSettle(objectiveId, accepted.request.id, true);
      } finally { pending.delete(key); }
    },

    awaitDecision(objectiveId, requestId, waitMs, signal) {
      if (waitMs <= 0 || signal?.aborted) return Promise.resolve(null);
      const key = `${objectiveId}:${requestId}`;
      return new Promise((resolve) => {
        let finished = false;
        const finish = (value: readonly DecisionAnswer[] | "cleared" | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearInterval(poll);
          signal?.removeEventListener("abort", onAbort);
          if (decisionWaiters.get(key) === finish) decisionWaiters.delete(key);
          resolve(value);
        };
        const onAbort = () => finish(null);
        decisionWaiters.set(key, finish);
        const timer = setTimeout(() => finish(null), waitMs);
        // 사람의 보드 편집 등으로 요청이 사라졌다 — 답은 오지 않는다.
        const poll = setInterval(() => {
          if (decisionWaiters.get(key) === finish && store.find(objectiveId)?.decisionRequest?.id !== requestId) finish("cleared");
        }, 1_000);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    async steer(objectiveId, options) {
      const current = objective(objectiveId);
      if (current.done) throw new ObjectiveStoreError("objective_done");
      if (current.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
      await accessOperation(objectiveId);
      editableObjective(objectiveId);
      // 스티어링 턴에서 기준 제안은 불가하다. 전송 전에 닫아 턴 전환 중 계획 쓰기와 경합하지 않는다.
      if (current.criteriaOpen) store.setCriteriaOpen(objectiveId, false);
      // 통지(send)와 달리 실패를 삼키지 않는다 — 지휘관이 받지 못했는데 띠가 「중단」으로 돌아가면 사람은 전해진 줄 안다.
      await control().request({ kind: "send", operationId: objectiveId, text: steerTurn(current, languageOf(options), options?.context), display: humanWords(options?.context), displayFormat: "markdown" }).catch(asStoreError);
      // 지휘관에게 닿았다 — 쌓인 편집을 지우고, 지휘관이 다시 일하므로 앞선 충족 판단(곧 검토 대기)도 거둔다.
      store.setEdited(objectiveId, null);
      return store.clearMet(objectiveId);
    },

    message: (objectiveId, memberId, text, options) => orderedOperationRequest(objectiveId, async () => {
      // 개시·구상이 지휘관을 띄우거나 구성원을 모으는 중이다 — 그 사이의 말은 어느 세션에 닿을지 정해지지 않았다.
      if (pending.has(objectiveId) || pending.has(`${objectiveId}:muster`)) throw new ObjectiveStoreError("objective_busy");
      const current = editableObjective(objectiveId);
      const member = memberId === null ? null : current.members.find((candidate) => candidate.id === memberId);
      if (member === undefined) throw new ObjectiveStoreError("unknown_member");
      const target = member ? member.id : current.id;
      if (!referenceNode(target)) throw new ObjectiveStoreError("unknown_operation");
      await accessOperation(target);
      editableObjective(objectiveId);
      // 스티어링처럼 거절을 삼키지 않는다 — 닿지 않았는데 띠가 「보냈다」고 말하면 사람은 전해진 줄 안다.
      await control().request({ kind: "send", operationId: target, text, display: text.trim(), displayFormat: "markdown" }).catch(asStoreError);
      if (!member) return { objective: objective(objectiveId), notified: null };
      const notified = await accessOperation(current.id).then(() => send(current.id, memberMessageTurn(current, member.role, text, languageOf(options)), humanWords(text)), () => false);
      return { objective: objective(objectiveId), notified };
    }),

    async stop(objectiveId) {
      let current = objective(objectiveId);
      if (current.planning) current = store.setPlanning(objectiveId, false);
      if (current.criteriaOpen) current = store.setCriteriaOpen(objectiveId, false);
      const ids = [current.id, ...current.members.filter((candidate) => !!ctx.host.operations.get(candidate.id)).map((candidate) => candidate.id)];
      // 대상마다 따로, 동시에 보낸다 — 한 대상의 느린 확인이 나머지를 늦추거나 요청 시한 뒤로 밀지 않게 한다.
      const targets = await Promise.all(ids.map(async (operationId): Promise<StopTarget> => {
        if (!stoppable(operationId)) return { operationId, outcome: "skipped", reason: "not_working" };
        // background 는 진행 중인 턴 없이 작업만 남은 상태다 — 중단은 턴만 끊으므로 보내지 않는다.
        if (ctx.host.consoleControl?.observe(operationId)?.activity === "background") return { operationId, outcome: "skipped", reason: "not_in_turn" };
        try { await control().request({ kind: "interrupt", operationId }); return { operationId, outcome: "interrupted" }; }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[objectives] Could not interrupt Operation ${operationId} of objective ${objectiveId}: ${reason}`);
          return { operationId, outcome: "failed", reason };
        }
      }));
      return { objective: current, interrupted: targets.filter((target) => target.outcome === "interrupted").length, targets };
    },

    async compact(objectiveId) {
      editableObjective(objectiveId);
      if (!store.pending(objectiveId)) await accessOperation(objectiveId);
      const current = editableObjective(objectiveId);
      // 보낼 곳 — 지휘관과, Operation 이 아직 있는 구성원. operationId 가 없거나 Operation 이 사라진 구성원은 제외로 센다.
      const memberIds = current.members.filter((candidate) => !!referenceNode(candidate.id)).map((candidate) => candidate.id);
      const live = [...new Set([current.id, ...memberIds])].filter((operationId) => operationId === current.id || !!referenceNode(operationId));
      const excluded = current.members.length - live.filter((operationId) => operationId !== current.id).length;
      // 상태로 거르지 않는다 — 큐잉·즉시 실행·휴면 깨움·거절은 호스트 전달 경로가 정한다. 깨움은 보내기 전에 휴면이었던 곳만 센다.
      const targets = await Promise.all(live.map(async (operationId): Promise<CompactTarget> => {
        try {
          await accessOperation(operationId);
          editableObjective(objectiveId);
          const dormant = ctx.host.consoleControl?.observe(operationId)?.lifecycle === "dormant";
          await control().request({ kind: "send", operationId, text: "/compact" });
          return { operationId, outcome: "requested", woken: dormant };
        }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[objectives] Could not send /compact to Operation ${operationId} of objective ${objectiveId}: ${reason}`);
          return { operationId, outcome: "rejected", woken: false, reason };
        }
      }));
      const requested = targets.filter((target) => target.outcome === "requested");
      return { objective: current, requested: requested.length, woken: requested.filter((target) => target.woken).length, rejected: targets.length - requested.length, excluded: Math.max(0, excluded), targets };
    },

    operationDeleted() {
      // 부모의 childSessions는 코어 삭제와 함께 원자적으로 사라진다.
    },

    operationPurged(operationId) {
      store.forget(operationId);
    },

    operationGrouped(event) {
      const current = store.find(event.operationId);
      if (current) store.refresh(event.operationId);
    },

    operationChanged(operationId) {
      const current = store.find(operationId) ?? store.findMember(operationId)?.objective;
      if (current) store.refresh(current.id);
    },

    dispose: () => {
      for (const timer of announceTimers) clearTimeout(timer);
      announceTimers.clear();
      for (const waiter of [...decisionWaiters.values()]) waiter(null);
    },
  };
  return service;
}

export const selfCaller = (ctx: FleetPluginServerContext): ConsoleCaller => ({ kind: "plugin", pluginId: ctx.pluginId });
