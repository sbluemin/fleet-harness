import {
  CanvasTexture,
  ClampToEdgeWrapping,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";

/**
 * 초원 마을(지형·건물·목재·석재·지붕·나뭇잎·접지 AO·이정표·성문 배너·낚시터·청사진) 전용 절차적 PBR/캔버스 텍스처 팩.
 *
 * 외부 이미지 파일 없이 런타임 캔버스에서 심리스(tileable) Albedo + Bump 맵 및
 * 마을 표지판·성문 배너·광장 이정표·낚시터 팻말·Tier 0 청사진 텍스처를 생성한다.
 * 보안 불변식: 어떤 텍스처에도 원시 파일시스템 `path`/`cwd` 문자열을 절대 그리지 않는다.
 */

export interface MeadowTexturePack {
  readonly terrainMap: CanvasTexture;
  readonly terrainBump: CanvasTexture;
  readonly plasterMap: CanvasTexture;
  readonly plasterBump: CanvasTexture;
  readonly woodMap: CanvasTexture;
  readonly woodBump: CanvasTexture;
  readonly barkMap: CanvasTexture;
  readonly barkBump: CanvasTexture;
  readonly stoneMap: CanvasTexture;
  readonly stoneBump: CanvasTexture;
  readonly roofMap: CanvasTexture;
  readonly roofBump: CanvasTexture;
  readonly foliageMap: CanvasTexture;
  readonly foliageBump: CanvasTexture;
  readonly contactShadowMap: CanvasTexture;
  readonly fishingSignMap: CanvasTexture;
  readonly blueprintEaselMap: CanvasTexture;
  readonly plazaSignRightMap: CanvasTexture;
  readonly plazaSignLeftMap: CanvasTexture;
  readonly roadSignRightMap: CanvasTexture;
  readonly roadSignLeftMap: CanvasTexture;
  dispose(): void;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  return [canvas, ctx];
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  isColor: boolean,
): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (isColor) tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 타일 경계에서 끊기지 않게 3x3 래핑으로 브러시 스트로크를 찍는다 (화면 밖 타일은 스킵). */
function drawWrapped(
  size: number,
  x: number,
  y: number,
  margin: number,
  draw: (ox: number, oy: number) => void,
): void {
  for (let ox = -size; ox <= size; ox += size) {
    const px = x + ox;
    if (px + margin < 0 || px - margin > size) continue;
    for (let oy = -size; oy <= size; oy += size) {
      const py = y + oy;
      if (py + margin < 0 || py - margin > size) continue;
      draw(px, py);
    }
  }
}

function buildTerrainPair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(101);

  // 정점 컬러(잔디·오솔길·광장 돌·강변)와 곱해지므로 밝은 중립 회화 톤을 베이스로 둔다
  ctxC.fillStyle = "#ecece6";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#808080";
  ctxB.fillRect(0, 0, size, size);

  // 부드러운 잔디/흙 패치 붓터치
  for (let i = 0; i < 420; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const rx = 6 + rng() * 18;
    const ry = 4 + rng() * 12;
    const rot = rng() * Math.PI;
    const shade = Math.round(218 + rng() * 34);
    const warm = Math.round((rng() - 0.5) * 10);
    const bVal = Math.round(112 + rng() * 34);
    drawWrapped(size, x, y, Math.max(rx, ry) + 2, (px, py) => {
      ctxC.save();
      ctxC.translate(px, py);
      ctxC.rotate(rot);
      ctxC.fillStyle = `rgba(${shade + warm}, ${shade}, ${shade - warm}, 0.24)`;
      ctxC.beginPath();
      ctxC.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctxC.fill();
      ctxC.restore();

      ctxB.save();
      ctxB.translate(px, py);
      ctxB.rotate(rot);
      ctxB.fillStyle = `rgba(${bVal}, ${bVal}, ${bVal}, 0.28)`;
      ctxB.beginPath();
      ctxB.ellipse(0, 0, rx * 0.85, ry * 0.85, 0, 0, Math.PI * 2);
      ctxB.fill();
      ctxB.restore();
    });
  }

  // 잔디 결 / 미세 자갈 점묘
  for (let i = 0; i < 1600; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 3 + rng() * 7;
    const ang = -0.35 + rng() * 0.7;
    const bright = rng() > 0.45;
    ctxC.strokeStyle = bright ? "rgba(255,255,244,0.22)" : "rgba(150,165,142,0.22)";
    ctxC.lineWidth = 1.2;
    ctxC.beginPath();
    ctxC.moveTo(x, y);
    ctxC.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctxC.stroke();

    ctxB.fillStyle = bright ? "rgba(205,205,205,0.34)" : "rgba(72,72,72,0.34)";
    ctxB.fillRect(x, y, 2, 2);
  }

  return [
    finalizeTexture(cCol, 28, 28, true),
    finalizeTexture(cBmp, 28, 28, false),
  ];
}

