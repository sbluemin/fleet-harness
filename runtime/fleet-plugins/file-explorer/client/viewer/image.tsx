import { useLayoutEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { formatByteSize } from "../format.js";
import type { FileExplorerMessageKey } from "../i18n/index.js";

export type ImageFitMode = "fit" | "actual";

interface ImageViewerProps {
  readonly src: string;
  readonly name: string;
  readonly sizeBytes?: number;
  readonly t: Translate<FileExplorerMessageKey>;
}

export function cacheBustedImageSrc(src: string, mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}t=${mtimeMs}`;
}

/**
 * 맞춤(fit)은 스테이지에 꽉 차게(확대 포함), 100%(actual)는 원본 크기.
 * 배율은 표시된 크기 / 원본 크기 — 메타 바가 이 값을 사실로 말한다.
 */
export function resolveImageScale(
  mode: ImageFitMode,
  natural: { readonly width: number; readonly height: number },
  stage: { readonly width: number; readonly height: number },
): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  if (mode === "actual") return 1;
  if (stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(stage.width / natural.width, stage.height / natural.height);
}

/** 메타 바의 배율 문구 — 맞춤으로 배율이 변했을 때만 (맞춤)을 병기한다. */
export function imageScaleLabel(
  mode: ImageFitMode,
  scale: number,
  t: Translate<FileExplorerMessageKey>,
): string {
  const pct = Math.round(scale * 100);
  if (mode === "fit" && pct !== 100) return t("fileExplorer.viewer.imageScaleFitted", { pct });
  return `${pct}%`;
}

export function ImageViewer({ src, name, sizeBytes, t }: ImageViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [fitMode, setFitMode] = useState<ImageFitMode>("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const scale = natural ? resolveImageScale(fitMode, natural, stageSize) : 1;
  const renderedSize = natural
    ? { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) }
    : null;

  return (
    <div className="fexp-img-wrap">
      <div ref={stageRef} className={`fexp-img-stage${fitMode === "actual" ? " is-actual" : ""}`}>
        <img
          src={src}
          alt={name}
          className={`fexp-img${scale > 1 ? " is-upscaled" : ""}`}
          style={renderedSize ? { width: `${renderedSize.width}px`, height: `${renderedSize.height}px` } : undefined}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            setNatural({ width: img.naturalWidth, height: img.naturalHeight });
          }}
        />
      </div>
      <div className="fexp-img-tools">
        <div className="fexp-img-zoom" role="group" aria-label={t("fileExplorer.viewer.imageZoomAria")}>
          <button
            type="button"
            aria-pressed={fitMode === "fit"}
            onClick={() => setFitMode("fit")}
          >
            {t("fileExplorer.viewer.imageFit")}
          </button>
          <button
            type="button"
            aria-pressed={fitMode === "actual"}
            onClick={() => setFitMode("actual")}
          >
            {t("fileExplorer.viewer.imageActual")}
          </button>
        </div>
      </div>
      {natural && (
        <div className="fexp-viewer-meta fexp-img-meta">
          <span className="fexp-viewer-meta-part">{natural.width} × {natural.height}</span>
          {sizeBytes !== undefined && (
            <span className="fexp-viewer-meta-part">{formatByteSize(sizeBytes)}</span>
          )}
          <span className="fexp-viewer-meta-part">{imageScaleLabel(fitMode, scale, t)}</span>
        </div>
      )}
    </div>
  );
}
