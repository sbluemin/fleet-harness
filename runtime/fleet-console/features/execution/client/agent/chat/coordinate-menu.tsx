import { isRosterFallbackGroup, RosterFallbackNotice } from "../../../../ai-gateway/client/roster-fallback.js";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog, OPERATION_CATALOG_CHANGED_EVENT } from "@fleet-console/sdk/operations/browser";
import {
  launchProviderCaption,
  launchProviderFromGroupId,
  launchProviderFromModelId,
  launchProviderGlyph,
  type LaunchProviderGlyphId,
} from "@fleet-console/sdk/components/launch-provider-glyphs";

import { EffortTrack, resolveRowEffort } from "../../components/effort-track.js";
import { cancelAgentChatCoordinates, changeAgentChatCoordinates } from "../api.js";
import { getT } from "../i18n/index.js";
import { useMobileSurface } from "../mobile-surface.js";
import type { AgentChatCoordinatePair } from "./chat-events.js";
import { MobileCoordinateSheet } from "./mobile-coordinate-sheet.js";
import { readAgentChatSessionCoordinates, type AgentChatSessionCoordinates } from "./session-coordinates.js";

/** `/model`은 모델 목록부터, `/effort`와 좌표 클릭은 지금 모델의 강도 트랙부터 연다. */
export type CoordinateMenuStage = "models" | "effort";

export interface CoordinateMenuOpenRequest {
  /** 값이 바뀐 사실만 뜻이 있다 — 같은 단계를 두 번 열어 달라는 요청도 새 요청이다. */
  readonly seq: number;
  readonly stage: CoordinateMenuStage;
}

interface LaunchGroup {
  readonly id: string;
  readonly provider: LaunchProviderGlyphId | null;
  readonly caption: string;
  readonly rows: readonly OperationLaunchVariantRow[];
}

const MENU_WIDTH = 216;
const MENU_MARGIN = 12;
const menuItems = (root: HTMLElement): HTMLButtonElement[] =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]')];

const Chevron = ({ back }: { readonly back?: boolean }) => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {back ? <path d="M7.5 2.5L4 6l3.5 3.5" /> : <path d="M4.5 2.5L8 6l-3.5 3.5" />}
  </svg>
);

/**
 * 컴포저 표시줄의 좌표 — 이 세션이 지금 도는 모델·강도이자, 그것을 바꾸는 문이다.
 *
 * 메뉴는 Objectives 지휘관·구성원의 모델·강도 메뉴와 같은 문법이다: 열면 지금 모델 한 줄(‹ 글리프 이름 강도)과
 * 늘 펼친 강도 트랙이 서고(2단계), 모델 이름을 누르면 공급자 띠 아래 모델 행 목록(1단계)으로 간다. 행을 고르면
 * 곧바로 적용하고 다시 그 모델의 트랙으로 돌아온다. 같은 세션의 모델을 두 표면이 다른 문법으로 고르게 하지 않는다.
 *
 * 표시는 payload의 좌표다. 서버는 자식에 적용한 뒤에만 payload를 고치므로, 이 글자는 여전히 "지금 도는 것"의
 * 사실이다. 턴이 도는 동안 고른 값은 좌표를 바꾸지 않고 옆에 예약으로 선다 — 그 턴은 아직 이전 모델로 답하고
 * 있기 때문이다. 후보는 런치 메뉴와 같은 카탈로그의 행과 칩이다.
 */
