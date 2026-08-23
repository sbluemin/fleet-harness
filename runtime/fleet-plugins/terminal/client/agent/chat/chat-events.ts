/**
 * 서버 chat-stream 이벤트의 브라우저 쪽 어휘와 해석기.
 *
 * 서버 모듈(server/agent-api/chat-events.ts)과 같은 union을 손으로 복제한다 — 클라이언트
 * 번들이 서버 디렉터리를 import하면 Node 의존이 딸려 들어온다. 두 정의의 일치는
 * tests/agent-chat-events.test.ts가 못 박는다.
 */

/** 쓰기 계열 도구가 남긴 파일 변경 — 서버가 도구 입력에서 접어 보낸다. */
export interface AgentChatChange {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

export interface AgentChatQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface AgentChatQuestion {
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly AgentChatQuestionOption[];
}

export type AgentChatAskForm = "question" | "plan";
export type AgentChatAskOutcome = "answered" | "dismissed" | "approved" | "revised";

/** 원장에 선 카드 하나. settled가 붙으면 접힌 줄로 바뀐다. */
export interface AgentChatAsk {
  readonly id: string;
  readonly form: AgentChatAskForm;
  readonly questions: readonly AgentChatQuestion[];
  readonly plan?: string;
  /** 계획이 잘렸다 — 보여 주지 못한 단계가 있으므로 카드는 승인을 열지 않는다. */
  readonly truncated?: true;
  readonly outcome?: AgentChatAskOutcome;
  readonly answers?: readonly { readonly header: string; readonly value: string }[];
}

/** 턴보다 오래 사는 작업의 종류. 서버 모듈의 같은 이름과 한 벌이다. */
export type AgentChatJobKind = "agent" | "shell" | "workflow" | "other";

/** 잡의 결말. `stopped`는 실패가 아니라 끝나기 전에 거둬진 것이다. */
export type AgentChatJobStatus = "completed" | "failed" | "stopped";

export interface AgentChatJobAgent {
  readonly label: string;
  readonly model?: string;
  readonly state: string;
  readonly tokens?: number;
  readonly tools?: number;
  readonly durationMs?: number;
  readonly result?: string;
}

export interface AgentChatJobStage {
  readonly title: string;
  readonly agents: readonly AgentChatJobAgent[];
}

/** 문맥 창을 나눠 쓰는 한 덩어리. */
export interface AgentChatContextSlice {
  readonly name: string;
  readonly tokens: number;
}

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  /** 접속 시점의 snapshot이 모두 도착했다. 이 앞의 live opener는 복원이지 새 도착이 아니다. */
  | { readonly kind: "snapshot-end"; readonly turns: number }
  /**
   * 측정된 문맥 창 내역. control 채널만이 카테고리 분해를 알고, 그 왕복은 30초쯤 걸린다(실측).
   * `asOf`가 그 값이 언제의 것인지 말한다 — 부재는 `"start"`이며 옛 저널의 뜻이기도 하다.
   */
  | {
      readonly kind: "context";
      /** 실제로 쓰인 몫의 합. 예약분과 남은 자리는 여기 들어가지 않는다. */
      readonly total: number;
      readonly max: number;
      /** 자동 압축을 위해 미리 비워 둔 자리. 쓴 것이 아니지만 쓸 수도 없다. */
      readonly reserved?: number;
      readonly compactAt?: number;
      readonly slices: readonly AgentChatContextSlice[];
      readonly memoryFiles?: readonly AgentChatContextSlice[];
      readonly mcpTools?: readonly AgentChatContextSlice[];
      readonly asOf?: "start" | "end";
    }
  /** 라이브 전용 총량 — 저널에 실리지 않는다. 내역은 없다(control 채널만 그것을 안다). */
  | { readonly kind: "context-live"; readonly total: number; readonly max: number }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  /** 라이브 전용 글자 단위 델타 — 저널에는 실리지 않으며, 완성 text 이벤트가 정정 앵커다. */
  | { readonly kind: "text-delta"; readonly text: string }
  /** 라이브 전용 — 인자 JSON이 끝나기 전에 도착하는 도구 이름. 완성 tool 이벤트가 좌표를 채운다. */
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly detail: string;
      readonly id?: string;
      readonly outside?: boolean;
      readonly change?: AgentChatChange;
    }
  | { readonly kind: "tool-result"; readonly id: string; readonly ok: boolean; readonly summary: string }
  /** 모델이 멈춰 서서 사용자를 기다린다. 저널에 남으므로 재접속해도 같은 카드가 다시 선다. */
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly form: AgentChatAskForm;
      readonly questions?: readonly AgentChatQuestion[];
      readonly plan?: string;
      readonly truncated?: true;
    }
  | {
      readonly kind: "ask-settled";
      readonly id: string;
      readonly outcome: AgentChatAskOutcome;
      readonly answers?: readonly { readonly header: string; readonly value: string }[];
    }
  /** answer는 SDK result가 말한 최종 응답 텍스트 — 마지막 text의 Answer 승격에 대한 서버 권위. */
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly answer?: string; readonly stopped?: boolean }
  | {
      readonly kind: "job";
      readonly id: string;
      readonly jobKind: AgentChatJobKind;
      readonly title: string;
      readonly toolUseId?: string;
      readonly who?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "job-progress";
      readonly id: string;
      readonly note?: string;
      readonly tokens?: number;
      readonly tools?: number;
      readonly durationMs?: number;
      readonly lastTool?: string;
      readonly stages?: readonly AgentChatJobStage[];
    }
  | {
      readonly kind: "job-end";
      readonly id: string;
      /** 없으면 끝났다는 사실만 아는 것이다 — 알아보지 못한 결말에 성공을 적지 않는다. */
      readonly status?: AgentChatJobStatus;
      readonly summary?: string;
      readonly tokens?: number;
      readonly tools?: number;
      readonly durationMs?: number;
    }
  | { readonly kind: "jobs"; readonly ids: readonly string[] }
  | { readonly kind: "error"; readonly code: string };

export interface AgentChatJournalEvent {
  readonly seq: number;
  readonly event: AgentChatStreamEvent;
}

