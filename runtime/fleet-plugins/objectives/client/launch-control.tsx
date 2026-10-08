import type { ReactNode } from "react";

import { ModelCoordinatePicker } from "@fleet-console/sdk/components/model-coordinate-picker";
import { canonicalModelId as sdkCanonicalModelId, type ModelRoster } from "@fleet-console/sdk/models";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import type { ClientModelsCapability } from "@fleet-console/sdk/plugin";
import { useModelRoster } from "@fleet-console/sdk/plugin/browser";

import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

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
}

/** 선택기의 로스터 — 아직 읽기 전이면 null(메뉴가 「읽는 중」을 보인다). */
function useLaunchRoster(): ModelRoster | null {
  return useModelRoster(models, "launch");
}

export function LaunchControl({ t, model, effort, locked, onChange, viewMode, onViewChange, trigger, triggerLabel, triggerText, triggerTitle, extras, startAtList = false, subagents, head, extrasCaption }: LaunchControlProps) {
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
