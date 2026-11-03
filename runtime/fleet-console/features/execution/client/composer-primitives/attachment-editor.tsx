import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";
import type { ComposerMessageKey } from "./messages.js";

/**
 * 첨부 확대 보기 안의 주석.
 *
 * 획은 저장 때 캔버스 픽셀로 합쳐지고, 다시 열면 개체로 남지 않는다. 도구·색·굵기만
 * 이 번들 안에서 기억한다 — 초안이 아니라 다음 편집의 시작값이라 스토어에 두지 않는다.
 */

type Tool = "pen" | "shape" | "text" | "cover";
type Shape = "line" | "arrow" | "rect" | "ellipse" | "step";
type Cover = "solid" | "mosaic";
type Menu = "shape" | "cover" | "color" | "width";

interface Ink { readonly id: "red" | "blue" | "green" | "black" | "white"; readonly value: string; readonly label: ComposerMessageKey }
interface Thickness { readonly id: "thin" | "medium" | "thick" | "heavy"; readonly value: number; readonly label: ComposerMessageKey }

const INK: readonly Ink[] = [
  { id: "red", value: "#e5484d", label: "composer.attach.color.red" },
  { id: "blue", value: "#3e8ef7", label: "composer.attach.color.blue" },
  { id: "green", value: "#3fb950", label: "composer.attach.color.green" },
  { id: "black", value: "#111111", label: "composer.attach.color.black" },
  { id: "white", value: "#ffffff", label: "composer.attach.color.white" },
];
const THICKNESS: readonly Thickness[] = [
  { id: "thin", value: 2, label: "composer.attach.width.thin" },
  { id: "medium", value: 4, label: "composer.attach.width.medium" },
  { id: "thick", value: 8, label: "composer.attach.width.thick" },
  { id: "heavy", value: 14, label: "composer.attach.width.heavy" },
];
const SHAPES: readonly { readonly id: Shape; readonly label: ComposerMessageKey }[] = [
  { id: "line", label: "composer.attach.line" },
  { id: "arrow", label: "composer.attach.arrow" },
  { id: "rect", label: "composer.attach.rect" },
  { id: "ellipse", label: "composer.attach.ellipse" },
  { id: "step", label: "composer.attach.step" },
];
const COVERS: readonly { readonly id: Cover; readonly label: ComposerMessageKey }[] = [
  { id: "solid", label: "composer.attach.solid" },
  { id: "mosaic", label: "composer.attach.mosaic" },
];

let rememberedTool: Tool = "pen";
let rememberedShape: Shape = "rect";
let rememberedCover: Cover = "mosaic";
let rememberedColor = INK[0]!.value;
let rememberedWidth = THICKNESS[1]!.value;

type Point = readonly [number, number];
type Mark =
  | { readonly kind: "pen"; readonly pts: Point[]; readonly color: string; readonly width: number }
  | { readonly kind: "line" | "arrow" | "rect" | "ellipse" | "solid" | "mosaic"; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly color: string; readonly width: number }
  | { readonly kind: "step"; readonly x0: number; readonly y0: number; readonly n: number; readonly color: string; readonly width: number }
  | { readonly kind: "text"; readonly x0: number; readonly y0: number; readonly text: string; readonly color: string; readonly width: number };

interface TextDraft {
  readonly left: number;
  readonly top: number;
  readonly fontPx: number;
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly width: number;
  readonly value: string;
}

/** 확정된 글자의 캔버스 픽셀 크기. 입력칸은 여기에 화면 배율을 곱한다. */
function annotationFontPx(strokeWidth: number): number {
  return 16 + strokeWidth * 2;
}

export interface ComposerImageEditorHandle {
  /** 메뉴·글상자·실행 취소가 삼킨 키면 none이 아니다. Esc를 삼키지 않으면 뷰어가 편집을 닫는다. */
  keydown(event: KeyboardEvent): "menu" | "text" | "history" | "none";
}

export interface ComposerImageEditorProps {
  readonly src: string;
  readonly edited: boolean;
  readonly saving: boolean;
  readonly notice: string | null;
  readonly t: Translate<ComposerMessageKey>;
  readonly onDirty: (dirty: boolean) => void;
  readonly onSave: (blob: Blob) => void;
  readonly onRevert: () => void;
  readonly onExit: () => void;
}

