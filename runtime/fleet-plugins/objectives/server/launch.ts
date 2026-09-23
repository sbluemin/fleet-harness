import { randomUUID } from "node:crypto";

import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { cookTurn, readySteps, sessionNames, startTurn, steerTurn, type PromptLanguage } from "./prompts.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { assignModeOf, type LaunchView, type PlanInput, type Slot, type SlotBy, type StepAddInput, type StepPatchInput, type ObjectiveItem, type ObjectiveStep } from "./types.js";

/**
 * 시작·연결·통지 — Operation 을 만들고 슬롯을 채우는 쪽.
 *
 * 시작 한 번이 조율자 하나와 열린 단계마다 담당 하나를 **한꺼번에** 띄운다. 모두 이름 붙은 CLI 세션이라 조율자는
 * Claude Code 의 세션 간 메시지로 담당에게 지시하고 보고를 받는다 — Console 은 그 대화를 중계하지 않는다.
 * Console 이 조율자에게 넣는 통지는 셋뿐이다: 연결됨 · 구상 요청 · 담당 세션이 떴다(이름 목록).
 * 「콘솔 사용」은 조율자에게만 켠다. 담당은 도구 없이 자기 단계만 한다.
 */

export interface LaunchService {
  describe(): { readonly available: boolean };
  startCoordinator(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string }>;
  linkCoordinator(itemId: string, operationId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem }>;
  requestPlan(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string; readonly started: boolean }>;
  complete(itemId: string, by: SlotBy, options?: LaunchOptions): Promise<ObjectiveItem>;
  stepPatched(itemId: string, stepId: string, patch: StepPatchInput, by: SlotBy, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 사람이 더한 단계(`by: "human"`)는 선행을 함께 주지 않았다면 미분류로 들어간다 — 지휘관의 추가는 지휘관이 이미 자리를 안다. */
  stepAdded(itemId: string, input: StepAddInput, options?: LaunchOptions & { readonly by?: SlotBy }): Promise<ObjectiveItem>;
  planApplied(itemId: string, plan: PlanInput, by: SlotBy, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 위임 — 지휘관이 이 단계를 맡길 때 그 단계의 담당 세션을 띄운다(프롬프트 없음, Console Use 켬). 이름을 돌려주면 지휘관이 메시지로 일을 시킨다. */
  delegateStep(itemId: string, stepId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string; readonly session: string }>;
  unlinkStep(itemId: string, stepId: string, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 조율자 Operation 이 지금 일하고 있는가(running·background) — 그동안 사람의 편집은 허용된 것만 받는다. 쌓인 편집은 「스티어링」이 알린다. */
  busy(itemId: string): boolean;
  /** 스티어링 — 지휘관 세션에 「바뀌었으니(무엇이) 보드를 다시 읽으라」는 한 줄을 보내고 쌓인 편집(edited)과 검토 대기를 비운다. 보내지 못하면 둘 다 남긴 채 거절한다. */
  steer(itemId: string, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 전체 중단 — 조율자와 모든 담당 Operation 에 인터럽트를 보낸다. 슬롯은 남는다. */
  stop(itemId: string): Promise<{ readonly item: ObjectiveItem; readonly interrupted: number }>;
  /** Operation 이 삭제됐다 — 지휘관였다면 담당 Operation 도 함께 닫고, 어느 슬롯에 있었든 매핑을 지운다. */
  operationDeleted(operationId: string): void;
  dispose(): void;
}

export interface LaunchOptions {
  readonly language?: PromptLanguage;
}

const languageOf = (options?: LaunchOptions): PromptLanguage => (options?.language === "ko" ? "ko" : "en");

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
  const operation = (operationId: string) => {
    const node = ctx.host.operations.get(operationId);
    if (!node) throw new ObjectiveStoreError("unknown_operation");
    return node;
  };
  const preset = (current: ObjectiveItem): { model?: string; effort?: string; view?: LaunchView } => current.launch;

  /** payload 에 포인터·콘솔 사용 표식을 남긴다. */
  const mark = (operationId: string, objective: { itemId: string; stepId?: string; role: "coordinator" | "step" }, consoleUse: PromptLanguage | null) => {
    const node = ctx.host.operations.get(operationId);
    if (!node) return;
    const payload: Record<string, unknown> = { ...node.payload, objective };
    delete payload.todo;
    if (consoleUse) payload.consoleUse = { enabled: true, language: consoleUse };
    ctx.host.operations.patch(operationId, { payload });
  };
  const unmark = (operationId: string) => {
    const node = ctx.host.operations.get(operationId);
    if (!node || (!node.payload.objective && !node.payload.todo)) return;
    const payload: Record<string, unknown> = { ...node.payload };
    delete payload.objective;
    // 이름을 바꾸기 전(todo 플러그인)에 남긴 표식도 함께 거둔다.
    delete payload.todo;
    ctx.host.operations.patch(operationId, { payload });
  };

  /** 전달됐는지를 돌려준다 — 못 닿은 알림에 기대 상태를 지우면 다음 시작이 같은 변경을 말하지 못한다. */
  const send = async (operationId: string | undefined, text: string): Promise<boolean> => {
    if (!operationId || !ctx.host.consoleControl) return false;
    if (!ctx.host.operations.get(operationId)) return false;
    try { await ctx.host.consoleControl.request({ kind: "send", operationId, text }, `objectives:notice:${randomUUID()}`); return true; }
    catch { /* 닫혔거나 받을 수 없는 Operation 에는 통지를 버린다 — 상태는 스토어가 진실이다. */ return false; }
  };

  /** 지휘관에게는 한 줄 프롬프트(text), 담당에게는 아무것도 — 첫 턴 없이 서서 지휘관의 메시지를 기다린다. */
  const launch = async (input: { theaterId: string; title: string; text?: string; view?: LaunchView; sessionName: string; model?: string; effort?: string; groupId: string | null; subagents?: boolean }): Promise<string> => {
    const receipt = await control().request({
      kind: "launch",
      theaterId: input.theaterId,
      title: input.title,
      ...(input.text ? { text: input.text, displayFormat: "markdown" as const } : {}),
      // 담당은 이미 분배된 일을 맡았다 — 서브에이전트(fleet:execute 포함)로 다시 나누지 않는다.
      ...(input.subagents === false ? { disableSubagents: true } : {}),
      viewMode: input.view === "chat" ? "chat" : "terminal",
      sessionName: input.sessionName,
      ...(input.model && input.model !== "default" ? { model: input.model } : {}),
      ...(input.effort && input.effort !== "auto" ? { effort: input.effort } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
    }, `objectives:launch:${randomUUID()}`);
    if (!receipt.operationId) throw new ObjectiveStoreError(receipt.error ?? "launch_failed");
    return receipt.operationId;
  };
  // 호스트 제어 경로의 거절(invalid_launch_option 등)은 코드 그대로 호출자에게 — todo_failed 로 뭉개지 않는다.
  const asStoreError = (error: unknown): never => {
    if (error instanceof ObjectiveStoreError) throw error;
    const code = error instanceof Error ? error.message : "";
    throw new ObjectiveStoreError(/^[a-z_]{1,64}$/.test(code) ? code : "launch_failed");
  };


  // 호스트의 제목 한도(120자) 안에서 「항목 › n. 단계」 — 넘치면 단계 본문부터, 그래도 넘치면 항목 제목을 줄인다.
  // 한도를 넘긴 제목은 런치가 거절돼 그 단계가 담당 없이 조용히 남는다.
  const workerTitle = (title: string, index: number, text: string): string => {
    const MAX = 120;
    const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value);
    const head = cut(title, 48);
    const tail = `${index}. ${text}`;
    return cut(`${head} › ${tail}`, MAX);
  };
  // 같은 슬롯에 시작 요청이 겹치면 Operation 이 둘 뜬다 — 시작이 끝날 때까지 자리를 잡아 둔다.
  const pending = new Set<string>();
  const claim = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    if (pending.has(key)) throw new ObjectiveStoreError("slot_taken");
    pending.add(key);
    try { return await run(); } finally { pending.delete(key); }
  };

  /**
   * 담당이 없는 열린 단계마다 담당 세션을 띄운다. 담당은 조율자의 프리셋(모델·강도)을 쓰고 항상 CLI 다.
   * 하나가 실패해도 나머지는 띄운다 — 못 뜬 단계는 조율자가 직접 한다(브리프 규칙). 띄운 목록을 돌려준다.
   */
  /**
   * 단계의 모델·강도 — 사전 배정이 정한다. route 는 AI Gateway 라우팅에 단계 본문을 보내 난이도에 맞는 모델을 받는다
   * (라우팅이 꺼져 있거나 실패하면 지휘관 프리셋으로). model 은 그 모델·강도, 없으면 지휘관 프리셋.
   */
  const routeStep = async (current: ObjectiveItem, target: ObjectiveStep, index: number): Promise<{ model?: string; effort?: string; because?: string }> => {
    const fallback = { model: preset(current).model, effort: preset(current).effort };
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
      const decision = await response.json() as { model?: string; effort?: string; because?: string };
      return decision.model ? { model: decision.model, effort: decision.effort ?? fallback.effort, because: decision.because } : fallback;
    } catch { return fallback; }
  };
  const stepLaunchPreset = async (current: ObjectiveItem, target: ObjectiveStep, index: number): Promise<{ model?: string; effort?: string }> => {
    if (target.assign?.mode === "model") return { model: target.assign.model ?? preset(current).model, effort: target.assign.effort ?? preset(current).effort };
    if (target.assign?.mode === "route") return routeStep(current, target, index);
    return { model: preset(current).model, effort: preset(current).effort };
  };

  /**
   * 담당 세션은 지휘관이 위임하는 순간 뜬다 — 목표는 담당에게 프롬프트를 보내지 않는다. 사람이 미리 배정한
   * 모델(route/model)은 그때 쓸 모델 선택으로만 작용한다.
   */
  const delegateStep = async (itemId: string, stepId: string, language: PromptLanguage): Promise<{ item: ObjectiveItem; operationId: string; session: string }> => {
    let current = item(itemId);
    const target = step(current, stepId);
    if (target.done) throw new ObjectiveStoreError("step_done");
    if (target.slot) throw new ObjectiveStoreError("slot_taken");
    const index = current.steps.indexOf(target) + 1;
    const session = sessionNames(current).step(index);
    const chosen = await stepLaunchPreset(current, target, index);
    const operationId = await launch({ theaterId: current.theaterId, title: workerTitle(current.title, index, target.text), view: "terminal", sessionName: session, model: chosen.model, effort: chosen.effort, groupId: current.groupId, subagents: false }).catch(asStoreError);
    mark(operationId, { itemId, stepId: target.id, role: "step" }, language);
    const slot: Slot = { operationId, since: Date.now(), launchedBy: current.slot ? { operationId: current.slot.operationId } : "human", sessionName: session, ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) };
    current = store.setSlot(itemId, target.id, slot);
    return { item: current, operationId, session };
  };

