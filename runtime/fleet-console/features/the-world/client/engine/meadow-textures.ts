import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";

/**
 * 초원 마을(지형·건물·목재·석재·지붕·나뭇잎·접지 AO) 전용 절차적 PBR 텍스처 팩.
 *
 * 외부 이미지 파일 없이 런타임 캔버스에서 심리스(tileable) Albedo + Bump 맵을 1회 생성해
 * 단색 프리미티브 느낌을 없애고, 몽글 캐릭터의 포근한 3D 솜털 질감과 조화되는
 * 회화풍 디오라마 표면 밀도를 만든다.
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

/** 타일 경계에서 끊기지 않게 3x3 래핑으로 브러시 스트로크를 찍는다. */
function drawWrapped(
  size: number,
  x: number,
  y: number,
  draw: (ox: number, oy: number) => void,
): void {
  for (let ox = -size; ox <= size; ox += size) {
    for (let oy = -size; oy <= size; oy += size) {
      draw(x + ox, y + oy);
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
    drawWrapped(size, x, y, (px, py) => {
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
    drawWrapped(size, x, y, (px, py) => {
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
      drawWrapped(size, x + drift, y, (px, py) => {
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
    drawWrapped(size, x, y, (px, py) => {
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

export function createMeadowTexturePack(): MeadowTexturePack {
  const [terrainMap, terrainBump] = buildTerrainPair();
  const [plasterMap, plasterBump] = buildPlasterPair();
  const [woodMap, woodBump] = buildWoodPair();
  const [barkMap, barkBump] = buildBarkPair();
  const [stoneMap, stoneBump] = buildStonePair();
  const [roofMap, roofBump] = buildRoofPair();
  const [foliageMap, foliageBump] = buildFoliagePair();
  const contactShadowMap = buildContactShadowMap();

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
  ];

  return {
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
    dispose() {
      for (const tex of all) tex.dispose();
    },
  };
}