function paint(g: CanvasRenderingContext2D, mark: Mark, src: HTMLCanvasElement): void {
  g.save();
  g.strokeStyle = mark.color;
  g.fillStyle = mark.color;
  g.lineWidth = mark.width;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (mark.kind === "pen") {
    g.beginPath();
    mark.pts.forEach((pt, index) => { if (index === 0) g.moveTo(pt[0], pt[1]); else g.lineTo(pt[0], pt[1]); });
    g.stroke();
  } else if (mark.kind === "line" || mark.kind === "arrow") {
    g.beginPath();
    g.moveTo(mark.x0, mark.y0);
    g.lineTo(mark.x1, mark.y1);
    g.stroke();
    if (mark.kind === "arrow") {
      const angle = Math.atan2(mark.y1 - mark.y0, mark.x1 - mark.x0);
      const head = 10 + mark.width * 2.5;
      g.beginPath();
      g.moveTo(mark.x1, mark.y1);
      g.lineTo(mark.x1 - head * Math.cos(angle - 0.45), mark.y1 - head * Math.sin(angle - 0.45));
      g.lineTo(mark.x1 - head * Math.cos(angle + 0.45), mark.y1 - head * Math.sin(angle + 0.45));
      g.closePath();
      g.fill();
    }
  } else if (mark.kind === "rect") {
    g.strokeRect(Math.min(mark.x0, mark.x1), Math.min(mark.y0, mark.y1), Math.abs(mark.x1 - mark.x0), Math.abs(mark.y1 - mark.y0));
  } else if (mark.kind === "ellipse") {
    const rx = Math.abs(mark.x1 - mark.x0) / 2;
    const ry = Math.abs(mark.y1 - mark.y0) / 2;
    if (rx >= 1 && ry >= 1) {
      g.beginPath();
      g.ellipse((mark.x0 + mark.x1) / 2, (mark.y0 + mark.y1) / 2, rx, ry, 0, 0, Math.PI * 2);
      g.stroke();
    }
  } else if (mark.kind === "step") {
    const radius = 14 + mark.width;
    g.beginPath();
    g.arc(mark.x0, mark.y0, radius, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = mark.color.toLowerCase() === "#ffffff" ? "#111111" : "#ffffff";
    g.font = `700 ${radius}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(mark.n), mark.x0, mark.y0 + 1);
  } else if (mark.kind === "text") {
    g.font = `600 ${annotationFontPx(mark.width)}px sans-serif`;
    g.textBaseline = "top";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,.55)";
    g.strokeText(mark.text, mark.x0, mark.y0);
    g.fillStyle = mark.color;
    g.fillText(mark.text, mark.x0, mark.y0);
  } else if (mark.kind === "solid" || mark.kind === "mosaic") {
    const x = Math.round(Math.min(mark.x0, mark.x1));
    const y = Math.round(Math.min(mark.y0, mark.y1));
    const w = Math.round(Math.abs(mark.x1 - mark.x0));
    const h = Math.round(Math.abs(mark.y1 - mark.y0));
    if (w > 1 && h > 1) {
      if (mark.kind === "solid") {
        g.fillStyle = "#0b0b0b";
        g.fillRect(x, y, w, h);
      } else {
        const block = 14;
        const tile = document.createElement("canvas");
        tile.width = Math.max(1, Math.ceil(w / block));
        tile.height = Math.max(1, Math.ceil(h / block));
        tile.getContext("2d")?.drawImage(src, x, y, w, h, 0, 0, tile.width, tile.height);
        g.imageSmoothingEnabled = false;
        g.drawImage(tile, 0, 0, tile.width, tile.height, x, y, w, h);
      }
    }
  }
  g.restore();
}

function flatten(base: HTMLCanvasElement, marks: readonly Mark[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  g.drawImage(base, 0, 0);
  for (const mark of marks) paint(g, mark, canvas);
  return canvas;
}

function pointer(event: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  const x = rect.width === 0 ? 0 : (event.clientX - rect.left) * canvas.width / rect.width;
  const y = rect.height === 0 ? 0 : (event.clientY - rect.top) * canvas.height / rect.height;
  return [x, y];
}

export const ComposerImageEditor = forwardRef<ComposerImageEditorHandle, ComposerImageEditorProps>(function ComposerImageEditor({
  src, edited, saving, notice, t, onDirty, onSave, onRevert, onExit,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const stepN = useRef(1);
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [history, setHistory] = useState<{ ops: Mark[]; redo: Mark[] }>({ ops: [], redo: [] });
  const historyRef = useRef(history);
  historyRef.current = history;
  const ops = history.ops;
  const redo = history.redo;
  const [draft, setDraft] = useState<Mark | null>(null);
  const [tool, setTool] = useState<Tool>(rememberedTool);
  const [shape, setShape] = useState<Shape>(rememberedShape);
  const [cover, setCover] = useState<Cover>(rememberedCover);
  const [color, setColor] = useState(rememberedColor);
  const [width, setWidth] = useState(rememberedWidth);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const draftRef = useRef<Mark | null>(null);
  draftRef.current = draft;

  useEffect(() => {
    let gone = false;
    const image = new Image();
    image.onload = () => {
      if (gone) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const g = canvas.getContext("2d");
      if (!g || canvas.width === 0 || canvas.height === 0) return;
      g.drawImage(image, 0, 0);
      setBase(canvas);
    };
    image.src = src;
    return () => { gone = true; };
  }, [src]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const flat = flatten(base, draft ? [...ops, draft] : ops);
    canvas.width = flat.width;
    canvas.height = flat.height;
    canvas.getContext("2d")?.drawImage(flat, 0, 0);
  }, [base, ops, draft]);

  const dirty = ops.length > 0 || (textDraft?.value.trim().length ?? 0) > 0;
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    onDirty(dirty);
  }, [dirty, onDirty]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  useEffect(() => { if (textDraft) textRef.current?.focus(); }, [textDraft]);
  useEffect(() => { toolsRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus(); }, []);

  const writeHistory = (next: { ops: Mark[]; redo: Mark[] }) => {
    historyRef.current = next;
    setHistory(next);
  };
  const push = (mark: Mark) => {
    const current = historyRef.current;
    writeHistory({ ops: [...current.ops, mark], redo: [] });
  };
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  const commitText = () => {
    const current = textDraftRef.current;
    if (!current) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const value = current.value.trim();
    if (value) push({ kind: "text", x0: current.x, y0: current.y, text: value, color: current.color, width: current.width });
  };
  const chooseTool = (next: Tool) => {
    rememberedTool = next;
    setTool(next);
    setMenu(null);
  };
  const toggleMenu = (next: Menu, asTool?: Tool) => {
    if (asTool) {
      rememberedTool = asTool;
      setTool(asTool);
    }
    setMenu((current) => current === next ? null : next);
  };
  const undo = () => {
    const current = historyRef.current;
    const mark = current.ops[current.ops.length - 1];
    if (!mark) return;
    writeHistory({ ops: current.ops.slice(0, -1), redo: [...current.redo, mark] });
  };
  const redoMark = () => {
    const current = historyRef.current;
    const mark = current.redo[current.redo.length - 1];
    if (!mark) return;
    writeHistory({ ops: [...current.ops, mark], redo: current.redo.slice(0, -1) });
  };
  const clear = () => {
    textDraftRef.current = null;
    setTextDraft(null);
    const current = historyRef.current;
    if (current.ops.length === 0) return;
    writeHistory({ ops: [], redo: [...current.ops].reverse() });
    stepN.current = 1;
  };

  useImperativeHandle(ref, () => ({
    keydown(event) {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape") {
        if (menu) { setMenu(null); return "menu"; }
        if (textDraftRef.current) { textDraftRef.current = null; setTextDraft(null); return "text"; }
        return "none";
      }
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (event.shiftKey) redoMark();
        else undo();
        return "history";
      }
      return "none";
    },
  }), [menu]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (saving || !base || !canvasRef.current) return;
    setMenu(null);
    const [x, y] = pointer(event, canvasRef.current);
    if (tool === "text") {
      // pointerdown의 기본 동작은 이어지는 mousedown으로 방금 연 입력칸의 포커스를 캔버스에 넘긴다.
      // 막지 않으면 빈 칸이 blur로 바로 닫힌다. 터치·펜도 같은 pointerdown을 쓴다.
      event.preventDefault();
      commitText();
      const canvas = canvasRef.current;
      const stage = stageRef.current?.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const scaleX = canvas.width > 0 ? box.width / canvas.width : 1;
      const scaleY = canvas.height > 0 ? box.height / canvas.height : 1;
      setTextDraft({
        left: (stage ? box.left - stage.left : 0) + x * scaleX,
        top: (stage ? box.top - stage.top : 0) + y * scaleY,
        fontPx: annotationFontPx(width) * scaleX,
        x, y, color, width, value: "",
      });
      return;
    }
    if (tool === "shape" && shape === "step") {
      const n = stepN.current;
      stepN.current += 1;
      push({ kind: "step", x0: x, y0: y, n, color, width });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "pen") {
      setDraft({ kind: "pen", pts: [[x, y]], color, width });
      return;
    }
    if (tool === "cover") {
      setDraft({ kind: cover, x0: x, y0: y, x1: x, y1: y, color, width });
      return;
    }
    if (shape === "step") return;
    setDraft({ kind: shape, x0: x, y0: y, x1: x, y1: y, color, width });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current;
    if (!current || !canvasRef.current) return;
    const [x, y] = pointer(event, canvasRef.current);
    if (current.kind === "step" || current.kind === "text") return;
    const next: Mark = current.kind === "pen"
      ? { ...current, pts: [...current.pts, [x, y]] }
      : { ...current, x1: x, y1: y };
    draftRef.current = next;
    setDraft(next);
  };
  const onPointerUp = () => {
    const current = draftRef.current;
    if (!current) return;
    draftRef.current = null;
    setDraft(null);
    if (current.kind === "step" || current.kind === "text") return;
    const kept = current.kind === "pen"
      ? current.pts.length > 1
      : Math.hypot(current.x1 - current.x0, current.y1 - current.y0) > 4;
    if (kept) push(current);
  };

  const save = () => {
    if (!base || saving) return;
    const pendingText = textDraftRef.current?.value.trim() ?? "";
    const pending = textDraftRef.current && pendingText
      ? [...historyRef.current.ops, { kind: "text" as const, x0: textDraftRef.current.x, y0: textDraftRef.current.y, text: pendingText, color: textDraftRef.current.color, width: textDraftRef.current.width }]
      : historyRef.current.ops;
    if (pending.length === 0) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const flat = flatten(base, pending);
    flat.toBlob((blob) => { if (blob) onSave(blob); }, "image/png");
  };

  const shapeLabel = t(SHAPES.find((item) => item.id === shape)?.label ?? "composer.attach.rect");
  const coverLabel = t(COVERS.find((item) => item.id === cover)?.label ?? "composer.attach.mosaic");
  const widthLabel = t(THICKNESS.find((item) => item.value === width)?.label ?? "composer.attach.width.medium");
  const locked = saving || !base;
  const shownScale = (() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return 1;
    const box = canvas.getBoundingClientRect();
    return box.width > 0 ? box.width / canvas.width : 1;
  })();

  return (
    <div className="fc-composer-editor">
      <div ref={stageRef} className="fc-composer-editor__stage">
        <canvas
          ref={canvasRef}
          className="fc-composer-viewer__canvas"
          aria-label={t("composer.attach.tools")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {textDraft ? (
          <input
            ref={textRef}
            className="fc-composer-editor__text"
            style={{
              left: textDraft.left,
              top: textDraft.top,
              color: textDraft.color,
              fontSize: `${textDraft.fontPx}px`,
              lineHeight: 1,
              height: `${textDraft.fontPx}px`,
              fontFamily: "sans-serif",
              fontWeight: 600,
            }}
            value={textDraft.value}
            aria-label={t("composer.attach.textInput")}
            onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
            onBlur={() => commitText()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitText(); }
            }}
          />
        ) : null}
      </div>
      <div ref={toolsRef} className="fc-composer-editor__tools" role="toolbar" aria-label={t("composer.attach.tools")}>
        <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.pen")} title={t("composer.attach.pen")} aria-pressed={tool === "pen"} disabled={locked} onClick={() => chooseTool("pen")}><PenGlyph /></button>
        <span className="fc-composer-editor__slot">
          <button type="button" className="fc-composer-editor__tool" aria-label={tool === "cover" ? t("composer.attach.cover") : t("composer.attach.shape")} title={tool === "cover" ? t("composer.attach.cover") : shapeLabel} aria-pressed={tool === "shape" || tool === "cover"} aria-expanded={menu === "shape"} disabled={locked} onClick={() => { if (tool !== "cover") { rememberedTool = "shape"; setTool("shape"); } setMenu((current) => current === "shape" ? null : "shape"); }}>
            <MarkGlyph kind={tool === "cover" ? "cover" : shape} /><CaretGlyph />
          </button>
          {menu === "shape" ? <InkMenu label={t("composer.attach.shape")} items={[...SHAPES.map((item) => ({ id: item.id, label: t(item.label), checked: tool === "shape" && item.id === shape, glyph: <MarkGlyph kind={item.id} /> })), { id: "cover", label: t("composer.attach.cover"), checked: tool === "cover", glyph: <MarkGlyph kind="cover" /> }]} onPick={(id) => { setMenu(null); if (id === "cover") { rememberedTool = "cover"; setTool("cover"); return; } rememberedShape = id as Shape; rememberedTool = "shape"; setShape(id as Shape); setTool("shape"); }} /> : null}
        </span>
        <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.textTool")} title={t("composer.attach.textTool")} aria-pressed={tool === "text"} disabled={locked} onClick={() => chooseTool("text")}><TextGlyph /></button>
        <span className="fc-composer-editor__sep" aria-hidden="true" />
        {tool === "cover" ? (
          <span className="fc-composer-editor__slot">
            <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.coverStyle")} title={coverLabel} aria-expanded={menu === "cover"} disabled={locked} onClick={() => setMenu((current) => current === "cover" ? null : "cover")}><CoverStyleGlyph kind={cover} /><CaretGlyph /></button>
            {menu === "cover" ? <InkMenu label={t("composer.attach.coverStyle")} items={COVERS.map((item) => ({ id: item.id, label: t(item.label), checked: item.id === cover, glyph: <CoverStyleGlyph kind={item.id} /> }))} onPick={(id) => { rememberedCover = id as Cover; setCover(id as Cover); setMenu(null); }} /> : null}
          </span>
        ) : (
          <span className="fc-composer-editor__slot">
            <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.color")} title={t("composer.attach.color")} aria-expanded={menu === "color"} disabled={locked} onClick={() => toggleMenu("color")}><span className="fc-composer-editor__swatch" style={{ background: color }} /><CaretGlyph /></button>
            {menu === "color" ? <InkMenu label={t("composer.attach.color")} items={INK.map((item) => ({ id: item.value, label: t(item.label), checked: item.value === color, swatch: item.value }))} onPick={(id) => { rememberedColor = id; setColor(id); setMenu(null); }} /> : null}
          </span>
        )}
        <span className="fc-composer-editor__slot">
          <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.width")} title={widthLabel} aria-expanded={menu === "width"} disabled={locked} onClick={() => toggleMenu("width")}><WidthGlyph value={width} /><CaretGlyph /></button>
          {menu === "width" ? <InkMenu label={t("composer.attach.width")} items={THICKNESS.map((item) => ({ id: String(item.value), label: t(item.label), checked: item.value === width, glyph: <WidthSample value={item.value} scale={shownScale} /> }))} onPick={(id) => { rememberedWidth = Number(id); setWidth(Number(id)); setMenu(null); }} /> : null}
        </span>
        {ops.length > 0 || redo.length > 0 ? (
          <>
            <span className="fc-composer-editor__sep" aria-hidden="true" />
            <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.undo")} title={t("composer.attach.undo")} disabled={locked || ops.length === 0} onClick={undo}><HistoryGlyph /></button>
            <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.redo")} title={t("composer.attach.redo")} disabled={locked || redo.length === 0} onClick={redoMark}><HistoryGlyph flip /></button>
            <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.clear")} title={t("composer.attach.clear")} disabled={locked || ops.length === 0} onClick={clear}><TrashGlyph /></button>
          </>
        ) : null}
        {edited ? <button type="button" className="fc-composer-editor__tool is-text" disabled={locked} onClick={onRevert}>{t("composer.attach.revert")}</button> : null}
        <button type="button" className="fc-composer-editor__tool is-save" disabled={locked || !dirty} onClick={save}>{saving ? t("composer.attach.saving") : t("composer.attach.save")}</button>
        <button type="button" className="fc-composer-editor__tool" aria-label={t("composer.attach.exitEdit")} title={t("composer.attach.exitEdit")} disabled={saving} onClick={onExit}><CloseGlyph /></button>
      </div>
      {notice ? <p className="fc-composer-editor__notice" role="status">{notice}</p> : null}
    </div>
  );
});

function Glyph({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>{children}</svg>;
}

function PenGlyph() {
  return <Glyph><path d="M9.2 2.6 13.4 6.8 6.2 14H2.8v-3.4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 3.8 12.2 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Glyph>;
}

function TextGlyph() {
  return <Glyph><path d="M3.2 3.6h9.6M8 3.6v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></Glyph>;
}

function CaretGlyph() {
  return <svg viewBox="0 0 8 8" aria-hidden="true" className="is-caret"><path d="M1.4 2.8 4 5.4 6.6 2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CloseGlyph() {
  return <Glyph><path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></Glyph>;
}

function TrashGlyph() {
  return <Glyph><path d="M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.5 8h5.8l.5-8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Glyph>;
}

function WidthGlyph({ value }: { readonly value: number }) {
  const stroke = value <= 2 ? 1.5 : value <= 4 ? 2.6 : value <= 8 ? 4 : 6.5;
  return <Glyph><path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" /></Glyph>;
}

function WidthSample({ value, scale }: { readonly value: number; readonly scale: number }) {
  const thickness = Math.min(16, Math.max(1, value * scale));
  return <span className="fc-composer-editor__width-sample" style={{ height: `${thickness}px` }} />;
}

function CoverStyleGlyph({ kind }: { readonly kind: Cover }) {
  return kind === "solid"
    ? <Glyph><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></Glyph>
    : <Glyph><path d="M3 3h4.5v4.5H3zM8.5 3H13v4.5H8.5zM3 8.5h4.5V13H3zM8.5 8.5H13V13H8.5z" fill="currentColor" /></Glyph>;
}

function MarkGlyph({ kind }: { readonly kind: Shape | "cover" }) {
  if (kind === "line") return <Glyph><path d="M3.2 12.6 12.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></Glyph>;
  if (kind === "arrow") return <Glyph><path d="M3.2 12.6 12.4 3.6M8.2 3.4h4.4V7.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></Glyph>;
  if (kind === "rect") return <Glyph><rect x="3" y="3.5" width="10" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" /></Glyph>;
  if (kind === "ellipse") return <Glyph><ellipse cx="8" cy="8" rx="5.2" ry="4" fill="none" stroke="currentColor" strokeWidth="1.6" /></Glyph>;
  if (kind === "step") return <Glyph><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /></Glyph>;
  return <Glyph><path d="M2.2 8s2.2-3.4 5.8-3.4 5.8 3.4 5.8 3.4-2.2 3.4-5.8 3.4S2.2 8 2.2 8z" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /><path d="M3.4 3.4 12.6 12.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Glyph>;
}

function HistoryGlyph({ flip = false }: { readonly flip?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={flip ? "is-flip" : undefined}>
      <path d="M6.1 3.6 3.1 6.5l3 2.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.4 6.5h5.2a3.2 3.2 0 1 1 0 6.4H8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function InkMenu({ label, items, onPick }: {
  readonly label: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly checked: boolean; readonly swatch?: string; readonly glyph?: ReactNode }[];
  readonly onPick: (id: string) => void;
}) {
  return (
    <div className="fc-composer-editor__menu" role="menu" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitemradio" aria-checked={item.checked} onClick={() => onPick(item.id)}>
          {item.glyph ?? (item.swatch ? <span className="fc-composer-editor__swatch" style={{ background: item.swatch }} /> : null)}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