  const WORKING = new Set(["running", "background"]);
  const working = (operationId: string | undefined): boolean => {
    if (!operationId) return false;
    const observation = ctx.host.consoleControl?.observe(operationId);
    return !!observation && observation.lifecycle !== "dormant" && WORKING.has(observation.activity);
  };
  const stoppable = (operationId: string) => { const observation = ctx.host.consoleControl?.observe(operationId); return !!observation && observation.lifecycle !== "dormant" && observation.activity !== "idle" && observation.activity !== "ended"; };

  const service: LaunchService = {
    describe: () => ({ available: !!ctx.host.consoleControl }),

    startCoordinator: (itemId, options) => claim(itemId, async () => {
      const language = languageOf(options);
      let current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      // 시작은 구상을 끝내고 검토 대기를 거둔다 — 여기서부터 계획·단계 추가가 담당을 띄운다.
      if (current.cooking) current = store.setCooking(itemId, false);
      if (current.review) current = store.setReview(itemId, null);
      const open = current.steps.filter((candidate) => !candidate.done);
      // 단계 하나짜리 목표는 조율자가 곧 담당이다 — Operation 하나로 끝내고, 브리프도 그렇게 말한다.
      const alone = open.length === 1 && !open[0]!.slot ? open[0] : undefined;
      const brief = alone ? { self: alone } : {};
      // 담당과 대화하는 지휘관은 CLI 여야 하므로 위임 단계가 하나라도 있으면 터미널로 연다. 담당 자체는 지휘관이 위임할 때 뜬다.
      const delegated = !alone && open.some((candidate) => !candidate.slot && assignModeOf(candidate) !== "self");
      const names = sessionNames(current);
      // 조율자가 이미 있으면(사람이 연결했거나, 중단된 뒤) 새로 띄우지 않는다 — 그 세션에 브리프를 보내고 담당만 띄운다.
      if (current.slot) {
        const existing = current.slot;
        const delivered = await send(existing.operationId, startTurn(current, language));
        // 알림이 닿았을 때만 지운다 — 같은 변경을 다음 시작에 되풀이하지 않되, 못 닿았으면 다음 시작이 다시 말한다.
        if (delivered) current = store.setEdited(itemId, null);
        if (alone) current = store.setSlot(itemId, alone.id, existing);
        return { item: current, operationId: existing.operationId };
      }
      // 새 지휘관은 보드를 처음부터 읽는다 — 앞선 지휘관에게 남겨 둔 변경 기록은 의미가 없다.
      current = store.setEdited(itemId, null);
      // 담당과 대화하려면 조율자도 이름 붙은 CLI 세션이어야 한다 — 담당이 있을 때는 채팅뷰를 고르지 않는다.
      const view: LaunchView | undefined = delegated ? "terminal" : preset(current).view;
      const operationId = await launch({ theaterId: current.theaterId, title: current.title, text: startTurn(current, language), view, sessionName: names.coordinator, model: preset(current).model, effort: preset(current).effort, groupId: current.groupId }).catch(asStoreError);
      mark(operationId, { itemId, role: "coordinator" }, language);
      const slot: Slot = { operationId, since: Date.now(), launchedBy: "human", sessionName: names.coordinator, ...(preset(current).model ? { model: preset(current).model! } : {}), ...(preset(current).effort ? { effort: preset(current).effort! } : {}) };
      current = store.setSlot(itemId, null, slot);
      if (alone) current = store.setSlot(itemId, alone.id, slot);
      return { item: current, operationId };
    }),

    async linkCoordinator(itemId, operationId, options) {
      const language = languageOf(options);
      const current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      operation(operationId);
      mark(operationId, { itemId, role: "coordinator" }, language);
      // 연결은 매핑일 뿐이다 — 통지도 브리프도 보내지 않는다. 일은 「시작」이 시킨다.
      const next = store.setSlot(itemId, null, { operationId, since: Date.now(), launchedBy: "human" });
      return { item: next };
    },

    requestPlan: (itemId, options) => claim(itemId, async () => {
      const language = languageOf(options);
      let current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      // 구상은 계획과 메모만이다 — 단계 수행도, 담당 기동도 「시작」이 한다.
      if (!current.cooking) current = store.setCooking(itemId, true);
      if (current.review) current = store.setReview(itemId, null);
      if (!current.slot) {
        current = store.setEdited(itemId, null);
        const names = sessionNames(current);
        const operationId = await launch({ theaterId: current.theaterId, title: current.title, text: cookTurn(current, language), view: preset(current).view, sessionName: names.coordinator, model: preset(current).model, effort: preset(current).effort, groupId: current.groupId }).catch(asStoreError);
        mark(operationId, { itemId, role: "coordinator" }, language);
        const next = store.setSlot(itemId, null, { operationId, since: Date.now(), launchedBy: "human", sessionName: names.coordinator, ...(preset(current).model ? { model: preset(current).model! } : {}), ...(preset(current).effort ? { effort: preset(current).effort! } : {}) });
        return { item: next, operationId, started: true };
      }
      // 지휘관이 이미 있으면 같은 구상 턴을 메시지로 보낸다.
      await send(current.slot.operationId, cookTurn(current, language));
      return { item: current, operationId: current.slot.operationId, started: false };
    }),

    async complete(itemId, by, options) {
      const language = languageOf(options);
      const current = item(itemId);
      if (current.done) return current;
      // 매핑과 표식은 남는다 — 완료는 상태이지 연결 해제가 아니다.
      return store.complete(itemId, by);
    },

    async stepPatched(itemId, stepId, patch, by) {
      let current = store.stepPatch(itemId, stepId, patch, by);
      // 단계를 되돌리면 검토 대기도 거둔다.
      if (patch.done === false && current.review) current = store.setReview(itemId, null);
      return current;
    },

    async stepAdded(itemId, input, options) {
      return store.stepAdd(itemId, input, { unplaced: options?.by === "human" });
    },

    async steer(itemId, options) {
      const current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      if (!current.slot) throw new ObjectiveStoreError("no_commander");
      operation(current.slot.operationId);
      // 통지(send)와 달리 실패를 삼키지 않는다 — 지휘관이 받지 못했는데 띠가 「중단」으로 돌아가면 사람은 전해진 줄 안다.
      const receipt = await control().request({ kind: "send", operationId: current.slot.operationId, text: steerTurn(current, languageOf(options)) }, `objectives:steer:${randomUUID()}`).catch(asStoreError);
      if (receipt.status === "rejected" || receipt.status === "failed") asStoreError(new Error(receipt.error ?? "steer_failed"));
      // 지휘관에게 닿았다 — 쌓인 편집은 알렸으니 지운다(띠는 「중단」으로 돌아간다). 검토 대기 중이었다면 지휘관이 다시 일하므로 검토 대기도 거둔다.
      const steered = store.setEdited(itemId, null);
      return steered.review ? store.setReview(itemId, null) : steered;
    },

    async planApplied(itemId, plan, by) {
      return store.plan(itemId, plan, by);
    },

    delegateStep: (itemId, stepId, options) => delegateStep(itemId, stepId, languageOf(options)),

    async unlinkStep(itemId, stepId) {
      const before = item(itemId);
      const previous = step(before, stepId).slot;
      if (previous) unmark(previous.operationId);
      return store.setSlot(itemId, stepId, null);
    },

    busy: (itemId) => working(item(itemId).slot?.operationId),

    async stop(itemId) {
      let current = item(itemId);
      if (current.cooking) current = store.setCooking(itemId, false);
      const ids = [current.slot?.operationId, ...current.steps.map((candidate) => candidate.slot?.operationId)].filter((id): id is string => !!id);
      let interrupted = 0;
      for (const operationId of ids) {
        if (!stoppable(operationId)) continue;
        try { await control().request({ kind: "interrupt", operationId }, `objectives:stop:${randomUUID()}`); interrupted += 1; }
        catch { /* 이미 멈췄거나 받을 수 없는 Operation — 나머지는 계속 멈춘다. */ }
      }
      return { item: current, interrupted };
    },

    operationDeleted(operationId) {
      // 지휘관이 닫히면 그 항목의 담당 Operation 도 닫는다 — 담당은 지휘관 없이는 할 일이 없다.
      for (const current of store.all()) {
        if (current.slot?.operationId !== operationId) continue;
        for (const step of current.steps) {
          const memberId = step.slot?.operationId;
          if (!memberId || memberId === operationId) continue;
          try { ctx.host.operations.delete(memberId); } catch { /* 이미 사라졌으면 그만 */ }
          store.forgetOperation(memberId);
        }
      }
      // 사람이 Operation 만 따로 닫았다면 「—」 로 남기지 않고 매핑을 지운다.
      store.forgetOperation(operationId);
    },

    dispose: () => undefined,
  };
  return service;
}

export { readySteps };
export type { SlotBy };
export const selfCaller = (ctx: FleetPluginServerContext): ConsoleCaller => ({ kind: "plugin", pluginId: ctx.pluginId });