export function readChatJournalEvent(raw: string): AgentChatJournalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed as { readonly seq?: unknown; readonly event?: unknown };
  if (typeof entry.seq !== "number" || !entry.event || typeof entry.event !== "object") return null;
  const event = entry.event as { readonly kind?: unknown } & Record<string, unknown>;
  switch (event.kind) {
    case "replay-start":
      return { seq: entry.seq, event: { kind: "replay-start" } };
    case "snapshot-end":
      return { seq: entry.seq, event: { kind: "snapshot-end", turns: numberOr(event.turns, 0) } };
    case "context": {
      // 총량과 창 크기가 없으면 그릴 수 있는 것이 없다. 0짜리 미터는 사실이 아니라 빈칸이다.
      if (typeof event.total !== "number" || typeof event.max !== "number" || event.max <= 0) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "context",
          total: event.total,
          max: event.max,
          ...(typeof event.reserved === "number" ? { reserved: event.reserved } : {}),
          ...(typeof event.compactAt === "number" ? { compactAt: event.compactAt } : {}),
          slices: readContextSlices(event.slices),
          ...(Array.isArray(event.memoryFiles) ? { memoryFiles: readContextSlices(event.memoryFiles) } : {}),
          ...(Array.isArray(event.mcpTools) ? { mcpTools: readContextSlices(event.mcpTools) } : {}),
          // 모르는 값은 부재와 같이 다룬다 — 그것이 옛 저널의 뜻이고, 새 값이 들어오더라도
          // 총량을 권위로 삼는 쪽(`"end"`)으로 오해되지 않는다.
          ...(event.asOf === "end" ? { asOf: "end" as const } : {}),
        },
      };
    }
    case "context-live": {
      if (typeof event.total !== "number" || typeof event.max !== "number" || event.max <= 0) return null;
      return { seq: entry.seq, event: { kind: "context-live", total: event.total, max: event.max } };
    }
    case "replay-end":
      return { seq: entry.seq, event: { kind: "replay-end", turns: numberOr(event.turns, 0) } };
    case "dispatch":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "dispatch", text: event.text, ...atField(event.at) } };
    case "turn-start":
      return { seq: entry.seq, event: { kind: "turn-start", ...atField(event.at) } };
    case "text":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "text", text: event.text } };
    case "text-delta":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "text-delta", text: event.text } };
    case "tool-start":
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      if (typeof event.name !== "string" || event.name.length === 0) return null;
      return { seq: entry.seq, event: { kind: "tool-start", id: event.id, name: event.name } };
    case "tool":
      if (typeof event.name !== "string") return null;
      return {
        seq: entry.seq,
        event: {
          kind: "tool",
          name: event.name,
          detail: typeof event.detail === "string" ? event.detail : "",
          ...(typeof event.id === "string" && event.id.length > 0 ? { id: event.id } : {}),
          ...(event.outside === true ? { outside: true } : {}),
          ...(readChange(event.change) ? { change: readChange(event.change) as AgentChatChange } : {}),
        },
      };
    case "ask": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      if (event.form !== "question" && event.form !== "plan") return null;
      const questions = readQuestions(event.questions);
      const plan = typeof event.plan === "string" && event.plan.length > 0 ? event.plan : undefined;
      // 형태가 비면 카드가 아무것도 못 그린다 — 빈 카드를 세우느니 이벤트를 버린다.
      if (event.form === "question" ? questions.length === 0 : plan === undefined) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "ask",
          id: event.id,
          form: event.form,
          ...(questions.length > 0 ? { questions } : {}),
          ...(plan !== undefined ? { plan } : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        },
      };
    }
    case "ask-settled": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      const outcome = event.outcome;
      if (outcome !== "answered" && outcome !== "dismissed" && outcome !== "approved" && outcome !== "revised") return null;
      const answers = Array.isArray(event.answers)
        ? event.answers.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const row = raw as { readonly header?: unknown; readonly value?: unknown };
          if (typeof row.header !== "string" || typeof row.value !== "string") return [];
          return [{ header: row.header, value: row.value }];
        })
        : [];
      return {
        seq: entry.seq,
        event: { kind: "ask-settled", id: event.id, outcome, ...(answers.length > 0 ? { answers } : {}) },
      };
    }
    case "tool-result":
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "tool-result",
          id: event.id,
          ok: event.ok === true,
          summary: typeof event.summary === "string" ? event.summary : "",
        },
      };
    case "turn-end":
      return {
        seq: entry.seq,
        event: {
          kind: "turn-end",
          ok: event.ok === true,
          ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
          ...(typeof event.answer === "string" && event.answer.length > 0 ? { answer: event.answer } : {}),
          ...(event.stopped === true ? { stopped: true } : {}),
        },
      };
    case "job": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      if (typeof event.title !== "string") return null;
      return {
        seq: entry.seq,
        event: {
          kind: "job",
          id: event.id,
          jobKind: readJobKind(event.jobKind),
          title: event.title,
          ...(typeof event.toolUseId === "string" && event.toolUseId.length > 0 ? { toolUseId: event.toolUseId } : {}),
          ...(typeof event.who === "string" && event.who.length > 0 ? { who: event.who } : {}),
          ...atField(event.at),
        },
      };
    }
    case "job-progress": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "job-progress",
          id: event.id,
          ...(typeof event.note === "string" && event.note.length > 0 ? { note: event.note } : {}),
          ...countField("tokens", event.tokens),
          ...countField("tools", event.tools),
          ...countField("durationMs", event.durationMs),
          ...(typeof event.lastTool === "string" && event.lastTool.length > 0 ? { lastTool: event.lastTool } : {}),
          ...(Array.isArray(event.stages) ? { stages: readStages(event.stages) } : {}),
        },
      };
    }
    case "job-end": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "job-end",
          id: event.id,
          ...(event.status === "completed" || event.status === "failed" || event.status === "stopped"
            ? { status: event.status }
            : {}),
          ...(typeof event.summary === "string" && event.summary.length > 0 ? { summary: event.summary } : {}),
          ...countField("tokens", event.tokens),
          ...countField("tools", event.tools),
          ...countField("durationMs", event.durationMs),
        },
      };
    }
    case "jobs": {
      if (!Array.isArray(event.ids)) return null;
      return {
        seq: entry.seq,
        event: { kind: "jobs", ids: event.ids.filter((id): id is string => typeof id === "string" && id.length > 0) },
      };
    }
    case "error":
      if (typeof event.code !== "string") return null;
      return { seq: entry.seq, event: { kind: "error", code: event.code } };
    default:
      return null;
  }
}

function readQuestions(value: unknown): readonly AgentChatQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AgentChatQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.question !== "string" || entry.question.length === 0) continue;
    if (typeof entry.header !== "string" || entry.header.length === 0) continue;
    const options: AgentChatQuestionOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const rawOption of entry.options) {
        if (!rawOption || typeof rawOption !== "object") continue;
        const option = rawOption as Record<string, unknown>;
        if (typeof option.label !== "string" || option.label.length === 0) continue;
        options.push({
          label: option.label,
          description: typeof option.description === "string" ? option.description : "",
        });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      header: entry.header,
      question: entry.question,
      multiSelect: entry.multiSelect === true,
      options,
    });
  }
  return questions;
}

function readJobKind(value: unknown): AgentChatJobKind {
  return value === "agent" || value === "shell" || value === "workflow" ? value : "other";
}

function countField<K extends string>(key: K, value: unknown): Record<K, number> | Record<string, never> {
  return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Record<K, number>) : {};
}