function buildPlasterPair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(202);

  ctxC.fillStyle = "#f4ede0";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#808080";
  ctxB.fillRect(0, 0, size, size);

  // 손미장 흙벽(스타코) 붓결
  for (let i = 0; i < 520; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 8 + rng() * 24;
    const v = Math.round(226 + rng() * 24);
    const bv = Math.round(108 + rng() * 44);
    drawWrapped(size, x, y, r + 2, (px, py) => {
      ctxC.fillStyle = `rgba(${v}, ${v - 7}, ${v - 16}, 0.18)`;
      ctxC.beginPath();
      ctxC.ellipse(px, py, r, r * 0.65, rng() * Math.PI, 0, Math.PI * 2);
      ctxC.fill();

      ctxB.fillStyle = `rgba(${bv}, ${bv}, ${bv}, 0.22)`;
      ctxB.beginPath();
      ctxB.ellipse(px, py, r * 0.9, r * 0.55, rng() * Math.PI, 0, Math.PI * 2);
      ctxB.fill();
    });
  }

  // 미세 모래 알갱이
  for (let i = 0; i < 1800; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const g = rng() > 0.5 ? 250 : 196;
    ctxC.fillStyle = `rgba(${g}, ${g - 6}, ${g - 12}, 0.25)`;
    ctxC.fillRect(x, y, 1.5, 1.5);
    const bg = rng() > 0.5 ? 168 : 96;
    ctxB.fillStyle = `rgba(${bg}, ${bg}, ${bg}, 0.35)`;
    ctxB.fillRect(x, y, 1.5, 1.5);
  }

  return [
    finalizeTexture(cCol, 2, 2, true),
    finalizeTexture(cBmp, 2, 2, false),
  ];
}

function buildWoodPair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(303);

  ctxC.fillStyle = "#dfd7cc";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#888888";
  ctxB.fillRect(0, 0, size, size);

  const planks = 4;
  const plankH = size / planks;
  for (let p = 0; p < planks; p += 1) {
    const y0 = p * plankH;
    const tone = Math.round(212 + (rng() - 0.5) * 28);
    ctxC.fillStyle = `rgb(${tone}, ${tone - 6}, ${tone - 14})`;
    ctxC.fillRect(0, y0, size, plankH);

    // 나뭇결 섬유선
    for (let g = 0; g < 34; g += 1) {
      const gy = y0 + rng() * plankH;
      const dark = rng() > 0.45;
      ctxC.strokeStyle = dark ? "rgba(110, 88, 66, 0.22)" : "rgba(255, 248, 236, 0.20)";
      ctxC.lineWidth = 1 + rng() * 1.6;
      ctxC.beginPath();
      ctxC.moveTo(0, gy);
      for (let x = 0; x <= size; x += 32) {
        ctxC.lineTo(x, gy + Math.sin(x * 0.05 + g) * 2.2);
      }
      ctxC.stroke();

      ctxB.strokeStyle = dark ? "rgba(86, 86, 86, 0.35)" : "rgba(176, 176, 176, 0.3)";
      ctxB.lineWidth = 1.2;
      ctxB.beginPath();
      ctxB.moveTo(0, gy);
      ctxB.lineTo(size, gy);
      ctxB.stroke();
    }

    // 판자 이음새 홈
    ctxC.fillStyle = "rgba(62, 46, 32, 0.48)";
    ctxC.fillRect(0, y0, size, 2.5);
    ctxB.fillStyle = "#262626";
    ctxB.fillRect(0, y0, size, 3);
  }

  return [
    finalizeTexture(cCol, 1.5, 1.5, true),
    finalizeTexture(cBmp, 1.5, 1.5, false),
  ];
}

