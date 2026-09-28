import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { launchProviderFromModelId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

import { findVariantLaunchKind } from "../../quick-launch.js";
import { EffortTrack, gatedEffortNames, resolveRowEffort } from "../../components/effort-track.js";
import { cancelAgentChatCoordinates, changeAgentChatCoordinates } from "../api.js";
import { getT } from "../i18n/index.js";
import type { AgentChatCoordinatePair } from "./chat-events.js";
import { readAgentChatSessionCoordinates, type AgentChatSessionCoordinates } from "./session-coordinates.js";

/**
 * 컴포저 표시줄의 좌표 — 이 세션이 지금 도는 모델·강도이자, 그것을 바꾸는 문이다.
 *
 * 표시는 payload의 좌표다. 서버는 자식에 적용한 뒤에만 payload를 고치므로, 이 글자는 여전히
 * "지금 도는 것"의 사실이다. 턴이 도는 동안 고른 값은 좌표를 바꾸지 않고 옆에 예약으로 선다 —
 * 그 턴은 아직 이전 모델로 답하고 있기 때문이다.
 *
 * 후보는 런치 메뉴와 같은 카탈로그의 행과 칩이다. 같은 세션을 두 표면이 다른 목록으로 다루면
 * 런치에서 끈 모델을 여기서 고를 수 있게 된다.
 */
export function SessionCoordinateMenu({
  operationId,
  payload,
  pending,
  occupied,
  working,
  language,
  openSignal,
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
  /** `/model`·`/effort`가 이 메뉴를 열어 달라는 신호. 값이 바뀐 사실만 뜻이 있다. */
  readonly openSignal: number;
  readonly formatTokens: (tokens: number) => string;
  /** 문맥을 줄이는 길 — `/compact`를 보낸다. */
  readonly onCompact: () => void;
}) {
  const t = getT(language);
  const [open, setOpen] = React.useState(false);
  const [groups, setGroups] = React.useState<readonly OperationLaunchVariantGroup[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const seenSignal = React.useRef(openSignal);

  const coordinates = readAgentChatSessionCoordinates(payload);
  const current = readCurrentPair(payload);
  // 체크 표시와 트랙은 "다음 턴에 도는 것"을 가리킨다. 예약이 없으면 지금 도는 것이다.
  const target: AgentChatCoordinatePair | null = pending ?? current;

  React.useEffect(() => {
    if (openSignal === seenSignal.current) return;
    seenSignal.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  // 열 때마다 카탈로그를 새로 읽는다. 설정에서 모델을 켜고 끈 직후에도 목록이 실제와 어긋나지 않는다.
  React.useEffect(() => {
    if (!open) return;
    setFailed(false);
    const abort = new AbortController();
    void fetchOperationCatalog(abort.signal)
      .then((catalog) => {
        if (!abort.signal.aborted) setGroups(findVariantLaunchKind(catalog)?.kind.variants ?? []);
      })
      .catch(() => {
        if (!abort.signal.aborted) setGroups([]);
      });
    return () => abort.abort();
  }, [open]);

  // 열려 있는 동안에만 문서에 손을 댄다 — 문맥 계기 팝오버와 같은 규율이다.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

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
  const model = coordinates.model ?? t("terminal.chat.coordDefaultModel");
  const effort = coordinates.effort ?? t("terminal.chat.coordAutoEffort");
  const pendingCoordinates = pending ? readAgentChatSessionCoordinates({ session: pending }) : null;

  return (
    <div className="agent-chat-coord-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`agent-chat-coord is-control${coordinates.ultracode ? " is-ultracode" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("terminal.chat.coordMenuAria", { model, effort })}
        {...(coordinates.title ? { title: coordinates.title } : {})}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <CoordinateFace coordinates={coordinates} model={model} effort={effort} />
        <span className="agent-chat-coord-caret" aria-hidden="true">⌄</span>
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
      {open ? (
        <div className="agent-chat-coord-pop" role="menu" aria-label={t("terminal.chat.coordMenuTitle")} aria-busy={busy}>
          {groups === null ? (
            <p className="agent-chat-coord-pop-note">{t("terminal.chat.coordMenuLoading")}</p>
          ) : (
            groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                <p className="agent-chat-coord-pop-group" aria-hidden="true">{group.label}</p>
                {group.rows.map((row) => (
                  <ModelRow
                    key={row.id}
                    row={row}
                    checked={target?.model === row.launch.model}
                    // 지금 모델은 막지 않는다 — 그 창에 이미 들어앉은 대화다.
                    tooLarge={occupied !== null && row.contextWindow !== undefined
                      && occupied > row.contextWindow && row.launch.model !== current?.model}
                    occupied={occupied}
                    formatTokens={formatTokens}
                    language={language}
                    onPick={() => {
                      const nextModel = row.launch.model;
                      if (!nextModel) return;
                      // 고른 강도가 새 모델의 사다리에 없으면 자동으로 떨어진다 — 런치 메뉴와 같은 규칙이다.
                      void apply({ model: nextModel, effort: resolveRowEffort(row, target?.effort ?? null) });
                    }}
                    onCompact={() => {
                      setOpen(false);
                      onCompact();
                    }}
                  />
                ))}
              </div>
            ))
          )}
          {targetRow?.chips && targetRow.chips.length > 0 ? (
            <div className="agent-chat-coord-pop-effort">
              <p className="agent-chat-coord-pop-group" aria-hidden="true">{t("terminal.chat.coordMenuEffort")}</p>
              <EffortTrack
                row={targetRow}
                value={resolveRowEffort(targetRow, target?.effort ?? null)}
                onChange={(next) => {
                  if (target) void apply({ model: target.model, effort: next });
                }}
                autoLabel={t("terminal.chat.coordAutoEffort")}
                ariaLabel={t("terminal.chat.coordMenuEffortTrack")}
                autoValueText={t("terminal.chat.coordMenuEffortAutoValue")}
                apexToggleLabel={t("terminal.chat.coordMenuApexToggle", { tiers: gatedEffortNames(targetRow) })}
                apexCollapseLabel={t("terminal.chat.coordMenuApexCollapse", { tiers: gatedEffortNames(targetRow) })}
              />
            </div>
          ) : null}
          <p className={`agent-chat-coord-pop-note${failed ? " is-failed" : ""}`} role="status">
            {failed
              ? t("terminal.chat.coordMenuFailed")
              : working ? t("terminal.chat.coordMenuNextTurn") : t("terminal.chat.coordMenuNow")}
          </p>
        </div>
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

function ModelRow({
  row,
  checked,
  tooLarge,
  occupied,
  formatTokens,
  language,
  onPick,
  onCompact,
}: {
  readonly row: OperationLaunchVariantRow;
  readonly checked: boolean;
  readonly tooLarge: boolean;
  readonly occupied: number | null;
  readonly formatTokens: (tokens: number) => string;
  readonly language: "en" | "ko";
  readonly onPick: () => void;
  readonly onCompact: () => void;
}) {
  const t = getT(language);
  const provider = launchProviderFromModelId(row.launch.model ?? row.id);
  return (
    <div className={`agent-chat-coord-row-wrap${tooLarge ? " is-blocked" : ""}`}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        aria-disabled={tooLarge}
        className="agent-chat-coord-row"
        onClick={() => {
          if (!tooLarge && !checked) onPick();
        }}
      >
        <span className="agent-chat-coord-row-check" aria-hidden="true">{checked ? "✓" : ""}</span>
        <span className="agent-chat-coord-row-glyph" aria-hidden="true">
          {provider !== null ? launchProviderGlyph(provider) : "◇"}
        </span>
        <span className="agent-chat-coord-row-label">{row.label}</span>
        {row.contextWindow !== undefined ? (
          <span className="agent-chat-coord-row-window">{formatTokens(row.contextWindow)}</span>
        ) : null}
      </button>
      {tooLarge && occupied !== null && row.contextWindow !== undefined ? (
        <p className="agent-chat-coord-row-why">
          {t("terminal.chat.coordMenuTooLarge", { used: formatTokens(occupied), window: formatTokens(row.contextWindow) })}
          {" "}
          <button type="button" className="agent-chat-coord-row-compact" onClick={onCompact}>
            {t("terminal.chat.coordMenuCompactFirst")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

function readCurrentPair(payload: Record<string, unknown> | undefined): AgentChatCoordinatePair | null {
  const session = payload?.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  const record = session as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  return { model: record.model, effort: typeof record.effort === "string" && record.effort.length > 0 ? record.effort : null };
}