function readStages(value: readonly unknown[]): readonly AgentChatJobStage[] {
  const stages: AgentChatJobStage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const stage = raw as { readonly title?: unknown; readonly agents?: unknown };
    if (typeof stage.title !== "string") continue;
    const agents: AgentChatJobAgent[] = [];
    if (Array.isArray(stage.agents)) {
      for (const rawAgent of stage.agents) {
        if (!rawAgent || typeof rawAgent !== "object") continue;
        const agent = rawAgent as Record<string, unknown>;
        if (typeof agent.label !== "string") continue;
        agents.push({
          label: agent.label,
          ...(typeof agent.model === "string" && agent.model.length > 0 ? { model: agent.model } : {}),
          state: typeof agent.state === "string" ? agent.state : "unknown",
          ...countField("tokens", agent.tokens),
          ...countField("tools", agent.tools),
          ...countField("durationMs", agent.durationMs),
          ...(typeof agent.result === "string" && agent.result.length > 0 ? { result: agent.result } : {}),
        });
      }
    }
    stages.push({ title: stage.title, agents });
  }
  return stages;
}

function readChange(value: unknown): AgentChatChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as { readonly file?: unknown; readonly added?: unknown; readonly removed?: unknown };
  if (typeof change.file !== "string" || change.file.length === 0) return null;
  return { file: change.file, added: numberOr(change.added, 0), removed: numberOr(change.removed, 0) };
}

/** 이름과 토큰 수가 갖춰진 항목만 남긴다. 이름 없는 조각은 미터에 자리를 차지할 자격이 없다. */
function readContextSlices(value: unknown): readonly AgentChatContextSlice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row: unknown) => {
    const slice = row as { readonly name?: unknown; readonly tokens?: unknown };
    return typeof slice?.name === "string" && slice.name.length > 0 && typeof slice.tokens === "number"
      ? [{ name: slice.name, tokens: slice.tokens }]
      : [];
  });
}

function atField(value: unknown): { readonly at?: number } {
  return typeof value === "number" && Number.isFinite(value) ? { at: value } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── 그룹핑: 평평한 이벤트 스트림 → 지휘 로그의 턴 구조 ────────────────────────

/** 스텝의 결말. running은 아직 돌아오지 않은 것이고, done은 결과 없이 턴이 닫힌 것이다. */
export type AgentChatStepState = "running" | "ok" | "fail" | "done";

export interface AgentChatTurnItem {
  readonly type: "text" | "tool" | "ask";
  /** type="ask"일 때의 카드. 대기 중이면 누를 수 있고, 결말이 붙으면 한 줄로 접힌다. */
  readonly ask?: AgentChatAsk;
  readonly text?: string;
  readonly name?: string;
  readonly detail?: string;
  readonly id?: string;
  readonly state?: AgentChatStepState;
  readonly result?: string;
  readonly outside?: boolean;
  readonly change?: AgentChatChange;
}

export interface AgentChatTurn {
  readonly dispatch: { readonly text: string; readonly at?: number } | null;
  readonly items: readonly AgentChatTurnItem[];
  /**
   * `stopped`가 `error`와 따로 있는 이유는 결말이 다르기 때문이다. 실패는 하려던 일이 안 된
   * 것이고 중지는 사용자가 그만두게 한 것이며, 후자에는 고칠 것이 없다 — 같은 자리에 두면
   * 자기가 누른 버튼의 결과를 고장으로 읽게 된다.
   */
  readonly state: "done" | "working" | "error" | "stopped";
  readonly durationMs?: number;
  readonly toolCount: number;
  /** 라이브 델타 누적 버퍼 — 완성 text 이벤트가 도착하면 비워지고 아이템으로 확정된다. */
  readonly draft: string;
  /** turn-end가 실어온 서버 권위의 최종 응답 텍스트. */
  readonly answer?: string;
  /** turn-start 시각 — 진행 중 elapsed 티커의 기준. */
  readonly startedAt?: number;
  /**
   * 이 턴이 **시작될 때**의 문맥 총량. 이 턴이 더한 몫은 다음 턴의 같은 값과의 차이다.
   *
   * 턴마다 남는 이유는 그 값이 그 시점의 사실이기 때문이다 — 지금 총량 하나로는 어느 턴이
   * 문맥을 태웠는지 영영 알 수 없다. 스냅숏을 못 받은 턴은 이 값이 없고, 그때는 증가분을
   * 지어내지 않고 빈칸으로 둔다.
   */
  readonly contextBefore?: number;
}

/** 지금 문맥 창의 내역. 마지막으로 끝난 턴 시점의 값이다. */
export interface AgentChatContext {
  /** 내역과 짝이 맞는 **측정된** 총량. 예약분과 남은 자리는 여기 들어가지 않는다. */
  readonly total: number;
  readonly max: number;
  /**
   * 지금 흐르고 있는 총량. 부재는 "이 턴이 아직 아무것도 더하지 않았다"가 아니라 "라이브 값이
   * 없다"이며, 그때 화면은 `total`을 쓴다. 내역은 여기에 없다 — 있는 것은 총량 하나뿐이다.
   */
  readonly liveTotal?: number;
  /** 자동 압축을 위해 미리 비워 둔 자리. */
  readonly reserved?: number;
  readonly compactAt?: number;
  readonly slices: readonly AgentChatContextSlice[];
  readonly memoryFiles: readonly AgentChatContextSlice[];
  readonly mcpTools: readonly AgentChatContextSlice[];
}

/**
 * 턴보다 오래 사는 작업 하나. 원장의 턴 시계와 나란히 도는 두 번째 시계이며, 잡의 좌표는
 * `id`(SDK task_id) 하나다. `open`은 살아 있는지, `status`는 어떻게 끝났는지 — 둘은 다른
 * 축이다: 목록에서 빠졌는데 결말 보고가 오지 않은 잡은 끝났지만 **어떻게 끝났는지 모르는** 것이고,
 * 그 상태에 성공 표식을 붙이는 것이 이 표면이 고치려는 바로 그 거짓말이다.
 */
export interface AgentChatJob {
  readonly id: string;
  readonly kind: AgentChatJobKind;
  readonly title: string;
  readonly who?: string;
  readonly toolUseId?: string;
  readonly startedAt?: number;
  readonly open: boolean;
  readonly status?: AgentChatJobStatus;
  readonly summary?: string;
  readonly note?: string;
  readonly lastTool?: string;
  readonly tokens?: number;
  readonly tools?: number;
  readonly durationMs?: number;
  readonly stages: readonly AgentChatJobStage[];
  /**
   * 이 잡에 대해 결말 보고가 도착한 횟수.
   *
   * 값 자체를 읽는 화면은 없다 — 이것은 **"보고가 하나 더 왔다"는 사실 자체**를 나르는 축이다.
   * 백그라운드 셸은 `task_updated`가 먼저 닫고 출력 파일의 좌표는 뒤따르는 `task_notification`이
   * 들고 오는데, 그 알림이 status만 싣고 오면(매퍼가 허용하는 형태다) 다른 필드는 하나도 바뀌지
   * 않는다. 보고의 내용에서 도착을 추론하면 그때 상세가 "기록 없음"에 굳는다.
   */
  readonly ends: number;
}

/** 잡 상세의 스텝 한 줄 — 원장의 스텝과 같은 어휘를 쓴다. */
export interface AgentChatJobStep {
  readonly name: string;
  readonly detail?: string;
  readonly failed?: boolean;
  readonly outcome?: string;
}

/**
 * 잡을 열었을 때 한 번 요청해 오는 상세. 저널이 아니라 요청인 이유는 크기다 — 전사록과 명령
 * 출력은 잡 하나당 수백 KB까지 자란다.
 */
export type AgentChatJobDetail =
  | { readonly kind: "agent"; readonly steps: readonly AgentChatJobStep[]; readonly truncated: boolean }
  | { readonly kind: "shell"; readonly tail: string; readonly truncated: boolean };

/** 서버 payload를 상세로 읽는다. 모양이 어긋나면 null — 화면은 "없다"를 그린다. */
export function readAgentChatJobDetailPayload(payload: unknown): AgentChatJobDetail | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const truncated = value.truncated === true;
  if (value.kind === "shell") {
    return typeof value.tail === "string" ? { kind: "shell", tail: value.tail, truncated } : null;
  }
  if (value.kind !== "agent" || !Array.isArray(value.steps)) return null;
  const steps: AgentChatJobStep[] = [];
  for (const entry of value.steps) {
    if (!entry || typeof entry !== "object") continue;
    const step = entry as Record<string, unknown>;
    if (typeof step.name !== "string" || step.name.length === 0) continue;
    steps.push({
      name: step.name,
      ...(typeof step.detail === "string" && step.detail.length > 0 ? { detail: step.detail } : {}),
      ...(step.failed === true ? { failed: true } : {}),
      ...(typeof step.outcome === "string" && step.outcome.length > 0 ? { outcome: step.outcome } : {}),
    });
  }
  return { kind: "agent", steps, truncated };
}