function buildBarkPair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(404);

  ctxC.fillStyle = "#cfc3b4";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#808080";
  ctxB.fillRect(0, 0, size, size);

  // 세로 수피 골
  for (let i = 0; i < 120; i += 1) {
    const x = rng() * size;
    const w = 2 + rng() * 6;
    const dark = rng() > 0.42;
    ctxC.fillStyle = dark ? "rgba(80, 56, 38, 0.34)" : "rgba(232, 218, 198, 0.28)";
    ctxB.fillStyle = dark ? "rgba(42, 42, 42, 0.45)" : "rgba(195, 195, 195, 0.4)";
    let y = 0;
    while (y < size) {
      const seg = 18 + rng() * 40;
      const drift = (rng() - 0.5) * 3;
      drawWrapped(size, x + drift, y, Math.max(w, seg) + 2, (px, py) => {
        ctxC.fillRect(px, py, w, seg);
        ctxB.fillRect(px, py, w, seg);
      });
      y += seg + 4;
    }
  }

  return [
    finalizeTexture(cCol, 1.5, 2, true),
    finalizeTexture(cBmp, 1.5, 2, false),
  ];
}

function buildStonePair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(505);

  // 줄눈(모르타르) 배경
  ctxC.fillStyle = "#9aa3ad";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#2c2c2c";
  ctxB.fillRect(0, 0, size, size);

  const rows = 6;
  const cols = 4;
  const rh = size / rows;
  const cw = size / cols;

  for (let r = 0; r < rows; r += 1) {
    const offset = (r % 2) * (cw * 0.5);
    for (let c = -1; c <= cols; c += 1) {
      const x = c * cw + offset;
      const y = r * rh;
      const pad = 3.2;
      const tone = Math.round(206 + (rng() - 0.5) * 38);
      const tint = Math.round((rng() - 0.5) * 14);
      ctxC.fillStyle = `rgb(${tone + tint}, ${tone}, ${tone - tint * 0.5})`;
      ctxC.beginPath();
      ctxC.roundRect(x + pad, y + pad, cw - pad * 2, rh - pad * 2, 6);
      ctxC.fill();

      const bTone = Math.round(168 + (rng() - 0.5) * 42);
      ctxB.fillStyle = `rgb(${bTone}, ${bTone}, ${bTone})`;
      ctxB.beginPath();
      ctxB.roundRect(x + pad, y + pad, cw - pad * 2, rh - pad * 2, 6);
      ctxB.fill();
    }
  }

  // 돌 표면 미세 얼룩
  for (let i = 0; i < 1200; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const bright = rng() > 0.5;
    ctxC.fillStyle = bright ? "rgba(255,255,255,0.14)" : "rgba(65,75,88,0.15)";
    ctxC.fillRect(x, y, 2.2, 2.2);
    ctxB.fillStyle = bright ? "rgba(215,215,215,0.22)" : "rgba(70,70,70,0.24)";
    ctxB.fillRect(x, y, 2, 2);
  }

  return [
    finalizeTexture(cCol, 2, 2, true),
    finalizeTexture(cBmp, 2, 2, false),
  ];
}

