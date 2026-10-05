import * as React from "react";
import { createPortal } from "react-dom";

import type { OperationLaunchVariantRow } from "../operations/types.js";
import { canonicalModelId, findRosterRow, resolveRosterCoordinate, type ModelRoster } from "../models/index.js";
import { useMobileSettingsHost, MobileSettingsRowLabelContext, type MobileCoordinateChoiceProps } from "../react/browser.js";
import { EffortTrack, resolveRowEffort } from "./effort-track.js";
import {
  launchProviderCaption,
  launchProviderFromGroupId,
  launchProviderFromModelId,
  launchProviderGlyph,
  type LaunchProviderGlyphId,
} from "./launch-provider-glyphs.js";

/**
 * 모델·강도 좌표 하나를 고르는 Console의 단일 선택기.
 *
 * 원천은 모델 로스터(`ctx.models.read(target)`) 하나다. 트리거는 「[공급자 글리프] 모델 · 강도」 한 줄이고, 누르면
 * 맵 우클릭 메뉴와 같은 문법의 메뉴가 선다: 공급자 띠 아래 모델 행 → 행을 고르면 그 모델 한 줄과 강도 트랙만 남는
 * 2단계(모델 이름을 다시 누르면 목록). 강도 트랙은 행이 내놓는 사다리 전체를 게이트 없이 펼친다.
 *
 * 저장값이 로스터 밖이면(Gateway에서 끈 모델) 그 id를 「꺼짐」 띠에 세우고 트리거에 `labels.off` 표식을 단다 —
 * 값을 지우거나 첫 행으로 바꿔 보이면 다음 저장이 사용자의 선택을 조용히 덮는다. 로스터가 비고 값도 없으면
 * 실행이 서는 최후 폴백 좌표를 `labels.fallback` 표식과 함께 보인다.
 *
 * 메시지 카탈로그를 갖지 않는다 — 문구는 호출부가 현지화해 `labels`로 넘긴다. 모양은 호스트 CSS(`fc-coord-*`)가 진다.
 */

export interface ModelCoordinateValue {
  readonly model?: string;
  readonly effort?: string;
}

export interface ModelCoordinatePickerExtra {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onPick: () => void;
}

export interface ModelCoordinatePickerLabels {
  /** 메뉴·트리거의 접근 이름. */
  readonly menu: string;
  /** 강도 트랙의 접근 이름. */
  readonly effort: string;
  /** 강도가 정해지지 않았을 때의 낱말(「자동」). */
  readonly auto: string;
  /** 2단계에서 목록으로 돌아가는 행의 접근 이름. */
  readonly back: string;
  readonly loading: string;
  /** 로스터가 비었을 때 메뉴에 서는 안내. */
  readonly empty?: string;
  /** 로스터 밖 저장값의 표식과 띠 머리(「꺼짐」). */
  readonly off?: string;
  /** 로스터가 비어 최후 폴백으로 설 때의 표식(「폴백」). */
  readonly fallback?: string;
  /** 잠긴 트리거의 툴팁 둘째 줄. */
  readonly locked?: string;
}

