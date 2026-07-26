import { useT } from "../i18n/index.js";

interface TriageClearPlateProps {
  readonly active: boolean;
  readonly entering: boolean;
  readonly hasContent: boolean;
  readonly idleCount: number;
}

export function TriageClearPlate({ active, entering, hasContent, idleCount }: TriageClearPlateProps) {
  const t = useT();
  if (!active || entering || hasContent) return null;
  return (
    <div className="canvas-triage-clear" data-canvas-blocker>
      <span>{t("canvas.triage.clearMark")}</span>
      <strong>{t("canvas.triage.clearTitle")}</strong>
      <p>{idleCount > 0
        ? t("canvas.triage.clearBodyIdle", { count: idleCount })
        : t("canvas.triage.clearBody")}</p>
    </div>
  );
}