function buildRoofPair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(606);

  // 중립 밝은 회백색 기와 베이스 (머티리얼 color가 지붕 색상을 자연스럽게 입힘)
  ctxC.fillStyle = "#d4d4d4";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#505050";
  ctxB.fillRect(0, 0, size, size);

  const rows = 8;
  const cols = 6;
  const rh = size / rows;
  const cw = size / cols;

  for (let r = 0; r < rows; r += 1) {
    const offset = (r % 2) * (cw * 0.5);
    const y = r * rh;
    for (let c = -1; c <= cols; c += 1) {
      const x = c * cw + offset;
      const v = Math.round(214 + (rng() - 0.5) * 34);

      const gradC = ctxC.createLinearGradient(0, y, 0, y + rh);
      gradC.addColorStop(0, `rgb(${Math.max(120, v - 36)}, ${Math.max(120, v - 36)}, ${Math.max(120, v - 32)})`);
      gradC.addColorStop(0.75, `rgb(${v}, ${v}, ${v})`);
      gradC.addColorStop(1, `rgb(${Math.min(255, v + 18)}, ${Math.min(255, v + 18)}, ${Math.min(255, v + 16)})`);
      ctxC.fillStyle = gradC;
      ctxC.beginPath();
      ctxC.roundRect(x + 1.5, y + 1, cw - 3, rh - 1.5, [2, 2, 8, 8]);
      ctxC.fill();

      ctxC.strokeStyle = "rgba(40, 40, 46, 0.32)";
      ctxC.lineWidth = 1.4;
      ctxC.stroke();

      const gradB = ctxB.createLinearGradient(0, y, 0, y + rh);
      gradB.addColorStop(0, "#464646");
      gradB.addColorStop(0.82, "#d8d8d8");
      gradB.addColorStop(1, "#2a2a2a");
      ctxB.fillStyle = gradB;
      ctxB.beginPath();
      ctxB.roundRect(x + 1.5, y + 1, cw - 3, rh - 1.5, [2, 2, 8, 8]);
      ctxB.fill();
    }
  }

  return [
    finalizeTexture(cCol, 2.2, 2.2, true),
    finalizeTexture(cBmp, 2.2, 2.2, false),
  ];
}

function buildFoliagePair(): [CanvasTexture, CanvasTexture] {
  const size = 256;
  const [cCol, ctxC] = makeCanvas(size);
  const [cBmp, ctxB] = makeCanvas(size);
  const rng = mulberry32(707);

  ctxC.fillStyle = "#d8ded6";
  ctxC.fillRect(0, 0, size, size);
  ctxB.fillStyle = "#767676";
  ctxB.fillRect(0, 0, size, size);

  // 지브리/동물의 숲풍 점묘 잎사귀 클러스터 질감
  for (let i = 0; i < 650; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const rx = 5 + rng() * 11;
    const ry = 3 + rng() * 6;
    const rot = rng() * Math.PI * 2;
    const light = rng();
    const shade = Math.round(176 + light * 76);
    const bVal = Math.round(68 + light * 165);
    drawWrapped(size, x, y, Math.max(rx, ry) + 2, (px, py) => {
      ctxC.save();
      ctxC.translate(px, py);
      ctxC.rotate(rot);
      ctxC.fillStyle = `rgba(${shade}, ${Math.min(255, shade + 6)}, ${Math.max(140, shade - 8)}, 0.58)`;
      ctxC.beginPath();
      ctxC.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctxC.fill();
      ctxC.restore();

      ctxB.save();
      ctxB.translate(px, py);
      ctxB.rotate(rot);
      ctxB.fillStyle = `rgba(${bVal}, ${bVal}, ${bVal}, 0.55)`;
      ctxB.beginPath();
      ctxB.ellipse(0, 0, rx * 0.9, ry * 0.9, 0, 0, Math.PI * 2);
      ctxB.fill();
      ctxB.restore();
    });
  }

  return [
    finalizeTexture(cCol, 2, 2, true),
    finalizeTexture(cBmp, 2, 2, false),
  ];
}

function buildContactShadowMap(): CanvasTexture {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, "rgba(18, 36, 26, 0.52)");
  grad.addColorStop(0.55, "rgba(22, 44, 32, 0.28)");
  grad.addColorStop(1, "rgba(22, 44, 32, 0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeRectCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  return [canvas, ctx];
}

function finalizeSignTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function hexToCss(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return alpha >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 표지판·배너 캔버스 표시용 안전 라벨 정제 (보안 불변식: 원시 파일시스템 path/cwd 조각 원천 차단).
 */
export function sanitizeSignDisplayText(raw: string, maxChars = 10): string {
  const trimmed = raw.trim();
  if (!trimmed) return "FLEET";
  // 경로 구분자(/, \, :, ~)가 포함된 문자열은 마지막 안전 토큰만 취하거나 일반 약칭으로 대체한다.
  if (/[\\/]|^[a-zA-Z]:|^~/.test(trimmed)) {
    return "FLEET";
  }
  const cleaned = trimmed.replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

function extractSignMonogram(raw: string): string {
  const safe = sanitizeSignDisplayText(raw, 12);
  const words = safe.split(" ").filter(Boolean);
  if (words.length >= 2) {
    const a = Array.from(words[0]!)[0] ?? "";
    const b = Array.from(words[1]!)[0] ?? "";
    const combo = `${a}${b}`.trim();
    if (combo) return combo.toUpperCase();
  }
  const chars = Array.from(safe);
  return chars.slice(0, Math.min(2, chars.length)).join("").toUpperCase() || "★";
}

function drawWoodPlankBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  baseLight = "#e8cfa6",
  baseDark = "#d6b482",
): void {
  const rng = mulberry32(seed);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, baseLight);
  grad.addColorStop(1, baseDark);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 42; i += 1) {
    const y = rng() * h;
    ctx.strokeStyle = rng() > 0.45 ? "rgba(116, 78, 42, 0.16)" : "rgba(255, 248, 232, 0.18)";
    ctx.lineWidth = 1 + rng() * 1.8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 32) {
      ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 2.2);
    }
    ctx.stroke();
  }
}

function drawEmblemStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  points = 5,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR;
    const ang = -Math.PI * 0.5 + (i * Math.PI) / points;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * 마을 입구 나무 표지판 전용 캔버스 텍스처 (사령관 약칭 · 문양 배지 · 발전도 별).
 * 호출자가 수명 종료 시 `dispose()`로 해제한다.
 */
export function createVillageSignTexture(
  label: string,
  toneHex: number,
  tier: number,
  theme: string,
): CanvasTexture {
  const w = 256;
  const h = 128;
  const [canvas, ctx] = makeRectCanvas(w, h);
  const safeLabel = sanitizeSignDisplayText(label, 9);
  const monogram = extractSignMonogram(safeLabel);

  const isSnow = theme === "snow";
  const isSakura = theme === "sakura";
  const isAutumn = theme === "autumn";

  drawWoodPlankBackdrop(
    ctx,
    w,
    h,
    811 + tier * 31 + safeLabel.length * 7,
    isSnow ? "#e5edf4" : isSakura ? "#f3dfdc" : isAutumn ? "#ecd0a6" : "#ebd4ad",
    isSnow ? "#cad8e6" : isSakura ? "#dfc0bd" : isAutumn ? "#d4a671" : "#d3b180",
  );

  // 어두운 목재 테두리 + 사각 황동 리벳
  ctx.strokeStyle = isSnow ? "#475d73" : "#5a3a22";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.strokeStyle = hexToCss(toneHex, 0.72);
  ctx.lineWidth = 2.5;
  ctx.strokeRect(12, 12, w - 24, h - 24);

  for (const [rx, ry] of [[18, 18], [w - 18, 18], [18, h - 18], [w - 18, h - 18]] as const) {
    ctx.fillStyle = "#d4a437";
    ctx.beginPath();
    ctx.arc(rx, ry, 3.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 좌측 원형 문양 엠블럼
  const badgeX = 48;
  const badgeY = h * 0.5;
  ctx.fillStyle = hexToCss(toneHex, 0.94);
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff7df";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = "#fffdf6";
  ctx.font = "700 20px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(monogram, badgeX, badgeY + 1);

  // 우측 마을 약칭 텍스트
  ctx.fillStyle = isSnow ? "#1e2e40" : "#3a2212";
  const fontSize = safeLabel.length > 7 ? 24 : safeLabel.length > 5 ? 27 : 31;
  ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(safeLabel, 84, 52, w - 102);

  // 하단 발전도 별 + 테마 소형 장식선
  const clampedTier = Math.max(0, Math.min(5, Math.round(tier)));
  for (let i = 0; i < 5; i += 1) {
    const sx = 92 + i * 21;
    const sy = 90;
    drawEmblemStar(ctx, sx, sy, 7.2, 3.3, 5);
    ctx.fillStyle = i < clampedTier ? "#d97706" : "rgba(90, 58, 34, 0.24)";
    ctx.fill();
  }

  return finalizeSignTexture(canvas);
}

/**
 * 마을 성문 좌/우 드리운 세로 문장 배너 캔버스 텍스처.
 * 호출자가 수명 종료 시 `dispose()`로 해제한다.
 */
export function createGateBannerTexture(
  label: string,
  toneHex: number,
  theme: string,
): CanvasTexture {
  const w = 128;
  const h = 256;
  const [canvas, ctx] = makeRectCanvas(w, h);
  const monogram = extractSignMonogram(label);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hexToCss(toneHex, 1));
  grad.addColorStop(0.75, hexToCss(toneHex, 0.88));
  grad.addColorStop(1, "#27232c");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 직물 미세 세로결
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  for (let x = 6; x < w; x += 8) {
    ctx.fillRect(x, 0, 2, h);
  }

  // 황금 테두리 & 하단 V자 장식 띠
  ctx.strokeStyle = "#f8df8c";
  ctx.lineWidth = 6;
  ctx.strokeRect(9, 9, w - 18, h - 22);

  ctx.strokeStyle = "rgba(255, 245, 205, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, w - 32, h - 36);

  // 중앙 방패 문양 + 별빛 장식
  ctx.fillStyle = "rgba(24, 24, 34, 0.36)";
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 48);
  ctx.lineTo(w - 28, 64);
  ctx.lineTo(w - 30, 128);
  ctx.quadraticCurveTo(w * 0.5, 162, 30, 128);
  ctx.lineTo(28, 64);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#f8df8c";
  ctx.lineWidth = 3;
  ctx.stroke();

  // 테마 아이콘 상단 별
  drawEmblemStar(ctx, w * 0.5, 76, 11, 4.8, theme === "snow" ? 6 : 5);
  ctx.fillStyle = "#fef3c7";
  ctx.fill();

  // 사령관 약칭 모노그램
  ctx.fillStyle = "#fffdf5";
  ctx.font = "800 32px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(monogram, w * 0.5, 118);

  // 하단 3단 황금 문양선
  ctx.fillStyle = "#f8df8c";
  ctx.fillRect(28, 184, w - 56, 4);
  drawEmblemStar(ctx, w * 0.5, 210, 10, 4.5, 4);
  ctx.fill();

  return finalizeSignTexture(canvas);
}