export interface ModelCoordinatePickerProps {
  /** 로스터. `null`은 아직 읽는 중이다. */
  readonly roster: ModelRoster | null;
  readonly value: ModelCoordinateValue;
  readonly onChange: (next: { readonly model?: string; readonly effort?: string }) => void;
  /** 값이 비었을 때 서는 좌표 — 표시에만 쓰고 저장하지 않는다. */
  readonly fallback?: ModelCoordinateValue;
  /** `track`: 행의 사다리 전체(EffortTrack). `none`: 모델만 고른다(행을 고르면 곧 닫힌다). */
  readonly effort?: "track" | "none";
  /**
   * @deprecated 확정 방식은 하나다 — 강도를 누르면(또는 Enter) 한 번 알리고 닫는다. 이 값은 받기만 하고 쓰지 않는다.
   * Fleet 1.215.0에서 제거한다.
   */
  readonly commit?: "immediate" | "on-close";
  /** 열 때 목록부터(`list`) 또는 고른 모델의 강도 단계부터(`focused`). */
  readonly startAt?: "list" | "focused";
  readonly locked?: boolean;
  readonly disabled?: boolean;
  readonly labels: ModelCoordinatePickerLabels;
  readonly trigger?: {
    /** `inline`: 글자 한 줄. `field`: 설정 행의 선택 상자. `glyph`: `node` 하나. */
    readonly variant?: "inline" | "field" | "glyph";
    readonly node?: React.ReactNode;
    /** 모델 좌표가 아닌 표시 낱말(예: 「라우팅」). */
    readonly text?: React.ReactNode;
    readonly title?: string;
    /** 트리거 앞에 덧붙는 표시(예: 시작 뷰). */
    readonly prefix?: React.ReactNode;
    readonly className?: string;
  };
  /** 메뉴 맨 위 한 줄. */
  readonly head?: React.ReactNode;
  /** 모델 행 위의 선택 방식. 하나라도 active 면 모델 행은 선택으로 서지 않는다. 고르면 메뉴가 닫힌다. */
  readonly extras?: readonly ModelCoordinatePickerExtra[];
  readonly extrasCaption?: string;
  /** 메뉴 맨 아래 슬롯. 안의 `role=menuitem*` 버튼은 메뉴의 키보드 순회에 합류한다. */
  readonly footer?: React.ReactNode;
  /** 「기본값 사용」 — 값이 바뀐 상태일 때만 넘긴다. 고르면 메뉴가 닫힌다. */
  readonly reset?: { readonly label: string; readonly description?: string; readonly onSelect: () => void };
  /** 메뉴 폭(px). */
  readonly menuWidth?: number;
  readonly menuClassName?: string;
}

export type { MobileCoordinateChoiceProps as ModelCoordinateMobileProps } from "../react/browser.js";

const MENU_WIDTH = 216;
const MENU_MARGIN = 12;
const OFF_GROUP_ID = "off";

const menuItems = (root: HTMLElement): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled)')];

const Chevron = ({ back }: { readonly back?: boolean }) => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {back ? <path d="M7.5 2.5L4 6l3.5 3.5" /> : <path d="M4.5 2.5L8 6l-3.5 3.5" />}
  </svg>
);

/** 로스터 밖 id의 읽을 수 있는 이름 — 접두와 공급자 칸을 벗긴 뒤 다듬는다. */
export function prettyModelId(model: string): string {
  const id = canonicalModelId(model);
  const bare = id.includes("--") ? id.slice(id.lastIndexOf("--") + 2) : id;
  return bare.replace(/\[1m\]$/u, "-1M").split(/[-_]+/u).filter(Boolean)
    .map((token) => (/^(gpt|o\d|glm|qwen)/iu.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1))).join(" ");
}

/** 모델 id의 공급자 — 로스터에 있으면 그 띠, 없으면 id에서 읽는다. */
export function rosterProviderOf(roster: ModelRoster | null, model: string | undefined): LaunchProviderGlyphId | null {
  if (!model) return null;
  const row = findRosterRow(roster, model);
  const group = row ? roster?.find((candidate) => candidate.rows.includes(row)) : undefined;
  return (group ? launchProviderFromGroupId(group.id) : null) ?? launchProviderFromModelId(canonicalModelId(model));
}

/** 「Opus」·「HIGH」 — 트리거와 메뉴가 같은 낱말을 쓴다. 로스터에 없는 모델은 id를 다듬어 쓴다. */
export function rosterCoordinateWords(roster: ModelRoster | null, value: ModelCoordinateValue, autoLabel: string): { readonly model: string; readonly effort: string } {
  const row = value.model ? findRosterRow(roster, value.model) : null;
  const chip = row?.chips?.find((candidate) => candidate.id === value.effort);
  return {
    model: row?.label ?? (value.model ? prettyModelId(value.model) : ""),
    effort: chip?.label ?? (value.effort && value.effort !== "auto" ? value.effort.toUpperCase() : autoLabel),
  };
}

