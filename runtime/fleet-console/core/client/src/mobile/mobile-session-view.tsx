import { useCallback, useEffect, useState } from "react";

import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import type { OperationGeometry, OperationNode } from "../types.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

export function MobileSessionView({ operation, theme, language, active, onBack, onActivate, onClose }: {
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
  readonly onBack: () => void;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
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
    onRequestCompanions: () => {},
    companionsOpen: false,
    hiddenCompanionPanelIds: [],
    onSetCompanionPanelVisible: () => {},
  };

  return (
    <section className="mobile-session-view">
      <header className="mobile-session-header">
        <button type="button" className="mobile-header-button" onClick={onBack} aria-label={t("mobile.session.backAria")}>
          <span aria-hidden="true">‹</span>
        </button>
        <h1>{operation.title}</h1>
        <button type="button" className="mobile-header-action" onClick={onClose}>{t("mobile.session.close")}</button>
      </header>
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot operationId={operation.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}