/**
 * 마을 성문 중앙 상인방 현판 캔버스 텍스처.
 * 호출자가 수명 종료 시 `dispose()`로 해제한다.
 */
export function createGatePlaqueTexture(
  label: string,
  toneHex: number,
  tier: number,
): CanvasTexture {
  const w = 256;
  const h = 96;
  const [canvas, ctx] = makeRectCanvas(w, h);
  const safeLabel = sanitizeSignDisplayText(label, 10);

  drawWoodPlankBackdrop(ctx, w, h, 919 + tier * 17, "#4d3524", "#362317");

  ctx.strokeStyle = "#e8c66b";
  ctx.lineWidth = 5;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.strokeStyle = hexToCss(toneHex, 0.85);
  ctx.lineWidth = 2.5;
  ctx.strokeRect(12, 12, w - 24, h - 24);

  // 좌우 다이아몬드 문양
  for (const dx of [28, w - 28]) {
    drawEmblemStar(ctx, dx, h * 0.5, 9, 4, 4);
    ctx.fillStyle = "#f8df8c";
    ctx.fill();
  }

  ctx.fillStyle = "#fff8e7";
  const fontSize = safeLabel.length > 8 ? 24 : safeLabel.length > 5 ? 28 : 32;
  ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(safeLabel, w * 0.5, h * 0.5 + 1, w - 76);

  return finalizeSignTexture(canvas);
}

/**
 * 광장 및 갈림길 방향 이정표 화살표 판자 텍스처.
 */