export interface AgentChatLogState {
  readonly turns: readonly AgentChatTurn[];
  readonly replaying: boolean;
  /** 현재 접속이 보유하던 snapshot을 아직 받고 있다. replay-end 뒤의 in-flight tail도 포함한다. */
  readonly snapshotting: boolean;
  /** 이 세션에서 snapshot으로 이미 관찰한 누적 턴 수. 저널 상한과 무관한 단조 좌표다. */
  readonly observedTurns: number;
  readonly errorCode: string | null;
  /** 도착 순서를 지키는 잡 원장. 살아 있는 것과 끝난 것이 한 목록에 함께 산다. */
  readonly jobs: readonly AgentChatJob[];
  /** 마지막으로 끝난 턴 시점의 문맥 창. 아직 한 턴도 끝나지 않았으면 null이다. */
  readonly context: AgentChatContext | null;
}

/** 서버 chat-events의 MAX_TEXT_CHARS와 같은 상한 — 확정 text가 이 길이로 도착하므로 draft도 같은 캡을 진다. */
const MAX_DRAFT_CHARS = 60_000;

export const initialAgentChatLogState: AgentChatLogState = {
  turns: [],
  replaying: false,
  snapshotting: true,
  observedTurns: 0,
  errorCode: null,
  jobs: [],
  context: null,
};

/**
 * 이벤트 하나를 로그 상태에 접는다. 재생 구간의 턴은 전부 done으로 닫고, 라이브 구간은
 * turn-start/turn-end가 상태를 옮긴다. dispatch는 항상 새 턴을 연다.
 */
