import type { ChromeUiState } from "../contract.js";
import { clear, G, glyph, h } from "./dom.js";
import { post, type T } from "./shared.js";

export interface Annotator { update(state: ChromeUiState): void; inspected(seq: number, element: unknown): void; dispose(): void }

interface ElementInfo { readonly tag: string; readonly id: string | null; readonly classes: readonly string[]; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly component: string | null; readonly styles: Record<string, string> }
type Pt = { x: number; y: number };
type Stroke = { tool: "pen"; color: string; points: Pt[] } | { tool: "arrow" | "rect"; color: string; a: Pt; b: Pt };
interface Pin { x: number; y: number; text: string }
type Mark = { kind: "stroke"; stroke: Stroke } | { kind: "pin"; pin: Pin };
type Tool = "comment" | "pen" | "arrow" | "rect";
/** 주석 잉크는 견본(`.swatch-*`)의 계산된 색이다 — Console 과 같은 토큰(`--id-*`)을 같은 길로 읽는다. */
const INK_KEYS = ["red", "blue", "green", "black"] as const;

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number): void {
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineWidth = 2.5 * scale; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const s = (p: Pt) => ({ x: p.x * scale, y: p.y * scale });
  if (stroke.tool === "pen") { ctx.beginPath(); stroke.points.forEach((p, i) => { const q = s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); }); ctx.stroke(); return; }
  const a = s(stroke.a), b = s(stroke.b);
  if (stroke.tool === "rect") { ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); return; }
  const ang = Math.atan2(b.y - a.y, b.x - a.x); const head = 12 * scale;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4)); ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
}

/** 번호 핀 — 첨부 이미지에도 화면과 같은 자리에 같은 번호로 찍힌다. */
function drawPin(ctx: CanvasRenderingContext2D, pin: Pin, n: number, scale: number, color: string, canvasWidth: number): void {
  const x = pin.x * scale, y = pin.y * scale, r = 11 * scale;
  ctx.font = `500 ${12 * scale}px system-ui, sans-serif`; ctx.textBaseline = "middle";
  const pad = 6 * scale, gap = 6 * scale, boxHeight = 22 * scale;
  const w = Math.min(ctx.measureText(pin.text).width + pad * 2, canvasWidth * 0.6);
  const left = x + r + gap + w <= canvasWidth ? x + r + gap : Math.max(0, x - r - gap - w);
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = color; ctx.lineWidth = 1.5 * scale;
  ctx.beginPath(); ctx.roundRect(left, y - boxHeight / 2, w, boxHeight, 4 * scale); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.rect(left, y - boxHeight / 2, w, boxHeight); ctx.clip();
  ctx.fillStyle = "#111111"; ctx.textAlign = "left"; ctx.fillText(pin.text, left + pad, y);
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2 * scale; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  ctx.fillStyle = "#ffffff"; ctx.font = `700 ${12 * scale}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.fillText(String(n), x, y);
}

const hex = (value: string | undefined): string => {
  const m = value ? /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value.trim()) : null;
  if (!value || !m || (m[4] !== undefined && Number(m[4]) < 1)) return value ?? "";
  return `#${[m[1], m[2], m[3]].map((part) => Number(part).toString(16).padStart(2, "0").toUpperCase()).join("")}`;
};

/**
 * 주석 편집기 — 찍어 둔 한 장 위에 요소 댓글·펜·화살표·사각형을 얹는다. 첨부는 결과 PNG 한 장이고 그것만 main 을 거쳐 Console 로 간다.
 * 화면은 이 문서가 그리므로 Console 의 렌더러·모달을 거치지 않는다.
 */