export function createDirectionalSignTexture(
  text: string,
  direction: "left" | "right",
  accentHex = 0x3b82f6,
): CanvasTexture {
  const w = 256;
  const h = 64;
  const [canvas, ctx] = makeRectCanvas(w, h);
  const safeText = sanitizeSignDisplayText(text, 10);

  drawWoodPlankBackdrop(ctx, w, h, direction === "right" ? 711 : 733, "#e9d0a4", "#cfb07d");

  ctx.strokeStyle = "#5c3b22";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  // 방향 화살표 심볼
  const arrowX = direction === "right" ? w - 34 : 34;
  ctx.fillStyle = hexToCss(accentHex, 0.92);
  ctx.beginPath();
  if (direction === "right") {
    ctx.moveTo(arrowX - 10, 20);
    ctx.lineTo(arrowX + 12, 32);
    ctx.lineTo(arrowX - 10, 44);
  } else {
    ctx.moveTo(arrowX + 10, 20);
    ctx.lineTo(arrowX - 12, 32);
    ctx.lineTo(arrowX + 10, 44);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#3b2313";
  ctx.font = "800 24px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(safeText, direction === "right" ? w * 0.44 : w * 0.56, h * 0.5 + 1, w - 76);

  return finalizeSignTexture(canvas);
}

/**
 * 시냇가 상시 낚시 포인트 3D 팻말 캔버스 텍스처 (물고기 아이콘 + 파도 + 낚시터 안내).
 */
export function createFishingSpotSignTexture(): CanvasTexture {
  const w = 256;
  const h = 160;
  const [canvas, ctx] = makeRectCanvas(w, h);

  drawWoodPlankBackdrop(ctx, w, h, 1049, "#dff3fb", "#b7e1f4");

  ctx.strokeStyle = "#4b3421";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.strokeStyle = "#0284c7";
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, w - 28, h - 28);

  // 아기자기한 물고기 실루엣
  ctx.save();
  ctx.translate(w * 0.5 - 6, 62);
  ctx.fillStyle = "#0369a1";
  ctx.beginPath();
  ctx.ellipse(0, 0, 38, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-34, 0);
  ctx.lineTo(-56, -18);
  ctx.lineTo(-56, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#e0f2fe";
  ctx.beginPath();
  ctx.arc(18, -5, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(19.5, -5, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 잔잔한 물결 2줄
  ctx.strokeStyle = "#0284c7";
  ctx.lineWidth = 3.5;
  for (const wy of [94, 105]) {
    ctx.beginPath();
    for (let x = 42; x <= w - 42; x += 8) {
      const y = wy + Math.sin(x * 0.14) * 3.2;
      if (x === 42) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.fillStyle = "#0c4a6e";
  ctx.font = "800 24px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("낚시터", w * 0.5, 131);

  return finalizeSignTexture(canvas);
}

/**
 * Tier 0 확장 예정지 이젤 청사진 캔버스 텍스처 (건축 그리드 + 주택 입면도 스케치 + 나침반).
 */
export function createBlueprintEaselTexture(): CanvasTexture {
  const w = 256;
  const h = 192;
  const [canvas, ctx] = makeRectCanvas(w, h);

  // 클래식 청사진 시아노타입 배경
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#1d4e89");
  grad.addColorStop(1, "#163a6b");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 모눈 그리드
  ctx.strokeStyle = "rgba(186, 230, 253, 0.18)";
  ctx.lineWidth = 1;
  for (let x = 16; x < w; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, h - 12);
    ctx.stroke();
  }
  for (let y = 16; y < h; y += 16) {
    ctx.beginPath();
    ctx.moveTo(12, y);
    ctx.lineTo(w - 12, y);
    ctx.stroke();
  }

  // 이중 도면 테두리
  ctx.strokeStyle = "rgba(224, 242, 254, 0.85)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.lineWidth = 1.2;
  ctx.strokeRect(16, 16, w - 32, h - 32);

  // 좌측: 아담한 공방 주택 입면도 청사진 스케치
  ctx.strokeStyle = "#e0f2fe";
  ctx.lineWidth = 2.6;
  ctx.strokeRect(42, 86, 86, 56);
  ctx.beginPath();
  ctx.moveTo(32, 88);
  ctx.lineTo(85, 44);
  ctx.lineTo(138, 88);
  ctx.stroke();
  // 문·창문·굴뚝
  ctx.strokeRect(58, 112, 22, 30);
  ctx.strokeRect(94, 100, 20, 20);
  ctx.strokeRect(108, 48, 12, 24);

  // 치수 보조선 (점선)
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(186, 230, 253, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(42, 154);
  ctx.lineTo(128, 154);
  ctx.stroke();
  ctx.restore();

  // 우측: 원형 부지 평면도 + 나침반 별
  ctx.strokeStyle = "#bae6fd";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(192, 82, 28, 0, Math.PI * 2);
  ctx.stroke();
  drawEmblemStar(ctx, 192, 82, 16, 6, 4);
  ctx.fillStyle = "rgba(224, 242, 254, 0.85)";
  ctx.fill();

  // 우하단 도면 표제란
  ctx.strokeStyle = "rgba(224, 242, 254, 0.78)";
  ctx.lineWidth = 1.8;
  ctx.strokeRect(150, 128, 84, 38);
  ctx.fillStyle = "#e0f2fe";
  ctx.font = "700 15px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("PLAN T0", 192, 147);

  return finalizeSignTexture(canvas);
}

interface CachedMeadowTextures {
  readonly pack: Omit<MeadowTexturePack, "dispose">;
  readonly all: readonly Texture[];
}

let cachedMeadowTextures: CachedMeadowTextures | null = null;

function ensureCachedMeadowTextures(): CachedMeadowTextures {
  if (cachedMeadowTextures) return cachedMeadowTextures;

  const [terrainMap, terrainBump] = buildTerrainPair();
  const [plasterMap, plasterBump] = buildPlasterPair();
  const [woodMap, woodBump] = buildWoodPair();
  const [barkMap, barkBump] = buildBarkPair();
  const [stoneMap, stoneBump] = buildStonePair();
  const [roofMap, roofBump] = buildRoofPair();
  const [foliageMap, foliageBump] = buildFoliagePair();
  const contactShadowMap = buildContactShadowMap();
  const fishingSignMap = createFishingSpotSignTexture();
  const blueprintEaselMap = createBlueprintEaselTexture();
  const plazaSignRightMap = createDirectionalSignTexture("길드 광장", "right", 0xd97706);
  const plazaSignLeftMap = createDirectionalSignTexture("시냇가 낚시", "left", 0x0284c7);
  const roadSignRightMap = createDirectionalSignTexture("마을 길", "right", 0x16a34a);
  const roadSignLeftMap = createDirectionalSignTexture("중앙 광장", "left", 0xd97706);

  const all: readonly Texture[] = [
    terrainMap,
    terrainBump,
    plasterMap,
    plasterBump,
    woodMap,
    woodBump,
    barkMap,
    barkBump,
    stoneMap,
    stoneBump,
    roofMap,
    roofBump,
    foliageMap,
    foliageBump,
    contactShadowMap,
    fishingSignMap,
    blueprintEaselMap,
    plazaSignRightMap,
    plazaSignLeftMap,
    roadSignRightMap,
    roadSignLeftMap,
  ];

  cachedMeadowTextures = {
    pack: {
      terrainMap,
      terrainBump,
      plasterMap,
      plasterBump,
      woodMap,
      woodBump,
      barkMap,
      barkBump,
      stoneMap,
      stoneBump,
      roofMap,
      roofBump,
      foliageMap,
      foliageBump,
      contactShadowMap,
      fishingSignMap,
      blueprintEaselMap,
      plazaSignRightMap,
      plazaSignLeftMap,
      roadSignRightMap,
      roadSignLeftMap,
    },
    all,
  };
  return cachedMeadowTextures;
}

/**
 * 초원 PBR 텍스처 팩을 모듈 싱글톤 캐시에서 반환한다.
 * 더 월드를 닫았다 다시 입장해도 15개 Canvas2D 텍스처를 재생성하지 않아 재입장 히치가 0ms가 된다.
 */
export function createMeadowTexturePack(): MeadowTexturePack {
  const { pack } = ensureCachedMeadowTextures();
  return {
    ...pack,
    dispose() {
      // 모듈 싱글톤 캐시가 수명 동안 텍스처를 보관한다.
    },
  };
}

export function disposeMeadowTexturePackCache(): void {
  if (!cachedMeadowTextures) return;
  for (const tex of cachedMeadowTextures.all) tex.dispose();
  cachedMeadowTextures = null;
}
