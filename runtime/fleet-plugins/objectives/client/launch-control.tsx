import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { EffortTrack, resolveRowEffort } from "@fleet-console/sdk/composer";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { Translate } from "@fleet-console/sdk/i18n";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 지휘관의 모델·강도 — 한 줄의 글("Opus · HIGH")이고, 누르면 **맵 우클릭 메뉴와 같은 문법**의 메뉴가 뜬다:
 * 공급자 띠(글리프 + 이름) 아래 모델 행(이름 · 강도 게이지 · ›). 행을 고르면 목록이 접히고 그 모델 한 줄과
 * 강도 트랙만 남는다(2단계); 모델 이름을 다시 누르면 목록으로 돌아간다. 값은 지휘관 Operation 에 산다 — 표면(CLI·채팅)은
 * 그 Operation 의 캡션이 바꾼다.
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

/** 모델 id 의 공급자 글리프 — 지휘관 컨트롤과 단계 줄이 같은 표식을 쓴다. 모르는 모델이면 아무것도 그리지 않는다. */
export function ProviderGlyph({ model }: { readonly model: string | undefined }) {
  const groups = useLaunchGroups();
  const provider = (model ? groups.find((group) => group.rows.some((row) => row.launch.model === model))?.provider : null) ?? (model ? launchProviderFromModelId(model) : null);
  if (!provider) return null;
  return <span className={`operation-launch-provider-glyph objectives-launch-provider is-${provider}`} aria-hidden="true">{launchProviderGlyph(provider)}</span>;
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
/** 라우팅이 준 "claude-gateway--codex--gpt-…" 와 카탈로그의 "codex--gpt-…" 는 같은 모델 — 어느 표기로든 행을 찾는다. */
function findLaunchRow(rows: readonly OperationLaunchVariantRow[], model: string): OperationLaunchVariantRow | undefined {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  const id = stripped.includes("--") ? stripped : stripped.replace("/", "--");
  return rows.find((candidate) => candidate.launch.model === model || candidate.launch.model === id || candidate.launch.model === stripped || candidate.launch.model === `${GATEWAY_PREFIX}${id}`);
}
/** 카탈로그에 없는 모델의 읽을 수 있는 이름 — 접두와 공급자 칸을 벗긴 뒤 다듬는다. */
function bareModelId(model: string): string {
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  return stripped.includes("--") ? stripped.slice(stripped.lastIndexOf("--") + 2) : stripped.includes("/") ? stripped.slice(stripped.lastIndexOf("/") + 1) : stripped;
}
/** "Codex GPT-5.3 Codex" / "Claude Opus" — 단계 아래 dim 줄의 풀네임. 게이트웨이 접두는 벗기고, 카탈로그 행이 있으면 그 이름, 없으면 id 를 읽을 수 있게 다듬는다. */
export function modelFullName(rows: readonly OperationLaunchVariantRow[], model: string | undefined | null): string {
  if (!model || model === "default") return "";
  const stripped = model.startsWith(GATEWAY_PREFIX) ? model.slice(GATEWAY_PREFIX.length) : model;
  // 라우팅은 "codex/gpt-…", 카탈로그는 "codex--gpt-…" — 같은 모델의 두 표기.
  const id = stripped.includes("--") ? stripped : stripped.replace("/", "--");
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

interface LaunchControlProps {
  readonly t: Translate<ObjectiveMessageKey>;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly locked: boolean;
  readonly onChange: (next: { model?: string; effort?: string }) => void;
  /** 트리거를 글리프 하나로 — 모델 낱말을 쓸 자리가 없을 때. */
  readonly trigger?: ReactNode;
  readonly triggerLabel?: string;
  /** 라우팅·지휘관과 같게처럼 모델 id가 아닌 선택 방식의 표시 낱말. */
  readonly triggerText?: ReactNode;
  /** 모델 목록 위에 서는 선택 방식(라우팅 · 지휘관과 같게). 고르면 메뉴가 닫힌다. */
  readonly extras?: readonly { readonly id: string; readonly label: string; readonly hint?: string; readonly active: boolean; readonly onPick: () => void }[];
  /** 열 때 모델 목록(1단계)부터 — 배정 메뉴는 특별 항목을 먼저 보여야 한다. */
  readonly startAtList?: boolean;
}

const MENU_WIDTH = 216;
const MENU_MARGIN = 12;

export function LaunchControl({ t, model, effort, locked, onChange, trigger, triggerLabel, triggerText, extras, startAtList = false }: LaunchControlProps) {
  const groups = useLaunchGroups();
  const rows = groups.flatMap((group) => group.rows);
  const currentModel = model ?? DEFAULT_LAUNCH.model;
  const currentEffort = effort ?? (model || extras?.length ? undefined : DEFAULT_LAUNCH.effort);
  const words = launchWords(rows, model, effort, t("objectives.coordinator.effortAuto"));
  const [open, setOpen] = useState(false);
  // 2단계 — 고른 모델 한 줄과 강도 트랙. 메뉴는 여기서 열리고, 모델명을 누르면 목록(1단계)으로 간다.
  const [focused, setFocused] = useState(!startAtList);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_MARGIN));
    const below = rect.bottom + 6;
    const height = menuRef.current?.offsetHeight ?? 320;
    const top = below + height > window.innerHeight - MENU_MARGIN ? Math.max(MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: MENU_WIDTH });
  }, [open, groups.length, currentModel, focused]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const chosenProvider = groups.find((group) => group.rows.some((row) => row.launch.model === currentModel))?.provider ?? launchProviderFromModelId(currentModel);
  const text = (
    <>
      {chosenProvider ? <span className={`operation-launch-provider-glyph objectives-launch-provider is-${chosenProvider}`} aria-hidden="true">{launchProviderGlyph(chosenProvider)}</span> : null}
      <span className="objectives-launch-model">{words.model}</span>
      <span className="objectives-launch-dot" aria-hidden="true">·</span>
      <span className="objectives-launch-effort">{words.effort}</span>
    </>
  );
  if (locked) return trigger ? null : <span className="objectives-launch is-locked" title={t("objectives.coordinator.locked")}>{triggerText ?? text}</span>;

  const chosenRow = rows.find((row) => row.launch.model === currentModel) ?? null;
  const providerOf = (row: OperationLaunchVariantRow) => groups.find((group) => group.rows.includes(row))?.provider ?? null;

  return (
    <>
      <button ref={triggerRef} type="button" className={`objectives-launch${trigger ? " is-glyph objectives-glyph" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={triggerLabel ?? t("objectives.launch.menuAria")} title={trigger ? triggerLabel : undefined} onClick={() => { setFocused(!startAtList); setOpen((value) => !value); }}>
        {trigger ?? triggerText ?? text}
      </button>
      {/* body 포털 — 확대 표면은 transform 조상이라 fixed 가 그 안에 갇히고 overflow 에 잘린다(캔버스 메뉴와 같은 이유). */}
      {open ? createPortal(
        <div ref={menuRef} className={`objectives-menu${focused ? " is-focused" : ""}`} role="menu" aria-label={t("objectives.launch.menuAria")} style={pos}>
          {focused && chosenRow ? (
            <>
              <button type="button" className="objectives-menu-item objectives-menu-back" onClick={() => setFocused(false)} aria-label={t("objectives.launch.backToModels")}>
                <span className="objectives-menu-chev" aria-hidden="true"><Chevron back /></span>
                {providerOf(chosenRow) ? <span className={`operation-launch-provider-glyph objectives-menu-provider is-${providerOf(chosenRow)}`} aria-hidden="true">{launchProviderGlyph(providerOf(chosenRow)!)}</span> : null}
                <span className="objectives-menu-label objectives-menu-back-label">{chosenRow.label}</span>
                {/* 강도 낱말은 모델 이름 오른쪽 — 한 줄이 「무엇을 · 얼마나」를 다 말한다. 트랙은 그 아래 한 줄. */}
                <span className="objectives-menu-effort-word">{chosenRow.chips?.find((chip) => chip.launch.effort === resolveRowEffort(chosenRow, currentEffort ?? null))?.label ?? t("objectives.coordinator.effortAuto")}</span>
              </button>
              {/* 게이트는 고정 개방 — MAX·ULTRACODE 까지 한 축에 펼쳐지고(펼친 폭 유지·apex 모션 유지) 접기/펼치기가 없다. */}
              <div className="objectives-menu-track">
                <EffortTrack
                  row={chosenRow}
                  apexPinnedOpen
                  value={resolveRowEffort(chosenRow, currentEffort ?? null)}
                  onChange={(next) => onChange({ model: chosenRow.launch.model, effort: next ?? undefined })}
                  autoLabel={t("objectives.coordinator.effortAuto")}
                  autoValueText={t("objectives.coordinator.effortAuto")}
                  ariaLabel={t("objectives.coordinator.effortAria")}
                />
              </div>
            </>
          ) : (
            <>
              {extras?.length ? (
                <div className="objectives-menu-group">
                  {extras.map((extra) => (
                    <button key={extra.id} type="button" role="menuitemradio" aria-checked={extra.active} className={`objectives-menu-item objectives-menu-extra${extra.active ? " is-active" : ""}`} onClick={() => { extra.onPick(); setOpen(false); }}>
                      <span className="objectives-menu-label">{extra.label}{extra.hint ? <span className="objectives-menu-hint">{extra.hint}</span> : null}</span>
                      {extra.active ? <span className="objectives-menu-chev" aria-hidden="true"><Chevron /></span> : null}
                    </button>
                  ))}
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
                    const active = row.launch.model === currentModel;
                    return (
                      <button key={row.id} type="button" role="menuitemradio" aria-checked={active} className={`objectives-menu-item${active ? " is-active" : ""}`}
                        onClick={() => { onChange({ model: row.launch.model, effort: resolveRowEffort(row, currentEffort ?? null) ?? undefined }); setFocused(true); }}>
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
        </div>,
        document.body,
      ) : null}
    </>
  );
}
