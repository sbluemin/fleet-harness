import type { ReactNode } from "react";

import { ModelCoordinatePicker, modelCoordinateDisplay } from "@fleet-console/sdk/components/model-coordinate-picker";
import { canonicalModelId as sdkCanonicalModelId, type ModelRoster } from "@fleet-console/sdk/models";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import type { ClientModelsCapability } from "@fleet-console/sdk/plugin";
import { useModelRoster } from "@fleet-console/sdk/plugin/browser";

import { memberFailureReason } from "../shared/signals.js";
import type { Objective, ObjectiveMember } from "../shared/types.js";
import { getT, objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 지휘관·구성원의 모델·강도 — 한 줄의 글("Opus · HIGH")이고, 누르면 Console 공유 선택기(`ModelCoordinatePicker`)의
 * 메뉴가 뜬다. 이 파일은 Objectives 고유 부분(시작 뷰·서브에이전트·실행 낱말·라우팅 사유)만 갖는 어댑터다.
 */

export const DEFAULT_LAUNCH = { model: "opus[1m]", effort: "high" } as const;

export interface LaunchGroup { readonly provider: LaunchProviderGlyphId | null; readonly caption: string; readonly rows: readonly OperationLaunchVariantRow[] }

/**
 * 지휘관·구성원 메뉴의 원천 — Console 모델 로스터(`launch` 대상). 코어 캐시 하나를 구독하므로 Settings › AI Gateway에서
 * 모델을 켜고 끄면(다른 탭·기기 포함) 열려 있는 메뉴도 곧 다시 그린다. 플러그인이 설치될 때 능력을 받는다.
 */
let models: ClientModelsCapability | null = null;
/** 마지막으로 투영한 띠 — 리액트 밖의 이름 조회(modelFullName)가 쓴다. */
let lastGroups: readonly LaunchGroup[] = [];
let lastRoster: ModelRoster | null = null;

/** 리액트 밖 구독자(대화 명부를 싣는 묶음 서술자) — 로스터가 오거나 바뀌면 다시 셈한다. */
const rosterListeners = new Set<() => void>();
const notifyRoster = () => { for (const listener of rosterListeners) listener(); };

export function installLaunchRoster(capability: ClientModelsCapability): () => void {
  models = capability;
  const off = capability.subscribe(notifyRoster);
  if (rosterListeners.size > 0) { void capability.load("launch").catch(() => undefined); notifyRoster(); }
  return () => { off(); if (models === capability) models = null; };
}

/** 지금 캐시된 기동 로스터 — 읽기 전이면 null 이고 읽기를 시작하지 않는다. */
export const readLaunchRoster = (): ModelRoster | null => models?.read("launch") ?? null;

/** 리액트 밖에서 로스터를 따른다 — 구독하는 동안 읽기를 한 번 청해, 보드를 열지 않아도 같은 낱말이 선다. */
export function subscribeLaunchRoster(listener: () => void): () => void {
  rosterListeners.add(listener);
  void models?.load("launch").catch(() => undefined);
  return () => { rosterListeners.delete(listener); };
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
export const useLaunchRows = (): readonly OperationLaunchVariantRow[] => useLaunchGroups().flatMap((group) => group.rows);

/** 모델 id 의 공급자 — 카탈로그 행이 있으면 그 밴드, 없으면 id 에서. 라우팅의 "codex/gpt-…"·게이트웨이 접두 표기도 같은 공급자로 읽는다. */
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
  return <span className={`operation-launch-provider-glyph objectives-launch-provider is-${provider}`} aria-hidden="true">{launchProviderGlyph(provider)}</span>;
}

/**
 * 실제로 띄운 모델의 낱말 — 설정 선택(member.launch)이 아니라 실행 Operation 에 적힌 값이다. 모델이 비어 있으면 Console 기본으로
 * 뜬 것이므로 기본 모델(Opus)을 추정하지 않고 「기본」으로 둔다. 제목(title)은 공급자까지 붙인 풀네임.
 */
export function launchedWords(rows: readonly OperationLaunchVariantRow[], model: string | undefined, effort: string | undefined, labels: { readonly auto: string; readonly fallback: string }): { readonly model: string | null; readonly words: { readonly model: string; readonly effort: string }; readonly title: string } {
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
/** 라우팅 폴백·기동 거절의 사유 코드 → 사람의 말. 모르는 코드는 코드 그대로 보인다. */
/** 사유 코드에 번역된 문면이 있는가 — 없으면 화면은 코드를 그대로 싣는 일반 실패 문면을 쓴다. */
export const hasRoutingReason = (code: string): boolean => `objectives.routing.reason.${code}` in objectivesEn;
export function routingReason(t: Translate<ObjectiveMessageKey>, code: string): string {
  const key = `objectives.routing.reason.${code}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : t("objectives.routing.reason.other", { code });
}

/** "Opus" / "HIGH" — 카드·행·메뉴가 같은 낱말을 쓴다. 카탈로그에 없는 모델은 id 그대로. */
export function launchWords(rows: readonly OperationLaunchVariantRow[], model: string | undefined, effort: string | undefined, autoLabel: string): { readonly model: string; readonly effort: string } {
  const id = model ?? DEFAULT_LAUNCH.model;
  const row = findLaunchRow(rows, id);
  const chosen = effort ?? (model ? undefined : DEFAULT_LAUNCH.effort);
  const chip = row?.chips?.find((candidate) => candidate.launch.effort === chosen);
  return { model: row?.label ?? prettyModelId(bareModelId(id)), effort: chip?.label ?? (chosen ? chosen.toUpperCase() : autoLabel) };
}

const GATEWAY_PREFIX = "claude-gateway--";
/** SDK 정준 id에, 라우팅의 "codex/gpt-…" 와 카탈로그의 "codex--gpt-…" 만 맞춘다. */
function canonicalModelId(model: string): string {
  const canonical = sdkCanonicalModelId(model);
  return canonical.includes("--") || !canonical.includes("/") ? canonical : canonical.replace(/\//g, "--");
}
/** 라우팅·스코프·bare 표기가 달라도 같은 모델의 행을 찾는다. */
function findLaunchRow(rows: readonly OperationLaunchVariantRow[], model: string): OperationLaunchVariantRow | undefined {
  const id = canonicalModelId(model);
  return rows.find((candidate) => canonicalModelId(candidate.launch.model ?? candidate.id) === id);
}
/** 카탈로그에 없는 모델의 읽을 수 있는 이름 — 접두와 공급자 칸을 벗긴 뒤 다듬는다. */
function bareModelId(model: string): string {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  return stripped.includes("--") ? stripped.slice(stripped.lastIndexOf("--") + 2) : stripped.includes("/") ? stripped.slice(stripped.lastIndexOf("/") + 1) : stripped;
}
/** "Codex GPT-5.3 Codex" / "Claude Opus" — 임무 아래 dim 줄의 풀네임. 게이트웨이 접두는 벗기고, 카탈로그 행이 있으면 그 이름, 없으면 id 를 읽을 수 있게 다듬는다. */
export function modelFullName(rows: readonly OperationLaunchVariantRow[], model: string | undefined | null): string {
  if (!model || model === "default") return "";
  // 라우팅은 "codex/gpt-…", 카탈로그는 "codex--gpt-…" — 같은 모델의 두 표기.
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

export type StartView = "terminal" | "chat";
export const StartViewGlyph = ({ view }: { readonly view: StartView }) => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{view === "chat" ? <path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H7.2L4.5 13.1v-2.35h-.25c-.83 0-1.5-.67-1.5-1.5z" /> : <path d="M3 4.5 6.5 8 3 11.5M8 12h5" />}</svg>;
export const startViewLabel = (t: Translate<ObjectiveMessageKey>, view: StartView) => t(view === "chat" ? "objectives.view.chat" : "objectives.view.terminal");

interface LaunchControlProps {
  readonly t: Translate<ObjectiveMessageKey>;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly locked: boolean;
  readonly onChange: (next: { model?: string; effort?: string }) => void;
  readonly viewMode?: StartView;
  readonly onViewChange?: (view: StartView) => void;
  /** 트리거를 글리프 하나로 — 모델 낱말을 쓸 자리가 없을 때. */
  readonly trigger?: ReactNode;
  readonly triggerLabel?: string;
  /** 라우팅·지휘관과 같게처럼 모델 id가 아닌 선택 방식의 표시 낱말. */
  readonly triggerText?: ReactNode;
  /** triggerText 의 풀네임 — 좁은 칸에서 잘린 모델 이름을 hover 로 읽는다. */
  readonly triggerTitle?: string;
  /** 모델 목록 위에 서는 선택 방식(라우팅 · 지휘관과 같게). 고르면 메뉴가 닫힌다. 하나라도 active 면 모델 행은 선택으로 서지 않는다. */
  readonly extras?: readonly { readonly id: string; readonly label: string; readonly hint?: string; readonly active: boolean; readonly disabled?: boolean; readonly onPick: () => void }[];
  /** 메뉴 맨 위의 한 줄 — 개시한 구성원은 지금 실행 중인 모델과 고르면 언제 바뀌는지를 말한다. */
  readonly head?: ReactNode;
  /** 선택 방식 아래의 작은 안내 — 예: 라우팅은 새로 띄울 때만 판단한다. */
  readonly extrasCaption?: string;
  /** 열 때 모델 목록(1단계)부터 — 배정 메뉴는 특별 항목을 먼저 보여야 한다. */
  readonly startAtList?: boolean;
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

export function LaunchControl({ t, model, effort, locked, onChange, viewMode, onViewChange, trigger, triggerLabel, triggerText, triggerTitle, extras, startAtList = false, subagents, head, extrasCaption, reconfirm = false }: LaunchControlProps) {
  const roster = useLaunchRoster();
  const viewPrefix = viewMode ? <><span className="objectives-launch-view"><StartViewGlyph view={viewMode} /><span className="objectives-launch-view-word">{startViewLabel(t, viewMode)}</span></span><span className="objectives-launch-separator" aria-hidden="true" /></> : undefined;
  const footer = (viewMode && onViewChange) || subagents ? (
    <>
      {viewMode && onViewChange ? <div className="fc-coord-menu-group">
        <div className="fc-coord-menu-divider" role="separator" />
        <p className="fc-coord-menu-caption">{t("objectives.view.label")}</p>
        {(["terminal", "chat"] as const).map((view) => <button key={view} type="button" role="menuitemradio" aria-checked={viewMode === view} className={`fc-coord-menu-item${viewMode === view ? " is-active" : ""}`} onClick={() => onViewChange(view)}><span className="objectives-launch-view"><StartViewGlyph view={view} /></span><span className="fc-coord-menu-label">{startViewLabel(t, view)}</span></button>)}
      </div> : null}
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
      // 비어 있으면 Console 기본 좌표를 보인다. 라우팅처럼 선택 방식이 있는 메뉴는 기본 모델을 추정하지 않는다.
      {...(extras?.length ? {} : { fallback: DEFAULT_LAUNCH })}
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
        fallback: t("objectives.launch.fallback"),
        locked: t("objectives.commander.locked"),
      }}
      trigger={{
        variant: trigger ? "glyph" : "inline",
        ...(trigger ? { node: trigger } : {}),
        ...(triggerText ? { text: triggerText } : {}),
        ...(triggerTitle ? { title: triggerTitle } : {}),
        ...(viewPrefix ? { prefix: viewPrefix } : {}),
        // 행 배치 오버라이드(objectives.css)가 이 이름으로 자리를 잡는다.
        className: `objectives-launch${trigger ? " objectives-glyph" : ""}`,
      }}
      {...(head ? { head } : {})}
      {...(extras ? { extras } : {})}
      {...(extrasCaption ? { extrasCaption } : {})}
      {...(footer ? { footer } : {})}
      {...(subagents ? { menuWidth: 232 } : {})}
    />
  );
}

/**
 * 구성원 트리거의 표시 — 실행과 설정을 가른다. 띄운 Operation 이 있으면 어떤 방식이든 그 Operation 의 모델이 실제 실행값이다(연결 뒤
 * 설정을 바꿔도 기존 Operation 은 옛 모델로 재개된다). 띄우기 전에는 라우팅·지휘관과 같게는 선택 낱말, 모델 지정은 선택값 그대로.
 * 메뉴의 선택 표시(model·effort·active)는 이 값이 아니라 member.launch 만 따른다.
 */
export function memberLaunchDisplay(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>, rows: readonly OperationLaunchVariantRow[]): { text?: ReactNode; title: string; label: string } {
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  if (launched) {
    const running = launchedWords(rows, member.model, member.effort, labels);
    // 라우팅으로 떴으면 그 근거, 폴백이면 사유가 풀네임 뒤에 붙는다 — 같은 「모델 · 강도」 줄이 어떻게 정해졌는지 말한다.
    const title = member.routed?.via === "route" ? t("objectives.members.routedBecause", { model: running.title, because: member.routed.because })
      : member.routed?.via === "fallback" ? t("objectives.members.fallbackBecause", { model: running.title, reason: routingReason(t, member.routed.reason) }) : running.title;
    return { text: <LaunchedText model={running.model} words={running.words} />, title, label: `${running.words.model} · ${running.words.effort}` };
  }
  if (member.launch.mode === "route") return { text: <span className="objectives-launch-model">{t("objectives.memberSelection.route")}</span>, title: t("objectives.members.routeHint"), label: t("objectives.memberSelection.route") };
  if (member.launch.mode === "same") return { text: <span className="objectives-launch-model">{t("objectives.memberSelection.inherit")}</span>, title: t("objectives.memberSelection.inherit"), label: t("objectives.memberSelection.inherit") };
  const chosen = launchedWords(rows, member.launch.model, member.launch.effort, labels);
  return { title: chosen.title, label: `${chosen.words.model} · ${chosen.words.effort}` };
}
/**
 * 대화 명부(오른쪽 「구성원」 탭)가 보이는 구성원 모델 줄 — 보드 행 트리거가 실제로 그리는 낱말과 같다. 띄운 구성원·라우팅·지휘관과 같게는
 * 위 표시의 낱말, 모델 지정은 공유 선택기의 트리거 낱말(메뉴처럼 기본 좌표 없이)이다. hover 글은 보드 트리거의 title 그대로다.
 */
export function memberLaunchShown(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>, roster: ModelRoster | null): LaunchShown {
  const groups = toLaunchGroups(roster);
  const display = memberLaunchDisplay(member, launched, t, groups.flatMap((group) => group.rows));
  if (launched) {
    // 보드 행의 LaunchedText 와 같은 낱말 — 이름과 강도를 따로 싣는다.
    const running = launchedWords(groups.flatMap((group) => group.rows), member.model, member.effort, { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") });
    return { label: running.words.model, effort: running.words.effort || null, title: display.title, provider: running.model ? providerOfModel(groups, running.model) : null, struck: false, badge: null };
  }
  if (member.launch.mode !== "model") return { label: display.label, effort: null, title: display.title, provider: null, struck: false, badge: null };
  const shown = modelCoordinateDisplay(roster, { model: member.launch.model, ...(member.launch.effort ? { effort: member.launch.effort } : {}) }, undefined, pickerLabels(t));
  return { label: shown.words.model, effort: shown.words.effort || null, title: display.title, provider: shown.provider, struck: shown.struck, badge: shown.badge };
}

/** 지휘관 행의 모델 줄 — 보드의 지휘관 트리거(기본 좌표를 둔 공유 선택기)가 그리는 낱말과 hover 글. */
export function commanderLaunchShown(objective: Objective, t: Translate<ObjectiveMessageKey>, roster: ModelRoster | null): LaunchShown {
  const { model, effort } = objective.commander;
  const shown = modelCoordinateDisplay(roster, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, DEFAULT_LAUNCH, pickerLabels(t));
  return { label: shown.words.model, effort: shown.words.effort || null, title: shown.title, provider: shown.provider, struck: shown.struck, badge: shown.badge };
}

/**
 * 트리거가 보이는 모델 줄 — 낱말, hover 글, 공급자, 그리고 공유 선택기가 그 곁에 그리는 상태: 로스터 밖 저장값이면 취소선(struck)과
 * 「꺼짐」, 로스터가 비어 최후 폴백으로 서면 「폴백」 표식(badge).
 */
export interface LaunchShown {
  /** 모델 낱말 — 선택 방식(라우팅·지휘관과 같게)이면 그 낱말. 취소선은 이 낱말에만 긋는다(보드 트리거와 같게). */
  readonly label: string;
  /** 강도 낱말 — 말하지 않는 행(선택 방식·강도 사다리 없는 모델)이면 null. */
  readonly effort: string | null;
  readonly title: string;
  readonly provider: LaunchProviderGlyphId | null;
  readonly struck: boolean;
  readonly badge: string | null;
}

/** 라우팅 사유 중 「켜져 있지 않거나 후보가 없음」 — 사유 줄과 표식 hover 가 같은 문장으로 접는다. */
export const ROUTING_OFF_REASONS: ReadonlySet<string> = new Set(["routing_disabled", "routing_off", "no_candidate"]);

/** 띄운 구성원의 「라우팅」·「폴백」 표식 — 보드 행의 모델 칩 곁과 대화 명부가 같은 낱말·hover 를 쓴다. 띄우기 전이면 없다. */
export function memberRoutedTag(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>): { readonly via: "route" | "fallback"; readonly label: string; readonly title: string } | null {
  const routed = launched ? member.routed : null;
  if (!routed) return null;
  return {
    via: routed.via,
    label: t(routed.via === "route" ? "objectives.members.routed" : "objectives.members.fallback"),
    title: t(routed.via === "route" ? "objectives.members.routedTitle" : ROUTING_OFF_REASONS.has(routed.reason) ? "objectives.members.fallbackOffTitle" : "objectives.members.fallbackTitle"),
  };
}

/** 폴백으로 띄운 구성원의 사유 한 줄 — hover 는 자식이 남긴 원문(detail)이다. 폴백이 아니면 없다. */
function memberFallbackNote(member: ObjectiveMember, launched: boolean, t: Translate<ObjectiveMessageKey>): { readonly text: string; readonly title?: string } | null {
  const routed = launched ? member.routed : null;
  if (routed?.via !== "fallback") return null;
  const text = routed.reason === "no_candidate" ? t("objectives.members.fallbackNoCandidate") : ROUTING_OFF_REASONS.has(routed.reason) ? t("objectives.members.fallbackOff") : t("objectives.members.fallbackLine", { reason: routingReason(t, routed.reason) });
  return { text, ...(routed.detail !== undefined ? { title: routed.detail } : {}) };
}

/**
 * 구성원 행 아래의 진단 줄 — 보드 행과 대화 명부가 같은 낱말·순서를 쓴다. 직전 턴 실패, 바꾸지 못한 모델 전환, 보고 경로 없음,
 * 라우팅 폴백 사유. `title` 은 보드가 펼침 안에 싣는 원문이다(번역하지 않는다). 없으면 빈 목록이다.
 */
export interface MemberNote {
  readonly kind: "failure" | "switch" | "noReportTool" | "fallback";
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
  const fallback = memberFallbackNote(member, launched, t);
  if (fallback) notes.push({ kind: "fallback", tone: "warn", ...fallback });
  return notes;
}

const pickerLabels = (t: Translate<ObjectiveMessageKey>) => ({ auto: t("objectives.commander.effortAuto"), off: t("objectives.launch.off"), fallback: t("objectives.launch.fallback") });

/** 한 로케일 값의 낱말을 로케일마다 다시 푼다 — 대화 명부는 호스트의 로케일로 읽는다. */
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

/** 사라진 Operation 은 실행값을 읽을 곳이 없다 — 띄우기 전처럼 설정 선택을 보인다(다음 개시가 연결을 새로 세운다). */
export const memberLaunched = (member: ObjectiveMember, operationState: (operationId: string) => string): boolean => member.sessionName !== null && operationState(member.id) !== "closed";
/** 저장값만. false와 키 없음은 꺼짐. 실행 중 세션에 적용됐는지는 여기서 말하지 않는다. */
export const memberSubagents = (member: ObjectiveMember): boolean => member.subagents === true;
/** 세션이 살아 있는 활동 — 서브에이전트 허용은 이런 세션에 곧바로 실리지 않고 다음 기동부터 적용된다. */
export const MEMBER_LIVE: ReadonlySet<string> = new Set(["running", "idle", "awaiting"]);

export type MemberLaunchChoice = { readonly mode: "same" } | { readonly mode: "model"; readonly model: string; readonly effort?: string | undefined };

interface MemberLaunchControlProps {
  readonly t: Translate<ObjectiveMessageKey>;
  readonly objective: Objective;
  readonly member: ObjectiveMember;
  /** 구성원 세션의 활동 — 세션이 없으면 "closed". */
  readonly state: string;
  readonly rows: readonly OperationLaunchVariantRow[];
  readonly touchable: boolean;
  /** 띄운 구성원의 선택 — 휴면·유휴면 곧바로, 일하는 중이면 이번 턴 뒤 바뀐다. 한 번의 선택에 한 번 불린다. */
  readonly onPickLaunched: (choice: MemberLaunchChoice) => void;
  /** 띄우기 전 선택 — 저장값만 바꾼다. null 은 라우팅. */
  readonly onPatchLaunch: (choice: MemberLaunchChoice | null) => void;
  readonly onToggleSubagents: () => void;
}

/**
 * 구성원 한 명의 기동 선택 — 데스크톱 명단과 모바일 보드가 같은 이 컨트롤을 쓴다. 띄운 구성원은 실행값을 보이고 「지휘관과 같게」만
 * 선택 방식으로 서며(라우팅은 새로 띄울 때만 판단한다), 띄우기 전에는 「라우팅」·「지휘관과 같게」가 선다. 폰에서는 공유 선택기가 호스트의
 * 좌표 시트로 서고, 머리·사유 줄·서브에이전트 footer 는 메뉴 밖(보드의 행·묶음)이 맡는다.
 */
export function MemberLaunchControl({ t, objective, member, state, rows, touchable, onPickLaunched, onPatchLaunch, onToggleSubagents }: MemberLaunchControlProps) {
  const launched = member.sessionName !== null && state !== "closed";
  const display = memberLaunchDisplay(member, launched, t, rows);
  const subagents = touchable ? { allowed: memberSubagents(member), onToggle: onToggleSubagents } : undefined;
  const triggerLabel = t("objectives.members.modelAria", { role: member.role });
  if (launched) {
    // 띄운 구성원 — 행은 실행값이다. 고른 값은 곧바로 또는 이번 턴 뒤 바뀌고, 그 경과는 칩 곁 말풍선(폰은 행의 설명 줄)이 말한다.
    const reserved = member.next && !member.next.failed ? member.next : null;
    const commanderWords = launchedWords(rows, objective.commander.model, objective.commander.effort, { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") });
    return (
      <LaunchControl t={t} model={reserved ? reserved.model : member.model} effort={reserved ? reserved.effort : member.effort} locked={!touchable} startAtList reconfirm triggerLabel={triggerLabel}
        triggerText={display.text} triggerTitle={display.title}
        head={<><b>{t(state === "ended" ? "objectives.members.menuHead.last" : "objectives.members.menuHead.running", { model: display.label })}</b><span>{t(state === "ended" ? "objectives.members.menuHead.dormant" : state === "idle" ? "objectives.members.menuHead.idle" : "objectives.members.menuHead.working")}</span></>}
        extras={[{ id: "same", label: t("objectives.memberSelection.inherit"), hint: `${commanderWords.words.model} · ${commanderWords.words.effort}`, active: member.launch.mode === "same", onPick: () => onPickLaunched({ mode: "same" }) }]}
        extrasCaption={t("objectives.members.routeAtLaunch")}
        {...(subagents ? { subagents } : {})}
        onChange={(choice) => { const model = choice.model ?? reserved?.model ?? member.model; if (model) onPickLaunched({ mode: "model", model, effort: choice.effort }); }} />
    );
  }
  return (
    <LaunchControl t={t} model={member.launch.mode === "model" ? member.launch.model : undefined} effort={member.launch.mode === "model" ? member.launch.effort : undefined} locked={!touchable} startAtList={member.launch.mode !== "model"} reconfirm triggerLabel={triggerLabel}
      triggerText={display.text} triggerTitle={display.title}
      extras={[{ id: "route", label: t("objectives.memberSelection.route"), hint: t("objectives.members.routeHint"), active: member.launch.mode === "route", onPick: () => onPatchLaunch(null) }, { id: "same", label: t("objectives.memberSelection.inherit"), active: member.launch.mode === "same", onPick: () => onPatchLaunch({ mode: "same" }) }]}
      {...(subagents ? { subagents } : {})}
      onChange={(next) => { const model = next.model ?? (member.launch.mode === "model" ? member.launch.model : undefined); if (model) onPatchLaunch({ mode: "model", model, effort: next.effort }); }} />
  );
}