function ProviderMark({ provider, className }: { readonly provider: LaunchProviderGlyphId | null; readonly className: string }) {
  if (!provider) return null;
  return <span className={`operation-launch-provider-glyph ${className} is-${provider}`} aria-hidden="true">{launchProviderGlyph(provider)}</span>;
}

export function ModelCoordinatePicker(props: ModelCoordinatePickerProps): React.ReactElement | null {
  const mobileHost = useMobileSettingsHost();
  if (mobileHost?.CoordinateChoice && !props.trigger?.node) return <MobileCoordinateTrigger {...props} Sheet={mobileHost.CoordinateChoice} />;
  return <DesktopCoordinatePicker {...props} />;
}

interface DisplayState {
  readonly shown: ModelCoordinateValue;
  readonly words: { readonly model: string; readonly effort: string };
  readonly provider: LaunchProviderGlyphId | null;
  readonly badge: string | null;
  readonly off: boolean;
  /** 트리거가 꺼진 저장값 자체를 말하고 있는지(취소선). 로스터가 비어 폴백 좌표를 보일 때는 아니다. */
  readonly struck: boolean;
}

/**
 * 트리거가 말할 좌표와 표식. 값이 있으면 그 값(로스터 밖이면 「꺼짐」 — 다시 켜면 그대로 돌아온다), 없으면 기본 좌표.
 * 로스터가 비면 실행이 서는 최후 폴백 좌표를 「폴백」 표식과 함께 보인다(저장값은 메뉴의 꺼짐 띠에 남는다).
 */
function useDisplay(props: ModelCoordinatePickerProps): DisplayState {
  const { roster, value, fallback, labels } = props;
  const stored = value.model ? value : null;
  const off = Boolean(stored?.model) && roster !== null && !findRosterRow(roster, stored!.model);
  let shown: ModelCoordinateValue = stored ?? { model: fallback?.model, effort: value.effort ?? fallback?.effort };
  let badge: string | null = off ? labels.off ?? null : null;
  if (roster !== null && (!stored || roster.length === 0)) {
    const resolved = resolveRosterCoordinate(roster, stored ? { effort: stored.effort } : {}, { model: fallback?.model, effort: value.effort ?? fallback?.effort });
    shown = { model: resolved.model, ...(resolved.effort ? { effort: resolved.effort } : {}) };
    if (resolved.reason === "roster_empty") badge = labels.fallback ?? null;
  }
  return {
    shown,
    words: rosterCoordinateWords(roster, shown, labels.auto),
    provider: rosterProviderOf(roster, shown.model),
    badge,
    off,
    struck: off && shown === stored,
  };
}

function TriggerText({ display, prefix }: { readonly display: DisplayState; readonly prefix?: React.ReactNode }) {
  return (
    <>
      {prefix}
      <ProviderMark provider={display.provider} className="fc-coord-trigger-provider" />
      <span className={`fc-coord-trigger-model${display.struck ? " is-off" : ""}`}>{display.words.model}</span>
      <span className="fc-coord-trigger-dot" aria-hidden="true">·</span>
      <span className="fc-coord-trigger-effort">{display.words.effort}</span>
      {display.badge ? <span className={`fc-coord-trigger-badge${display.struck ? " is-off" : ""}`}>{display.badge}</span> : null}
    </>
  );
}