export function mountAnnotate(host: HTMLElement, initial: ChromeUiState, t: T): Annotator {
  let shot = (initial.overlay as Extract<NonNullable<ChromeUiState["overlay"]>, { kind: "annotate" }>).shot;
  let state = initial;
  const marks: Mark[] = [];
  let tool: Tool = "comment";
  let colorKey: (typeof INK_KEYS)[number] = "red";
  let drawing: Stroke | null = null;
  let draftPin: { x: number; y: number } | null = null;
  let hover: ElementInfo | null = null;
  let seq = 0;
  let waiting = false;
  let lastMove = 0;

  const root = h("div", { class: "annotate" });
  const stage = h("div", { class: "stage" });
  const image = h("img", { class: "frame", src: `data:${shot.mime};base64,${shot.data}`, alt: t("pageFrame"), draggable: false });
  const canvas = h("canvas", { class: "sketch is-comment", attrs: { "aria-label": t("annotate") } });
  const highlight = h("div", { class: "highlight", hidden: true as unknown as boolean });
  const hovercard = h("div", { class: "hovercard", hidden: true as unknown as boolean });
  const pins = h("div", { class: "pins" });
  const comment = h("div", { class: "comment", role: "dialog", hidden: true as unknown as boolean, attrs: { "aria-label": t("tool.comment") } });
  const commentInput = h("input", { class: "comment-input", placeholder: t("commentPlaceholder"), attrs: { "aria-label": t("commentPlaceholder") } });
  const commentOk = h("button", { class: "comment-ok", type: "button", attrs: { "aria-label": t("commentAdd") }, title: t("commentAdd") }, glyph(G.check));
  comment.append(commentInput, commentOk);
  const anchor = h("span", { class: "pin is-anchor", hidden: true as unknown as boolean });
  stage.append(image, canvas, highlight, hovercard, pins, anchor, comment);

  const bar = h("div", { class: "sketchbar", role: "toolbar", attrs: { "aria-label": t("annotate") } });
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  for (const entry of ["comment", "pen", "arrow", "rect"] as const) {
    const button = h("button", { class: "icon tool", type: "button", title: t(`tool.${entry}`), attrs: { "aria-label": t(`tool.${entry}`), "aria-pressed": String(entry === tool) } }, glyph(entry === "comment" ? G.comment : entry === "pen" ? G.pen : entry === "arrow" ? G.arrow : G.rect));
    button.addEventListener("click", () => { tool = entry; cancelPin(); sync(); });
    toolButtons.set(entry, button); bar.append(button);
  }
  const swatchColor = (key: string): string => { const swatch = swatches.get(key); return swatch ? getComputedStyle(swatch).backgroundColor : "#2f6fdd"; };
  const ink = (): string => swatchColor(colorKey);
  const divider = () => h("span", { class: "divider" });
  bar.append(divider());
  const swatches = new Map<string, HTMLButtonElement>();
  for (const key of INK_KEYS) {
    const swatch = h("button", { class: `swatch swatch-${key}`, type: "button", title: t(`color.${key}`), attrs: { "aria-label": t(`color.${key}`), "aria-pressed": String(key === colorKey) } });
    swatch.addEventListener("click", () => { colorKey = key; sync(); });
    swatches.set(key, swatch); bar.append(swatch);
  }
  bar.append(divider());
  const undo = h("button", { class: "icon", type: "button", title: t("undo"), attrs: { "aria-label": t("undo") } }, glyph(G.undo));
  const wipe = h("button", { class: "button", type: "button", text: t("clear") });
  const attach = h("button", { class: "button primary", type: "button" });
  const close = h("button", { class: "icon", type: "button", title: t("close"), attrs: { "aria-label": t("close") } }, glyph(G.close));
  bar.append(undo, wipe, divider(), attach, close);
  root.append(stage, bar);
  host.append(root);

  const place = (): void => {
    const page = state.page;
    root.style.left = `${page.x}px`; root.style.top = `${page.y}px`; root.style.width = `${page.width}px`; root.style.height = `${page.height}px`;
    stage.style.aspectRatio = `${shot.width} / ${shot.height}`;
    stage.style.width = `min(${shot.width}px, ${page.height * shot.width / shot.height}px, 100%)`;
  };
  const scale = (): number => (image.clientWidth > 0 ? shot.width / image.clientWidth : 1);
  /** 화면 px → 페이지 CSS px. */
  const point = (event: { clientX: number; clientY: number }): Pt | null => {
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: (event.clientX - rect.left) * (shot.width / rect.width), y: (event.clientY - rect.top) * (shot.height / rect.height) };
  };
  const stagePoint = (p: Pt): { left: string; top: string } => ({ left: `${p.x / shot.width * 100}%`, top: `${p.y / shot.height * 100}%` });

  const redraw = (): void => {
    const width = image.clientWidth, height = image.clientHeight;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const factor = width / shot.width;
    for (const mark of marks) if (mark.kind === "stroke") drawStroke(ctx, mark.stroke, factor);
    if (drawing) drawStroke(ctx, drawing, factor);
  };
  const renderPins = (): void => {
    clear(pins);
    marks.forEach((mark, index) => {
      if (mark.kind !== "pin") return;
      const at = stagePoint(mark.pin);
      const button = h("button", { class: "pin", type: "button", text: String(index + 1), attrs: { "aria-label": t("removePin", { n: String(index + 1) }) } });
      button.addEventListener("click", () => { marks.splice(index, 1); renderPins(); redraw(); sync(); });
      const wrap = h("span", { class: "pinwrap" }, button, h("span", { class: "pin-label", role: "tooltip", text: mark.pin.text }));
      wrap.style.left = at.left; wrap.style.top = at.top;
      pins.append(wrap);
    });
  };
  const sync = (): void => {
    for (const [name, button] of toolButtons) button.setAttribute("aria-pressed", String(name === tool));
    for (const [name, swatch] of swatches) swatch.setAttribute("aria-pressed", String(name === colorKey));
    undo.disabled = marks.length === 0; wipe.disabled = marks.length === 0;
    attach.disabled = marks.length === 0 || state.busy; attach.textContent = t("attachMarks", { count: String(marks.length) });
    canvas.classList.toggle("is-comment", tool === "comment");
    anchor.hidden = draftPin === null; comment.hidden = draftPin === null;
    if (draftPin) {
      const at = stagePoint(draftPin);
      anchor.style.left = at.left; anchor.style.top = at.top; anchor.textContent = String(marks.length + 1);
      comment.style.left = `clamp(8px, calc(${at.left} - 14px), max(8px, calc(100% - 328px)))`; comment.style.top = `calc(${at.top} + 18px)`;
    }
    const info = hover;
    const factor = scale();
    highlight.hidden = !info; hovercard.hidden = !info;
    if (info) {
      const box = { left: info.box.x / factor, top: info.box.y / factor, width: info.box.width / factor, height: info.box.height / factor };
      Object.assign(highlight.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      clear(hovercard);
      const name = `${info.tag}${info.id ? `#${info.id}` : info.classes[0] ? `.${info.classes[0]}` : ""}`;
      const row = (key: string, value: Node | string) => { hovercard.append(h("span", { class: "hovercard-key", text: key }), h("span", { class: "hovercard-value" }, value)); };
      hovercard.append(h("span", { class: "hovercard-name", text: name }), h("span", { class: "hovercard-value", text: `${info.box.width}×${info.box.height}` }));
      if (info.component) row(t("hover.component"), info.component);
      const swatch = h("span", { class: "hovercard-swatch" }); swatch.style.background = info.styles.color ?? "";
      row(t("hover.color"), swatch); hovercard.lastElementChild?.append(hex(info.styles.color));
      row(t("hover.font"), `${info.styles["font-size"] ?? ""} ${(info.styles["font-family"] ?? "").split(",")[0]?.replace(/["']/g, "") ?? ""}`);
      hovercard.style.left = `${Math.max(4, box.left)}px`;
      if (box.top > 92) { hovercard.style.top = ""; hovercard.style.bottom = `calc(100% - ${box.top - 6}px)`; } else { hovercard.style.bottom = ""; hovercard.style.top = `${box.top + box.height + 6}px`; }
    }
  };
  const cancelPin = (): void => { draftPin = null; commentInput.value = ""; };
  const confirmPin = (): void => {
    const text = commentInput.value.trim();
    if (!draftPin || !text) return;
    marks.push({ kind: "pin", pin: { x: draftPin.x, y: draftPin.y, text } });
    cancelPin(); hover = null; renderPins(); sync();
  };
  const inspect = (p: Pt): void => { seq += 1; waiting = true; post("bar", "annotate-inspect", { x: p.x, y: p.y, seq }); };

  canvas.addEventListener("pointerdown", (event) => {
    const p = point(event); if (!p) return;
    event.preventDefault();
    if (tool === "comment") {
      if (draftPin) { cancelPin(); sync(); return; }
      draftPin = p; sync(); commentInput.focus(); inspect(p);
      return;
    }
    drawing = tool === "pen" ? { tool: "pen", color: ink(), points: [p] } : { tool, color: ink(), a: p, b: p };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drawing) { const p = point(event); if (!p) return; if (drawing.tool === "pen") drawing.points.push(p); else drawing.b = p; redraw(); return; }
    if (tool !== "comment" || draftPin) return;
    const now = performance.now();
    if (waiting || now - lastMove < 90) return;
    lastMove = now;
    const p = point(event); if (p) inspect(p);
  });
  const up = (): void => { if (!drawing) return; marks.push({ kind: "stroke", stroke: drawing }); drawing = null; redraw(); sync(); };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { if (!drawing && !draftPin) { hover = null; sync(); } });
  commentInput.addEventListener("input", () => { commentOk.disabled = !commentInput.value.trim(); });
  commentInput.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); confirmPin(); } else if (event.key === "Escape") { event.preventDefault(); cancelPin(); sync(); }
  });
  commentOk.addEventListener("click", confirmPin);
  undo.addEventListener("click", () => { marks.pop(); renderPins(); redraw(); sync(); });
  wipe.addEventListener("click", () => { marks.length = 0; renderPins(); redraw(); sync(); });
  close.addEventListener("click", () => post("bar", "annotate-done", { png: null }));
  attach.addEventListener("click", () => {
    if (marks.length === 0) return;
    const out = document.createElement("canvas");
    out.width = image.naturalWidth; out.height = image.naturalHeight;
    const ctx = out.getContext("2d"); if (!ctx) return;
    ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
    const factor = image.naturalWidth / shot.width;
    const pinColor = swatchColor("blue");
    marks.forEach((mark, index) => { if (mark.kind === "stroke") drawStroke(ctx, mark.stroke, factor); else drawPin(ctx, mark.pin, index + 1, factor, pinColor, image.naturalWidth); });
    post("bar", "annotate-done", { png: out.toDataURL("image/png").split(",")[1] ?? "" });
  });
  image.addEventListener("load", () => { redraw(); sync(); });
  const resize = new ResizeObserver(() => { redraw(); sync(); });
  resize.observe(image);

  place(); sync(); redraw(); renderPins();
  void t;
  return {
    update(next) {
      state = next;
      const overlay = next.overlay;
      if (overlay?.kind === "annotate" && overlay.shot !== shot) { shot = overlay.shot; image.src = `data:${shot.mime};base64,${shot.data}`; }
      place(); sync();
    },
    inspected(answer, element) {
      if (answer !== seq) return;
      waiting = false;
      hover = element && typeof element === "object" ? element as ElementInfo : null;
      sync();
    },
    dispose() { resize.disconnect(); root.remove(); },
  };
}
