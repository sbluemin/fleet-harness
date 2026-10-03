import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { EffortTrack, resolveRowEffort } from "@fleet-console/sdk/composer";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { Translate } from "@fleet-console/sdk/i18n";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 지휘관의 모델·강도 — 한 줄의 글("Opus · HIGH")이고, 누르면 **맵 우클릭 메뉴와 같은 문법**의 메뉴가 뜬다:
 * 공급자 띠(글리프 + 이름) 아래 모델 행(이름 · 강도 게이지 · ›). 행을 고르면 목록이 접히고 그 모델 한 줄과
 * 강도 트랙만 남는다(2단계); 모델 이름을 다시 누르면 목록으로 돌아간다. 지휘관은 첫 실행 전에 시작 뷰도 고른다.
 */

export const DEFAULT_LAUNCH = { model: "opus[1m]", effort: "high" } as const;

export interface LaunchGroup { readonly provider: LaunchProviderGlyphId | null; readonly caption: string; readonly rows: readonly OperationLaunchVariantRow[] }

let cached: readonly LaunchGroup[] | null = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

export async function loadLaunchGroups(signal?: AbortSignal): Promise<readonly LaunchGroup[]> {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const plugins = await fetchOperationCatalog(signal);
  const groups: LaunchGroup[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const kind of plugin.kinds) {
      for (const group of kind.variants ?? []) {
        const rows = group.rows.filter((row) => { const model = row.launch.model; if (!model || seen.has(model)) return false; seen.add(model); return true; });
        if (rows.length === 0) continue;
        const provider = launchProviderFromGroupId(group.id) ?? launchProviderFromModelId(rows[0]!.launch.model);
        groups.push({ provider, caption: provider ? launchProviderCaption(provider) : group.label, rows });
      }
    }
  }
  cached = groups;
  cachedAt = Date.now();
  return groups;
}

export function useLaunchGroups(): readonly LaunchGroup[] {
  const [groups, setGroups] = useState<readonly LaunchGroup[]>(cached ?? []);
  useEffect(() => {
    const controller = new AbortController();
    void loadLaunchGroups(controller.signal).then(setGroups).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return groups;
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
export const loadLaunchRows = async (signal?: AbortSignal) => (await loadLaunchGroups(signal)).flatMap((group) => group.rows);

/** "Opus" / "HIGH" — 카드·행·메뉴가 같은 낱말을 쓴다. 카탈로그에 없는 모델은 id 그대로. */
export function launchWords(rows: readonly OperationLaunchVariantRow[], model: string | undefined, effort: string | undefined, autoLabel: string): { readonly model: string; readonly effort: string } {
  const id = model ?? DEFAULT_LAUNCH.model;
  const row = findLaunchRow(rows, id);
  const chosen = effort ?? (model ? undefined : DEFAULT_LAUNCH.effort);
  const chip = row?.chips?.find((candidate) => candidate.launch.effort === chosen);
  return { model: row?.label ?? prettyModelId(bareModelId(id)), effort: chip?.label ?? (chosen ? chosen.toUpperCase() : autoLabel) };
}

const GATEWAY_PREFIX = "claude-gateway--";
/** 게이트웨이 접두를 벗기고 "codex/gpt-…" 를 카탈로그 표기 "codex--gpt-…" 로 맞춘 id. */
function canonicalModelId(model: string): string {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  return stripped.includes("--") ? stripped : stripped.replace("/", "--");
}
/** 라우팅이 준 "claude-gateway--codex--gpt-…" 와 카탈로그의 "codex--gpt-…" 는 같은 모델 — 어느 표기로든 행을 찾는다. */
function findLaunchRow(rows: readonly OperationLaunchVariantRow[], model: string): OperationLaunchVariantRow | undefined {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  const id = canonicalModelId(model);
  return rows.find((candidate) => candidate.launch.model === model || candidate.launch.model === id || candidate.launch.model === stripped || candidate.launch.model === `${GATEWAY_PREFIX}${id}`);
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
  const group = row ? cached?.find((candidate) => candidate.rows.includes(row)) : undefined;
  const provider = group?.provider ?? launchProviderFromModelId(id);
  const caption = group?.caption ?? (provider ? launchProviderCaption(provider) : null);
  const name = row?.label ?? prettyModelId(id.includes("--") ? id.slice(id.indexOf("--") + 2) : id);
  return caption && !name.toLowerCase().startsWith(caption.toLowerCase()) ? `${caption} ${name}` : name;
}
function prettyModelId(id: string): string {
  return id.replace(/\[1m\]$/, "-1M").split(/[-_]+/).filter(Boolean)
    .map((token) => (/^(gpt|o\d|glm|qwen)/i.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1))).join(" ");
}

const Chevron = ({ back }: { readonly back?: boolean }) => <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{back ? <path d="M7.5 2.5L4 6l3.5 3.5" /> : <path d="M4.5 2.5L8 6l-3.5 3.5" />}</svg>;

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
  /**
   * 고른 모델·강도를 메뉴가 닫힐 때 한 번만 알린다. 행을 고르면 강도 단계가 이어지므로 고를 때마다 알리면 한 번의 선택이 두 번의 변경이
   * 된다 — 변경이 곧 세션 재기동·모델 전환인 곳(띄운 구성원)에서 쓴다. 고르는 동안은 메뉴의 표시만 바뀐다. 선택 방식(extras)은 따로 곧바로다.
   */
  readonly commitOnClose?: boolean;
}

const MENU_WIDTH = 216;
const MENU_MARGIN = 12;
const menuItems = (root: HTMLElement): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled)')];

