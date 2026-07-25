import { useT } from "../i18n/index.js";

interface TriageClearPlateProps {
  readonly active: boolean;
  readonly entering: boolean;
  readonly hasContent: boolean;
}

export function TriageClearPlate({ active, entering, hasContent }: TriageClearPlateProps) {
  const t = useT();
  if (!active || entering || hasContent) return null;
  return (
    <div className="canvas-triage-clear" data-canvas-blocker>
      <span>{t("canvas.triage.clearMark")}</span>
      <strong>{t("canvas.triage.clearTitle")}</strong>
      <p>{t("canvas.triage.clearBody")}</p>
    </div>
  );
}