export function reduceAgentChatLog(state: AgentChatLogState, event: AgentChatStreamEvent): AgentChatLogState {
  switch (event.kind) {
    case "replay-start":
      return { ...initialAgentChatLogState, observedTurns: state.observedTurns, replaying: true };
    case "snapshot-end":
      return { ...state, snapshotting: false, observedTurns: event.turns };
    case "replay-end": {
      // 이 이벤트 앞의 턴은 전부 재생된 과거다. 보통은 각 턴이 turn-end로 닫히지만 두 경우에
      // 열린 채 남는다: 마지막 턴의 시각 차가 없어 서버가 소요 시간을 말하지 못했을 때, 그리고
      // 저널이 상한(JOURNAL_CAP)에 걸려 replay-start가 잘려 나가 replaying이 false로 시작했을 때.
      // 후자에서는 settleLastTurn이 무력하므로 플래그와 무관하게 닫는다 — 지나간 턴이 "작업 중"
      // 티커를 단 채 굳는 것보다는, 시간을 말하지 않는 편이 정직하다.
      const last = state.turns.at(-1);
      const turns = last !== undefined && last.state === "working"
        ? [...state.turns.slice(0, -1), { ...last, state: "done" as const }]
        : state.turns;
      // event.turns(재생된 턴 수)는 더는 화면에 쓰지 않는다 — 경계만 닫고 카운트는 버린다.
      return { ...state, turns, replaying: false };
    }
    case "context": {
      // 턴 종료 스냅숏은 무조건 권위다 — 그 시점의 측정이므로 라이브가 더 말할 것이 없다.
      // 턴 시작 스냅숏은 왕복 때문에 턴이 한참 돈 뒤에 도착하고(실측 20~30초), 그 값은 이 턴이
      // 시작될 때의 것이다. 그때 라이브를 버리면 화면의 숫자가 뒤로 간다 — 이미 흐른 총량이
      // 더 크면 그것을 지키고 내역만 받는다.
      const live = event.asOf === "end"
        ? undefined
        : (state.context?.liveTotal !== undefined && state.context.liveTotal > event.total
          ? state.context.liveTotal
          : undefined);
      const context: AgentChatContext = {
        total: event.total,
        max: event.max,
        ...(live === undefined ? {} : { liveTotal: live }),
        ...(event.reserved !== undefined ? { reserved: event.reserved } : {}),
        ...(event.compactAt !== undefined ? { compactAt: event.compactAt } : {}),
        slices: event.slices,
        memoryFiles: event.memoryFiles ?? [],
        mcpTools: event.mcpTools ?? [],
      };
      // 턴별 증가분은 **시작 시점** 총량으로만 센다. 그 턴에 붙여 두면 재생에서도 같은 턴이 같은
      // 값을 지녀 증가분이 흔들리지 않는다. 종료 스냅숏은 그 자리를 건드리지 않는다 — 덮으면
      // 다음 턴과의 차이가 이 턴이 더한 몫을 두 번 세거나 아예 지운다.
      const held = { ...state, context };
      return state.turns.length === 0 || event.asOf === "end"
        ? held
        : withLastTurn(held, (turn) => ({ ...turn, contextBefore: event.total }));
    }
    case "context-live": {
      // 내역은 건드리지 않는다. 아직 한 번도 측정이 오지 않았으면 총량만 아는 상태로 세운다 —
      // 그것이 사실이고, 빈 내역은 "모른다"를 정직하게 말한다.
      const context: AgentChatContext = state.context
        ? { ...state.context, liveTotal: event.total }
        : { total: 0, max: event.max, liveTotal: event.total, slices: [], memoryFiles: [], mcpTools: [] };
      return { ...state, context };
    }
    case "dispatch": {
      const turn: AgentChatTurn = {
        dispatch: { text: event.text, ...(event.at !== undefined ? { at: event.at } : {}) },
        items: [],
        // synthetic replay에서는 저널의 live dispatch 뒤에 같은 턴의 turn-start가 따라온다. 여기서
        // 미리 done으로 닫으면 그 start가 별도 턴을 만들므로, replay-end나 다음 dispatch가 닫게 둔다.
        state: "working",
        toolCount: 0,
        draft: "",
      };
      return { ...state, turns: [...settleLastTurn(state), turn] };
    }
    case "turn-start": {
      // 백그라운드 작업이 끝나면 SDK가 모델을 다시 깨워 두 번째 응답을 낸다(실측: 하나의
      // startTurn이 result를 두 번 낸다). 그 응답을 이미 닫힌 턴에 이어 붙이면 앞 턴의 Answer가
      // 뒤 응답으로 갈아치워진다 — 디스패치 없는 새 턴으로 세운다.
      //
      // 재생에서도 같은 줄이 온다: 트랜스크립트의 주입 운반체는 말풍선 없이 이 이벤트만 남긴다.
      // 그 턴은 이미 끝난 과거이므로 dispatch 턴과 같이 done으로 세운다 — working으로 세우면
      // 소요 시간을 말할 수 없는 마지막 턴이 "작업 중"으로 굳는다.
      const settled: AgentChatTurn["state"] = state.replaying ? "done" : "working";
      const last = state.turns.at(-1);
      // capped 저널의 live dispatch/start는 내용이 끼지 않은 연속 쌍이라 한 턴이다. 반대로
      // transcript carrier의 start는 앞 dispatch가 이미 내용을 낸 뒤 오므로 말풍선 없는 다음 턴이다.
      const opensCarrier = state.replaying
        && last?.dispatch !== null
        && (last?.items.length ?? 0) > 0;
      if (!last || last.state !== "working" || opensCarrier) {
        const turn: AgentChatTurn = {
          dispatch: null,
          items: [],
          state: settled,
          toolCount: 0,
          draft: "",
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
        };
        return { ...state, turns: [...settleLastTurn(state), turn] };
      }
      return withLastTurn(state, (turn) => ({
        ...turn,
        state: settled,
        ...(event.at !== undefined ? { startedAt: event.at } : {}),
      }));
    }
    case "text":
      // 완성 text는 흘러온 델타의 정정 앵커다 — 버퍼를 비우고 확정 아이템으로 치환한다.
      return withLastTurn(appendItem(state, { type: "text", text: event.text }), (turn) => ({ ...turn, draft: "" }));
    case "text-delta":
      // 델타 개별은 서버가 캡을 지키지만 누적 버퍼는 여기서 다시 상한을 진다 — 병합 앵커가
      // 도착하기 전의 초장문 응답이 draft를 무한히 키우면 매 렌더가 그 전체를 복사한다.
      return withLastTurn(state, (turn) => {
        if (turn.state !== "working" || turn.draft.length >= MAX_DRAFT_CHARS) return turn;
        return { ...turn, draft: (turn.draft + event.text).slice(0, MAX_DRAFT_CHARS) };
      });
    case "tool-start":
      // 이름만 아는 스텝을 먼저 세운다. 뒤따르는 완성 tool 이벤트가 같은 id로 좌표를 채운다.
      return appendItem(state, { type: "tool", name: event.name, detail: "", id: event.id, state: "running" });
    case "tool": {
      // 재생 구간의 스텝은 이미 끝난 일이다 — 결과 줄이 뒤따르면 ok/fail로 다시 옮겨 붙는다.
      const initial: AgentChatStepState = state.replaying ? "done" : "running";
      const filled: AgentChatTurnItem = {
        type: "tool",
        name: event.name,
        detail: event.detail,
        state: initial,
        ...(event.id !== undefined ? { id: event.id } : {}),
        ...(event.outside === true ? { outside: true } : {}),
        ...(event.change ? { change: event.change } : {}),
      };
      // tool-start가 이미 세운 스텝이면 새 줄을 만들지 않고 그 자리를 채운다.
      const merged = event.id !== undefined
        ? mergeItemById(state, event.id, (item) => ({ ...filled, state: item.state ?? initial }))
        : null;
      return merged ?? appendItem(state, filled);
    }
    case "ask":
      return appendItem(state, {
        type: "ask",
        ask: {
          id: event.id,
          form: event.form,
          questions: event.questions ?? [],
          ...(event.plan !== undefined ? { plan: event.plan } : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        },
      });
    case "ask-settled": {
      // 재생 구간에서는 여러 턴이 한꺼번에 쌓이므로 마지막 턴만 보면 짝을 놓친다.
      const merged = mergeAskById(state, event.id, (ask) => ({
        ...ask,
        outcome: event.outcome,
        ...(event.answers ? { answers: event.answers } : {}),
      }));
      return merged ?? state;
    }
    case "tool-result": {
      const merged = mergeItemById(state, event.id, (item) => ({
        ...item,
        state: event.ok ? "ok" : "fail",
        ...(event.summary.length > 0 ? { result: event.summary } : {}),
      }));
      // 짝을 못 찾은 결과는 버린다 — 좌표 없는 결말은 원장에 세울 자리가 없다.
      return merged ?? state;
    }
    case "turn-end":
      return withLastTurn(state, (turn) => ({
        ...turn,
        // 델타만 받고 완성 text 없이 턴이 끝나면(스트림 조기 종료) 버퍼를 아이템으로 회수한다.
        ...(turn.draft.length > 0
          ? { items: [...settleRunningSteps(turn.items), { type: "text" as const, text: turn.draft }], draft: "" }
          : { items: settleRunningSteps(turn.items), draft: "" }),
        state: event.stopped === true ? "stopped" : event.ok ? "done" : "error",
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.answer !== undefined ? { answer: event.answer } : {}),
      }));
    case "job": {
      const existing = state.jobs.find((job) => job.id === event.id);
      const next: AgentChatJob = {
        id: event.id,
        kind: event.jobKind,
        title: event.title,
        ...(event.who !== undefined ? { who: event.who } : {}),
        ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
        ...(event.at !== undefined ? { startedAt: event.at } : {}),
        open: true,
        stages: existing?.stages ?? [],
        ends: existing?.ends ?? 0,
      };
      return {
        ...state,
        jobs: existing
          ? state.jobs.map((job) => (job.id === event.id ? { ...job, ...next } : job))
          : [...state.jobs, next],
      };
    }
    case "job-progress":
      return mergeJob(state, event.id, (job) => ({
        ...job,
        // 맥박이 도착했다는 것 자체가 살아 있다는 사실이다.
        open: job.status === undefined ? true : job.open,
        ...(event.note !== undefined ? { note: event.note } : {}),
        ...(event.lastTool !== undefined ? { lastTool: event.lastTool } : {}),
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.tools !== undefined ? { tools: event.tools } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        // 단계 트리는 전량 교체다 — 병합하면 사라진 에이전트가 영원히 남는다.
        ...(event.stages !== undefined ? { stages: event.stages } : {}),
      }));
    case "job-end":
      return mergeJob(state, event.id, (job) => ({
        ...job,
        open: false,
        // 내용이 아니라 도착을 센다 — status만 실은 알림도 이 값을 움직여야 상세가 다시 묻는다.
        ends: job.ends + 1,
        // 결말을 알아보지 못한 보고는 이미 세워 둔 결말을 지우지 않는다 — 근거 없는 값으로
        // 근거 있는 값을 덮는 셈이 된다.
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.tools !== undefined ? { tools: event.tools } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }));
    case "jobs": {
      // REPLACE 시맨틱: 목록이 곧 살아 있는 전량이다. 여기서 빠진 잡은 더 이상 돌지 않지만,
      // 그것이 어떻게 끝났는지는 이 이벤트가 말하지 않는다 — status는 job-end만 세운다.
      //
      // 목록이 아는 잡을 원장이 모를 수도 있다. 상한에 걸린 저널이 그 잡의 시작을 앞에서
      // 밀어냈는데 이 스냅숏만 남은 재접속이 그렇고, 셸은 맥박을 하나도 내지 않으므로 되살릴
      // 근거가 이 목록 말고는 없다. 모르는 좌표를 버리면 목록이 살아 있다고 말하는 작업이
      // 탭에서도 배지에서도 스트립에서도 사라진다 — 맥박·결말이 이미 하는 대로 자리를 세운다.
      const live = new Set(event.ids);
      const known = new Set(state.jobs.map((job) => job.id));
      const seeded: readonly AgentChatJob[] = event.ids
        .filter((id) => !known.has(id))
        .map((id) => ({ id, kind: "other" as const, title: id, open: true, stages: [], ends: 0 }));
      return {
        ...state,
        jobs: [...state.jobs.map((job) => ({ ...job, open: live.has(job.id) })), ...seeded],
      };
    }
    case "error":
      return { ...state, errorCode: event.code };
    default:
      return state;
  }
}

