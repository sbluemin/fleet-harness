import { randomUUID } from "node:crypto";

import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import { readOperationLaunch, withOperationLaunchPreset, type OperationGroupedEvent } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { cookTurn, startTurn, steerTurn, type PromptLanguage } from "./prompts.js";
import { ObjectiveStoreError, type ObjectiveInit, type ObjectiveStore } from "./store.js";
import type { MemberPatchInput, ObjectiveItem, ObjectiveMember, PlanInput, SlotBy, StepAddInput, StepPatchInput } from "./types.js";

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
  create(input: { readonly theaterId: string; readonly title: string; readonly groupId: string | null; readonly viewMode?: "terminal" | "chat" } & ObjectiveInit, options?: LaunchOptions): Promise<ObjectiveItem>;
  /** 목표를 지운다 — 지휘관 Operation 을 닫는다(삭제 유예 동안 복원할 수 있고, 담당도 함께 닫힌다). */
  remove(itemId: string): ObjectiveItem;
  /** 완료를 먼저 기록한 뒤 지휘관과 담당 Operation을 비동기로 휴면시킨다. */
  complete(itemId: string): ObjectiveItem;
  rename(itemId: string, title: string): ObjectiveItem;
  regroup(itemId: string, groupId: string | null): ObjectiveItem;
  /** 지휘관의 모델·강도 — 지휘관 Operation 에 쓴다(다음 깨움부터 쓰인다). */
  setPreset(itemId: string, preset: { readonly model?: string; readonly effort?: string; readonly viewMode?: "terminal" | "chat" }): ObjectiveItem;
  startCoordinator(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string }>;
  requestPlan(itemId: string, options?: LaunchOptions): Promise<{ readonly item: ObjectiveItem; readonly operationId: string }>;
  stepPatched(itemId: string, stepId: string, patch: StepPatchInput): ObjectiveItem;
  /** 사람이 더한 단계(`by: "human"`)는 선행을 함께 주지 않았다면 미분류로 들어간다 — 지휘관의 추가는 지휘관이 이미 자리를 안다. */
  stepAdded(itemId: string, input: StepAddInput, options?: { readonly by?: SlotBy }): ObjectiveItem;
  planApplied(itemId: string, plan: PlanInput): ObjectiveItem;
  /** 구성원 명단을 대기 기동하거나 휴면 세션째 재개한다. */
  muster(itemId: string): Promise<readonly { readonly id: string; readonly role: string; readonly session: string; readonly operationId: string; readonly state: "live" | "launched" | "resumed" | "unknown" }[]>;
  /** 사람 경로의 구성원 수정. 서브에이전트 허용이 바뀌면 다음 기동 정책만 호스트에 알리고, 떠 있는 프로세스는 건드리지 않는다. */
  memberPatched(itemId: string, memberId: string, patch: MemberPatchInput): ObjectiveItem;
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
  /** 사람이 개시·스티어링에 덧붙인 말 — 그 알림 아래 인용으로 한 번 간다(저장하지 않는다). 구상의 말은 목표의 `cook` 에 산다. */
  readonly context?: string;
}

