import type { ReactNode } from "react";

import { ModelCoordinatePicker, type ModelCoordinatePickerExtra } from "../../ai-gateway/client/components/model-coordinate-picker.js";
import { canonicalModelId as sdkCanonicalModelId, type ModelRoster } from "../../ai-gateway/shared/models.js";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "../../ai-gateway/client/components/launch-provider-glyphs.js";
import type { LocalizedText, Translate } from "@fleet-console/i18n";
import type { ObjectiveLaunchVariantRow } from "../shared/records/types.js";
import type { ClientModelsCapability } from "../../ai-gateway/shared/model-ports.js";
import { useModelRoster } from "../../ai-gateway/client/use-model-roster.js";

import { memberFailureReason } from "../shared/signals.js";
import { COMMANDER_PRESET, type MemberLaunch, type Objective, type ObjectiveMember } from "../shared/types.js";
import { getT, objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 지휘관·구성원의 모델·강도 — 한 줄의 글("Opus · HIGH")이고, 누르면 Console 공유 선택기(`ModelCoordinatePicker`)의
 * 메뉴가 뜬다. 이 파일은 Objectives 고유 부분(시작 뷰·서브에이전트·실행 낱말·기동 거절 사유)만 갖는 어댑터다.
 */

/** 지휘관 기본 좌표 — 사령관 설정의 지휘관 선택기와 같은 원천(COMMANDER_PRESET)이다. */
const DEFAULT_LAUNCH = COMMANDER_PRESET;

export interface LaunchGroup { readonly provider: LaunchProviderGlyphId | null; readonly caption: string; readonly rows: readonly ObjectiveLaunchVariantRow[] }

/**
 * 지휘관·구성원 메뉴의 원천 — Console 모델 로스터(`launch` 대상). 코어 캐시 하나를 구독하므로 Settings › AI Gateway에서
 * 모델을 켜고 끄면(다른 탭·기기 포함) 열려 있는 메뉴도 곧 다시 그린다. 플러그인이 설치될 때 능력을 받는다.
 */
let models: ClientModelsCapability | null = null;
/** 마지막으로 투영한 띠 — 리액트 밖의 이름 조회(modelFullName)가 쓴다. */
let lastGroups: readonly LaunchGroup[] = [];
let lastRoster: ModelRoster | null = null;

export function installLaunchRoster(capability: ClientModelsCapability): () => void {
  models = capability;
  return () => { if (models === capability) models = null; };
}

function toLaunchGroups(roster: ModelRoster | null): readonly LaunchGroup[] {
  if (roster === lastRoster) return lastGroups;
  lastRoster = roster;
  lastGroups = (roster ?? []).map((group) => {
    const provider = launchProviderFromGroupId(group.id) ?? launchProviderFromModelId(group.rows[0]?.launch.model);
    return { provider, caption: provider ? launchProviderCaption(provider) : group.label, rows: group.rows };
  });
  return lastGroups;
}

export function useLaunchGroups(): readonly LaunchGroup[] {
  return toLaunchGroups(useModelRoster(models, "launch"));
}
export const useLaunchRows = (): readonly ObjectiveLaunchVariantRow[] => useLaunchGroups().flatMap((group) => group.rows);

/** 모델 id 의 공급자 — 카탈로그 행이 있으면 그 밴드, 없으면 id 에서. "codex/gpt-…"·게이트웨이 접두 표기도 같은 공급자로 읽는다. */
function providerOfModel(groups: readonly LaunchGroup[], model: string): LaunchProviderGlyphId | null {
  const row = findLaunchRow(groups.flatMap((group) => group.rows), model);
  const group = row ? groups.find((candidate) => candidate.rows.includes(row)) : undefined;
  return group?.provider ?? launchProviderFromModelId(canonicalModelId(model));
}

/** 모델 id 의 공급자 글리프 — 지휘관 컨트롤과 구성원 줄이 같은 표식을 쓴다. 모르는 모델이면 아무것도 그리지 않는다. */
export function ProviderGlyph({ model }: { readonly model: string | undefined }) {
  const groups = useLaunchGroups();
  const provider = model ? providerOfModel(groups, model) : null;
  if (!provider) return null;
  return <span className={`objective-launch-provider-glyph objectives-launch-provider is-${provider}`} aria-hidden="true">{launchProviderGlyph(provider)}</span>;
}

/**
 * 실제로 띄운 모델의 낱말 — 설정 선택(member.launch)이 아니라 실행 Objective 에 적힌 값이다. 모델이 비어 있으면 Console 기본으로
 * 뜬 것이므로 기본 모델(Opus)을 추정하지 않고 「기본」으로 둔다. 제목(title)은 공급자까지 붙인 풀네임.
 */
export function launchedWords(rows: readonly ObjectiveLaunchVariantRow[], model: string | undefined, effort: string | undefined, labels: { readonly auto: string; readonly fallback: string }): { readonly model: string | null; readonly words: { readonly model: string; readonly effort: string }; readonly title: string } {
  const known = model && model !== "default" ? model : null;
  const words = known ? launchWords(rows, known, effort, labels.auto) : { model: labels.fallback, effort: effort && effort !== "auto" ? effort.toUpperCase() : labels.auto };
  return { model: known, words, title: `${known ? modelFullName(rows, known) : labels.fallback} · ${words.effort}` };
}

/** 실행 모델 한 줄 — [공급자 글리프] 이름 · 강도. LaunchControl 의 triggerText 로 들어가 설정 메뉴의 선택 표시와 섞이지 않는다. */
export function LaunchedText({ model, words }: { readonly model: string | null; readonly words: { readonly model: string; readonly effort: string } }) {
  return (
    <>
      <ProviderGlyph model={model ?? undefined} />
      <span className="objectives-launch-model">{words.model}</span>
      <span className="objectives-launch-dot" aria-hidden="true">·</span>
      <span className="objectives-launch-effort">{words.effort}</span>
    </>
  );
}
/** 모델 전환·기동 거절의 사유 코드 → 사람의 말. 모르는 코드는 코드 그대로 보인다. */
/** 사유 코드에 번역된 문면이 있는가 — 없으면 화면은 코드를 그대로 싣는 일반 실패 문면을 쓴다. */
export const hasLaunchReason = (code: string): boolean => `objectives.reason.${code}` in objectivesEn;
export function launchReason(t: Translate<ObjectiveMessageKey>, code: string): string {
  const key = `objectives.reason.${code}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : t("objectives.reason.other", { code });
}

/** "Opus" / "HIGH" — 카드·행·메뉴가 같은 낱말을 쓴다. 카탈로그에 없는 모델은 id 그대로. */
export function launchWords(rows: readonly ObjectiveLaunchVariantRow[], model: string | undefined, effort: string | undefined, autoLabel: string): { readonly model: string; readonly effort: string } {
  const id = model ?? DEFAULT_LAUNCH.model;
  const row = findLaunchRow(rows, id);
  const chosen = effort ?? (model ? undefined : DEFAULT_LAUNCH.effort);
  const chip = row?.chips?.find((candidate) => candidate.launch.effort === chosen);
  return { model: row?.label ?? prettyModelId(bareModelId(id)), effort: chip?.label ?? (chosen ? chosen.toUpperCase() : autoLabel) };
}

const GATEWAY_PREFIX = "claude-gateway--";
/** SDK 정준 id에, "codex/gpt-…" 표기와 카탈로그의 "codex--gpt-…" 만 맞춘다. */
function canonicalModelId(model: string): string {
  const canonical = sdkCanonicalModelId(model);
  return canonical.includes("--") || !canonical.includes("/") ? canonical : canonical.replace(/\//g, "--");
}
/** 스코프·bare 표기가 달라도 같은 모델의 행을 찾는다. */
function findLaunchRow(rows: readonly ObjectiveLaunchVariantRow[], model: string): ObjectiveLaunchVariantRow | undefined {
  const id = canonicalModelId(model);
  return rows.find((candidate) => canonicalModelId(candidate.launch.model ?? candidate.id) === id);
}
/** 카탈로그에 없는 모델의 읽을 수 있는 이름 — 접두와 공급자 칸을 벗긴 뒤 다듬는다. */
function bareModelId(model: string): string {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  return stripped.includes("--") ? stripped.slice(stripped.lastIndexOf("--") + 2) : stripped.includes("/") ? stripped.slice(stripped.lastIndexOf("/") + 1) : stripped;
}
/** "Codex GPT-5.3 Codex" / "Claude Opus" — 임무 아래 dim 줄의 풀네임. 게이트웨이 접두는 벗기고, 카탈로그 행이 있으면 그 이름, 없으면 id 를 읽을 수 있게 다듬는다. */
export function modelFullName(rows: readonly ObjectiveLaunchVariantRow[], model: string | undefined | null): string {
  if (!model || model === "default") return "";
  // "codex/gpt-…" 와 "codex--gpt-…" — 같은 모델의 두 표기.
  const id = canonicalModelId(model);
  const row = findLaunchRow(rows, model);
  const group = row ? lastGroups.find((candidate) => candidate.rows.includes(row)) : undefined;
  const provider = group?.provider ?? launchProviderFromModelId(id);
  const caption = group?.caption ?? (provider ? launchProviderCaption(provider) : null);
  const name = row?.label ?? prettyModelId(id.includes("--") ? id.slice(id.indexOf("--") + 2) : id);
  return caption && !name.toLowerCase().startsWith(caption.toLowerCase()) ? `${caption} ${name}` : name;
}
function prettyModelId(id: string): string {
  return id.replace(/\[1m\]$/i, "").split(/[-_]+/).filter(Boolean)
    .map((token) => (/^(gpt|o\d|glm|qwen)/i.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1))).join(" ");
}

interface LaunchControlProps {
  readonly t: Translate<ObjectiveMessageKey>;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly locked: boolean;
  readonly onChange: (next: { model?: string; effort?: string }) => void;
  /** 트리거를 글리프 하나로 — 모델 낱말을 쓸 자리가 없을 때. */
  readonly trigger?: ReactNode;
  readonly triggerLabel?: string;
  /** 모델 id가 아닌 표시 낱말. */
  readonly triggerText?: ReactNode;
  /** triggerText 의 풀네임 — 좁은 칸에서 잘린 모델 이름을 hover 로 읽는다. */
  readonly triggerTitle?: string;
  /** 모델을 아직 고르지 않았다 — 메뉴는 기본 좌표를 선택으로 추정하지 않는다. */
  readonly unset?: boolean;
  /** 메뉴 맨 위의 한 줄 — 개시한 구성원은 지금 실행 중인 모델과 고르면 언제 바뀌는지를 말한다. */
  readonly head?: ReactNode;
  /** 열 때 모델 목록(1단계)부터 — 배정 메뉴는 특별 항목을 먼저 보여야 한다. */
  readonly startAtList?: boolean;
  /** 모델 목록 맨 위의 선택. 구성원 메뉴의 「라우팅」이 여기 선다. */
  readonly extras?: readonly ModelCoordinatePickerExtra[];
  /**
   * 구성원 기동 설정의 서브에이전트 허용. 메뉴 맨 아래 체크이며, 모델을 고르는 것과 달리 눌러도 메뉴는 닫히지 않는다.
   * 지휘관 메뉴에는 넘기지 않는다.
   */
  readonly subagents?: { readonly allowed: boolean; readonly onToggle: () => void };
  /** 지금 값과 같은 좌표를 다시 골라도 알린다 — 구성원 칩은 그 재확정으로 사람의 선택(소유)을 굳힌다. 지휘관 메뉴에는 넘기지 않는다. */
  readonly reconfirm?: boolean;
}

/** 선택기의 로스터 — 아직 읽기 전이면 null(메뉴가 「읽는 중」을 보인다). */
function useLaunchRoster(): ModelRoster | null {
  return useModelRoster(models, "launch");
}

export function LaunchControl({ t, model, effort, locked, onChange, trigger, triggerLabel, triggerText, triggerTitle, unset = false, startAtList = false, subagents, head, extras, reconfirm = false }: LaunchControlProps) {
  const roster = useLaunchRoster();
  const footer = subagents ? (
    <>
      {subagents ? <div className="fc-coord-menu-group" role="group" aria-label={t("objectives.members.subagentsGroup")}>
        <div className="fc-coord-menu-divider" role="separator" />
        <button type="button" role="menuitemcheckbox" aria-checked={subagents.allowed} className={`fc-coord-menu-item objectives-menu-check${subagents.allowed ? " is-active" : ""}`} onClick={() => subagents.onToggle()}>
          <span className="objectives-menu-box" aria-hidden="true" />
          <span className="objectives-menu-check-copy">
            <span className="fc-coord-menu-label">{t("objectives.members.subagents")}</span>
            <span className="fc-coord-menu-hint">{t("objectives.members.subagentsHint")}</span>
          </span>
        </button>
      </div> : null}
    </>
  ) : undefined;
  return (
    <ModelCoordinatePicker
      roster={roster}
      value={{ ...(model ? { model } : {}), ...(effort ? { effort } : {}) }}
      // 비어 있으면 Console 기본 좌표를 보인다. 아직 고르지 않은 메뉴는 기본 모델을 추정하지 않는다.
      {...(unset ? {} : { fallback: DEFAULT_LAUNCH })}
      onChange={onChange}
      startAt={startAtList ? "list" : "focused"}
      locked={locked}
      {...(reconfirm ? { reconfirm } : {})}
      labels={{
        menu: triggerLabel ?? t("objectives.launch.menuAria"),
        effort: t("objectives.commander.effortAria"),
        auto: t("objectives.commander.effortAuto"),
        back: t("objectives.launch.backToModels"),
        loading: t("objectives.launch.loading"),
        empty: t("objectives.launch.empty"),
        off: t("objectives.launch.off"),
        providerRemoved: t("objectives.launch.providerRemoved"),
        chooseAnotherModel: t("objectives.launch.chooseAnotherModel"),
        fallback: t("objectives.launch.fallback"),
        locked: t("objectives.commander.locked"),
      }}
      trigger={{
        variant: trigger ? "glyph" : "inline",
        ...(trigger ? { node: trigger } : {}),
        ...(triggerText ? { text: triggerText } : {}),
        ...(triggerTitle ? { title: triggerTitle } : {}),
        // 행 배치 오버라이드(objectives.css)가 이 이름으로 자리를 잡는다.
        className: `objectives-launch${trigger ? " objectives-glyph" : ""}`,
      }}
      {...(head ? { head } : {})}
      {...(extras ? { extras } : {})}
      {...(footer ? { footer } : {})}
      {...(subagents ? { menuWidth: 232 } : {})}
    />
  );
}

/** 사람이 고른 기동 모델 — 고르지 않았으면 null(라우팅). */
export const pickedLaunch = (member: ObjectiveMember): MemberLaunch | null => (member.launch && member.launch.mode === "model" ? member.launch : null);

/**
 * 구성원 트리거의 표시 — 실행과 설정을 가른다. 띄운 Objective 이 있으면 어떤 방식이든 그 Objective 의 모델이 실제 실행값이다(연결 뒤
 * 설정을 바꿔도 기존 Objective 은 옛 모델로 재개된다). 띄우기 전에는 고른 값 그대로, 고르지 않았으면 「라우팅」.
 * 메뉴의 선택 표시(model·effort·active)는 이 값이 아니라 member.launch 만 따른다.
 */
export function memberLaunchDisplay(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>, rows: readonly ObjectiveLaunchVariantRow[]): { text?: ReactNode; title: string; label: string } {
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  if (launched) {
    const running = launchedWords(rows, member.model, member.effort, labels);
    return { text: <LaunchedText model={running.model} words={running.words} />, title: running.title, label: `${running.words.model} · ${running.words.effort}` };
  }
  const picked = pickedLaunch(member);
  if (!picked) return { title: t("objectives.members.assignedHint"), label: t("objectives.members.assigned") };
  const chosen = launchedWords(rows, picked.model, picked.effort, labels);
  return { title: chosen.title, label: `${chosen.words.model} · ${chosen.words.effort}` };
}

/**
 * 구성원 행 아래의 진단 줄 — 직전 턴 실패, 바꾸지 못한 모델 전환, 보고 경로 없음. `title` 은 보드가 펼침 안에 싣는 원문이다(번역하지 않는다). 없으면 빈 목록이다.
 */
export interface MemberNote {
  readonly kind: "failure" | "switch" | "noReportTool";
  readonly text: string;
  readonly title?: string;
  readonly tone: "danger" | "warn";
}

export function memberNotes(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>): readonly MemberNote[] {
  const notes: MemberNote[] = [];
  const raw = (values: readonly (string | undefined)[]) => { const text = values.filter((value): value is string => value !== undefined && value !== "").join("\n"); return text ? { title: text } : {}; };
  if (member.failure) {
    const reason = memberFailureReason(member.failure);
    notes.push({ kind: "failure", tone: "danger", text: reason ? t("objectives.members.failureReason", { reason: t(`objectives.members.reason.${reason}`), count: member.failure.consecutiveFailures }) : t("objectives.members.failureCount", { count: member.failure.consecutiveFailures }),
      ...raw([member.failure.error, member.failure.error_details, member.failure.last_assistant_message]) });
  }
  if (launched && member.next?.failed && member.next.cause) notes.push({ kind: "switch", tone: "danger", text: t("objectives.members.next.causeSummary"), ...raw([member.next.cause.message]) });
  if (member.noReportTool) notes.push({ kind: "noReportTool", tone: "warn", text: t("objectives.members.noReportTool") });
  return notes;
}

/** 한 로케일 값의 낱말을 로케일마다 다시 푼다. */
export const localized = (word: (t: Translate<ObjectiveMessageKey>) => string): LocalizedText => (locale) => word(getT(locale));

/**
 * 활동 → 상태 낱말 — 데스크톱 명단·모바일 보드·대화 명부가 같은 낱말을 쓴다. 세션이 없으면(closed) 말하지 않는다.
 * 활동은 화면 활동(백그라운드를 작업 중으로 접은 값)으로 받는다 — 접기는 부르는 쪽이 한다.
 */
export function memberActivityWord(state: string, t: Translate<ObjectiveMessageKey>): string | null {
  if (state === "closed") return null;
  if (state === "archived") return t("objectives.members.archived");
  if (state === "ended") return t("objectives.members.dormant");
  if (state === "awaiting") return t("objectives.awaiting.word");
  return state === "running" ? t("objectives.members.working") : t("objectives.members.idle");
}

/** 구성원 행의 상태 낱말 — 실패가 먼저, 세션이 없으면 맡은 임무 수, 아니면 상태 낱말. */
export function memberStatus(member: ObjectiveMember, state: string, objective: Objective, t: Translate<ObjectiveMessageKey>): { readonly text: string; readonly failed: boolean } {
  const working = state === "running" || state === "awaiting";
  if ((member.outcome === "failed" || !!member.failure) && !working) return { text: t("objectives.members.failed"), failed: true };
  if (state === "closed") return { text: t("objectives.members.missions", { count: objective.missions.filter((mission) => mission.member === member.id).length }), failed: false };
  return { text: memberActivityWord(state, t) ?? "", failed: false };
}

/** 사라진 Objective 은 실행값을 읽을 곳이 없다 — 띄우기 전처럼 설정 선택을 보인다(다음 개시가 연결을 새로 세운다). */
export const memberLaunched = (member: ObjectiveMember, objectiveRecordState: (objectiveId: string) => string): boolean => member.sessionName !== null && objectiveRecordState(member.id) !== "closed";
/** 저장값만. false와 키 없음은 꺼짐. 실행 중 세션에 적용됐는지는 여기서 말하지 않는다. */
export const memberSubagents = (member: ObjectiveMember): boolean => member.subagents === true;
/** 세션이 살아 있는 활동 — 서브에이전트 허용은 이런 세션에 곧바로 실리지 않고 다음 기동부터 적용된다. */
export const MEMBER_LIVE: ReadonlySet<string> = new Set(["running", "idle", "awaiting"]);

export type MemberLaunchChoice = { readonly mode: "model"; readonly model: string; readonly effort?: string | undefined };

interface MemberLaunchControlProps {
  readonly t: Translate<ObjectiveMessageKey>;
  readonly objective: Objective;
  readonly member: ObjectiveMember;
  /** 구성원 세션의 활동 — 세션이 없으면 "closed". */
  readonly state: string;
  readonly rows: readonly ObjectiveLaunchVariantRow[];
  readonly touchable: boolean;
  /** 띄운 구성원의 선택 — 휴면·유휴면 곧바로, 일하는 중이면 이번 턴 뒤 바뀐다. 한 번의 선택에 한 번 불린다. */
  readonly onPickLaunched: (choice: MemberLaunchChoice) => void;
  /** 띄우기 전 선택 — 저장값만 바꾼다. */
  readonly onPatchLaunch: (choice: MemberLaunchChoice) => void;
  /** 「라우팅」 — launch 를 비운다. 뜬 모델 칸은 실행값을 그대로 보인다. */
  readonly onClearLaunch: () => void;
  readonly onToggleSubagents: () => void;
}

/**
 * 구성원 한 명의 기동 선택 — 데스크톱 명단과 모바일 보드가 같은 이 컨트롤을 쓴다. 띄운 구성원은 실행값과 모델 목록만 보인다
 * 띄우기 전에는 사람이 고른 값(없으면 「라우팅」)을 보인다. 폰에서는 그 선택기가 호스트의
 * 좌표 시트로 서고, 머리·사유 줄·서브에이전트 footer 는 메뉴 밖(보드의 행·묶음)이 맡는다.
 */
export function MemberLaunchControl({ t, objective: _objective, member, state, rows, touchable, onPickLaunched, onPatchLaunch, onClearLaunch, onToggleSubagents }: MemberLaunchControlProps) {
  const launched = member.sessionName !== null && state !== "closed";
  const display = memberLaunchDisplay(member, launched, t, rows);
  const subagents = touchable ? { allowed: memberSubagents(member), onToggle: onToggleSubagents } : undefined;
  const triggerLabel = t("objectives.members.modelAria", { role: member.role });
  const routing = [{ id: "member-routing", label: t("objectives.members.assigned"), hint: t("objectives.members.assignedHint"), active: member.launch === null, ...(touchable ? {} : { disabled: true }), onPick: onClearLaunch }];
  if (launched) {
    // 띄운 구성원 — 행은 실행값이다. 고른 값은 곧바로 또는 이번 턴 뒤 바뀌고, 그 경과는 칩 곁 말풍선(폰은 행의 설명 줄)이 말한다.
    const reserved = member.next && !member.next.failed ? member.next : null;
    return (
      <LaunchControl t={t} model={reserved ? reserved.model : member.model} effort={reserved ? reserved.effort : member.effort} locked={!touchable} startAtList reconfirm triggerLabel={triggerLabel} extras={routing}
        triggerText={display.text} triggerTitle={display.title}
        head={<><b>{t(state === "ended" ? "objectives.members.menuHead.last" : "objectives.members.menuHead.running", { model: display.label })}</b><span>{t(state === "ended" ? "objectives.members.menuHead.dormant" : state === "idle" ? "objectives.members.menuHead.idle" : "objectives.members.menuHead.working")}</span></>}
        {...(subagents ? { subagents } : {})}
        onChange={(choice) => { const model = choice.model ?? reserved?.model ?? member.model; if (model) onPickLaunched({ mode: "model", model, effort: choice.effort }); }} />
    );
  }
  const picked = pickedLaunch(member);
  return (
    <LaunchControl t={t} model={picked?.model} effort={picked?.effort} locked={!touchable} startAtList={!picked} unset={!picked} reconfirm triggerLabel={triggerLabel} extras={routing}
      triggerText={picked ? display.text : <span className="objectives-launch-model">{display.label}</span>} triggerTitle={display.title}
      {...(subagents ? { subagents } : {})}
      onChange={(next) => { const model = next.model ?? picked?.model; if (model) onPatchLaunch({ mode: "model", model, effort: next.effort }); }} />
  );
}
