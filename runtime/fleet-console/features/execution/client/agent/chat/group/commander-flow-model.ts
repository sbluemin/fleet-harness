import type { ConsoleLocale } from "@fleet-console/i18n";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";

import type {
  ConversationParticipant,
  ConversationSpeaker,
  GroupTimelineEntry,
  GroupTimelineSnapshot,
} from "../../../../shared/conversation/types.js";
import { getGroupT } from "./group-chat-i18n.js";
import { deliveryFailure } from "./group-relay.js";
import { ledgerTarget, speakerKey } from "./speaker-mark.js";

/**
 * 지휘관 Inner Loop Flow 투영 모델 — `GroupTimelineSnapshot` 을 n8n 스타일 노드·베지어 와이어 그래프와
 * 모바일용 Quiet Thread 스텝으로 결정론적 투영한다.
 *
 * - 백엔드 저장/전송 계약을 건드리지 않고 기존 스냅숏에서 순수 계산한다.
 * - `member-joined`·`member-left`·5분 시각선·단순 보드 메타 줄 등 IM 잡음은 걷어낸다.
 * - 모든 오류(`session-error`·전언 `deliveryFailure`·실패/미보고 `plugin-notice`·`undelivered`·`cliFailure`)는
 *   절대 접지 않고 그래프 단절 와이어·노드 및 오류 카드로 즉시 승격한다.
 */

export type FlowNodeStatus = "done" | "live" | "error" | "warn" | "await" | "dim";
export type FlowEdgeStatus = "done" | "live" | "error" | "await" | "dim";

export interface FlowNode {
  readonly id: string;
  readonly role: "trigger" | "commander" | "branch" | "checkpoint" | "merge";
  readonly speaker: ConversationSpeaker | null;
  readonly title: string;
  readonly subtitle: string;
  readonly meta: string;
  readonly status: FlowNodeStatus;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly ledgerObjectiveId: string | null;
  readonly detailTitle?: string;
  readonly detailBody?: string;
  readonly entryId?: string;
}

export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly status: FlowEdgeStatus;
  readonly label: string;
  readonly path: string;
  readonly midX: number;
  readonly midY: number;
  readonly detailTitle?: string;
  readonly detailBody?: string;
  readonly ledgerObjectiveId?: string | null;
}

export interface FlowErrorItem {
  readonly id: string;
  readonly entryId?: string;
  readonly severity: "error" | "warn";
  readonly speaker: ConversationSpeaker | null;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly at: number | null;
  readonly ledgerObjectiveId: string | null;
}

export interface FlowThreadStep {
  readonly id: string;
  readonly entryId?: string;
  readonly actor: ConversationSpeaker;
  readonly target?: ConversationSpeaker | null;
  readonly summary: string;
  readonly meta: string;
  readonly status: FlowNodeStatus;
  readonly ledgerObjectiveId: string | null;
  readonly detailBody?: string;
}

export type FlowMessageEntry = Extract<GroupTimelineEntry, { kind: "message" }>;

export interface FlowLoop {
  readonly id: string;
  readonly triggerEntryId?: string;
  readonly prompt: string;
  readonly triggerSpeaker: ConversationSpeaker | null;
  readonly triggerMessage?: FlowMessageEntry;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationLabel: string;
  readonly status: "live" | "error" | "await" | "done";
  readonly hasErrors: boolean;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly miniActors: readonly ConversationSpeaker[];
  readonly steps: readonly FlowThreadStep[];
  readonly errors: readonly FlowErrorItem[];
  readonly outcome: FlowMessageEntry | null;
  readonly checkpointPassedText?: string;
}

export interface CommanderFlowModel {
  readonly loops: readonly FlowLoop[];
  readonly activeCount: number;
  readonly errorCount: number;
}

export interface BuildCommanderFlowOptions {
  readonly language: ConsoleLocale | undefined;
  /** 현재 활성 승인/결정 체크포인트 존재 여부 (최신 루프에 aurora 체크포인트 노드를 세운다). */
  readonly awaitingCheckpoint?: boolean;
  /** 실시간 참여자별 활동 문구 (objectiveId → "파일 읽는 중" 등). */
  readonly activityPhrases?: ReadonlyMap<string, string>;
}

const NODE_H = 64;
const BRANCH_H = 66;
const TRIGGER_W = 148;
const COMMANDER_W = 152;
const BRANCH_W = 198;
const CHECKPOINT_W = 186;
const MERGE_W = 148;
const GAP_LEAD = 48;
const GAP_CLI = 96;
const GAP_BRANCH = 94;
const GAP_MERGE = 76;
const PAD_X = 12;
const PAD_Y = 14;
const BRANCH_GAP_Y = 14;