function DesktopCoordinatePicker(props: ModelCoordinatePickerProps): React.ReactElement | null {
  const { roster, value, onChange, labels, trigger, head, extras, extrasCaption, footer, reset, locked = false, disabled = false } = props;
  const effortMode = props.effort ?? "track";
  const startAtList = props.startAt === "list";
  const display = useDisplay(props);
  const groups = React.useMemo(() => {
    const listed = roster ?? [];
    if (!display.off || !value.model) return listed;
    // 꺼진 저장값은 「꺼짐」 띠에 그대로 세운다 — 사라지면 첫 행이 골라진 것처럼 읽힌다.
    return [...listed, { id: OFF_GROUP_ID, label: labels.off ?? value.model, rows: [{ id: value.model, label: prettyModelId(value.model), launch: { model: value.model } }] }];
  }, [roster, display.off, value.model, labels.off]);
  const rows = React.useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  // 메뉴에서 방금 고른 값 — 저장이 돌아오기 전에도 2단계가 그 모델로 선다. 값이 돌아오거나 메뉴가 닫히면 거둔다.
  const [picked, setPicked] = React.useState<{ readonly model: string; readonly effort?: string } | null>(null);
  const extraActive = extras?.some((extra) => extra.active) ?? false;
  const activeModel = picked?.model ?? (extraActive ? null : display.shown.model ?? null);
  const currentEffort = picked ? picked.effort : display.shown.effort;
  const [open, setOpen] = React.useState(false);
  // 확정은 한 번이다. 모델 행은 강도 단계로 넘어가기만 하고(staged), 강도 노브에서 손을 떼거나 Enter를 치는 순간 그 좌표를
  // 한 번 알리고 닫는다. 강도를 받지 않는 행·모델만 고르는 선택기는 행이 곧 확정이다. 행만 고르고 바깥을 누르거나 Tab으로
  // 나가면 고른 모델로 한 번 확정하고, Esc는 아무것도 저장하지 않는다. 그래서 한 번의 선택은 늘 저장(세션 전환) 한 번이다.
  const staged = React.useRef<{ readonly model: string; readonly effort?: string } | null>(null);
  const notify = (next: { readonly model: string; readonly effort?: string } | null) => {
    if (!next || locked || (next.model === value.model && (next.effort ?? "") === (value.effort ?? ""))) return;
    onChange(next);
  };
  const closeMenu = (mode: "commit" | "cancel", refocus = false) => {
    const last = staged.current;
    staged.current = null;
    setOpen(false);
    if (mode === "commit") notify(last);
    if (refocus) triggerRef.current?.focus();
  };
  const settle = (next: { readonly model: string; readonly effort?: string }) => {
    staged.current = null;
    notify(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  React.useEffect(() => { if (locked || disabled) { staged.current = null; setOpen(false); } }, [locked, disabled]);
  React.useEffect(() => { setPicked(null); }, [value.model, value.effort, open]);
  const [focused, setFocused] = React.useState(!startAtList);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const focusIntent = React.useRef<"first" | "last" | null>(null);
  const [pos, setPos] = React.useState<React.CSSProperties>({});
  const menuWidth = props.menuWidth ?? MENU_WIDTH;
  // 문서 리스너는 열릴 때 한 번 붙는다 — 그 뒤 렌더의 값(value·staged)으로 닫도록 최신 닫기 함수를 ref로 읽는다.
  const closeMenuRef = React.useRef(closeMenu);
  closeMenuRef.current = closeMenu;

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - menuWidth - MENU_MARGIN));
    const below = rect.bottom + 6;
    const height = menuRef.current?.offsetHeight ?? 320;
    const top = below + height > window.innerHeight - MENU_MARGIN ? Math.max(MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: menuWidth });
  }, [open, groups.length, activeModel, focused, menuWidth, footer]);

  React.useLayoutEffect(() => {
    if (!open || !focusIntent.current || !menuRef.current) return;
    const items = menuItems(menuRef.current);
    const target = focusIntent.current === "last" ? items.at(-1) : items[0];
    focusIntent.current = null;
    target?.focus();
  }, [open, focused, groups.length]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeMenuRef.current("commit");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenuRef.current("cancel", true); return; }
      if (!menuRef.current || !(event.target instanceof Node) || !menuRef.current.contains(event.target)) return;
      // 캔버스가 window keydown에서 Space를 삼켜 button의 keyup 클릭이 사라진다 — 체크 항목만 여기서 한 번 누른다.
      if (!event.repeat && (event.key === " " || event.code === "Space") && event.target instanceof Element) {
        const check = event.target.closest<HTMLButtonElement>("[role='menuitemcheckbox']");
        if (check) { event.preventDefault(); event.stopPropagation(); check.click(); return; }
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
        // 메뉴 밖으로 나가는 Tab — 고른 모델을 확정해 닫고 트리거로 초점을 돌려 브라우저가 그다음으로 가게 한다.
        closeMenuRef.current("commit", true);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const variant = trigger?.variant ?? (trigger?.node ? "glyph" : "inline");
  const title = trigger?.title ?? (trigger?.text ? undefined : `${display.words.model} · ${display.words.effort}${display.badge ? ` · ${display.badge}` : ""}`);
  const text = trigger?.text ?? <TriggerText display={display} prefix={trigger?.prefix} />;
  const triggerClass = ["fc-coord-trigger", `is-${variant}`, trigger?.className ?? ""].filter(Boolean).join(" ");
  if (locked) {
    if (trigger?.node) return null;
    return <span className={`${triggerClass} is-locked`} title={[title, labels.locked].filter(Boolean).join("\n") || undefined}>{text}</span>;
  }

  const chosenRow: OperationLaunchVariantRow | null = activeModel ? findRosterRow(groups, activeModel) : null;
  const providerOfRow = (row: OperationLaunchVariantRow) => {
    const group = groups.find((candidate) => candidate.rows.includes(row));
    return group && group.id !== OFF_GROUP_ID ? launchProviderFromGroupId(group.id) ?? launchProviderFromModelId(row.launch.model) : null;
  };
  const pickRow = (row: OperationLaunchVariantRow) => {
    const model = row.launch.model ?? row.id;
    // 모델만 고르는 선택기·강도를 받지 않는 행은 행이 곧 확정이다.
    if (effortMode === "none" || (row.chips?.length ?? 0) === 0) { settle({ model }); return; }
    const chosenEffort = resolveRowEffort(row, currentEffort ?? null) ?? undefined;
    const next = { model, ...(chosenEffort ? { effort: chosenEffort } : {}) };
    setPicked(next);
    staged.current = next;
    setFocused(true);
  };
  const showTrack = effortMode === "track" && focused && chosenRow !== null && (chosenRow.chips?.length ?? 0) > 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={labels.menu}
        title={trigger?.node ? labels.menu : title}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          focusIntent.current = event.key === "ArrowUp" ? "last" : "first";
          setFocused(!startAtList);
          setOpen(true);
        }}
        onClick={(event) => {
          // 열린 메뉴의 트리거를 다시 누르는 것은 바깥 누름과 같다 — 고른 모델이 있으면 한 번 확정하고 닫는다.
          if (open) { closeMenu("commit"); return; }
          setFocused(!startAtList);
          if (event.detail === 0) focusIntent.current = "first";
          setOpen(true);
        }}
      >
        {trigger?.node ?? text}
      </button>
      {/* body 포털 — 확대 표면은 transform 조상이라 fixed가 그 안에 갇히고 overflow에 잘린다. */}
      {open ? createPortal(
        <div ref={menuRef} className={["fc-coord-menu", showTrack ? "is-focused" : "", props.menuClassName ?? ""].filter(Boolean).join(" ")} role="menu" aria-label={labels.menu} style={pos}>
          {head ? <div className="fc-coord-menu-head">{head}</div> : null}
          {showTrack && chosenRow ? (
            <>
              <button type="button" role="menuitem" className="fc-coord-menu-item fc-coord-menu-back" onClick={() => setFocused(false)} aria-label={labels.back}>
                <span className="fc-coord-menu-chev" aria-hidden="true"><Chevron back /></span>
                <ProviderMark provider={providerOfRow(chosenRow)} className="fc-coord-menu-provider" />
                <span className="fc-coord-menu-label fc-coord-menu-back-label">{chosenRow.label}</span>
                <span className="fc-coord-menu-effort-word">{chosenRow.chips?.find((chip) => chip.launch.effort === resolveRowEffort(chosenRow, currentEffort ?? null))?.label ?? labels.auto}</span>
              </button>
              {/* 게이트는 고정 개방 — 행이 내놓는 사다리 전체가 한 축에 펼쳐진다. */}
              <div className="fc-coord-menu-track">
                <EffortTrack
                  row={chosenRow}
                  apexPinnedOpen
                  value={resolveRowEffort(chosenRow, currentEffort ?? null)}
                  // 끄는 동안·방향키는 미리보기다. 손을 떼거나 Enter를 치면 그 강도로 한 번 확정하고 닫는다.
                  onChange={(next) => {
                    const model = chosenRow.launch.model ?? chosenRow.id;
                    const preview = { model, ...(next ? { effort: next } : {}) };
                    setPicked(preview);
                    staged.current = preview;
                  }}
                  onSettle={(next) => settle({ model: chosenRow.launch.model ?? chosenRow.id, ...(next ? { effort: next } : {}) })}
                  autoLabel={labels.auto}
                  autoValueText={labels.auto}
                  ariaLabel={labels.effort}
                />
              </div>
            </>
          ) : (
            <>
              {extras?.length ? (
                <div className="fc-coord-menu-group">
                  {extras.map((extra) => (
                    <button key={extra.id} type="button" role="menuitemradio" aria-checked={extra.active} disabled={extra.disabled} className={`fc-coord-menu-item fc-coord-menu-extra${extra.active ? " is-active" : ""}`} onClick={() => { staged.current = null; extra.onPick(); setOpen(false); }}>
                      <span className="fc-coord-menu-label">{extra.label}{extra.hint ? <span className="fc-coord-menu-hint">{extra.hint}</span> : null}</span>
                      {extra.active ? <span className="fc-coord-menu-chev" aria-hidden="true"><Chevron /></span> : null}
                    </button>
                  ))}
                  {extrasCaption ? <p className="fc-coord-menu-caption fc-coord-menu-note">{extrasCaption}</p> : null}
                  <div className="fc-coord-menu-divider" role="separator" />
                </div>
              ) : null}
              {groups.map((group, index) => {
                const provider = group.id === OFF_GROUP_ID ? null : launchProviderFromGroupId(group.id);
                return (
                  <div key={group.id} className="fc-coord-menu-group">
                    {index > 0 ? <div className="fc-coord-menu-divider" role="separator" /> : null}
                    <p className={`operation-launch-variant-caption fc-coord-menu-caption${provider ? ` is-${provider}` : ""}${group.id === OFF_GROUP_ID ? " is-off" : ""}`}>
                      {provider ? <span className="operation-launch-provider-glyph" aria-hidden="true">{launchProviderGlyph(provider)}</span> : null}
                      <span>{provider ? launchProviderCaption(provider) : group.label}</span>
                    </p>
                    {group.rows.map((row) => {
                      const active = activeModel !== null && canonicalModelId(row.launch.model ?? row.id) === canonicalModelId(activeModel);
                      return (
                        <button key={row.id} type="button" role="menuitemradio" aria-checked={active} className={`fc-coord-menu-item${active ? " is-active" : ""}`} onClick={() => pickRow(row)}>
                          <span className="fc-coord-menu-label">{row.label}</span>
                          {active && effortMode === "track" ? <span className="fc-coord-menu-chev" aria-hidden="true"><Chevron /></span> : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {roster === null ? <div className="fc-coord-menu-empty">{labels.loading}</div> : null}
              {roster !== null && roster.length === 0 && labels.empty ? <div className="fc-coord-menu-empty">{labels.empty}</div> : null}
            </>
          )}
          {reset ? (
            <div className="fc-coord-menu-group">
              <div className="fc-coord-menu-divider" role="separator" />
              <button type="button" role="menuitem" className="fc-coord-menu-item fc-coord-menu-reset" onClick={() => { staged.current = null; reset.onSelect(); setOpen(false); triggerRef.current?.focus(); }}>
                <span className="fc-coord-menu-label">{reset.label}{reset.description ? <span className="fc-coord-menu-hint">{reset.description}</span> : null}</span>
              </button>
            </div>
          ) : null}
          {footer}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** 폰: 값 줄(「{모델} · {강도}」 + 표식)만 서고, 누르면 호스트의 좌표 시트가 선다. */
function MobileCoordinateTrigger(props: ModelCoordinatePickerProps & { readonly Sheet: React.ComponentType<MobileCoordinateChoiceProps> }): React.ReactElement | null {
  const { roster, value, onChange, labels, extras, reset, locked = false, disabled = false, Sheet } = props;
  const display = useDisplay(props);
  const rowLabel = React.useContext(MobileSettingsRowLabelContext);
  const [open, setOpen] = React.useState(false);
  // 데스크톱 메뉴와 같은 확정 규칙 — 시트가 「확정」으로 알린 선택(강도 탭, 강도 없는 모델)은 한 번 알리고 시트는 스스로 닫힌다.
  // 모델 탭은 강도 단계로 넘어가는 초안일 뿐이고, 그 상태로 시트를 닫으면(뒤로·바깥) 고른 모델로 한 번 확정한다.
  const draftRef = React.useRef<{ readonly model: string; readonly effort?: string } | null>(null);
  const [draft, setDraft] = React.useState<{ readonly model: string; readonly effort?: string } | null>(null);
  const keepDraft = (next: { readonly model: string; readonly effort?: string } | null) => { draftRef.current = next; setDraft(next); };
  const notify = (next: { readonly model: string; readonly effort?: string } | null) => {
    if (next && (next.model !== value.model || (next.effort ?? "") !== (value.effort ?? ""))) onChange(next);
  };
  const closeSheet = () => {
    setOpen(false);
    const last = draftRef.current;
    keepDraft(null);
    notify(last);
  };
  const text = props.trigger?.text ?? `${display.words.model} · ${display.words.effort}${display.badge ? ` · ${display.badge}` : ""}`;
  if (locked) return <span className="fc-select__trigger fc-select--mobile fc-coord-trigger is-locked"><span className="fc-select__value">{text}</span></span>;
  return (
    <>
      <button type="button" className={["fc-select__trigger", "fc-select--mobile", "fc-coord-trigger", "is-mobile", props.trigger?.className ?? ""].filter(Boolean).join(" ")} disabled={disabled} aria-haspopup="dialog" aria-label={labels.menu} onClick={() => setOpen(true)}>
        <span className="fc-select__value">{text}</span>
      </button>
      {open ? (
        <Sheet
          title={rowLabel ?? labels.menu}
          roster={roster ?? []}
          value={draft ?? (value.model ? value : display.shown)}
          onSelect={(next, meta) => {
            if (meta?.final) { keepDraft(null); notify(next); return; }
            keepDraft(next);
          }}
          effort={props.effort ?? "track"}
          effortLabel={labels.effort}
          {...(labels.off ? { offLabel: labels.off } : {})}
          {...(extras ? { extras: extras.map((extra) => ({ ...extra, onPick: () => { keepDraft(null); extra.onPick(); } })) } : {})}
          {...(reset ? { reset: { ...reset, onSelect: () => { keepDraft(null); reset.onSelect(); } } } : {})}
          onClose={closeSheet}
        />
      ) : null}
    </>
  );
}