function mergeJob(
  state: AgentChatLogState,
  id: string,
  update: (job: AgentChatJob) => AgentChatJob,
): AgentChatLogState {
  if (!state.jobs.some((job) => job.id === id)) {
    // 시작을 못 본 잡의 맥박·결말이 먼저 올 수 있다(재접속 직후). 좌표만으로 세운다.
    const seeded: AgentChatJob = { id, kind: "other", title: id, open: true, stages: [], ends: 0 };
    return { ...state, jobs: [...state.jobs, update(seeded)] };
  }
  return { ...state, jobs: state.jobs.map((job) => (job.id === id ? update(job) : job)) };
}

/** 지금 돌고 있는 잡. 스트립과 탭 배지가 세는 것이 이것이다. */
export function openAgentChatJobs(state: AgentChatLogState): readonly AgentChatJob[] {
  return state.jobs.filter((job) => job.open);
}

/**
 * 턴이 닫히면 아직 돌지 않은 스텝은 done으로 가라앉는다 — 결과를 못 받았을 뿐 실패는 아니다.
 * running을 그대로 두면 끝난 턴에 진행 링이 영원히 돈다.
 */
function settleRunningSteps(items: readonly AgentChatTurnItem[]): readonly AgentChatTurnItem[] {
  if (!items.some((item) => item.state === "running")) return items;
  return items.map((item) => (item.state === "running" ? { ...item, state: "done" as const } : item));
}

/** 뷰가 소비하는 턴의 파생 형태 — 원장(과정)과 Answer(결론)와 스트리밍 말미를 가른다. */
export interface AgentChatTurnView {
  /** 접힌 원장에 들어가는 과정 아이템 — Answer로 승격된 말미 텍스트는 제외된다. */
  readonly ledger: readonly AgentChatTurnItem[];
  /** done 턴의 확정 응답. 서버 권위(turn-end.answer)가 있으면 그것, 없으면 말미 text 승격. */
  readonly answer: string | null;
  /** working 턴이 지금 흘리고 있는 말미 텍스트(확정 text 아이템 + 델타 버퍼). */
  readonly streamingText: string | null;
  /** 이 턴이 건드린 파일 — 같은 파일의 여러 쓰기는 한 줄로 합친다. */
  readonly changes: readonly AgentChatChange[];
  /** 아직 답하지 않은 카드가 있는가 — 이 턴은 일하는 중이 아니라 기다리는 중이다. */
  readonly awaiting: boolean;
}

/**
 * 턴을 뷰 구조로 가른다. done 턴의 말미 text 아이템은 Answer로 승격되어 원장에서 빠진다 —
 * 서버 answer가 있으면 그것이 권위이고, 말미 text와 같은 내용이면 중복을 걷어낸다. 재생 턴은
 * turn-end 이벤트가 없으므로 말미 승격 규칙이 곧 Answer 판정이다.
 */
export function splitAgentChatTurn(turn: AgentChatTurn): AgentChatTurnView {
  const last = turn.items.at(-1);
  const trailingText = last?.type === "text" ? last.text ?? "" : null;
  const changes = collectChanges(turn.items);
  const awaiting = turn.items.some((item) => item.type === "ask" && item.ask?.outcome === undefined);
  if (turn.state === "working") {
    const streaming = (trailingText ?? "") + turn.draft;
    return {
      ledger: trailingText !== null ? turn.items.slice(0, -1) : turn.items,
      answer: null,
      streamingText: streaming.length > 0 ? streaming : null,
      changes,
      awaiting,
    };
  }
  if (turn.state === "error") {
    return { ledger: turn.items, answer: null, streamingText: null, changes, awaiting };
  }
  // 중지된 턴에서 흐르던 글은 Answer가 아니다 — 끝까지 쓰이지 않았으므로 그 이름을 줄 수 없다.
  // 그렇다고 접힘 속에 넣지도 않는다: 방금 멈춘 사람이 가장 먼저 보려는 것이 그 글이고,
  // 접어 두면 자기가 무엇을 멈췄는지 확인하려고 한 번 더 눌러야 한다.
  if (turn.state === "stopped") {
    return {
      ledger: trailingText !== null ? turn.items.slice(0, -1) : turn.items,
      answer: null,
      streamingText: trailingText !== null && trailingText.length > 0 ? trailingText : null,
      changes,
      awaiting,
    };
  }
  if (turn.answer !== undefined) {
    const promoted = trailingText !== null && trailingText.trim() === turn.answer.trim();
    return {
      ledger: promoted ? turn.items.slice(0, -1) : turn.items,
      answer: turn.answer,
      streamingText: null,
      changes,
      awaiting,
    };
  }
  if (trailingText !== null && trailingText.length > 0) {
    return { ledger: turn.items.slice(0, -1), answer: trailingText, streamingText: null, changes, awaiting };
  }
  return { ledger: turn.items, answer: null, streamingText: null, changes, awaiting };
}