/** 마크다운 서식을 가볍게 걷은 한 줄 요약. 식별자 속 밑줄(_)은 보존한다. */
function conciseLine(text: string, max = 72): string {
  const first = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)/u, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("```") && !line.startsWith("<"))
    ?? "";
  const cleaned = first.replace(/[*`~]+/gu, "").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

function formatDuration(startMs: number | null, endMs: number | null, language: ConsoleLocale | undefined): string {
  if (startMs === null || endMs === null || endMs <= startMs) return "";
  const sec = Math.max(1, Math.round((endMs - startMs) / 1000));
  if (sec < 60) return language === "ko" ? `${sec}초` : `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return language === "ko"
    ? (rem > 0 ? `${min}분 ${rem}초` : `${min}분`)
    : (rem > 0 ? `${min}m ${rem}s` : `${min}m`);
}

function formatClock(at: number | null, language: ConsoleLocale | undefined): string {
  if (at === null) return "";
  const locale = language === "ko" ? "ko-KR" : "en-US";
  return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function cubicPath(x1: number, y1: number, x2: number, y2: number): { readonly path: string; readonly midX: number; readonly midY: number } {
  const dx = Math.max(30, (x2 - x1) * 0.52);
  return {
    path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    midX: Math.round((x1 + x2) / 2),
    midY: Math.round((y1 + y2) / 2),
  };
}

interface ParsedPluginNotice {
  readonly severity: "error" | "warn" | "info";
  readonly memberSpeaker: ConversationSpeaker | null;
  readonly summary: string;
  readonly detail: string;
  readonly code: string;
}

/**
 * `objectives/host/prompts.ts` 가 보낸 `plugin-notice` 를 오류·미보고·일반으로 분류한다.
 * 무채색 전언 칩 뒤에 숨겨지던 구성원 실패 및 미보고 정지를 즉시 승격한다.
 */
export function classifyPluginNotice(
  text: string,
  participants: readonly ConversationParticipant[],
  fallbackRecipient: ConversationSpeaker,
): ParsedPluginNotice {
  const trimmed = text.trim();
  const isFailure = /실패로 끝났습니다|ended in failure|<error-data>/iu.test(trimmed);
  const isUnreported = !isFailure && /전달된 메시지가 없습니다|no message from that turn was delivered|지휘관에게 온 메시지는 없다|without a message to the Commander/iu.test(trimmed);

  // 「role」(objectiveId) 또는 "role" (objectiveId) 패턴에서 구성원을 찾는다.
  const memberMatch = /(?:구성원\s*「([^」]+)」|member\s+"([^"]+)")\s*\(([^)]+)\)/iu.exec(trimmed);
  const roleHint = memberMatch?.[1] ?? memberMatch?.[2] ?? null;
  const idHint = memberMatch?.[3]?.trim() ?? null;
  const matchedParticipant = participants.find((p) =>
    (idHint && p.speaker.objectiveId === idHint) || (roleHint && p.speaker.name === roleHint),
  );
  const memberSpeaker: ConversationSpeaker | null = matchedParticipant?.speaker
    ?? (roleHint ? { kind: "member", name: roleHint, ...(idHint ? { objectiveId: idHint } : {}) } : fallbackRecipient);

  const reasonMatch = /^(?:사유|Reason)\s*:\s*(.+)$/im.exec(trimmed);
  const errorDataMatch = /<error-data>\s*([\s\S]*?)\s*<\/error-data>/iu.exec(trimmed);
  const lastMsgMatch = /<last-message>\s*([\s\S]*?)\s*<\/last-message>/iu.exec(trimmed);

  const rawBody = errorDataMatch?.[1]?.trim() ?? lastMsgMatch?.[1]?.trim() ?? "";
  const detailLines = [
    reasonMatch?.[1]?.trim(),
    rawBody ? conciseLine(rawBody.replace(/^---\s*\w+\s*---$/gmu, "").trim(), 220) : "",
  ].filter((part): part is string => Boolean(part));

  const fallbackDetail = conciseLine(trimmed, 200);
  const detail = detailLines.length > 0 ? detailLines.join(" · ") : fallbackDetail;
  const summary = reasonMatch?.[1]?.trim()
    ? conciseLine(reasonMatch[1].trim(), 48)
    : rawBody
      ? conciseLine(rawBody.replace(/^---\s*\w+\s*---$/gmu, "").trim(), 48)
      : conciseLine(trimmed, 48);

  return {
    severity: isFailure ? "error" : isUnreported ? "warn" : "info",
    memberSpeaker,
    summary,
    detail,
    code: isFailure ? "member_turn_failed" : isUnreported ? "member_unreported" : "plugin_notice",
  };
}

interface RawLoopBucket {
  readonly id: string;
  readonly triggerEntryId?: string;
  readonly triggerSpeaker: ConversationSpeaker | null;
  readonly triggerMessage?: FlowMessageEntry;
  readonly prompt: string;
  readonly startedAt: number | null;
  readonly checkpointPassedText?: string;
  readonly entries: GroupTimelineEntry[];
}

interface BranchAccumulator {
  readonly key: string;
  speaker: ConversationSpeaker;
  readonly kind: "member" | "consult" | "missing";
  delegatedText: string;
  reportedText: string;
  latestMessage: FlowMessageEntry | null;
  hasOutgoing: boolean;
  hasReturn: boolean;
  outgoingFailed: string | null;
  returnFailed: string | null;
  errorText: string | null;
  warnText: string | null;
  streaming: boolean;
  startedAt: number | null;
  endedAt: number | null;
  entryId?: string;
}

function isLoopOpener(entry: GroupTimelineEntry): boolean {
  if (entry.kind === "message" && entry.speaker.kind === "human") return true;
  if (entry.kind === "message" && entry.speaker.kind === "commodore" && Boolean(entry.via)) return true;
  if (entry.kind === "decision-answer") return true;
  return false;
}

function isCommanderSpeaker(speaker: ConversationSpeaker, rootObjectiveId: string | null): boolean {
  return speaker.kind === "commander"
    || speaker.kind === "objectiveRecord"
    || (rootObjectiveId !== null && speaker.objectiveId === rootObjectiveId);
}

/**
 * 스냅숏 전체를 Inner Loop 목록과 각 루프의 결정론적 n8n 플로우 그래프로 투영한다.
 */
export function buildCommanderFlow(
  snapshot: GroupTimelineSnapshot,
  options: BuildCommanderFlowOptions,
): CommanderFlowModel {
  const t = getGroupT(options.language);
  const locale = options.language ?? "en";
  const commander: ConversationSpeaker = snapshot.participants.find((p) => p.speaker.kind === "commander")?.speaker
    ?? snapshot.participants.find((p) => p.speaker.objectiveId === snapshot.rootObjectiveId)?.speaker
    ?? { kind: "commander", name: t("group.commander"), ...(snapshot.rootObjectiveId ? { objectiveId: snapshot.rootObjectiveId } : {}) };

  const workingKeys = new Set(snapshot.working.map((speaker) => speakerKey(speaker)));
  const buckets: RawLoopBucket[] = [];

  for (const entry of snapshot.entries) {
    // IM 잡음(합류·제거)은 버린다.
    if (entry.kind === "member-joined" || entry.kind === "member-left") continue;

    if (isLoopOpener(entry)) {
      if (entry.kind === "decision-answer") {
        const summary = entry.answers
          .map((item) => (item.declined ? t("group.decision.declined") : item.answer))
          .filter(Boolean)
          .join(" · ");
        buckets.push({
          id: entry.id,
          triggerEntryId: entry.id,
          triggerSpeaker: { kind: "human", name: t("group.you") },
          prompt: summary || t("group.decision.answered"),
          startedAt: entry.at,
          checkpointPassedText: summary || t("group.decision.answered"),
          entries: [entry],
        });
      } else if (entry.kind === "message") {
        const fallback = entry.via ? t(`group.via.${entry.via}`) : t("group.flow.trigger");
        buckets.push({
          id: entry.id,
          triggerEntryId: entry.id,
          triggerSpeaker: entry.speaker,
          triggerMessage: entry,
          prompt: conciseLine(entry.text, 160) || fallback,
          startedAt: entry.at,
          entries: [entry],
        });
      }
      continue;
    }

    // 첫 사람/사령관 지시 전 자율 개시 활동이 있으면 자율 루프를 연다.
    if (buckets.length === 0) {
      // 단순 메타 board-action(실패가 아닌 경우)만 있고 다른 활동이 없으면 뒤의 실활동과 합치되, 첫 실항목으로 루프를 연다.
      if (entry.kind === "board-action" && !entry.status?.failed) {
        continue;
      }
      buckets.push({
        id: `loop:auto:${entry.id}`,
        triggerEntryId: entry.id,
        triggerSpeaker: commander,
        prompt: t("group.flow.autonomous"),
        startedAt: entry.at,
        entries: [],
      });
    }

    buckets[buckets.length - 1]!.entries.push(entry);
  }

  // 아직 지시나 응답 줄이 없지만 현재 작업 중·결정 대기·CLI 차단 상태라면 즉시 활성 루프를 만든다.
  const needsSyntheticLoop = buckets.length === 0
    && (snapshot.working.length > 0 || Boolean(options.awaitingCheckpoint) || Boolean(snapshot.cliFailure));
  if (needsSyntheticLoop) {
    buckets.push({
      id: "loop:live",
      triggerSpeaker: commander,
      prompt: snapshot.cliFailurePrompt
        ? conciseLine(snapshot.cliFailurePrompt, 160)
        : t("group.flow.autonomous"),
      startedAt: null,
      entries: [],
    });
  }

  const loops: FlowLoop[] = buckets.map((bucket, bucketIndex) => {
    const isLatest = bucketIndex === buckets.length - 1;
    const branches = new Map<string, BranchAccumulator>();
    const errors: FlowErrorItem[] = [];
    const steps: FlowThreadStep[] = [];
    const commanderMessages: FlowMessageEntry[] = [];
    let firstWorkAt: number | null = null;
    let endedAt: number | null = bucket.startedAt;
    let commanderError: FlowErrorItem | null = null;

    const noteTime = (at: number | null) => {
      if (at === null) return;
      if (endedAt === null || at > endedAt) endedAt = at;
    };

    const ensureBranch = (
      speaker: ConversationSpeaker,
      kind: BranchAccumulator["kind"],
      at: number | null,
      entryId?: string,
    ): BranchAccumulator => {
      const key = kind === "consult" ? "consult:commodore" : speakerKey(speaker);
      const existing = branches.get(key);
      if (existing) {
        if (at !== null) {
          if (existing.startedAt === null || at < existing.startedAt) existing.startedAt = at;
          if (existing.endedAt === null || at > existing.endedAt) existing.endedAt = at;
        }
        return existing;
      }
      if (at !== null && (firstWorkAt === null || at < firstWorkAt)) firstWorkAt = at;
      const created: BranchAccumulator = {
        key,
        speaker,
        kind,
        delegatedText: "",
        reportedText: "",
        latestMessage: null,
        hasOutgoing: false,
        hasReturn: false,
        outgoingFailed: null,
        returnFailed: null,
        errorText: null,
        warnText: null,
        streaming: false,
        startedAt: at,
        endedAt: at,
        ...(entryId ? { entryId } : {}),
      };
      branches.set(key, created);
      return created;
    };

    for (const entry of bucket.entries) {
      noteTime(entry.at);

      if (entry.kind === "message") {
        // 트리거 자체의 전달 오류 확인
        if (entry === bucket.triggerMessage) {
          if (entry.undelivered || entry.deliveryNote) {
            errors.push({
              id: `err:${entry.id}`,
              entryId: entry.id,
              severity: "warn",
              speaker: entry.speaker,
              code: "undelivered",
              title: t("group.flow.error.undelivered"),
              detail: entry.deliveryNote || t("group.undelivered"),
              at: entry.at,
              ledgerObjectiveId: null,
            });
          }
          continue;
        }

        if (isCommanderSpeaker(entry.speaker, snapshot.rootObjectiveId)) {
          if (entry.streaming || entry.text.trim().length > 0 || Boolean(entry.attachments?.length)) {
            commanderMessages.push(entry);
          }
          continue;
        }

        if (entry.speaker.kind === "member") {
          const branch = ensureBranch(entry.speaker, "member", entry.at, entry.id);
          branch.hasOutgoing = true;
          branch.latestMessage = entry;
          if (entry.text.trim().length > 0) branch.reportedText = entry.text;
          if (entry.streaming) branch.streaming = true;
          else branch.hasReturn = true;
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: entry.speaker,
            target: entry.recipient ?? null,
            summary: conciseLine(entry.text, 90) || (entry.streaming ? t("group.streaming") : t("group.flow.memberDone")),
            meta: entry.streaming ? t("group.flow.running") : formatClock(entry.at, options.language),
            status: entry.streaming ? "live" : "done",
            ledgerObjectiveId: ledgerTarget(entry.speaker, snapshot.participants),
            detailBody: entry.text,
          });
          continue;
        }

        if (entry.speaker.kind === "commodore") {
          const branch = ensureBranch(entry.speaker, "consult", entry.at, entry.id);
          branch.hasReturn = true;
          if (entry.text.trim().length > 0) branch.reportedText = entry.text;
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: entry.speaker,
            target: commander,
            summary: conciseLine(entry.text, 90) || t("group.flow.consultDone"),
            meta: formatClock(entry.at, options.language),
            status: "done",
            ledgerObjectiveId: null,
            detailBody: entry.text,
          });
        }
        continue;
      }

      if (entry.kind === "delegation") {
        const failure = deliveryFailure(entry);
        const fromCommander = isCommanderSpeaker(entry.sender, snapshot.rootObjectiveId);
        const isConsult = entry.via === "consult" || entry.via === "consult-reply";

        if (isConsult) {
          const commodoreSpeaker = entry.via === "consult"
            ? (entry.recipients[0] ?? { kind: "commodore" as const, name: t("group.commodore") })
            : entry.sender;
          const branch = ensureBranch(commodoreSpeaker, "consult", entry.at, entry.id);
          if (entry.via === "consult") {
            branch.hasOutgoing = true;
            if (entry.text.trim()) branch.delegatedText = entry.text;
            if (failure !== null) branch.outgoingFailed = failure || t("group.delegation.failed");
          } else {
            branch.hasReturn = true;
            branch.reportedText = entry.noAdvice ? t("group.consult.noAdvice") : entry.text;
            if (failure !== null) branch.returnFailed = failure || t("group.delegation.failed");
          }
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: entry.sender,
            target: entry.recipients[0] ?? null,
            summary: failure !== null
              ? (failure || t("group.delegation.failed"))
              : entry.noAdvice
                ? t("group.consult.noAdvice")
                : conciseLine(entry.text, 90) || t(entry.via === "consult" ? "group.relay.consultAsk" : "group.relay.consultReply"),
            meta: failure !== null ? t("group.delegation.failed") : formatClock(entry.at, options.language),
            status: failure !== null ? "error" : "done",
            ledgerObjectiveId: ledgerTarget(entry.sender, snapshot.participants),
            detailBody: entry.text || entry.result,
          });
        } else if (fromCommander) {
          const targets: readonly ConversationSpeaker[] = entry.recipients.length > 0
            ? entry.recipients
            : [{ kind: "member", name: t("group.flow.missingMember") }];
          for (const recipient of targets) {
            const missing = entry.recipients.length === 0;
            const branch = ensureBranch(recipient, missing ? "missing" : "member", entry.at, entry.id);
            branch.hasOutgoing = true;
            if (entry.text.trim()) branch.delegatedText = entry.text;
            if (failure !== null) {
              branch.outgoingFailed = failure || t("group.delegation.failed");
              branch.errorText = branch.outgoingFailed;
            }
          }
          const primaryTarget = targets[0]!;
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: entry.sender,
            target: primaryTarget,
            summary: failure !== null
              ? (failure || t("group.delegation.failed"))
              : conciseLine(entry.text, 90) || t("group.flow.edge.delegate"),
            meta: failure !== null ? t("group.delegation.failed") : formatClock(entry.at, options.language),
            status: failure !== null ? "error" : "done",
            ledgerObjectiveId: ledgerTarget(primaryTarget, snapshot.participants) ?? ledgerTarget(entry.sender, snapshot.participants),
            detailBody: entry.text || entry.result,
          });
        } else {
          // 구성원 → 지휘관 보고 (또는 구성원 → 다른 구성원)
          const branch = ensureBranch(entry.sender, "member", entry.at, entry.id);
          branch.hasReturn = true;
          if (entry.text.trim()) branch.reportedText = entry.text;
          if (failure !== null) {
            branch.returnFailed = failure || t("group.delegation.failed");
            branch.errorText = branch.returnFailed;
          }
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: entry.sender,
            target: entry.recipients[0] ?? commander,
            summary: failure !== null
              ? (failure || t("group.delegation.failed"))
              : conciseLine(entry.text, 90) || t("group.flow.edge.report"),
            meta: failure !== null ? t("group.delegation.failed") : formatClock(entry.at, options.language),
            status: failure !== null ? "error" : "done",
            ledgerObjectiveId: ledgerTarget(entry.sender, snapshot.participants),
            detailBody: entry.text || entry.result,
          });
        }

        if (failure !== null) {
          const toName = entry.recipients.map((r) => r.name).join(", ") || t("group.flow.missingMember");
          errors.push({
            id: `err:${entry.id}`,
            entryId: entry.id,
            severity: "error",
            speaker: entry.sender,
            code: "delivery_failed",
            title: t("group.flow.error.delivery", { from: entry.sender.name, to: toName }),
            detail: failure || t("group.delegation.failed"),
            at: entry.at,
            ledgerObjectiveId: ledgerTarget(entry.sender, snapshot.participants),
          });
        }
        continue;
      }

      if (entry.kind === "session-error") {
        const isTurnFail = entry.code === "turn_failed";
        const item: FlowErrorItem = {
          id: `err:${entry.id}`,
          entryId: entry.id,
          severity: "error",
          speaker: entry.speaker,
          code: entry.code,
          title: t(isTurnFail ? "group.flow.error.turnFailed" : "group.flow.error.session", { name: entry.speaker.name }),
          detail: entry.durationMs !== undefined
            ? `${entry.code} · ${formatDuration(0, entry.durationMs, options.language)}`
            : entry.code,
          at: entry.at,
          ledgerObjectiveId: ledgerTarget(entry.speaker, snapshot.participants),
        };
        errors.push(item);

        if (isCommanderSpeaker(entry.speaker, snapshot.rootObjectiveId)) {
          commanderError = item;
        } else {
          const branch = ensureBranch(entry.speaker, "member", entry.at, entry.id);
          branch.hasOutgoing = true;
          branch.errorText = item.detail;
        }
        steps.push({
          id: entry.id,
          entryId: entry.id,
          actor: entry.speaker,
          summary: `${item.title} (${entry.code})`,
          meta: formatClock(entry.at, options.language),
          status: "error",
          ledgerObjectiveId: item.ledgerObjectiveId,
        });
        continue;
      }

      if (entry.kind === "plugin-notice" && entry.text.trim().length > 0) {
        const parsed = classifyPluginNotice(entry.text, snapshot.participants, entry.recipient);
        if (parsed.severity === "error" || parsed.severity === "warn") {
          const targetSpeaker = parsed.memberSpeaker ?? entry.recipient;
          const targetLedger = ledgerTarget(targetSpeaker, snapshot.participants)
            ?? ledgerTarget(entry.recipient, snapshot.participants);
          errors.push({
            id: `err:${entry.id}`,
            entryId: entry.id,
            severity: parsed.severity,
            speaker: targetSpeaker,
            code: parsed.code,
            title: t(
              parsed.severity === "error" ? "group.flow.error.notice" : "group.flow.error.unreported",
              { name: targetSpeaker.name },
            ),
            detail: parsed.detail,
            at: entry.at,
            ledgerObjectiveId: targetLedger,
          });
          if (!isCommanderSpeaker(targetSpeaker, snapshot.rootObjectiveId)) {
            const branch = ensureBranch(targetSpeaker, "member", entry.at, entry.id);
            branch.hasOutgoing = true;
            if (parsed.severity === "error") branch.errorText = parsed.summary;
            else branch.warnText = parsed.summary;
          }
          steps.push({
            id: entry.id,
            entryId: entry.id,
            actor: targetSpeaker,
            summary: parsed.summary,
            meta: formatClock(entry.at, options.language),
            status: parsed.severity === "error" ? "error" : "warn",
            ledgerObjectiveId: targetLedger,
            detailBody: entry.text,
          });
        }
        continue;
      }

      if (entry.kind === "board-action" && entry.status?.failed) {
        const actText = resolveLocalizedText(entry.action, locale);
        const statusText = resolveLocalizedText(entry.status.text, locale);
        errors.push({
          id: `err:${entry.id}`,
          entryId: entry.id,
          severity: "error",
          speaker: entry.speaker,
          code: "board_action_failed",
          title: `${entry.speaker.name} · ${actText}`,
          detail: statusText || conciseLine(entry.text, 160),
          at: entry.at,
          ledgerObjectiveId: null,
        });
      }
    }

    // 최신 루프에서 현재 작업 중인 구성원은 첫 메시지가 오기 전이라도 실시간 실행 노드로 즉시 세운다.
    if (isLatest) {
      for (const workingSpeaker of snapshot.working) {
        if (workingSpeaker.kind === "member") {
          const branch = ensureBranch(workingSpeaker, "member", endedAt);
          branch.hasOutgoing = true;
        }
      }
    }

    // 최종 Outcome 선택: 지휘관 최신 응답 (직접 @member 멘션 후 지휘관 답이 없을 때만 해당 구성원 답을 착지로 보존).
    const lastCommanderMsg = commanderMessages[commanderMessages.length - 1] ?? null;
    const directMemberTarget = bucket.triggerMessage?.recipient?.kind === "member" ? bucket.triggerMessage.recipient : null;
    const directMemberOutcome = !lastCommanderMsg && directMemberTarget
      ? (branches.get(speakerKey(directMemberTarget))?.latestMessage ?? null)
      : null;

    const branchList = [...branches.values()];
    const anyBranchLive = isLatest && branchList.some((b) => b.streaming || workingKeys.has(speakerKey(b.speaker)));
    const commanderLive = isLatest && (workingKeys.has(speakerKey(commander)) || commanderMessages.some((m) => m.streaming));
    const loopLive = commanderLive || anyBranchLive;
    const loopAwaiting = isLatest && Boolean(options.awaitingCheckpoint);
    const cliBlocked = isLatest && Boolean(snapshot.cliFailure);

    // 지휘관이 분기 위임 전에만 남긴 짧은 예고 문구가 있고 구성원들이 아직 일하는 중이라면, 예고는 지휘관 노드 부제로 두고 완료 뒤에도 다른 답이 없으면 Outcome 으로 보여준다.
    const outcome: FlowMessageEntry | null = lastCommanderMsg
      ? (anyBranchLive && firstWorkAt !== null && lastCommanderMsg.at !== null && lastCommanderMsg.at <= firstWorkAt && !lastCommanderMsg.streaming
          ? null
          : lastCommanderMsg)
      : directMemberOutcome;

    const commanderPreSummary = commanderMessages.length > 0
      ? conciseLine(commanderMessages[0]!.text, 44)
      : "";

    const loopStatus: FlowLoop["status"] = cliBlocked || errors.some((e) => e.severity === "error")
      ? "error"
      : loopLive
        ? "live"
        : loopAwaiting
          ? "await"
          : "done";

    // ── 결정론적 n8n 노드·베지어 와이어 배치 ──────────────────────────────
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];

    const hasBranches = branchList.length > 0;
    const branchCount = branchList.length;
    const branchesBlockH = branchCount > 0 ? branchCount * BRANCH_H + (branchCount - 1) * BRANCH_GAP_Y : NODE_H;
    const totalH = Math.max(NODE_H + PAD_Y * 2, branchesBlockH + PAD_Y * 2);
    const centerY = Math.round((totalH - NODE_H) / 2);

    // Col 0: Trigger
    const triggerX = PAD_X;
    const triggerNode: FlowNode = {
      id: `${bucket.id}:trigger`,
      role: "trigger",
      speaker: bucket.triggerSpeaker,
      title: bucket.triggerSpeaker?.kind === "commodore"
        ? bucket.triggerSpeaker.name
        : bucket.triggerSpeaker?.kind === "commander"
          ? t("group.flow.autonomous")
          : t("group.flow.trigger"),
      subtitle: conciseLine(bucket.prompt, 36) || t("group.flow.trigger"),
      meta: formatClock(bucket.startedAt, options.language),
      status: "done",
      x: triggerX,
      y: centerY,
      w: TRIGGER_W,
      h: NODE_H,
      ledgerObjectiveId: null,
      detailTitle: bucket.triggerSpeaker?.name ?? t("group.flow.trigger"),
      detailBody: bucket.triggerMessage?.text ?? bucket.prompt,
      ...(bucket.triggerEntryId ? { entryId: bucket.triggerEntryId } : {}),
    };
    nodes.push(triggerNode);

    // Col 1: Commander Orchestration Node
    const cmdX = triggerX + TRIGGER_W + (cliBlocked ? GAP_CLI : GAP_LEAD);
    const cmdActivity = commander.objectiveId ? options.activityPhrases?.get(commander.objectiveId) : undefined;
    const cmdStatus: FlowNodeStatus = cliBlocked || commanderError !== null
      ? "error"
      : commanderLive
        ? "live"
        : loopAwaiting && !hasBranches
          ? "await"
          : "done";
    const cmdSub = cliBlocked
      ? t(snapshot.cliFailure === "missing" ? "group.flow.cliMissing" : "group.flow.cliSignedOut")
      : commanderError
        ? commanderError.detail
        : commanderLive
          ? (cmdActivity || t("group.streaming"))
          : commanderPreSummary || (hasBranches ? t("group.flow.dispatching") : (outcome ? conciseLine(outcome.text, 40) : t("group.flow.done")));
    const cmdNode: FlowNode = {
      id: `${bucket.id}:cmd`,
      role: "commander",
      speaker: commander,
      title: commander.name,
      subtitle: cmdSub,
      meta: cliBlocked
        ? t("group.flow.blocked")
        : commanderError
          ? t("group.flow.interrupted")
          : commanderLive
            ? t("group.flow.running")
            : formatDuration(bucket.startedAt, firstWorkAt ?? endedAt, options.language) || t("group.flow.done"),
      status: cmdStatus,
      x: cmdX,
      y: centerY,
      w: COMMANDER_W,
      h: NODE_H,
      ledgerObjectiveId: ledgerTarget(commander, snapshot.participants),
      detailTitle: commander.name,
      detailBody: lastCommanderMsg?.text ?? commanderError?.detail ?? "",
    };
    nodes.push(cmdNode);

    const leadWire = cubicPath(triggerNode.x + triggerNode.w, triggerNode.y + triggerNode.h / 2, cmdNode.x, cmdNode.y + cmdNode.h / 2);
    edges.push({
      id: `${bucket.id}:e-lead`,
      from: triggerNode.id,
      to: cmdNode.id,
      status: cliBlocked ? "error" : commanderLive && !hasBranches ? "live" : "done",
      label: cliBlocked ? t("group.flow.edge.cli") : "",
      ...leadWire,
      ledgerObjectiveId: cmdNode.ledgerObjectiveId,
    });

    let lastColRight = cmdX + COMMANDER_W;

    // Col 2: Parallel Member & Consultation Branches
    if (hasBranches) {
      const branchX = cmdX + COMMANDER_W + GAP_BRANCH;
      const startY = Math.round((totalH - branchesBlockH) / 2);
      const branchNodes: { readonly node: FlowNode; readonly acc: BranchAccumulator }[] = [];

      branchList.forEach((acc, index) => {
        const by = startY + index * (BRANCH_H + BRANCH_GAP_Y);
        const live = isLatest && (acc.streaming || workingKeys.has(speakerKey(acc.speaker)));
        const activityPhrase = acc.speaker.objectiveId ? options.activityPhrases?.get(acc.speaker.objectiveId) : undefined;
        const bStatus: FlowNodeStatus = acc.errorText !== null || acc.outgoingFailed !== null || acc.returnFailed !== null
          ? "error"
          : acc.warnText !== null
            ? "warn"
            : live
              ? "live"
              : "done";

        const sub = acc.errorText
          ? conciseLine(acc.errorText, 44)
          : acc.warnText
            ? conciseLine(acc.warnText, 44)
            : live
              ? (activityPhrase || (acc.reportedText ? conciseLine(acc.reportedText, 44) : t("group.streaming")))
              : acc.reportedText
                ? conciseLine(acc.reportedText, 44)
                : acc.delegatedText
                  ? conciseLine(acc.delegatedText, 44)
                  : t(acc.kind === "consult" ? "group.flow.consultDone" : "group.flow.memberDone");

        const dur = live
          ? t("group.flow.running")
          : bStatus === "error"
            ? t("group.flow.interrupted")
            : formatDuration(acc.startedAt, acc.endedAt, options.language) || t("group.flow.done");

        const bNode: FlowNode = {
          id: `${bucket.id}:b:${index}`,
          role: "branch",
          speaker: acc.speaker,
          title: acc.speaker.name,
          subtitle: sub,
          meta: dur,
          status: bStatus,
          x: branchX,
          y: by,
          w: BRANCH_W,
          h: BRANCH_H,
          ledgerObjectiveId: ledgerTarget(acc.speaker, snapshot.participants),
          detailTitle: acc.speaker.name,
          detailBody: [acc.delegatedText, acc.reportedText, acc.errorText, acc.warnText].filter(Boolean).join("\n\n"),
          ...(acc.entryId ? { entryId: acc.entryId } : {}),
        };
        nodes.push(bNode);
        branchNodes.push({ node: bNode, acc });

        // Outgoing wire: Commander → Branch
        const outWire = cubicPath(cmdNode.x + cmdNode.w, cmdNode.y + cmdNode.h / 2, bNode.x, bNode.y + bNode.h / 2);
        const outFailed = acc.outgoingFailed !== null;
        edges.push({
          id: `${bucket.id}:e-out:${index}`,
          from: cmdNode.id,
          to: bNode.id,
          status: outFailed ? "error" : live ? "live" : "done",
          label: outFailed
            ? t("group.flow.edge.failed")
            : acc.kind === "consult"
              ? t("group.flow.edge.consult")
              : t("group.flow.edge.delegate"),
          ...outWire,
          detailTitle: `${commander.name} → ${acc.speaker.name}`,
          detailBody: acc.outgoingFailed || acc.delegatedText || sub,
          ledgerObjectiveId: bNode.ledgerObjectiveId ?? cmdNode.ledgerObjectiveId,
        });
      });

      lastColRight = branchX + BRANCH_W;

      // Col 3: Checkpoint or Merge Landing Node
      const tailX = branchX + BRANCH_W + GAP_MERGE;
      if (loopAwaiting) {
        const cpNode: FlowNode = {
          id: `${bucket.id}:checkpoint`,
          role: "checkpoint",
          speaker: commander,
          title: t("group.flow.checkpoint"),
          subtitle: t("group.flow.checkpointSub"),
          meta: t("group.flow.awaiting"),
          status: "await",
          x: tailX,
          y: centerY,
          w: CHECKPOINT_W,
          h: BRANCH_H,
          ledgerObjectiveId: cmdNode.ledgerObjectiveId,
        };
        nodes.push(cpNode);
        for (const { node, acc } of branchNodes) {
          const w = cubicPath(node.x + node.w, node.y + node.h / 2, cpNode.x, cpNode.y + cpNode.h / 2);
          edges.push({
            id: `${bucket.id}:e-cp:${node.id}`,
            from: node.id,
            to: cpNode.id,
            status: acc.errorText ? "dim" : "await",
            label: branchNodes.length === 1 ? t("group.flow.edge.await") : "",
            ...w,
            ledgerObjectiveId: cpNode.ledgerObjectiveId,
          });
        }
        lastColRight = tailX + CHECKPOINT_W;
      } else {
        const mergeWaiting = anyBranchLive;
        const mergeHalted = !mergeWaiting && errors.some((e) => e.severity === "error") && !outcome;
        const mergeStatus: FlowNodeStatus = mergeWaiting || mergeHalted
          ? "dim"
          : outcome
            ? (outcome.streaming ? "live" : "done")
            : "done";
        const mergeNode: FlowNode = {
          id: `${bucket.id}:merge`,
          role: "merge",
          speaker: commander,
          title: t("group.flow.merge"),
          subtitle: mergeWaiting
            ? t("group.flow.mergeWait")
            : mergeHalted
              ? t("group.flow.mergeStop")
              : outcome
                ? (outcome.streaming ? t("group.streaming") : t("group.flow.mergeDone"))
                : t("group.flow.mergeWait"),
          meta: mergeWaiting
            ? t("group.flow.waiting")
            : mergeHalted
              ? t("group.flow.interrupted")
              : outcome
                ? (outcome.streaming ? t("group.flow.running") : t("group.flow.done"))
                : t("group.flow.waiting"),
          status: mergeStatus,
          x: tailX,
          y: centerY,
          w: MERGE_W,
          h: NODE_H,
          ledgerObjectiveId: cmdNode.ledgerObjectiveId,
          detailTitle: commander.name,
          detailBody: outcome?.text ?? "",
        };
        nodes.push(mergeNode);

        for (const { node, acc } of branchNodes) {
          const w = cubicPath(node.x + node.w, node.y + node.h / 2, mergeNode.x, mergeNode.y + mergeNode.h / 2);
          const retFailed = acc.returnFailed !== null;
          const isDim = acc.errorText !== null || (isLatest && (acc.streaming || workingKeys.has(speakerKey(acc.speaker))));
          edges.push({
            id: `${bucket.id}:e-in:${node.id}`,
            from: node.id,
            to: mergeNode.id,
            status: retFailed ? "error" : isDim ? "dim" : (outcome?.streaming ? "live" : "done"),
            label: retFailed
              ? t("group.flow.edge.failed")
              : isDim
                ? ""
                : acc.hasReturn
                  ? t(acc.kind === "consult" ? "group.flow.edge.reply" : "group.flow.edge.report")
                  : "",
            ...w,
            detailTitle: `${acc.speaker.name} → ${commander.name}`,
            detailBody: acc.returnFailed || acc.reportedText || "",
            ledgerObjectiveId: node.ledgerObjectiveId,
          });
        }
        lastColRight = tailX + MERGE_W;
      }
    } else if (loopAwaiting) {
      const cpX = cmdX + COMMANDER_W + GAP_BRANCH;
      const cpNode: FlowNode = {
        id: `${bucket.id}:checkpoint`,
        role: "checkpoint",
        speaker: commander,
        title: t("group.flow.checkpoint"),
        subtitle: t("group.flow.checkpointSub"),
        meta: t("group.flow.awaiting"),
        status: "await",
        x: cpX,
        y: centerY,
        w: CHECKPOINT_W,
        h: BRANCH_H,
        ledgerObjectiveId: cmdNode.ledgerObjectiveId,
      };
      nodes.push(cpNode);
      const w = cubicPath(cmdNode.x + cmdNode.w, cmdNode.y + cmdNode.h / 2, cpNode.x, cpNode.y + cpNode.h / 2);
      edges.push({
        id: `${bucket.id}:e-cp`,
        from: cmdNode.id,
        to: cpNode.id,
        status: "await",
        label: t("group.flow.edge.await"),
        ...w,
        ledgerObjectiveId: cmdNode.ledgerObjectiveId,
      });
      lastColRight = cpX + CHECKPOINT_W;
    }

    const totalW = lastColRight + PAD_X;

    // 과거 루프 리본용 중복 없는 참여자 체인
    const seenActors = new Set<string>();
    const miniActors: ConversationSpeaker[] = [];
    for (const candidate of [commander, ...branchList.map((b) => b.speaker)]) {
      const key = speakerKey(candidate);
      if (seenActors.has(key)) continue;
      seenActors.add(key);
      miniActors.push(candidate);
    }

    const durationLabel = loopLive
      ? t("group.flow.running")
      : loopStatus === "error"
        ? t("group.flow.interrupted")
        : loopAwaiting
          ? t("group.flow.awaiting")
          : formatDuration(bucket.startedAt, endedAt, options.language) || formatClock(endedAt ?? bucket.startedAt, options.language);

    return {
      id: bucket.id,
      ...(bucket.triggerEntryId ? { triggerEntryId: bucket.triggerEntryId } : {}),
      prompt: bucket.prompt,
      triggerSpeaker: bucket.triggerSpeaker,
      ...(bucket.triggerMessage ? { triggerMessage: bucket.triggerMessage } : {}),
      startedAt: bucket.startedAt,
      endedAt,
      durationLabel,
      status: loopStatus,
      hasErrors: errors.length > 0 || cliBlocked,
      width: totalW,
      height: totalH,
      nodes,
      edges,
      miniActors,
      steps,
      errors,
      outcome,
      ...(bucket.checkpointPassedText ? { checkpointPassedText: bucket.checkpointPassedText } : {}),
    };
  });

  return {
    loops,
    activeCount: snapshot.working.length,
    errorCount: loops.reduce((sum, loop) => sum + loop.errors.length, 0) + (snapshot.cliFailure ? 1 : 0),
  };
}
