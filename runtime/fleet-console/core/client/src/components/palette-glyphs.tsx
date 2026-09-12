import type { ReactNode } from "react";

import type { PaletteCommandEntry, PaletteCommandGroup, PaletteGlyphId } from "../palette-commands.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";

/**
 * 팔레트 행·구역 글리프 한 벌. 16px 상자, 1.5px 선, 둥근 끝 — 시작 화면·상태 아이콘과 같은 굵기다.
 * 채운 면은 쓰지 않아 모노그램·상태 마크와 무게가 맞는다. 색은 currentColor 하나뿐이다:
 * 모양이 종류를 말하고, 색은 행의 상태(선택 brass·파괴 coral)만 말한다.
 */
function Glyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const LINE_GLYPHS: Readonly<Record<Exclude<PaletteGlyphId, "theater-monogram" | "rail-entry">, ReactNode>> = {
  "theater-add": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M8 5.5v5M5.5 8h5" /></Glyph>,
  "operation-new": <Glyph><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" /><path d="M4.5 4.5l1.6 1.6M9.9 9.9l1.6 1.6M4.5 11.5l1.6-1.6M9.9 6.1l1.6-1.6" /></Glyph>,
  "operation-open": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M6 10l4-4M6.5 6H10v3.5" /></Glyph>,
  "operation-resume": <Glyph><path d="M5 3.5v9l7.5-4.5z" /></Glyph>,
  "operation-close": <Glyph><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Glyph>,
  "operation-rename": <Glyph><path d="M3 13l.9-3.4L10.6 2.9a1.3 1.3 0 0 1 1.8 0l.7.7a1.3 1.3 0 0 1 0 1.8L6.4 12.1z" /><path d="M9.7 3.8l2.5 2.5" /></Glyph>,
  "operation-group": <Glyph><path d="M2.5 8.2V3.5a1 1 0 0 1 1-1h4.7l5.3 5.3-5.7 5.7z" /><circle cx="5.5" cy="5.5" r=".9" fill="currentColor" stroke="none" /></Glyph>,
  "operation-accent": <Glyph><path d="M8 2.5s4 4.2 4 7a4 4 0 0 1-8 0c0-2.8 4-7 4-7z" /></Glyph>,
  "operation-minimize": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 10.5h5" /></Glyph>,
  "view-minimize-all": <Glyph><path d="M3 4h10M3 8h10M3 12h6" /><path d="M13 10.5v3M11.5 12h3" /></Glyph>,
  "view-fit": <Glyph><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /><rect x="5.5" y="5.5" width="5" height="5" rx="1" /></Glyph>,
  "view-war-room": <Glyph><rect x="2.5" y="8.5" width="11" height="5" rx="1.5" /><path d="M4.5 6h7M6 3.5h4" /></Glyph>,
  "view-tactical": <Glyph><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></Glyph>,
  "view-station-keeping": <Glyph><path d="M4 2.5v6a4 4 0 0 0 8 0v-6" /><path d="M4 2.5h2.6v6a1.4 1.4 0 0 0 2.8 0v-6H12" /><path d="M4 5.5h2.6M9.4 5.5H12" /></Glyph>,
  "view-status-axis": <Glyph><rect x="2.5" y="2.5" width="11" height="3.2" rx="1" /><rect x="2.5" y="6.4" width="11" height="3.2" rx="1" /><rect x="2.5" y="10.3" width="11" height="3.2" rx="1" /></Glyph>,
  "console-sidebar": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 2.5v11" /></Glyph>,
  "console-rail": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M10.5 2.5v11" /></Glyph>,
  "console-band": <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M2.5 5.5h11" /></Glyph>,
  "console-theme": <Glyph><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor" stroke="none" /></Glyph>,
  "console-settings": <Glyph><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></Glyph>,
  "console-shortcuts": <Glyph><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.5M6.5 7h.5M9 7h.5M11.5 7h.5M5 9.5h6" /></Glyph>,
  "console-commissioning": <Glyph><path d="M3 3.5h10v9H3z" /><path d="M5.5 6.5h5M5.5 9.5h3" /></Glyph>,
  "console-whats-new": <Glyph><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" /><path d="M4.5 4.5l1.6 1.6M9.9 9.9l1.6 1.6M4.5 11.5l1.6-1.6M9.9 6.1l1.6-1.6" /></Glyph>,
  "console-undo": <Glyph><path d="M6 4.5L3 7.5l3 3" /><path d="M3 7.5h6.5a3 3 0 0 1 0 6H8" /></Glyph>,
};

const SECTION_GLYPHS: Readonly<Record<"recent" | PaletteCommandGroup, ReactNode>> = {
  recent: <Glyph><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" /></Glyph>,
  "current-operation": <Glyph><rect x="3" y="3" width="10" height="10" rx="2" /></Glyph>,
  theater: <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M5.5 10.5V6.2m0 0h2.6m-2.6 2.1h2.1" /></Glyph>,
  view: LINE_GLYPHS["view-tactical"],
  panel: LINE_GLYPHS["console-rail"],
  console: LINE_GLYPHS["console-settings"],
};

export function PaletteSectionGlyph({ section }: { readonly section: "recent" | PaletteCommandGroup }) {
  return <span className="operation-search-section-glyph" aria-hidden="true">{SECTION_GLYPHS[section]}</span>;
}

/** 명령 행의 선행 글리프. Theater는 사이드바 모노그램, 패널은 레일 엔트리의 등록 아이콘을 그대로 쓴다. */
export function PaletteCommandGlyph({ command }: { readonly command: PaletteCommandEntry }) {
  if (command.glyph === "theater-monogram") {
    return <span className="operation-search-command-glyph operation-search-monogram" aria-hidden="true">{theaterInitials(command.monogramSource ?? command.label)}</span>;
  }
  if (command.glyph === "rail-entry") {
    const icon = typeof command.railIcon === "function" ? command.railIcon() : command.railIcon;
    return <span className="operation-search-command-glyph operation-search-rail-icon" aria-hidden="true">{icon ?? LINE_GLYPHS["console-rail"]}</span>;
  }
  return <span className="operation-search-command-glyph" aria-hidden="true">{LINE_GLYPHS[command.glyph]}</span>;
}

/** Operation 행 동작 띠의 글리프 — 같은 어휘를 쓴다. */
export function PaletteActionGlyph({ glyph }: { readonly glyph: Exclude<PaletteGlyphId, "theater-monogram" | "rail-entry"> }) {
  return <span className="operation-search-action-glyph" aria-hidden="true">{LINE_GLYPHS[glyph]}</span>;
}