/**
 * 도구 이름을 계열로 접는다. 원장이 스텝을 하나하나 세는 대신 "무엇을 몇 번 했는가"로 읽히려면
 * 집계 축이 이름이 아니라 계열이어야 한다 — Read와 NotebookRead는 사용자에게 같은 일이다.
 */
const TOOL_FAMILIES: Readonly<Record<string, string>> = {
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  // 백그라운드 잡을 들여다보는 호출은 "실행"이 아니다 — 같은 계열에 두면 셸을 새로 돌린 것과
  // 구별되지 않고, 실제로 그렇게 읽혔다(실측: bash_id만 실은 BashOutput이 "셸 1회 실행"으로 접힘).
  BashOutput: "inspect",
  TaskOutput: "inspect",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  Task: "delegate",
  Agent: "delegate",
  Workflow: "workflow",
  TaskStop: "stop",
  KillShell: "stop",
  TodoWrite: "plan",
  // 재생 구간에서만 이 이름들이 스텝으로 온다 — 라이브에서는 카드가 그 자리를 대신한다.
  AskUserQuestion: "ask",
  ExitPlanMode: "propose",
};

export function agentChatToolFamily(name: string | undefined): string {
  return (name !== undefined ? TOOL_FAMILIES[name] : undefined) ?? "other";
}

/** 집계 한 덩어리 — 계열과 그 계열로 끝난 스텝 수. `other`는 도구 이름별로 따로 센다. */
export interface AgentChatStepGroup {
  readonly family: string;
  /** `other` 계열의 표시 이름. 알려진 계열에서는 비어 있다. */
  readonly name?: string;
  readonly count: number;
}

/**
 * 구간을 이루는 한 조각. 구간은 이 조각들의 **순서 있는** 목록이다 — 순서가 곧 시간이다.
 *
 * 조각을 순서로 두기 전에는 접힌 것이 전부 집계 한 줄로 구간 맨 위에 서고 접히지 않은 것이
 * 그 아래로 밀렸다. 그래서 "파일 하나 읽고 → 잡을 띄우고 → 넉 장 더 읽은" 구간이
 * "파일 5개 읽음" 다음에 잡이 서는 모양으로 그려졌다 — 원장이 일어난 순서를 뒤집은 셈이다.
 */
export type AgentChatLedgerPart =
  /** 이웃한 완료 스텝을 한 줄로 접은 집계. 접히지 않는 조각이 오면 이 집계는 거기서 닫힌다. */
  | { readonly kind: "tally"; readonly groups: readonly AgentChatStepGroup[]; readonly folded: readonly AgentChatTurnItem[] }
  /** 백그라운드 잡을 낳은 호출. 접지 않는다 — 접히면 그 잡으로 가는 문이 사라진다. */
  | { readonly kind: "job"; readonly item: AgentChatTurnItem }
  /** 줄을 지키는 그 밖의 스텝 — 확인되지 않은 호출, 지금 도는 호출, 그리고 질문 카드. */
  | { readonly kind: "step"; readonly item: AgentChatTurnItem };

/**
 * 원장의 한 구간 — 모델이 남긴 문장 하나와, 그 문장 뒤에 이어진 스텝들.
 *
 * 턴 전체를 하나로 집계하면 숫자가 끝없이 커지기만 하고("셸 7회 실행 · 파일 19개 읽음"),
 * 무엇을 하려고 그 도구들을 썼는지가 사라진다. 구간을 가르는 것은 모델 자신의 문장이다:
 * 문장이 의도를 말하고 바로 아래 한 줄이 그 의도로 한 일을 말한다.
 */
export interface AgentChatLedgerSegment {
  /** 이 구간을 여는 문장. 첫 도구가 문장보다 먼저 오면 없다. */
  readonly note?: string;
  /** 이 구간의 조각들 — 도착한 순서 그대로다. */
  readonly parts: readonly AgentChatLedgerPart[];
}

/**
 * 원장을 구간으로 가른다. 구간의 경계는 모델의 문장이고, 각 구간은 그 문장 뒤에 이어진
 * 스텝들을 한 줄로 접는다 — 한 턴이 여러 번 "문장 → 한 일" 쌍으로 읽힌다.
 *
 * 도는 동안에도 예외는 없다. 예전에는 열린 구간이 최근 스텝 여덟 개를 전폭 행으로 세워 두었고,
 * 실측하면 그 행들이 로그 가시 영역의 58%를 먹었다 — 읽는 자리를 도구 목록이 밀어낸 것이다.
 * 지금은 도는 구간도 같은 집계 한 줄로 접히고, "일하는 중"은 그 줄이 스스로 진다(호출부가
 * 링과 물결, 그리고 지금 도는 도구의 이름을 그 줄에 붙인다).
 *
 * 결과가 온 스텝은 실패와 Theater 밖 표식을 포함해 같은 집계로 접힌다. 펼치면 표식은
 * 그대로 있다. 결과 없이 닫힌 스텝만 줄을 지킨다 — 확인되지 않은 것을 과거형으로 세면 안 된다.
 */
export function segmentAgentChatLedger(
  items: readonly AgentChatTurnItem[],
  /**
   * 백그라운드 잡을 낳은 호출인가. 이 스텝은 접히지 않고 태어난 자리에 그대로 서서, 그 잡을
   * 부른 문장과 그 뒤에 이어진 일 사이의 순서를 지킨다.
   */
  hasJob?: (item: AgentChatTurnItem) => boolean,
): readonly AgentChatLedgerSegment[] {
  const buckets: { note?: string; steps: AgentChatTurnItem[] }[] = [];
  for (const item of items) {
    if (item.type === "text") {
      const note = item.text !== undefined ? spokenNote(item.text) : undefined;
      buckets.push({ ...(note !== undefined ? { note } : {}), steps: [] });
      continue;
    }
    const last = buckets.at(-1);
    if (last) last.steps.push(item);
    else buckets.push({ steps: [item] });
  }
  if (buckets.length === 0) return [];

  return buckets
    .map((bucket) => foldSegment(bucket.note, bucket.steps, hasJob))
    // 문장도 스텝도 남지 않은 구간은 그리지 않는다 — 빈 구간도 구간 사이 간격은 그대로 받아서,
    // 긴 턴일수록 아무것도 말하지 않는 여백만 쌓인다.
    .filter((segment) => segment.note !== undefined || segment.parts.length > 0);
}

/**
 * 구간을 여는 문장. 내용은 한 글자도 손대지 않는다 — 문장은 공유 마크다운이 그리고, 그
 * 문법은 공백으로 쓰인다: 첫 줄의 네 칸은 코드 블록이고, 줄 끝 두 칸은 줄바꿈이며, 문단
 * 사이 빈 줄은 파서가 알아서 흡수한다. 다듬는 순간 모델이 쓴 형식이 표시 직전에 사라진다.
 * 여기서 가리는 것은 하나뿐이다: 공백밖에 없는 문장은 구간을 열 자격이 없는데도 빈 블록과
 * 구간 여백을 그대로 받아, 긴 턴일수록 아무것도 말하지 않는 여백만 쌓는다.
 */
