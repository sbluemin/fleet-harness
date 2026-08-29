import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { EffortGaugeGlyph, EffortTrack, effortLadderPosition } from "@fleet-console/sdk/components/effort-track";
import { useT } from "../i18n/index.js";

const FLYOUT_ID = "cowork-effort-flyout";
/** 플라이아웃 예상 폭 — 트랙(116) + 값 라벨 + 패딩. 이 폭이 안 나오는 쪽으로는 열지 않는다. */
const FLYOUT_WIDTH = 240;
const FLYOUT_CLOSE_DELAY_MS = 300;

export interface CoworkAgentMenuProps {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly model: string;
  readonly effort: string;
  /**
   * 모델·강도를 함께 확정한다 — 행 클릭은 강도를 유지한 채 모델만 바꾸고,
   * 행의 강도 플라이아웃은 그 행의 모델과 고른 강도를 함께 싣는다.
   */
  readonly onSelect: (model: string, effort: string) => void;
}

/**
 * Cowork 도크의 에이전트 설정 메뉴 — 캔버스 실행 메뉴와 같은 문법으로, 모델 행 오른쪽의
 * 강도 손잡이에 포인터를 올리면 EffortTrack 플라이아웃이 열린다. 폼 셀렉트를 겹쳐 쌓던
 * 이전 팝오버와 달리 층은 이 메뉴 하나로 끝난다.
 */
export function CoworkAgentMenu({ models, efforts, model, effort, onSelect }: CoworkAgentMenuProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flyout, setFlyout] = useState<{ readonly model: string; readonly top: number; readonly placement: "left" | "right" | "overlay" } | null>(null);

  // 세 모델이 같은 강도 사다리를 쓰므로 트랙 행은 하나로 충분하다 — 어느 행에서 열었는지는
  // 플라이아웃의 model이 들고 있고, 고르는 순간 그 모델까지 함께 확정된다.
  const trackRow = useMemo<OperationLaunchVariantRow>(() => ({
    id: "cowork-effort",
    label: t("codex.cowork.effort"),
    launch: {},
    chips: efforts.map((id) => ({ id, label: id.toUpperCase(), launch: {} })),
    effortAxis: [...efforts],
  }), [efforts, t]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closeFlyout = useCallback(() => {
    cancelClose();
    setFlyout(null);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setFlyout(null);
    }, FLYOUT_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const openFlyout = useCallback((rowModel: string) => {
    cancelClose();
    const root = rootRef.current;
    const row = rowRefs.current.get(rowModel);
    if (!root || !row) return;
    // 강도 손잡이가 행 오른쪽 끝에 있으니 트랙은 같은 방향으로 이어지는 오른쪽부터 재고, 안
    // 되면 왼쪽을 재고, 좁은 화면(≤720px에서 팝오버가 도크 폭으로 늘어난다)처럼 양쪽 다 폭이
    // 안 나오면 화면 밖으로 여는 대신 메뉴 위에 겹쳐 행 아래로 연다 — 가려지는 것은 조작
    // 불능보다 낫다.
    const rect = root.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const placement = viewportWidth - rect.right >= FLYOUT_WIDTH + 8
      ? "right"
      : rect.left >= FLYOUT_WIDTH + 8
        ? "left"
        : "overlay";
    const top = placement === "overlay" ? row.offsetTop + row.offsetHeight + 4 : row.offsetTop;
    setFlyout({ model: rowModel, top, placement });
  }, [cancelClose]);

  const focusTrack = useCallback(() => {
    requestAnimationFrame(() => {
      flyoutRef.current?.querySelector<HTMLElement>(".effort-track")?.focus();
    });
  }, []);

  const gauge = effortLadderPosition(trackRow, efforts.includes(effort) ? effort : null);

  return (
    <div ref={rootRef} className="cowork-agent-menu">
      <span className="cowork-agent-menu-label">{t("codex.cowork.model")}</span>
      {models.map((rowModel) => {
        const open = flyout?.model === rowModel;
        return (
          <button
            key={rowModel}
            ref={(el) => { if (el) rowRefs.current.set(rowModel, el); else rowRefs.current.delete(rowModel); }}
            type="button"
            className="cowork-agent-row"
            aria-pressed={rowModel === model}
            aria-expanded={open}
            aria-controls={open ? FLYOUT_ID : undefined}
            onClick={() => onSelect(rowModel, effort)}
            onPointerLeave={scheduleClose}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)
                && !flyoutRef.current?.contains(event.relatedTarget as Node | null)) {
                scheduleClose();
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              openFlyout(rowModel);
              focusTrack();
            }}
          >
            <span className="cowork-agent-row-label">{rowModel}</span>
            <span className="cowork-agent-check" aria-hidden="true">{rowModel === model ? "✓" : ""}</span>
            {/* 강도 손잡이 — 지금 실릴 강도를 되비치는 표식이자 트랙을 여는 자리. 버튼 안 span이라
                초점 대상이 아니고, 키보드 경로는 행 버튼의 ArrowRight다(실행 메뉴와 같은 계약). */}
            <span
              className="cowork-agent-effort-handle"
              data-effort-level={efforts.includes(effort) ? effort : "auto"}
              data-open={open ? "true" : undefined}
              title={t("launchVariants.effort.track")}
              onPointerEnter={() => openFlyout(rowModel)}
              onPointerLeave={scheduleClose}
              onClick={(event) => {
                // 손잡이는 모델 확정이 아니라 강도를 연다 — 행 클릭까지 함께 발화하지 않게 끊는다.
                event.preventDefault();
                event.stopPropagation();
                if (open) closeFlyout();
                else openFlyout(rowModel);
              }}
            >
              {/* 라벨·꺾쇠는 실행 메뉴의 클래스를 그대로 입는다 — 강도 톤(--effort-tone) 사다리와
                  조판이 core 한 곳에 남는다. cowork-agent-effort는 테스트가 짚는 자리 표식이다. */}
              <EffortGaugeGlyph {...gauge} />
              <span className="cowork-agent-effort operation-launch-variant-effort">{effort.toUpperCase()}</span>
              <span className="operation-launch-variant-chevron" aria-hidden="true">›</span>
            </span>
          </button>
        );
      })}
      {flyout ? (
        <div
          ref={flyoutRef}
          id={FLYOUT_ID}
          // 슬라이더 하나를 담는 상자다 — menu로 선언하면 보조기술이 방향키를 항목 이동으로 가로챈다.
          role="group"
          aria-label={t("launchVariants.effort.track")}
          className={`cowork-effort-flyout${flyout.placement === "left" ? " is-left" : flyout.placement === "overlay" ? " is-overlay" : ""}`}
          style={{ top: flyout.top }}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            event.stopPropagation();
            rowRefs.current.get(flyout.model)?.focus();
            closeFlyout();
          }}
        >
          <EffortTrack
            row={trackRow}
            value={efforts.includes(effort) ? effort : efforts[0] ?? null}
            onChange={(next) => {
              // autoSlot이 없으니 next는 사다리 위의 단이다 — 이 행의 모델과 함께 확정한다.
              if (next !== null) onSelect(flyout.model, next);
            }}
            autoLabel={t("launchVariants.effort.auto")}
            autoSlot={false}
            ariaLabel={t("launchVariants.effort.track")}
            autoValueText={t("launchVariants.effort.autoValue")}
          />
        </div>
      ) : null}
    </div>
  );
}
