import { randomUUID } from "node:crypto";

import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import { readOperationLaunch, withOperationLaunchPreset, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { cookTurn, startTurn, steerTurn, type PromptLanguage } from "./prompts.js";
import { ObjectiveStoreError, type ObjectiveInit, type ObjectiveStore } from "./store.js";
import type { ObjectiveItem, ObjectiveStep, PlanInput, SlotBy, StepAddInput, StepPatchInput } from "./types.js";

/**
 * 기동·통지 — 목표의 지휘관 Operation 을 만들고 깨우고, 담당 Operation 을 띄운다.
 *
 * 목표를 만들면 지휘관 Operation 이 dormant 로 함께 태어난다(프로세스 없음). 「구상」·「시작」은 그 Operation 에 한 줄을
 * 보내 깨운다 — 첫 깨움은 새 세션이고, 태어날 때 정한 세션 이름·모델로 뜬다. 담당은 지휘관이 위임하는 순간 뜨는 이름 붙은
 * CLI 세션이라 지휘관이 Claude Code 의 세션 간 메시지로 지시한다 — Console 은 그 대화를 중계하지 않는다.
 */

export interface LaunchService {
  describe(): { readonly available: boolean };
  /** 목표를 만든다 — 지휘관 Operation 을 dormant 로 먼저 만들고 그 id 로 목표 레코드를 세운다. */
  create(input: { readonly theaterId: string; readonly title: string; readonly groupId: string | null } & ObjectiveInit, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 목표를 지운다 — 지휘관 Operation 을 닫는다(삭제 유예 동안 복원할 수 있고, 담당도 함께 닫힌다). */
  remove(itemId: string): ObjectiveItem;
  rename(itemId: string, title: string): ObjectiveItem;
  regroup(itemId: string, groupId: string | null): ObjectiveItem;
  /** 지휘관의 모델·강도 — 지휘관 Operation 에 쓴다(다음 깨움부터 쓰인다). */
  setPreset(itemId: string, preset: { readonly model?: string; readonly effort?: string }): ObjectiveItem;
  startCoordinator(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string }>;
  requestPlan(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string }>;
  stepPatched(itemId: string, stepId: string, patch: StepPatchInput): ObjectiveItem;
  /** 사람이 더한 단계(`by: "human"`)는 선행을 함께 주지 않았다면 미분류로 들어간다 — 지휘관의 추가는 지휘관이 이미 자리를 안다. */
  stepAdded(itemId: string, input: StepAddInput, options?: { readonly by?: SlotBy }): ObjectiveItem;
  planApplied(itemId: string, plan: PlanInput): ObjectiveItem;
  /** 위임 — 지휘관이 이 단계를 맡길 때 그 단계의 담당 세션을 띄운다(프롬프트 없음, Console Use 켬). */
  delegateStep(itemId: string, stepId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string; readonly session: string }>;
  unlinkStep(itemId: string, stepId: string): ObjectiveItem;
  /** 지휘관 Operation 이 지금 일하고 있는가(running·background) — 그동안 사람의 편집은 허용된 것만 받는다. */
  busy(itemId: string): boolean;
  /** 스티어링 — 지휘관에게 「바뀌었으니 보드를 다시 읽으라」는 한 줄을 보내고 쌓인 편집과 충족 판단을 비운다. */
  steer(itemId: string, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 전체 중단 — 지휘관과 모든 담당 Operation 에 인터럽트를 보낸다. */
  stop(itemId: string): Promise<{ readonly item: ObjectiveItem; readonly interrupted: number }>;
  /** Operation 이 삭제 유예에 들어갔다 — 지휘관이었다면 담당 Operation 도 함께 닫는다. */
  operationDeleted(operationId: string): void;
  /** Operation 이 복원 불가로 사라졌다 — 목표 레코드(지휘관)나 단계 연결(담당)을 거둔다. */
  operationPurged(operationId: string): void;
  /** 호스트의 `operation:grouped` — 지휘관이 옮겨지면 담당이 따라가고, 목표 화면을 다시 방송한다. */
  operationGrouped(event: OperationGroupedEvent): void;
  /** 제목 등 Operation 쪽 값이 바뀌었다 — 목표 화면을 다시 방송한다. */
  operationChanged(operationId: string): void;
  dispose(): void;
}

export interface LaunchOptions {
  readonly language?: PromptLanguage;
}

const languageOf = (options?: LaunchOptions): PromptLanguage => (options?.language === "ko" ? "ko" : "en");
/** 지휘관 기본값 — Opus · high. 카탈로그가 다르면 깨울 때 호스트가 거절한다. */
const COMMANDER_PRESET = { model: "opus[1m]", effort: "high" } as const;
/** 세션 이름 — 다른 세션이 이 세션을 부르는 주소. 담당 이름은 지휘관 이름의 머리를 잇는다. */
const commanderSession = () => `objective-${randomUUID().slice(0, 6)}-cmdr`;
const missionSession = (commander: string | null, index: number) => `${(commander ?? `objective-${randomUUID().slice(0, 6)}-cmdr`).replace(/-cmdr$/, "")}-mission-${index}`;

export function createLaunchService(ctx: FleetPluginServerContext, store: ObjectiveStore): LaunchService {
  const control = () => {
    const capability = ctx.host.consoleControl;
    if (!capability) throw new ObjectiveStoreError("launch_unavailable");
    return capability;
  };
  const item = (itemId: string) => {
    const found = store.find(itemId);
    if (!found) throw new ObjectiveStoreError("unknown_item");
    return found;
  };
  const step = (current: ObjectiveItem, stepId: string): ObjectiveStep => {
    const found = current.steps.find((candidate) => candidate.id === stepId);
    if (!found) throw new ObjectiveStoreError("unknown_step");
    return found;
  };
  const patchOperation = (operationId: string, patch: { title?: string; groupId?: string | null; payload?: Record<string, unknown> }) => {
    if (!ctx.host.operations.patch(operationId, patch)) throw new ObjectiveStoreError("unknown_item");
  };
  /**
   * 알림 문구의 언어를 그 Operation 에 남긴다. 콘솔 사용은 켜지 않는다 — 지휘관과 담당은 `fleet-objectives` 로 일하고
   * (지휘관은 읽고 쓰고, 담당은 읽기만), Console 이 필요하면 사람이 그 Operation 에서 허용한다.
   */
  const rememberLanguage = (operationId: string, language: PromptLanguage) => {
    const node = ctx.host.operations.get(operationId);
    if (node && node.payload.objectiveLanguage !== language) ctx.host.operations.patch(operationId, { payload: { ...node.payload, objectiveLanguage: language } });
  };

  /** 전달됐는지를 돌려준다 — 못 닿은 알림에 기대 상태를 지우면 다음 시작이 같은 변경을 말하지 못한다. */
  const send = async (operationId: string, text: string): Promise<boolean> => {
    if (!ctx.host.consoleControl || !ctx.host.operations.get(operationId)) return false;
    try { await ctx.host.consoleControl.request({ kind: "send", operationId, text }, `objectives:notice:${randomUUID()}`); return true; }
    catch { return false; }
  };
  // 호스트 제어 경로의 거절(invalid_launch_option 등)은 코드 그대로 호출자에게 — 뭉개지 않는다.
  const asStoreError = (error: unknown): never => {
    if (error instanceof ObjectiveStoreError) throw error;
    const code = error instanceof Error ? error.message : "";
    throw new ObjectiveStoreError(/^[a-z_]{1,64}$/.test(code) ? code : "launch_failed");
  };
  const launch = async (input: { theaterId: string; title: string; sessionName: string; model?: string; effort?: string; groupId: string | null; dormant?: boolean; subagents?: boolean }): Promise<string> => {
    const receipt = await control().request({
      kind: "launch",
      theaterId: input.theaterId,
      title: input.title,
      viewMode: "terminal",
      sessionName: input.sessionName,
      ...(input.dormant ? { dormant: true } : {}),
      // 담당은 이미 분배된 일을 맡았다 — 서브에이전트(fleet:execute 포함)로 다시 나누지 않는다.
      ...(input.subagents === false ? { disableSubagents: true } : {}),
      ...(input.model && input.model !== "default" ? { model: input.model } : {}),
      ...(input.effort && input.effort !== "auto" ? { effort: input.effort } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
    }, `objectives:launch:${randomUUID()}`);
    if (!receipt.operationId) throw new ObjectiveStoreError(receipt.error ?? "launch_failed");
    return receipt.operationId;
  };

  // 호스트의 제목 한도(120자) 안에서 「항목 › n. 단계」.
  const workerTitle = (title: string, index: number, text: string): string => {
    const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value);
    return cut(`${cut(title, 48)} › ${index}. ${text}`, 120);
  };
  // 같은 목표에 기동 요청이 겹치면 Operation 이 둘 뜬다 — 기동이 끝날 때까지 자리를 잡아 둔다.
  const pending = new Set<string>();
  const claim = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    if (pending.has(key)) throw new ObjectiveStoreError("slot_taken");
    pending.add(key);
    try { return await run(); } finally { pending.delete(key); }
  };

  /**
   * 단계의 모델·강도 — 사전 배정이 정한다. route 는 AI Gateway 라우팅에 단계 본문을 보내 난이도에 맞는 모델을 받는다
   * (라우팅이 꺼져 있거나 실패하면 지휘관 프리셋으로). model 은 그 모델·강도, 없으면 지휘관 프리셋.
   */
  const routeStep = async (current: ObjectiveItem, target: ObjectiveStep, index: number): Promise<{ model?: string; effort?: string }> => {
    const fallback = { model: current.commander.model, effort: current.commander.effort };
    const origin = (ctx.host as { server?: { origin?: () => string | null } }).server?.origin?.() ?? null;
    if (!origin) return fallback;
    try {
      const response = await fetch(`${origin}/api/v1/ai-gateway/routing-test`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ prompt: `${current.title}\n\n${index}. ${target.text}\n${current.note.slice(0, 2000)}` }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) return fallback;
      const decision = await response.json() as { model?: string; effort?: string };
      return decision.model ? { model: decision.model, effort: decision.effort ?? fallback.effort } : fallback;
    } catch { return fallback; }
  };
  const stepLaunchPreset = async (current: ObjectiveItem, target: ObjectiveStep, index: number): Promise<{ model?: string; effort?: string }> => {
    if (target.assign?.mode === "model") return { model: target.assign.model ?? current.commander.model, effort: target.assign.effort ?? current.commander.effort };
    if (target.assign?.mode === "route") return routeStep(current, target, index);
    return { model: current.commander.model, effort: current.commander.effort };
  };

  const WORKING = new Set(["running", "background"]);
  const working = (operationId: string): boolean => {
    const observation = ctx.host.consoleControl?.observe(operationId);
    return !!observation && observation.lifecycle !== "dormant" && WORKING.has(observation.activity);
  };
  const stoppable = (operationId: string) => { const observation = ctx.host.consoleControl?.observe(operationId); return !!observation && observation.lifecycle !== "dormant" && observation.activity !== "idle" && observation.activity !== "ended"; };
  /** 지휘관이 한 번도 깨지 않았다 — 보드를 처음부터 읽으므로 앞서 쌓인 편집 기록은 뜻이 없다. */
  const neverStarted = (operationId: string) => { const node = ctx.host.operations.get(operationId); return !!node && !readOperationLaunch(node.payload).started; };
  /** 지휘관 Operation 이 담당들과 함께 서야 할 그룹으로 담당을 옮긴다. */
  const followGroup = (current: ObjectiveItem) => {
    for (const candidate of current.steps) {
      const operationId = candidate.operationId;
      const node = operationId ? ctx.host.operations.get(operationId) : null;
      if (!node || node.theaterId !== current.theaterId || (node.groupId ?? null) === current.groupId) continue;
      ctx.host.operations.patch(node.id, { groupId: current.groupId });
    }
  };

  const service: LaunchService = {
    describe: () => ({ available: !!ctx.host.consoleControl }),

    async create(input, options) {
      const language = languageOf(options);
      const operationId = await launch({ theaterId: input.theaterId, title: input.title, sessionName: commanderSession(), ...COMMANDER_PRESET, groupId: input.groupId, dormant: true }).catch(asStoreError);
      rememberLanguage(operationId, language);
      try {
        return store.adopt(operationId, input);
      } catch (error) {
        // 레코드를 세우지 못한 지휘관은 가리킬 목표가 없다 — 남기지 않는다.
        try { ctx.host.operations.delete(operationId); } catch { /* ignore */ }
        throw error;
      }
    },

    remove(itemId) {
      const current = item(itemId);
      // 레코드는 Operation 이 복원 불가로 사라질 때(operation:purged) 거둔다 — 유예 동안 복원하면 목표도 돌아온다.
      if (!ctx.host.operations.delete(itemId)) throw new ObjectiveStoreError("unknown_item");
      return current;
    },

    rename(itemId, title) {
      patchOperation(itemId, { title });
      return item(itemId);
    },

    regroup(itemId, groupId) {
      const current = item(itemId);
      // 없는 그룹이나 다른 Theater 의 그룹으로 옮기지 않는다.
      if (groupId !== null && ctx.host.operations.groups?.get(groupId)?.theaterId !== current.theaterId) throw new ObjectiveStoreError("unknown_group");
      patchOperation(itemId, { groupId });
      // 담당 이동과 방송은 호스트의 operation:grouped 가 맡는다(operationGrouped).
      return item(itemId);
    },

    setPreset(itemId, preset) {
      const node = ctx.host.operations.get(itemId);
      if (!node) throw new ObjectiveStoreError("unknown_item");
      patchOperation(itemId, { payload: withOperationLaunchPreset(node.payload, preset) });
      store.refresh(itemId);
      return item(itemId);
    },

    startCoordinator: (itemId, options) => claim(itemId, async () => {
      const language = languageOf(options);
      let current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      // 따로 만든 Operation 도 지휘관이 될 수 있다 — 보드를 읽고 쓰려면 콘솔 사용이 켜져 있어야 한다.
      rememberLanguage(itemId, language);
      // 시작은 구상을 끝낸다 — 여기서부터 계획·단계 추가가 담당을 띄울 수 있다.
      if (current.cooking) current = store.setCooking(itemId, false);
      // 새 지휘관은 보드를 처음부터 읽는다 — 앞서 쌓인 변경 기록은 뜻이 없다.
      if (neverStarted(itemId)) current = store.setEdited(itemId, null);
      const delivered = await send(itemId, startTurn(current, language));
      if (!delivered) throw new ObjectiveStoreError("launch_failed");
      // 알림이 닿았을 때만 지운다 — 못 닿았으면 다음 시작이 다시 말한다.
      return { item: store.setEdited(itemId, null), operationId: itemId };
    }),

    requestPlan: (itemId, options) => claim(itemId, async () => {
      const language = languageOf(options);
      let current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      rememberLanguage(itemId, language);
      // 구상은 계획과 메모만이다 — 단계 수행도, 담당 기동도 「시작」이 한다.
      if (!current.cooking) current = store.setCooking(itemId, true);
      if (neverStarted(itemId)) current = store.setEdited(itemId, null);
      if (!(await send(itemId, cookTurn(current, language)))) throw new ObjectiveStoreError("launch_failed");
      return { item: current, operationId: itemId };
    }),

    stepPatched: (itemId, stepId, patch) => store.stepPatch(itemId, stepId, patch),
    stepAdded: (itemId, input, options) => store.stepAdd(itemId, input, { unplaced: options?.by === "human" }),
    planApplied: (itemId, plan) => store.plan(itemId, plan),

    delegateStep: (itemId, stepId, options) => claim(`${itemId}:${stepId}`, async () => {
      const language = languageOf(options);
      const current = item(itemId);
      const target = step(current, stepId);
      if (target.done) throw new ObjectiveStoreError("step_done");
      if (target.operationId) throw new ObjectiveStoreError("slot_taken");
      const index = current.steps.indexOf(target) + 1;
      const session = missionSession(current.commander.sessionName, index);
      const chosen = await stepLaunchPreset(current, target, index);
      const operationId = await launch({ theaterId: current.theaterId, title: workerTitle(current.title, index, target.text), sessionName: session, model: chosen.model, effort: chosen.effort, groupId: current.groupId, subagents: false }).catch(asStoreError);
      rememberLanguage(operationId, language);
      return { item: store.setStepOperation(itemId, target.id, operationId), operationId, session };
    }),

    unlinkStep: (itemId, stepId) => store.setStepOperation(itemId, stepId, null),

    busy: (itemId) => working(item(itemId).id),

    async steer(itemId, options) {
      const current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      // 통지(send)와 달리 실패를 삼키지 않는다 — 지휘관이 받지 못했는데 띠가 「중단」으로 돌아가면 사람은 전해진 줄 안다.
      const receipt = await control().request({ kind: "send", operationId: itemId, text: steerTurn(current, languageOf(options)) }, `objectives:steer:${randomUUID()}`).catch(asStoreError);
      if (receipt.status === "rejected" || receipt.status === "failed") asStoreError(new Error(receipt.error ?? "steer_failed"));
      // 지휘관에게 닿았다 — 쌓인 편집을 지우고, 지휘관이 다시 일하므로 앞선 충족 판단(곧 검토 대기)도 거둔다.
      store.setEdited(itemId, null);
      return store.clearMet(itemId);
    },

    async stop(itemId) {
      let current = item(itemId);
      if (current.cooking) current = store.setCooking(itemId, false);
      const ids = [current.id, ...current.steps.flatMap((candidate) => (candidate.operationId ? [candidate.operationId] : []))];
      let interrupted = 0;
      for (const operationId of ids) {
        if (!stoppable(operationId)) continue;
        try { await control().request({ kind: "interrupt", operationId }, `objectives:stop:${randomUUID()}`); interrupted += 1; }
        catch { /* 이미 멈췄거나 받을 수 없는 Operation — 나머지는 계속 멈춘다. */ }
      }
      return { item: current, interrupted };
    },

    operationDeleted(operationId) {
      // 지휘관이 닫히면 그 목표의 담당 Operation 도 닫는다 — 담당은 지휘관 없이는 할 일이 없다.
      // 지휘관 Operation 은 이미 없으므로 레코드에서 담당을 찾는다. 레코드는 purge 때까지 남아 복원을 기다린다.
      for (const memberId of store.assigneesOf(operationId)) {
        if (memberId === operationId) continue;
        try { ctx.host.operations.delete(memberId); } catch { /* 이미 사라졌으면 그만 */ }
      }
    },

    operationPurged: (operationId) => store.forget(operationId),

    operationGrouped(event) {
      const current = store.find(event.operationId);
      if (current) { followGroup(current); store.refresh(event.operationId); }
    },

    operationChanged: (operationId) => store.refresh(operationId),

    dispose: () => undefined,
  };
  return service;
}

export const selfCaller = (ctx: FleetPluginServerContext): ConsoleCaller => ({ kind: "plugin", pluginId: ctx.pluginId });
