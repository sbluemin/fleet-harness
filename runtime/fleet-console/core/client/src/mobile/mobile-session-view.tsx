import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import type { OperationGeometry, OperationNode } from "../types.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

// Same two-tap arm as OperationFrame — a single tap names the intent, a second tap disposes.
const CLOSE_ARM_DURATION_MS = 1500;

/**
 * An open operation is the terminal plus a named title. Leave remains the platform back
 * gesture, which this shell already answers. Close is a separate two-tap control on that
 * title row so the phone can dispose the Operation the same way the desktop frame does.
 */
export function MobileSessionView({ operation, theme, language, active, onActivate, onClose }: {
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
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

  return (
    <section className="mobile-session-view">
      <div className="mobile-session-bar">
        <h1 className="mobile-session-title">{title}</h1>
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
