import { useCallback, useEffect, useState } from "react";

import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import type { OperationGeometry, OperationNode } from "../types.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

/**
 * An open operation is the terminal and nothing else. The title stays as a line above it so the
 * session is named, but it carries no controls: leaving is the platform's own back gesture, which
 * this shell already answers, and a bar of buttons would spend height the terminal needs.
 */
export function MobileSessionView({ operation, theme, language, active, onActivate }: {
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
  readonly onActivate: () => void;
}) {
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
    onClose: () => {},
    onGeometryChange: setGeometry,
    // This layout gives the whole surface to the session, so it opens no companion panels. The
    // callbacks stay out rather than being no-ops: their absence is how a plugin reads a host
    // without companions, and a no-op would have it advertise a panel that never opens.
  };

  return (
    <section className="mobile-session-view">
      <h1 className="mobile-session-title">{operation.title}</h1>
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot operationId={operation.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}
