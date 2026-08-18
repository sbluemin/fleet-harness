import { useCallback, useEffect, useRef, useState } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheme, OperationKindDescriptor, OperationRenderContext, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import type { createHostCapabilities } from "../plugin-capabilities.js";
import type { OperationGeometry, OperationNode } from "../types.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

// Same two-tap arm as OperationFrame — a single tap names the intent, a second tap disposes.
const CLOSE_ARM_DURATION_MS = 1500;

/**
 * An open operation is the terminal plus a named title. Leave remains the platform back
 * gesture, which this shell already answers. Close is a separate two-tap control on that
 * title row so the phone can dispose the Operation the same way the desktop frame does.
 */
export function MobileSessionView({ operation, theme, language, active, runtimeState, operationKinds, capabilities, onActivate, onClose }: {
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
  readonly runtimeState: OperationRuntimeState | null;
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [isCloseArmed, setIsCloseArmed] = useState(false);
  const [geometry, setGeometry] = useState<OperationGeometry>({ x: 0, y: 0, width: 390, height: 640, zIndex: 0 });
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const update = () => setGeometry((current) => ({
      ...current,
      width: Math.max(1, element.clientWidth),
      height: Math.max(1, element.clientHeight),
    }));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [measureTarget, setMeasureTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => measure(measureTarget), [measure, measureTarget]);

  const clearCloseArmTimer = () => {
    if (closeArmTimeoutRef.current === null) return;
    window.clearTimeout(closeArmTimeoutRef.current);
    closeArmTimeoutRef.current = null;
  };

  const disarmClose = () => {
    clearCloseArmTimer();
    setIsCloseArmed(false);
  };

  const armClose = () => {
    clearCloseArmTimer();
    setIsCloseArmed(true);
    closeArmTimeoutRef.current = window.setTimeout(() => {
      closeArmTimeoutRef.current = null;
      setIsCloseArmed(false);
    }, CLOSE_ARM_DURATION_MS);
  };

  useEffect(() => {
    setIsCloseArmed(false);
    if (closeArmTimeoutRef.current !== null) {
      window.clearTimeout(closeArmTimeoutRef.current);
      closeArmTimeoutRef.current = null;
    }
    return () => {
      if (closeArmTimeoutRef.current !== null) window.clearTimeout(closeArmTimeoutRef.current);
    };
  }, [operation.id]);

  const close = () => {
    if (!isCloseArmed) {
      armClose();
      return;
    }
    disarmClose();
    onClose();
  };

  const config: OperationBodyConfig = {
    active,
    geometry,
    operation,
    runtimeState,
    bodyLive: true,
    theme,
    language,
    zoom: 1,
    onActivate,
    onClose,
    onGeometryChange: setGeometry,
    // This layout gives the whole surface to the session, so it opens no companion panels. The
    // callbacks stay out rather than being no-ops: their absence is how a plugin reads a host
    // without companions, and a no-op would have it advertise a panel that never opens.
  };

  const title = operation.title;

  // 캔버스 프레임의 캡션 동작 선반과 같은 것 — 이 레이아웃의 제목 줄이 그 밴드다. 여기서 빠지면
  // 채팅 뷰로 들어간 세션이 터미널로 돌아갈 문을 잃는다(본문에는 더 이상 그 칩이 없다).
  const descriptor = operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const captionActions = descriptor?.captionActions?.({
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    zoom: 1,
    theme,
    language,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    runtime: capabilities.runtime,
    runtimeState,
    bodyLive: true,
    statusDetail: capabilities.statusDetail,
    composer: capabilities.composer,
    onActivate,
    onClose,
    onGeometryChange: setGeometry,
    // 본문과 같은 이유로 companion 콜백은 싣지 않는다 — 그 부재가 "여기엔 드로어가 없다"는 말이다.
  } satisfies OperationRenderContext);

  return (
    <section className="mobile-session-view">
      <div className="mobile-session-bar">
        <h1 className="mobile-session-title">{title}</h1>
        {captionActions ? (
          <span className="mobile-session-caption-actions">
            <PluginErrorBoundary fallback={<></>}>{captionActions}</PluginErrorBoundary>
          </span>
        ) : null}
        <button
          type="button"
          className={`mobile-session-close${isCloseArmed ? " is-armed" : ""}`}
          onClick={close}
          aria-label={isCloseArmed ? t("canvas.frame.confirmCloseAria", { title }) : t("canvas.frame.closeAria", { title })}
          title={isCloseArmed ? t("canvas.frame.confirmCloseTitle") : t("canvas.frame.closeTitle")}
        >
          {isCloseArmed ? t("canvas.frame.closeArmed") : <CloseIcon />}
        </button>
      </div>
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot operationId={operation.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