export function LaunchControl({ t, model, effort, locked, onChange, viewMode, onViewChange, trigger, triggerLabel, triggerText, triggerTitle, extras, startAtList = false, subagents, head, extrasCaption, commitOnClose = false }: LaunchControlProps) {
  const groups = useLaunchGroups();
  const rows = groups.flatMap((group) => group.rows);
  const currentModel = model ?? DEFAULT_LAUNCH.model;
  // 메뉴에서 방금 고른 값 — 저장이 방송으로 돌아오기 전에도 2단계(모델 한 줄 + 강도 트랙)가 그 모델로 선다. 값이 돌아오거나 메뉴가 닫히면 거둔다.
  const [picked, setPicked] = useState<{ readonly model: string; readonly effort?: string } | null>(null);
  // 라우팅·지휘관과 같게를 골랐으면 모델 행은 선택이 아니다 — 모델이 비어 기본(Opus)으로 읽힌 행이 함께 체크되지 않게 한다.
  const activeModel = picked?.model ?? (extras?.some((extra) => extra.active) ? null : currentModel);
  const currentEffort = picked ? picked.effort : effort ?? (model || extras?.length ? undefined : DEFAULT_LAUNCH.effort);
  const words = launchWords(rows, model, effort, t("objectives.commander.effortAuto"));
  const [open, setOpen] = useState(false);
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  // commitOnClose — 아직 알리지 않은 마지막 선택. 메뉴가 닫히는 순간(바깥 누름·Esc·Tab·고른 노브 다시 누름 모두) 지금 값과 다르면 한 번 알린다.
  const pending = useRef<{ readonly model?: string; readonly effort?: string } | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const last = pending.current;
    pending.current = null;
    if (!last || locked || (last.model === model && (last.effort ?? "") === (effort ?? ""))) return;
    onChange(last);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 닫히는 순간 한 번만 — 그 렌더의 값으로 알린다.
  const choose = (next: { readonly model?: string; readonly effort?: string }) => { if (commitOnClose) pending.current = next; else onChange(next); };
  useEffect(() => { setPicked(null); }, [model, effort, open]);
  // 2단계 — 고른 모델 한 줄과 강도 트랙. 메뉴는 여기서 열리고, 모델명을 누르면 목록(1단계)으로 간다.
  const [focused, setFocused] = useState(!startAtList);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusIntent = useRef<"first" | "last" | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const menuWidth = subagents ? 232 : MENU_WIDTH;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - menuWidth - MENU_MARGIN));
    const below = rect.bottom + 6;
    const height = menuRef.current?.offsetHeight ?? 320;
    const top = below + height > window.innerHeight - MENU_MARGIN ? Math.max(MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: menuWidth });
  }, [open, groups.length, currentModel, focused, menuWidth, subagents?.allowed]);

  useLayoutEffect(() => {
    if (!open || !focusIntent.current || !menuRef.current) return;
    const items = menuItems(menuRef.current);
    const target = focusIntent.current === "last" ? items.at(-1) : items[0];
    focusIntent.current = null;
    target?.focus();
  }, [open, focused, groups.length, subagents?.allowed]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); return; }
      if (!subagents || !menuRef.current || !(event.target instanceof Node) || !menuRef.current.contains(event.target)) return;
      // 캔버스가 window keydown에서 Space를 삼켜 button의 keyup 클릭이 사라진다. 체크만 여기서 한 번 토글하고, Enter의 기본 클릭은 그대로 둔다.
      if (!event.repeat && (event.key === " " || event.code === "Space") && event.target instanceof Element && event.target.closest("[role='menuitemcheckbox']")) {
        event.preventDefault();
        event.stopPropagation();
        subagents.onToggle();
        return;
      }
      const items = menuItems(menuRef.current);
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
      else if (event.key === "Tab" && (event.shiftKey ? index === 0 : index === items.length - 1)) {
        // 메뉴 밖으로 나가는 Tab — 닫고 트리거에 초점을 돌려, 브라우저가 트리거 다음(또는 이전)으로 가게 한다.
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open, subagents]);

  const chosenProvider = groups.find((group) => group.rows.some((row) => row.launch.model === currentModel))?.provider ?? launchProviderFromModelId(currentModel);
  const text = (
    <>
      {viewMode ? <><span className="objectives-launch-view"><StartViewGlyph view={viewMode} /><span className="objectives-launch-view-word">{startViewLabel(t, viewMode)}</span></span><span className="objectives-launch-separator" aria-hidden="true" /></> : null}
      {chosenProvider ? <span className={`operation-launch-provider-glyph objectives-launch-provider is-${chosenProvider}`} aria-hidden="true">{launchProviderGlyph(chosenProvider)}</span> : null}
      <span className="objectives-launch-model">{words.model}</span>
      <span className="objectives-launch-dot" aria-hidden="true">·</span>
      <span className="objectives-launch-effort">{words.effort}</span>
    </>
  );
  // 좁은 칸에서 줄임표로 접힌 모델 이름의 풀네임 — 호출부가 따로 주지 않으면 이 컨트롤이 그리는 낱말에서 만든다.
  const title = triggerTitle ?? (triggerText ? undefined : `${modelFullName(rows, currentModel) || words.model} · ${words.effort}`);
  if (locked) return trigger ? null : <span className="objectives-launch is-locked" title={title ? `${title}\n${t("objectives.commander.locked")}` : t("objectives.commander.locked")}>{triggerText ?? text}</span>;

  const chosenRow = activeModel ? rows.find((row) => row.launch.model === activeModel) ?? null : null;
  const providerOf = (row: OperationLaunchVariantRow) => groups.find((group) => group.rows.includes(row))?.provider ?? null;

  return (
    <>
      <button ref={triggerRef} type="button" className={`objectives-launch${trigger ? " is-glyph objectives-glyph" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={triggerLabel ?? t("objectives.launch.menuAria")} title={trigger ? triggerLabel : title} onKeyDown={subagents ? (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        focusIntent.current = event.key === "ArrowUp" ? "last" : "first";
        setFocused(!startAtList);
        setOpen(true);
      } : undefined} onClick={(event) => { setFocused(!startAtList); setOpen((value) => { const next = !value; if (next && subagents && event.detail === 0) focusIntent.current = "first"; return next; }); }}>
        {trigger ?? triggerText ?? text}
      </button>
      {/* body 포털 — 확대 표면은 transform 조상이라 fixed 가 그 안에 갇히고 overflow 에 잘린다(캔버스 메뉴와 같은 이유). */}
      {open ? createPortal(
        <div ref={menuRef} className={`objectives-menu${focused ? " is-focused" : ""}`} role="menu" aria-label={triggerLabel ?? t("objectives.launch.menuAria")} style={pos}>
          {head ? <div className="objectives-menu-head">{head}</div> : null}
          {focused && chosenRow ? (
            <>
              <button type="button" role="menuitem" className="objectives-menu-item objectives-menu-back" onClick={() => setFocused(false)} aria-label={t("objectives.launch.backToModels")}>
                <span className="objectives-menu-chev" aria-hidden="true"><Chevron back /></span>
                {providerOf(chosenRow) ? <span className={`operation-launch-provider-glyph objectives-menu-provider is-${providerOf(chosenRow)}`} aria-hidden="true">{launchProviderGlyph(providerOf(chosenRow)!)}</span> : null}
                <span className="objectives-menu-label objectives-menu-back-label">{chosenRow.label}</span>
                {/* 강도 낱말은 모델 이름 오른쪽 — 한 줄이 「무엇을 · 얼마나」를 다 말한다. 트랙은 그 아래 한 줄. */}
                <span className="objectives-menu-effort-word">{chosenRow.chips?.find((chip) => chip.launch.effort === resolveRowEffort(chosenRow, currentEffort ?? null))?.label ?? t("objectives.commander.effortAuto")}</span>
              </button>
              {/* 게이트는 고정 개방 — MAX·ULTRACODE 까지 한 축에 펼쳐지고(펼친 폭 유지·apex 모션 유지) 접기/펼치기가 없다. */}
              <div className="objectives-menu-track">
                <EffortTrack
                  row={chosenRow}
                  apexPinnedOpen
                  value={resolveRowEffort(chosenRow, currentEffort ?? null)}
                  onChange={(next) => { if (chosenRow.launch.model) setPicked({ model: chosenRow.launch.model, ...(next ? { effort: next } : {}) }); choose({ model: chosenRow.launch.model, effort: next ?? undefined }); }}
                  // 값은 이미 골랐다 — 고른 노브를 한 번 더 누르거나 Enter 는 「이걸로」라는 뜻이라 메뉴만 닫는다(commitOnClose 면 닫힐 때 알린다).
                  onConfirmCurrent={() => { setOpen(false); triggerRef.current?.focus(); }}
                  autoLabel={t("objectives.commander.effortAuto")}
                  autoValueText={t("objectives.commander.effortAuto")}
                  ariaLabel={t("objectives.commander.effortAria")}
                />
              </div>
            </>
          ) : (
            <>
              {extras?.length ? (
                <div className="objectives-menu-group">
                  {extras.map((extra) => (
                    <button key={extra.id} type="button" role="menuitemradio" aria-checked={extra.active} disabled={extra.disabled} className={`objectives-menu-item objectives-menu-extra${extra.active ? " is-active" : ""}`} onClick={() => { pending.current = null; extra.onPick(); setOpen(false); }}>
                      <span className="objectives-menu-label">{extra.label}{extra.hint ? <span className="objectives-menu-hint">{extra.hint}</span> : null}</span>
                      {extra.active ? <span className="objectives-menu-chev" aria-hidden="true"><Chevron /></span> : null}
                    </button>
                  ))}
                  {extrasCaption ? <p className="objectives-menu-caption objectives-menu-note">{extrasCaption}</p> : null}
                  <div className="objectives-menu-divider" role="separator" />
                </div>
              ) : null}
              {groups.map((group, index) => (
                <div key={group.provider ?? `etc-${index}`} className="objectives-menu-group">
                  {index > 0 ? <div className="objectives-menu-divider" role="separator" /> : null}
                  <p className={`operation-launch-variant-caption objectives-menu-caption${group.provider ? ` is-${group.provider}` : ""}`}>
                    {group.provider ? <span className="operation-launch-provider-glyph" aria-hidden="true">{launchProviderGlyph(group.provider)}</span> : null}
                    <span>{group.caption}</span>
                  </p>
                  {group.rows.map((row) => {
                    const active = row.launch.model === activeModel;
                    return (
                      <button key={row.id} type="button" role="menuitemradio" aria-checked={active} className={`objectives-menu-item${active ? " is-active" : ""}`}
                        onClick={() => { const chosenEffort = resolveRowEffort(row, currentEffort ?? null) ?? undefined; if (row.launch.model) setPicked({ model: row.launch.model, ...(chosenEffort ? { effort: chosenEffort } : {}) }); choose({ model: row.launch.model, effort: chosenEffort }); setFocused(true); }}>
                        <span className="objectives-menu-label">{row.label}</span>
                        {active ? <span className="objectives-menu-chev" aria-hidden="true"><Chevron /></span> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groups.length === 0 ? <div className="objectives-menu-empty">{t("objectives.launch.loading")}</div> : null}
            </>
          )}
          {viewMode && onViewChange ? <div className="objectives-menu-group">
            <div className="objectives-menu-divider" role="separator" />
            <p className="objectives-menu-caption">{t("objectives.view.label")}</p>
            {(["terminal", "chat"] as const).map((view) => <button key={view} type="button" role="menuitemradio" aria-checked={viewMode === view} className={`objectives-menu-item${viewMode === view ? " is-active" : ""}`} onClick={() => onViewChange(view)}><span className="objectives-launch-view"><StartViewGlyph view={view} /></span><span className="objectives-menu-label">{startViewLabel(t, view)}</span></button>)}
          </div> : null}
          {subagents ? <div className="objectives-menu-group" role="group" aria-label={t("objectives.members.subagentsGroup")}>
            <div className="objectives-menu-divider" role="separator" />
            <button type="button" role="menuitemcheckbox" aria-checked={subagents.allowed} className={`objectives-menu-item objectives-menu-check${subagents.allowed ? " is-active" : ""}`} onClick={() => subagents.onToggle()}>
              <span className="objectives-menu-box" aria-hidden="true" />
              <span className="objectives-menu-check-copy">
                <span className="objectives-menu-label">{t("objectives.members.subagents")}</span>
                <span className="objectives-menu-hint">{t("objectives.members.subagentsHint")}</span>
              </span>
            </button>
          </div> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