export function SessionCoordinateMenu({
  operationId,
  payload,
  pending,
  occupied,
  working,
  language,
  openRequest,
  formatTokens,
  onCompact,
}: {
  readonly operationId: string;
  readonly payload: Record<string, unknown> | undefined;
  /** 턴이 닫히면 적용될 예약. 서버가 권위다. */
  readonly pending: AgentChatCoordinatePair | null;
  /** 지금 문맥 점유. 창이 작은 모델을 고를 수 있는지 가르는 근거이며, 모르면 `null`이다. */
  readonly occupied: number | null;
  readonly working: boolean;
  readonly language: "en" | "ko";
  /** `/model`·`/effort`가 이 메뉴를 열어 달라는 요청. */
  readonly openRequest: CoordinateMenuOpenRequest | null;
  readonly formatTokens: (tokens: number) => string;
  /** 문맥을 줄이는 길 — `/compact`를 보낸다. */
  readonly onCompact: () => void;
}) {
  const t = getT(language);
  // 모바일 표면에서는 같은 좌표·같은 적용 경로를 S-11b 모델 시트로 연다(데스크톱 포털 메뉴 대신).
  const mobile = useMobileSurface();
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState<CoordinateMenuStage>("effort");
  const [groups, setGroups] = React.useState<readonly LaunchGroup[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [pos, setPos] = React.useState<React.CSSProperties>({});
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const focusOnOpen = React.useRef(false);
  const seenRequest = React.useRef(openRequest?.seq ?? 0);

  const coordinates = readAgentChatSessionCoordinates(payload);
  const current = readCurrentPair(payload);
  // 체크와 트랙은 "다음 턴에 도는 것"을 가리킨다. 예약이 없으면 지금 도는 것이다.
  const target: AgentChatCoordinatePair | null = pending ?? current;

  React.useEffect(() => {
    if (!openRequest || openRequest.seq === seenRequest.current) return;
    seenRequest.current = openRequest.seq;
    focusOnOpen.current = true;
    setStage(openRequest.stage);
    setOpen(true);
  }, [openRequest]);

  // 열려 있는 동안 카탈로그가 바뀌면(이 탭의 Gateway 저장, 다른 탭·기기의 로스터 브로드캐스트) 다시 읽는다 —
  // Quick Launch·Settings·Objectives 선택기처럼 열린 채로 따라간다.
  const [catalogEpoch, setCatalogEpoch] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    const onChanged = () => setCatalogEpoch((epoch) => epoch + 1);
    window.addEventListener(OPERATION_CATALOG_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OPERATION_CATALOG_CHANGED_EVENT, onChanged);
  }, [open]);

  // 열 때마다 카탈로그를 새로 읽는다. 설정에서 모델을 켜고 끈 직후에도 목록이 실제와 어긋나지 않는다.
  React.useEffect(() => {
    if (!open) return;
    setFailed(false);
    const abort = new AbortController();
    void fetchOperationCatalog(abort.signal)
      .then((catalog) => {
        if (abort.signal.aborted) return;
        const next: LaunchGroup[] = [];
        const seen = new Set<string>();
        for (const plugin of catalog) {
          for (const kind of plugin.kinds) {
            for (const group of kind.variants ?? []) {
              const rows = group.rows.filter((row) => {
                const model = row.launch.model;
                if (!model || seen.has(model)) return false;
                seen.add(model);
                return true;
              });
              if (rows.length === 0) continue;
              const provider = launchProviderFromGroupId(group.id) ?? launchProviderFromModelId(rows[0]!.launch.model);
              next.push({ id: group.id, provider, caption: provider ? launchProviderCaption(provider) : group.label, rows });
            }
          }
        }
        setGroups(next);
      })
      .catch(() => {
        if (!abort.signal.aborted) setGroups([]);
      });
    return () => abort.abort();
  }, [open, catalogEpoch]);

  // 메뉴는 body 포털의 고정 위치다 — 패널은 확대 표면의 transform 조상 안에 있어 그 안의 fixed는 갇히고 잘린다.
  // 좌표는 패널 바닥에 앉으므로 아래 자리가 모자라면 위로 연다.
  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_MARGIN));
    const below = rect.bottom + 6;
    const height = menuRef.current?.offsetHeight ?? 320;
    const top = below + height > window.innerHeight - MENU_MARGIN ? Math.max(MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: MENU_WIDTH });
  }, [open, stage, groups, pending, failed, working]);

  React.useLayoutEffect(() => {
    if (!open || !focusOnOpen.current || !menuRef.current) return;
    focusOnOpen.current = false;
    menuItems(menuRef.current)[0]?.focus();
  }, [open, stage, groups]);

  React.useEffect(() => {
    if (!open || mobile) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menuRef.current?.contains(node) && !triggerRef.current?.contains(node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      const menu = menuRef.current;
      if (!menu || !(event.target instanceof Node) || !menu.contains(event.target)) return;
      const items = menuItems(menu);
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (event.key === "Tab" && (event.shiftKey ? index === 0 : index === items.length - 1)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, mobile]);

  const apply = React.useCallback(async (next: AgentChatCoordinatePair) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await changeAgentChatCoordinates(operationId, next);
    } catch {
      // 거절이든 적용 실패든 세션은 지금 설정 그대로다. 창 초과는 행이 먼저 막으므로, 여기에는
      // 그 사이 문맥이 자란 경우만 온다.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, operationId]);

  const cancelPending = React.useCallback(() => {
    void cancelAgentChatCoordinates(operationId).catch(() => undefined);
  }, [operationId]);

  const rows = (groups ?? []).flatMap((group) => group.rows);
  const targetRow = target ? rows.find((row) => row.launch.model === target.model) ?? null : null;
  const providerOf = (row: OperationLaunchVariantRow) => groups?.find((group) => group.rows.includes(row))?.provider ?? null;
  const model = coordinates.model ?? t("terminal.chat.coordDefaultModel");
  const effort = coordinates.effort ?? t("terminal.chat.coordAutoEffort");
  const pendingCoordinates = pending ? readAgentChatSessionCoordinates({ session: pending }) : null;
  // 강도 트랙이 설 모델이 없으면(카탈로그 밖 모델·아직 못 읽음) 2단계가 아니라 목록을 연다.
  const showEffort = stage === "effort" && targetRow !== null && (targetRow.chips?.length ?? 0) > 0;
  const targetEffort = targetRow ? resolveRowEffort(targetRow, target?.effort ?? null) : null;

  return (
    <div className="agent-chat-coord-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`agent-chat-coord is-control${coordinates.ultracode ? " is-ultracode" : ""}`}
        aria-haspopup={mobile ? "dialog" : "menu"}
        aria-expanded={open}
        aria-label={t("terminal.chat.coordMenuAria", { model, effort })}
        {...(coordinates.title ? { title: coordinates.title } : {})}
        onClick={(event) => {
          if (!open && event.detail === 0) focusOnOpen.current = true;
          setStage("effort");
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <CoordinateFace coordinates={coordinates} model={model} effort={effort} />
      </button>
      {pendingCoordinates ? (
        <span
          className="agent-chat-coord-pending"
          aria-label={t("terminal.chat.coordPendingAria", {
            model: pendingCoordinates.model ?? t("terminal.chat.coordDefaultModel"),
            effort: pendingCoordinates.effort ?? t("terminal.chat.coordAutoEffort"),
          })}
        >
          <span aria-hidden="true">→ {pendingCoordinates.model} · {pendingCoordinates.effort ?? t("terminal.chat.coordAutoEffort")}</span>
          <span className="agent-chat-coord-pending-when" aria-hidden="true">{t("terminal.chat.coordPendingWhen")}</span>
          <button
            type="button"
            className="agent-chat-coord-pending-cancel"
            aria-label={t("terminal.chat.coordPendingCancel")}
            title={t("terminal.chat.coordPendingCancel")}
            onClick={cancelPending}
          >
            ✕
          </button>
        </span>
      ) : null}
      {open && mobile ? (
        <MobileCoordinateSheet
          groups={groups}
          target={target}
          current={current}
          occupied={occupied}
          working={working}
          failed={failed}
          language={language}
          formatTokens={formatTokens}
          onApply={(next) => { void apply(next); }}
          onCompact={onCompact}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {open && !mobile ? createPortal(
        <div
          ref={menuRef}
          className={`agent-chat-coord-pop${showEffort ? " is-focused" : ""}`}
          role="menu"
          aria-label={t("terminal.chat.coordMenuTitle")}
          aria-busy={busy}
          style={pos}
        >
          {showEffort && targetRow ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="agent-chat-coord-pop-item agent-chat-coord-pop-back"
                aria-label={t("terminal.chat.coordMenuBackToModels")}
                onClick={() => setStage("models")}
              >
                <span className="agent-chat-coord-pop-chev" aria-hidden="true"><Chevron back /></span>
                {providerOf(targetRow) ? (
                  <span className={`operation-launch-provider-glyph agent-chat-coord-pop-provider is-${providerOf(targetRow)}`} aria-hidden="true">
                    {launchProviderGlyph(providerOf(targetRow)!)}
                  </span>
                ) : null}
                <span className="agent-chat-coord-pop-label">{targetRow.label}</span>
                <span className="agent-chat-coord-pop-effort-word">
                  {targetRow.chips?.find((chip) => chip.launch.effort === targetEffort)?.label ?? t("terminal.chat.coordAutoEffort")}
                </span>
              </button>
              {/* 게이트는 고정 개방 — MAX·ULTRACODE까지 한 축에 펼친다(Objectives 메뉴와 같다). */}
              <div className="agent-chat-coord-pop-track">
                <EffortTrack
                  row={targetRow}
                  apexPinnedOpen
                  value={targetEffort}
                  onChange={(next) => {
                    const nextModel = targetRow.launch.model;
                    if (nextModel) void apply({ model: nextModel, effort: next });
                  }}
                  // 값은 onChange가 이미 실었다 — 고른 노브를 한 번 더 누르거나 Enter는 「이걸로」라는 뜻이라 메뉴만 닫는다.
                  onConfirmCurrent={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  autoLabel={t("terminal.chat.coordAutoEffort")}
                  autoValueText={t("terminal.chat.coordMenuEffortAutoValue")}
                  ariaLabel={t("terminal.chat.coordMenuEffortTrack")}
                />
              </div>
            </>
          ) : (
            <>
              {(groups ?? []).map((group, index) => (
                <div key={group.id} className="agent-chat-coord-pop-group" role="group" aria-label={group.caption}>
                  {index > 0 ? <div className="agent-chat-coord-pop-divider" role="separator" /> : null}
                  {isRosterFallbackGroup(group.id) ? <RosterFallbackNotice onOpened={() => setOpen(false)} /> : (
                    <p className={`operation-launch-variant-caption agent-chat-coord-pop-caption${group.provider ? ` is-${group.provider}` : ""}`} aria-hidden="true">
                      {group.provider ? <span className="operation-launch-provider-glyph" aria-hidden="true">{launchProviderGlyph(group.provider)}</span> : null}
                      <span>{group.caption}</span>
                    </p>
                  )}
                  {group.rows.map((row) => {
                    const active = row.launch.model === target?.model;
                    // 지금 모델은 막지 않는다 — 그 창에 이미 들어앉은 대화다.
                    const tooLarge = occupied !== null && row.contextWindow !== undefined
                      && occupied > row.contextWindow && row.launch.model !== current?.model;
                    return (
                      <div key={row.id} className={`agent-chat-coord-pop-row${tooLarge ? " is-blocked" : ""}`}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          aria-disabled={tooLarge}
                          className={`agent-chat-coord-pop-item${active ? " is-active" : ""}`}
                          onClick={() => {
                            if (tooLarge) return;
                            const nextModel = row.launch.model;
                            if (!nextModel) return;
                            // 행을 고르면 곧바로 적용하고 그 모델의 강도 트랙으로 돌아온다. 고른 강도가 새 모델의
                            // 사다리에 없으면 자동으로 떨어진다 — 런치·Objectives 메뉴와 같은 규칙이다.
                            if (!active) void apply({ model: nextModel, effort: resolveRowEffort(row, target?.effort ?? null) });
                            focusOnOpen.current = true;
                            setStage("effort");
                          }}
                        >
                          <span className="agent-chat-coord-pop-label">{row.label}</span>
                          {row.contextWindow !== undefined ? (
                            <span className="agent-chat-coord-pop-window">{formatTokens(row.contextWindow)}</span>
                          ) : null}
                          {active ? <span className="agent-chat-coord-pop-chev" aria-hidden="true"><Chevron /></span> : null}
                        </button>
                        {tooLarge && occupied !== null && row.contextWindow !== undefined ? (
                          <p className="agent-chat-coord-pop-why">
                            {t("terminal.chat.coordMenuTooLarge", { used: formatTokens(occupied), window: formatTokens(row.contextWindow) })}
                            {" "}
                            <button
                              type="button"
                              className="agent-chat-coord-pop-compact"
                              onClick={() => {
                                setOpen(false);
                                onCompact();
                              }}
                            >
                              {t("terminal.chat.coordMenuCompactFirst")}
                            </button>
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {groups === null ? <p className="agent-chat-coord-pop-empty">{t("terminal.chat.coordMenuLoading")}</p> : null}
            </>
          )}
          {/* 좌표를 바꾸는 시점은 이 메뉴만의 사정이다 — 답하는 중이면 다음 턴부터라는 사실을 한 줄로 말한다. */}
          {failed || working ? (
            <p className={`agent-chat-coord-pop-note${failed ? " is-failed" : ""}`} role="status">
              {failed ? t("terminal.chat.coordMenuFailed") : t("terminal.chat.coordMenuNextTurn")}
            </p>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/** 좌표 글자 — 공급자 글리프(또는 ultracode 별)·모델·강도. 읽기 전용 표식과 같은 조각이다. */
export function CoordinateFace({
  coordinates,
  model,
  effort,
}: {
  readonly coordinates: AgentChatSessionCoordinates;
  readonly model: string;
  readonly effort: string;
}) {
  return (
    <>
      {coordinates.provider !== null && !coordinates.ultracode ? (
        <span className="agent-chat-coord-glyph" aria-hidden="true" data-provider={coordinates.provider}>
          {launchProviderGlyph(coordinates.provider)}
        </span>
      ) : (
        <span className="agent-chat-coord-mark" aria-hidden="true">{coordinates.ultracode ? "✦" : "◇"}</span>
      )}
      <span className="agent-chat-coord-model">{model}</span>
      <span className="agent-chat-coord-sep" aria-hidden="true">·</span>
      <span className="agent-chat-coord-effort" data-effort-level={coordinates.effortLevel}>{effort}</span>
    </>
  );
}

function readCurrentPair(payload: Record<string, unknown> | undefined): AgentChatCoordinatePair | null {
  const session = payload?.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  const record = session as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  return { model: record.model, effort: typeof record.effort === "string" && record.effort.length > 0 ? record.effort : null };
}