const languageOf = (options?: LaunchOptions): PromptLanguage => (options?.language === "ko" ? "ko" : "en");
/** 지휘관 기본값 — Opus · high. 카탈로그가 다르면 깨울 때 호스트가 거절한다. */
const COMMANDER_PRESET = { model: "opus[1m]", effort: "high" } as const;
/** 세션 이름 — 다른 세션이 이 세션을 부르는 주소. 담당 이름은 지휘관 이름의 머리를 잇는다. */
const commanderSession = () => `objective-${randomUUID().slice(0, 6)}-cmdr`;
const memberSession = (commander: string | null, index: number) => `${(commander ?? `objective-${randomUUID().slice(0, 6)}-cmdr`).replace(/-cmdr$/, "")}-member-${index}`;

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
  const launch = async (input: { theaterId: string; title: string; sessionName: string; model?: string; effort?: string; groupId: string | null; viewMode?: "terminal" | "chat"; dormant?: boolean; subagents?: boolean; parentOperationId?: string }): Promise<string> => {
    const receipt = await control().request({
      kind: "launch",
      theaterId: input.theaterId,
      title: input.title,
      viewMode: input.viewMode ?? "terminal",
      sessionName: input.sessionName,
      ...(input.dormant ? { dormant: true } : {}),
      // 허용하지 않은 구성원만 태어날 때 서브에이전트(fleet:execute 포함)를 끈다. 허용은 전역 정책을 그대로 쓴다.
      ...(input.subagents === false ? { disableSubagents: true } : {}),
      ...(input.model && input.model !== "default" ? { model: input.model } : {}),
      ...(input.effort && input.effort !== "auto" ? { effort: input.effort } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      // 구성원은 태어날 때부터 지휘관 아래 선다 — 코어가 목록 표면에서 빼고 지휘관이 대표한다.
      ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : {}),
    }, `objectives:launch:${randomUUID()}`);
    if (!receipt.operationId) throw new ObjectiveStoreError(receipt.error ?? "launch_failed");
    return receipt.operationId;
  };

  // 호스트의 제목 한도(120자) 안에서 「목표 › 역할」.
  const memberTitle = (title: string, role: string): string => `${title} › ${role}`.slice(0, 120);
  // 같은 목표에 기동 요청이 겹치면 Operation 이 둘 뜬다 — 기동이 끝날 때까지 자리를 잡아 둔다.
  const pending = new Set<string>();
  const claim = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    if (pending.has(key)) throw new ObjectiveStoreError("slot_taken");
    pending.add(key);
    try { return await run(); } finally { pending.delete(key); }
  };

  /** 라우팅이 없거나 실패하면 지휘관 프리셋으로 돌아간다. 역할·설명을 라우터에 건넨다. */
  const routeMember = async (current: ObjectiveItem, member: ObjectiveMember): Promise<{ model?: string; effort?: string }> => {
    const fallback = { model: current.commander.model, effort: current.commander.effort };
    const origin = (ctx.host as { server?: { origin?: () => string | null } }).server?.origin?.() ?? null;
    if (!origin) return fallback;
    try {
      const response = await fetch(`${origin}/api/v1/ai-gateway/routing-test`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ prompt: `${current.title}\n\n${member.role}\n${member.brief ?? ""}\n${current.note.slice(0, 2000)}` }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) return fallback;
      const decision = await response.json() as { model?: string; effort?: string };
      return decision.model ? { model: decision.model, effort: decision.effort ?? fallback.effort } : fallback;
    } catch { return fallback; }
  };
  /** 다음 프로세스 기동에 쓸 정책. 세션 payload를 직접 고치지 않고, 떠 있는 프로세스는 중단하지 않는다. */
  const rememberSubagentSpawn = (operationId: string, allowed: boolean) => {
    ctx.host.consoleControl?.setSubagentSpawn?.(operationId, allowed ? "default" : "blocked");
  };
  const memberPreset = (current: ObjectiveItem, member: ObjectiveMember) => member.launch.mode === "model"
    ? { model: member.launch.model, effort: member.launch.effort }
    : { model: current.commander.model, effort: current.commander.effort };

  const WORKING = new Set(["running", "background"]);
  const working = (operationId: string): boolean => {
    const observation = ctx.host.consoleControl?.observe(operationId);
    return !!observation && observation.lifecycle !== "dormant" && WORKING.has(observation.activity);
  };
  const stoppable = (operationId: string) => { const observation = ctx.host.consoleControl?.observe(operationId); return !!observation && observation.lifecycle !== "dormant" && observation.activity !== "idle" && observation.activity !== "ended"; };
  const settleIntervalMs = 100;
  const settleDeadlineMs = 10_000;
  const waitFor = async (ready: () => boolean, cancelled: () => boolean = () => false): Promise<boolean> => {
    const deadline = Date.now() + settleDeadlineMs;
    while (!ready()) {
      if (cancelled() || Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, settleIntervalMs));
    }
    return true;
  };
  const sleepCompleted = async (current: ObjectiveItem): Promise<void> => {
    const capability = ctx.host.consoleControl;
    const sleep = capability?.sleep?.bind(capability);
    if (!capability || !sleep) return;
    // 지휘관과 명단의 모든 구성원 — 임무를 맡지 않은 구성원도 함께 재운다.
    const ids = new Set([current.id, ...current.members.flatMap((candidate) => candidate.operationId ? [candidate.operationId] : [])]);
    await Promise.all([...ids].map(async (operationId) => {
      const warn = (reason: string) => console.warn(`[objectives] Could not sleep completed Operation ${operationId}: ${reason}`);
      const stillCompleted = () => {
        const latest = store.find(current.id);
        return !!latest?.done && (operationId === current.id || latest.members.some((candidate) => candidate.operationId === operationId));
      };
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!stillCompleted()) return; // 완료를 되돌렸거나 연결을 풀었다면 아직 시작하지 않은 휴면은 취소한다.
          const observation = capability.observe(operationId);
          if (!observation) { warn("observation_unavailable"); return; }
          if (observation.lifecycle === "dormant") return;
          if (observation.lifecycle !== "live") { warn("lifecycle_unknown"); return; }
          // 터미널의 답 대기와 백그라운드 작업은 멈출 턴이 없어 interrupt 를 받지 않는다 — 완료는 사람이 내린 종결이므로 그 대기·작업을 끝내고 바로 재운다.
          const endPendingWork = (observation.activity === "awaiting" || observation.activity === "background") && !observation.supportedActions.includes("interrupt");
          if (observation.activity !== "idle" && !endPendingWork) {
            if (observation.activity === "ended" || observation.activity === "unknown") { warn(`activity_${observation.activity}`); return; }
            try {
              const receipt = await capability.request({ kind: "interrupt", operationId }, `objectives:complete:${randomUUID()}`);
              if (receipt.status === "failed" || receipt.status === "rejected") { warn(receipt.error ?? "interrupt_failed"); return; }
            } catch (error) {
              // 관측과 접수 사이에 스스로 유휴가 된 경우는 중단 없이 바로 휴면을 시도한다.
              if (!(error instanceof Error && error.message === "nothing_to_interrupt")) throw error;
            }
            if (!await waitFor(() => {
              const next = capability.observe(operationId);
              return next?.lifecycle === "dormant" || next?.lifecycle === "live" && next.activity === "idle";
            }, () => !stillCompleted())) { if (stillCompleted()) warn("interrupt_timeout"); return; }
          }
          if (!stillCompleted()) return;
          if (capability.observe(operationId)?.lifecycle === "dormant") return;
          const result = await sleep(operationId, endPendingWork ? { endPendingWork: true } : undefined);
          if (!result.ok) {
            if (result.error === "already_dormant") return;
            if (result.error === "not_idle" && attempt === 0) continue;
            warn(result.error); return;
          }
          if (result.lifecycle === "ending" && !await waitFor(() => capability.observe(operationId)?.lifecycle === "dormant", () => !stillCompleted()) && stillCompleted()) warn("sleep_timeout");
          return;
        }
      } catch (error) { warn(error instanceof Error ? error.message : "unexpected_failure"); }
    }));
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
  const announceStarted = (itemId: string) => {
    const deadline = Date.now() + ANNOUNCE_DEADLINE_MS;
    const tick = () => {
      if (!ctx.host.operations.get(itemId)) return;
      if (!neverStarted(itemId)) { store.refresh(itemId); return; }
      if (Date.now() >= deadline) return;
      const timer = setTimeout(() => { announceTimers.delete(timer); tick(); }, ANNOUNCE_POLL_MS);
      announceTimers.add(timer);
    };
    tick();
  };
  /** 지휘관 Operation 이 담당들과 함께 서야 할 그룹으로 담당을 옮긴다. */
  const followGroup = (current: ObjectiveItem) => {
    for (const candidate of current.members) {
      const operationId = candidate.operationId;
      const node = operationId ? ctx.host.operations.get(operationId) : null;
      if (!node || node.theaterId !== current.theaterId || (node.groupId ?? null) === current.groupId) continue;
      ctx.host.operations.patch(node.id, { groupId: current.groupId });
    }
  };

  const muster = (itemId: string): ReturnType<LaunchService["muster"]> => claim(`${itemId}:muster`, async () => {
    let current = item(itemId);
    if (current.cooking) throw new ObjectiveStoreError("planning_only");
    if (current.done) throw new ObjectiveStoreError("item_done");
    const members: Array<{ id: string; role: string; session: string; operationId: string; state: "live" | "launched" | "resumed" | "unknown" }> = [];
    for (let index = 0; index < current.members.length; index += 1) {
      const member = current.members[index]!;
      const operationId = member.operationId;
      const observation = operationId ? ctx.host.consoleControl?.observe(operationId) : null;
      const node = operationId ? ctx.host.operations.get(operationId) : null;
      if (node && node.theaterId !== current.theaterId) throw new ObjectiveStoreError("unknown_operation");
      if (operationId && node && observation?.lifecycle === "live") {
        members.push({ id: member.id, role: member.role, session: member.sessionName ?? memberSession(current.commander.sessionName, index + 1), operationId, state: "live" });
        continue;
      }
      if (operationId && node && observation?.lifecycle === "dormant") {
        // 앞선 구성원의 기동·재개를 기다리는 동안 바뀐 허용값도 이번 재개부터 반영한다.
        rememberSubagentSpawn(operationId, item(itemId).members.find((candidate) => candidate.id === member.id)?.subagents === true);
        const receipt = await control().request({ kind: "resume", operationId }, `objectives:resume:${randomUUID()}`).catch(asStoreError);
        if (receipt.status === "failed" || receipt.status === "rejected") throw new ObjectiveStoreError(receipt.error ?? "resume_failed");
        members.push({ id: member.id, role: member.role, session: member.sessionName ?? memberSession(current.commander.sessionName, index + 1), operationId, state: "resumed" });
        continue;
      }
      // 관측이 없는 Operation 은 세울지 판단할 수 없다 — 그 구성원만 건너뛰고 알린다(한 구성원 때문에 개시 전체를 막지 않는다).
      if (operationId && node) { members.push({ id: member.id, role: member.role, session: member.sessionName ?? memberSession(current.commander.sessionName, index + 1), operationId, state: "unknown" }); continue; }
      if (operationId) current = store.setMemberOperation(itemId, member.id, null);
      const used = new Set(current.members.flatMap((candidate) => candidate.sessionName ? [candidate.sessionName] : []));
      let number = index + 1;
      let session = memberSession(current.commander.sessionName, number);
      while (used.has(session)) session = memberSession(current.commander.sessionName, ++number);
      const preset = member.launch.mode === "route" ? await routeMember(current, member) : memberPreset(current, member);
      // 라우팅은 오래 걸릴 수 있으므로 실제 기동 요청 직전에 저장된 허용값을 읽는다.
      const allowed = item(itemId).members.find((candidate) => candidate.id === member.id)?.subagents === true;
      const launchedId = await launch({ theaterId: current.theaterId, title: memberTitle(current.title, member.role), sessionName: session, ...preset, groupId: current.groupId, subagents: allowed ? undefined : false, parentOperationId: current.id }).catch(asStoreError);
      rememberLanguage(launchedId, ctx.host.operations.get(itemId)?.payload.objectiveLanguage === "ko" ? "ko" : "en");
      try { current = store.setMemberOperation(itemId, member.id, launchedId); }
      catch (error) { ctx.host.operations.delete(launchedId); throw error; }
      // 라우팅·기동을 기다리는 동안 사람이 허용을 바꿀 수 있다. 그때는 Operation이 아직 없어 포트가 무시되므로, 연결 직후 저장된 값으로 다음 기동 정책만 다시 맞춘다. 방금 뜬 프로세스는 중단하지 않는다.
      const linked = current.members.find((candidate) => candidate.id === member.id);
      if (linked?.operationId) rememberSubagentSpawn(linked.operationId, linked.subagents === true);
      members.push({ id: member.id, role: member.role, session, operationId: launchedId, state: "launched" });
    }
    return members;
  });

  const service: LaunchService = {
    describe: () => ({ available: !!ctx.host.consoleControl }),

    async create(input, options) {
      const language = languageOf(options);
      const operationId = await launch({ theaterId: input.theaterId, title: input.title, sessionName: commanderSession(), ...COMMANDER_PRESET, groupId: input.groupId, viewMode: input.viewMode, dormant: true }).catch(asStoreError);
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

    complete(itemId) {
      const completed = store.complete(itemId);
      // 기록이 먼저 확정된다. PTY 휴면 확정은 오래 걸릴 수 있으므로 HTTP 응답을 붙잡지 않는다.
      void sleepCompleted(completed);
      return completed;
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
      // 수동 재개는 첫 메시지 전에도 세션을 초기화한다 — 살아 있는 세션의 프리셋을 뒤에서 바꾸지 않는다.
      if (readOperationLaunch(node.payload).started || pending.has(itemId) || control().observe(itemId)?.lifecycle === "live" || service.busy(itemId)) throw new ObjectiveStoreError("item_busy");
      if (item(itemId).done) throw new ObjectiveStoreError("item_done");
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
      // 개시는 구상을 끝내고 구성원을 먼저 대기 기동·재개한다.
      if (current.cooking) current = store.setCooking(itemId, false);
      await muster(itemId);
      current = item(itemId);
      // 새 지휘관은 보드를 처음부터 읽는다 — 앞서 쌓인 변경 기록은 뜻이 없다.
      const firstWake = neverStarted(itemId);
      if (firstWake) current = store.setEdited(itemId, null);
      const delivered = await send(itemId, startTurn(current, language, options?.context));
      if (!delivered) throw new ObjectiveStoreError("launch_failed");
      if (firstWake) announceStarted(itemId);
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
      const firstWake = neverStarted(itemId);
      if (firstWake) current = store.setEdited(itemId, null);
      if (!(await send(itemId, cookTurn(current, language)))) throw new ObjectiveStoreError("launch_failed");
      if (firstWake) announceStarted(itemId);
      return { item: current, operationId: itemId };
    }),

    stepPatched: (itemId, stepId, patch) => store.stepPatch(itemId, stepId, patch),
    stepAdded: (itemId, input, options) => store.stepAdd(itemId, input, { unplaced: options?.by === "human", ...(options?.by === "human" ? { by: "human" as const } : {}) }),
    planApplied: (itemId, plan) => store.plan(itemId, plan),

    muster,
    memberPatched(itemId, memberId, patch) {
      const next = store.memberPatch(itemId, memberId, patch);
      if (patch.subagents !== undefined) {
        const operationId = next.members.find((member) => member.id === memberId)?.operationId;
        if (operationId) rememberSubagentSpawn(operationId, patch.subagents === true);
      }
      return next;
    },

    busy: (itemId) => working(item(itemId).id),

    async steer(itemId, options) {
      const current = item(itemId);
      if (current.done) throw new ObjectiveStoreError("item_done");
      // 통지(send)와 달리 실패를 삼키지 않는다 — 지휘관이 받지 못했는데 띠가 「중단」으로 돌아가면 사람은 전해진 줄 안다.
      const receipt = await control().request({ kind: "send", operationId: itemId, text: steerTurn(current, languageOf(options), options?.context) }, `objectives:steer:${randomUUID()}`).catch(asStoreError);
      if (receipt.status === "rejected" || receipt.status === "failed") asStoreError(new Error(receipt.error ?? "steer_failed"));
      // 지휘관에게 닿았다 — 쌓인 편집을 지우고, 지휘관이 다시 일하므로 앞선 충족 판단(곧 검토 대기)도 거둔다.
      store.setEdited(itemId, null);
      return store.clearMet(itemId);
    },

    async stop(itemId) {
      let current = item(itemId);
      if (current.cooking) current = store.setCooking(itemId, false);
      const ids = [current.id, ...current.members.flatMap((candidate) => (candidate.operationId ? [candidate.operationId] : []))];
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

    dispose: () => { for (const timer of announceTimers) clearTimeout(timer); announceTimers.clear(); },
  };
  return service;
}

export const selfCaller = (ctx: FleetPluginServerContext): ConsoleCaller => ({ kind: "plugin", pluginId: ctx.pluginId });