function spokenNote(text: string): string | undefined {
  return text.trim().length > 0 ? text : undefined;
}

function foldSegment(
  note: string | undefined,
  steps: readonly AgentChatTurnItem[],
  hasJob?: (item: AgentChatTurnItem) => boolean,
): AgentChatLedgerSegment {
  const parts: AgentChatLedgerPart[] = [];
  // 지금 열려 있는 집계. 접히지 않는 조각을 만나면 닫히고, 다음 완료 스텝이 새 집계를 연다 —
  // 이 열고 닫음이 구간 안의 시간 순서를 지킨다.
  let groups: AgentChatStepGroup[] | null = null;
  let folded: AgentChatTurnItem[] | null = null;
  let seen: Map<string, number> | null = null;
  for (const step of steps) {
    // 카드는 접지 않는다 — 접힌 질문은 답할 수 없고, 답한 뒤의 한 줄도 그 턴이 무엇으로
    // 갈렸는지 말하는 증거라 집계에 삼켜지면 안 된다.
    // 잡을 낳은 호출도 접지 않는다. 접으면 그 잡으로 가는 문이 사라지고, 구간 밖으로 꺼내면
    // 자기를 부른 문장보다 위에 서서 어느 의도가 그것을 낳았는지가 사라진다.
    // 결과 없이 닫힌 스텝(`done`)을 과거형으로 세면, 같은 이유로 변경 장부에서 뺀 그 쓰기를
    // 원장이 다시 했다고 말하는 셈이다 — 확인되지 않은 것과 지금 도는 것은 줄을 지킨다.
    const job = step.type !== "ask" && hasJob?.(step) === true;
    const foldable = step.type !== "ask" && !job && (step.state === "ok" || step.state === "fail");
    if (!foldable) {
      groups = null;
      folded = null;
      seen = null;
      parts.push(job ? { kind: "job", item: step } : { kind: "step", item: step });
      continue;
    }
    if (groups === null || folded === null || seen === null) {
      groups = [];
      folded = [];
      seen = new Map();
      parts.push({ kind: "tally", groups, folded });
    }
    folded.push(step);
    const family = agentChatToolFamily(step.name);
    const key = family === "other" ? `other:${step.name ?? ""}` : family;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, groups.length);
      groups.push({ family, count: 1, ...(family === "other" ? { name: step.name ?? "" } : {}) });
    } else {
      const current = groups[found];
      if (current) groups[found] = { ...current, count: current.count + 1 };
    }
  }
  return { ...(note !== undefined ? { note } : {}), parts };
}

/** 같은 파일을 여러 번 쓴 턴은 파일 하나로 합산한다 — 장부는 파일 단위다. */
function collectChanges(items: readonly AgentChatTurnItem[]): readonly AgentChatChange[] {
  const byFile = new Map<string, { file: string; added: number; removed: number }>();
  for (const item of items) {
    // 결과가 ok로 돌아온 쓰기만 장부에 오른다. 실패한 쓰기는 남지 않은 변경이고, 결과 없이
    // 끝난 쓰기(턴이 중간에 닫혀 done으로 가라앉은 스텝)는 일어났는지 자체를 모른다 —
    // 모르는 것을 "바뀌었다"로 세우면 이 원장이 고치려던 거짓말을 다시 하는 셈이다.
    if (!item.change || item.state !== "ok") continue;
    const entry = byFile.get(item.change.file);
    if (entry) {
      entry.added += item.change.added;
      entry.removed += item.change.removed;
    } else {
      byFile.set(item.change.file, { ...item.change });
    }
  }
  return [...byFile.values()];
}

/** 재생 중 dispatch가 연달아 오면 앞 턴은 그 시점에 닫힌 것이다. */
function settleLastTurn(state: AgentChatLogState): readonly AgentChatTurn[] {
  if (!state.replaying) return state.turns;
  const last = state.turns.at(-1);
  if (!last || last.state === "done") return state.turns;
  return [...state.turns.slice(0, -1), { ...last, state: "done" }];
}

function withLastTurn(state: AgentChatLogState, update: (turn: AgentChatTurn) => AgentChatTurn): AgentChatLogState {
  const last = state.turns.at(-1);
  if (!last) return state;
  return { ...state, turns: [...state.turns.slice(0, -1), update(last)] };
}

/**
 * 마지막 턴에서 같은 id의 스텝을 찾아 갱신한다. 없으면 null — 호출부가 새로 세울지 버릴지 고른다.
 * 재생 구간에서는 여러 턴이 한 번에 쌓이므로 마지막 턴만 보고 판단하면 짝을 놓친다: 뒤에서부터
 * 훑어 처음 만나는 턴에서 잇는다.
 */
function mergeItemById(
  state: AgentChatLogState,
  id: string,
  update: (item: AgentChatTurnItem) => AgentChatTurnItem,
): AgentChatLogState | null {
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex];
    if (!turn) continue;
    const itemIndex = turn.items.findIndex((item) => item.type === "tool" && item.id === id);
    if (itemIndex < 0) continue;
    const current = turn.items[itemIndex];
    if (!current) continue;
    const items = [...turn.items];
    items[itemIndex] = update(current);
    const turns = [...state.turns];
    turns[turnIndex] = { ...turn, items };
    return { ...state, turns };
  }
  return null;
}

/** 마지막 턴부터 거슬러 올라가며 같은 id의 카드를 찾아 갱신한다. 없으면 null. */
function mergeAskById(
  state: AgentChatLogState,
  id: string,
  update: (ask: AgentChatAsk) => AgentChatAsk,
): AgentChatLogState | null {
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex];
    if (!turn) continue;
    const itemIndex = turn.items.findIndex((item) => item.type === "ask" && item.ask?.id === id);
    if (itemIndex < 0) continue;
    const current = turn.items[itemIndex];
    if (!current?.ask) continue;
    const items = [...turn.items];
    items[itemIndex] = { ...current, ask: update(current.ask) };
    const turns = [...state.turns];
    turns[turnIndex] = { ...turn, items };
    return { ...state, turns };
  }
  return null;
}

function appendItem(state: AgentChatLogState, item: AgentChatTurnItem): AgentChatLogState {
  const last = state.turns.at(-1);
  // 재생이 dispatch 이전의 assistant 줄로 시작할 수 있다(파일 중간 잘림) — 디스패치 없는 턴으로 담는다.
  if (!last) {
    const turn: AgentChatTurn = { dispatch: null, items: [item], state: state.replaying ? "done" : "working", toolCount: item.type === "tool" ? 1 : 0, draft: "" };
    return { ...state, turns: [turn] };
  }
  return withLastTurn(state, (turn) => ({
    ...turn,
    items: [...turn.items, item],
    toolCount: turn.toolCount + (item.type === "tool" ? 1 : 0),
  }));
}
