import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONSOLE_ROOT = new URL("../", import.meta.url);
const CLIENT_ROOT = new URL("../core/client/src/", import.meta.url);
const PRODUCT_SOURCE_ROOTS = [
  new URL("core/client/src/", CONSOLE_ROOT),
  new URL("sdk/", CONSOLE_ROOT),
  new URL("../fleet-plugins/", CONSOLE_ROOT),
] as const;
const CSS_SOURCE_ROOTS = [
  new URL("core/client/src/", CONSOLE_ROOT),
  new URL("../fleet-plugins/", CONSOLE_ROOT),
] as const;
const STANDALONE_CSS_SOURCES = [
  new URL("markdown/styles.css", CONSOLE_ROOT),
  new URL("font-picker/styles.css", CONSOLE_ROOT),
] as const;
const CSS_THEME_SOURCES = [
  new URL("core/client/src/styles/theme.css", CONSOLE_ROOT),
  new URL("core/client/src/codex/styles/theme.css", CONSOLE_ROOT),
] as const;
const PRODUCT_SOURCE_SUFFIXES = [".ts", ".tsx"] as const;
const PRODUCT_SOURCE_SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "tests",
  "test",
  "__tests__",
  "proposals",
  "examples",
]);
const JSX_FACTORY_NAMES = new Set(["createElement", "jsx", "jsxs"]);
const SKILLS_CSS_PATH = new URL("../../fleet-plugins/skills/client/skills.css", import.meta.url);
const SCUTTLEBUTT_CSS_PATH = new URL("../../fleet-plugins/scuttlebutt/client/styles.css", import.meta.url);
const TERMINAL_AGENT_PATH = new URL("../../fleet-plugins/terminal/client/agent/index.tsx", import.meta.url);
const TERMINAL_ANALYSIS_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/analysis.css", import.meta.url);
const TERMINAL_AGENT_CLI_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/agent-cli.css", import.meta.url);
const TERMINAL_SURFACE_PATH = new URL("../../fleet-plugins/terminal/client/shared/terminal-surface.tsx", import.meta.url);
const TERMINAL_CHAT_VIEW_PATH = new URL("../../fleet-plugins/terminal/client/agent/chat/chat-view.tsx", import.meta.url);
const TERMINAL_CHAT_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/chat/chat.css", import.meta.url);
const QUOTA_CSS_PATH = new URL("../../fleet-plugins/quota/client/quota.css", import.meta.url);
const QUOTA_PANEL_PATH = new URL("../../fleet-plugins/quota/client/rail-panel.tsx", import.meta.url);
const SDK_RAIL_TYPES_PATH = new URL("../sdk/rail/types.ts", import.meta.url);
const SDK_VERSION_PATH = new URL("../sdk/version.ts", import.meta.url);
const OWNED_SOURCES = [
  "app.tsx",
  "canvas/canvas-store.ts",
  "canvas/canvas-overlays.tsx",
  "canvas/canvas-context-menu.tsx",
  "canvas/canvas-minimap.tsx",
  "canvas/canvas.tsx",
  "pages/operations.tsx",
  "components/command-band.tsx",
  "components/command-band-system-cluster.tsx",
  "sidebar/operations-side-bar.tsx",
  "styles/theme.css",
  "styles/components.css",
  "styles/layout.css",
  "styles/rail.css",
  "styles/rail-alerts.css",
] as const;

const FORBIDDEN_DECORATION = /radar-sweep|operations-radar|BACKGROUND_ANIMATION_STORAGE_KEY|PERIMETER_ANIMATION_STORAGE_KEY|Panel pulse|perimeter-orbit|notification-wake-pulse|AnchorIcon/;
const RAW_TEXT_INK_TOKENS = /var\(\s*--ink-(?:fog|rim|spectral|pearl)\b/;
const NUMERIC_FONT_WEIGHT = /^(?:[1-9]\d{0,2}|1000)\b/;
const RUNTIME_CUSTOM_PROPERTY_ALLOWLIST = new Set([
  // Canvas injects each frame's identity accent through TSX inline styles.
  "--user-accent",
  // Canvas injects stagger timing through CSSStyleDeclaration.setProperty at runtime.
  "--panel-stagger-delay",
  // Formation injects guide and landing sequence indices through TSX/runtime styles.
  "--gi",
  "--li",
  // Sidebar TSX injects its measured width for the shell layout.
  "--side-bar-width",
  // Sidebar TSX injects transient drag offsets for chips and group headers; the fleet map's
  // marker drag writes both axes on the dot element itself, without a re-render per frame.
  "--drag-dy",
  "--drag-dx",
  // Sidebar TSX injects the persisted group tone used by group-scoped surfaces.
  "--grp-color",
  // Sidebar chip TSX injects the group marker tone for each rendered mark.
  "--group-mark",
  // What's New TSX injects each section's reveal delay.
  "--whatsnew-delay",
  // Command Band TSX injects the measured left sidebar width.
  "--command-band-left-width",
  // Command Band TSX injects the state-dependent map-controls anchor (sidebar seam ↔ docked left cluster).
  "--command-band-map-anchor",
  // Right Rail TSX injects the current panel width.
  "--right-rail-panel-width",
  // Right Rail TSX injects the user-selected overlay opacity.
  "--right-rail-overlay-alpha",
  // Right Rail TSX injects the continuous opacity slider's filled-track percentage.
  "--alpha-fill",
  // Repository Rail TSX injects the user-resized workspace tree width.
  "--ws-tree-width",
  // Repository commit/compare inspector TSX injects the user-resized dock file-list width.
  "--ws-dock-files-width",
  // Canvas context menu TSX injects the viewport-derived height ceiling for its own box.
  "--canvas-menu-max-height",
  // Quick Launch TSX injects the viewport-derived height ceiling for its open popover.
  "--quick-launch-pop-max-height",
  // Triage Watch Deck TSX injects the grid-capped quick-look magnification at hover time.
  "--triage-quicklook-scale",
  // Watch Deck zoom tween injects card column/row sizing each frame.
  "--triage-card-min",
  "--triage-row-min",
  "--triage-row-max",
  // Fleet map TSX injects each theater zone's circle position/diameter and identity tint.
  "--zone-x",
  "--zone-y",
  "--zone-size",
  "--zone-tint",
  // Triage Watch Deck TSX injects running-dot drift vars inline.
  "--triage-drift-mult",
  "--triage-drift-x1",
  "--triage-drift-y1",
  "--triage-drift-x2",
  "--triage-drift-y2",
]);

function source(path: string): string {
  return fs.readFileSync(new URL(path, CLIENT_ROOT), "utf8").replace(/\r\n/g, "\n");
}

function externalSource(path: URL): string {
  return fs.readFileSync(path, "utf8");
}

function listProductSourceFiles(root: URL): string[] {
  const files: string[] = [];
  const stack = [fileURLToPath(root)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (PRODUCT_SOURCE_SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".generated.ts")) continue;
      if (!PRODUCT_SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      files.push(path.join(current, entry.name));
    }
  }
  return files.sort();
}

function listCssFiles(root: URL): string[] {
  const files: string[] = [];
  const stack = [fileURLToPath(root)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".css")) files.push(path.join(current, entry.name));
    }
  }
  return files.sort();
}

function listProductCssFiles(): string[] {
  return [
    ...CSS_SOURCE_ROOTS.flatMap(listCssFiles),
    ...STANDALONE_CSS_SOURCES.map((source) => fileURLToPath(source)),
  ].sort();
}

function consoleRelativePath(file: string): string {
  return path.relative(fileURLToPath(CONSOLE_ROOT), file).replace(/\\/g, "/");
}

function maskCssCommentsAndStrings(css: string): string {
  const masked = css.split("");
  let state: "code" | "comment" | "string" = "code";
  let quote = "";

  for (let index = 0; index < css.length; index += 1) {
    const current = css[index]!;
    const next = css[index + 1];
    if (state === "code" && current === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      state = "comment";
      index += 1;
      continue;
    }
    if (state === "comment") {
      if (current === "*" && next === "/") {
        masked[index] = " ";
        masked[index + 1] = " ";
        state = "code";
        index += 1;
      } else if (current !== "\n") {
        masked[index] = " ";
      }
      continue;
    }
    if (state === "code" && (current === '"' || current === "'")) {
      quote = current;
      masked[index] = " ";
      state = "string";
      continue;
    }
    if (state === "string") {
      if (current === "\\") {
        masked[index] = " ";
        if (next !== undefined && next !== "\n") {
          masked[index + 1] = " ";
          index += 1;
        }
      } else if (current === quote) {
        masked[index] = " ";
        state = "code";
      } else if (current !== "\n") {
        masked[index] = " ";
      }
    }
  }

  return masked.join("");
}

function maskFontFaceBlocks(css: string): string {
  const masked = maskCssCommentsAndStrings(css);
  const result = masked.split("");
  const fontFace = /@font-face\b/gi;
  let match: RegExpExecArray | null;
  while ((match = fontFace.exec(masked)) !== null) {
    const open = masked.indexOf("{", match.index);
    if (open === -1) continue;
    let depth = 0;
    let close = open;
    for (; close < masked.length; close += 1) {
      if (masked[close] === "{") depth += 1;
      if (masked[close] === "}") {
        depth -= 1;
        if (depth === 0) {
          close += 1;
          break;
        }
      }
    }
    for (let index = match.index; index < close; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
    fontFace.lastIndex = close;
  }
  return result.join("");
}

function cssDeclarations(css: string, property: string): Array<{ index: number; value: string }> {
  const declarations: Array<{ index: number; value: string }> = [];
  const pattern = new RegExp(`(?:^|[;{])\\s*(${property})\\s*:\\s*([^;{}]*)`, "gim");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    declarations.push({
      index: match.index + match[0].indexOf(match[1]!),
      value: match[2]!.trim(),
    });
  }
  return declarations;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function customPropertyDefinitions(css: string): Set<string> {
  const definitions = new Set<string>();
  const masked = maskCssCommentsAndStrings(css);
  const pattern = /(?:^|[;{])\s*(--[A-Za-z0-9_-]+)\s*:/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    definitions.add(match[1]!);
  }
  return definitions;
}

function findRawProductSelects(): Array<{ file: string; line: number; snippet: string }> {
  const hits: Array<{ file: string; line: number; snippet: string }> = [];
  for (const root of PRODUCT_SOURCE_ROOTS) {
    for (const file of listProductSourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const sourceFile = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      hits.push(...findRawProductSelectsInSourceFile(sourceFile, file, text));
    }
  }
  return hits.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function findRawProductSelectsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  text: string,
): Array<{ file: string; line: number; snippet: string }> {
  const hits: Array<{ file: string; line: number; snippet: string }> = [];
  const relativeFile = path.relative(fileURLToPath(CONSOLE_ROOT), filePath).replace(/\\/g, "/");
  const lines = text.split("\n");

  const recordHit = (node: ts.Node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    hits.push({
      file: relativeFile,
      line,
      snippet: (lines[line - 1] ?? "").trim(),
    });
  };

  const isSelectTagName = (name: ts.JsxTagNameExpression | undefined): boolean =>
    name !== undefined && ts.isIdentifier(name) && name.text === "select";

  const isSelectFactoryFirstArg = (expression: ts.Expression | undefined): boolean =>
    expression !== undefined && ts.isStringLiteralLike(expression) && expression.text === "select";

  const factoryName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text;
    return undefined;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (isSelectTagName(node.tagName)) recordHit(node);
    } else if (ts.isCallExpression(node)) {
      const name = factoryName(node.expression);
      if (name !== undefined && JSX_FACTORY_NAMES.has(name) && isSelectFactoryFirstArg(node.arguments[0])) {
        recordHit(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hits;
}

describe("Instrument core design contract", () => {
  it("collapses backend API rows against their Settings card width", () => {
    const components = source("styles/components.css");
    const section = components.match(/\.backend-api-section \{[^}]*\}/)?.[0] ?? "";
    const narrowContainer = components.match(/@container \(max-width: 720px\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(section).toContain("container-type: inline-size;");
    expect(narrowContainer).toContain(".backend-api-row {");
    expect(narrowContainer).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(components).not.toMatch(/@media \(max-width: 720px\) \{\s*\.backend-api-row/);
  });

  it("keeps SDK v1 rail compatibility as a deprecated root-only facade", () => {
    const types = externalSource(SDK_RAIL_TYPES_PATH);
    const version = externalSource(SDK_VERSION_PATH);
    const rightRail = source("rail/right-rail.tsx");
    expect(version).toContain("SDK_API_VERSION = 1");
    for (const field of ["RailPathContext", "pathContext", "selectPathContext", "pathAware"]) expect(types).toContain(field);
    expect(types.match(/@deprecated/g)?.length).toBeGreaterThanOrEqual(4);
    expect(rightRail).toContain("useSyncExternalStore(");
    expect(rightRail).toContain("getState().theaters.find");
    expect(rightRail).toContain("theater.id === theaterId");
    expect(rightRail).toContain('pathContext: { kind: "root", relPath: null, label: theaterLabel }');
    expect(types).toContain("readonly theme?: ConsoleTheme;");
    expect(rightRail).toContain("theme,");
    expect(rightRail).toContain("[theaterId, theaterLabel, api, language, theme, activeId]");
    expect(rightRail).not.toContain("selectPathContext");
    expect(rightRail).not.toContain(".pathAware");
  });

  it("removes ambient radar, panel pulse, perimeter wake, and anchor surfaces", () => {
    for (const path of OWNED_SOURCES) expect(source(path)).not.toMatch(FORBIDDEN_DECORATION);
  });

  it("denies the canvas a scroll port so a focused overhanging descendant cannot shift the board", () => {
    const components = source("styles/components.css");
    const canvasBlock = components.match(/\n\.operations-canvas \{[\s\S]*?\n\}/)?.[0] ?? "";
    const contextMenu = source("canvas/canvas-context-menu.tsx");

    // hidden은 스크롤바만 감출 뿐 스크롤 포트를 남긴다 — 밖으로 나간 자손에 포커스가 닿으면
    // 브라우저가 이 컨테이너를 굴려 판 전체가 밀린 채 남는다. clip은 그 포트를 만들지 않는다.
    expect(canvasBlock).toContain("overflow: clip;");
    expect(canvasBlock).not.toContain("overflow: hidden;");
    // 메뉴는 커서 자리에 스스로 선다 — 조상을 굴려 드러낼 것이 없다.
    expect(contextMenu).toContain("menuRef.current?.focus({ preventScroll: true });");
  });

  it("replaces the launch menu's native scrollbar with edge strips and a scroll gauge", () => {
    const components = source("styles/components.css");
    const contextMenu = source("canvas/canvas-context-menu.tsx");
    const menuBlock = components.match(/\n\.canvas-context-menu \{[\s\S]*?\n\}/)?.[0] ?? "";

    // 떠 있는 실행 메뉴 안의 OS풍 스크롤바는 제품 밖 장치처럼 읽힌다 — 스크롤 포트(휠·키보드·
    // 플라이아웃 scroll-follow)는 남기고 시각 장치만 메뉴 문법으로 바꾼다.
    expect(menuBlock).toContain("overflow-y: auto;");
    expect(menuBlock).toContain("scrollbar-width: none;");
    expect(components).toContain(".canvas-context-menu::-webkit-scrollbar");

    // 절단 신호·포인터 항해는 방향 스트립이, 위치 표시는 스크롤 게이지가 잇는다. 전부 포인터
    // 전용 장치라 aria-hidden이어야 한다 — 키보드는 방향키 포커스 추적이, 보조기술은 목록
    // 자체가 담당한다.
    expect(contextMenu).toContain("canvas-context-menu-edge canvas-context-menu-edge--top");
    expect(contextMenu).toContain("canvas-context-menu-edge canvas-context-menu-edge--bottom");
    expect(contextMenu).toContain('className="canvas-context-menu-gauge"');

    // 스트립 hover 강조는 brass(위치/hover 채널) 문법 그대로다.
    expect(components).toContain(".canvas-context-menu-edge.is-on:hover .canvas-context-menu-edge-fill");

    // reduced-motion에서는 연속 글라이드를 접는다 — 클릭 스텝·휠·키보드만 남긴다.
    expect(contextMenu).toContain("if (prefersReducedMotion()) return;");
  });

  it("keeps minimap navigation and collapse controls while hiding Map in Formation and maximize", () => {
    const minimap = source("canvas/canvas-minimap.tsx");
    const canvas = source("canvas/canvas.tsx");
    const components = source("styles/components.css");
    const contextMenu = source("canvas/canvas-context-menu.tsx");
    expect(minimap).toContain('{t("canvas.minimap.label")}');
    expect(minimap).toContain("onPointerMove={onPointerMove}");
    expect(minimap).toContain("onJump({");
    expect(minimap).toContain("fleet-console.map.radarCollapsed");
    expect(minimap).toContain('aria-label={t("canvas.minimap.open")}');
    expect(minimap).toContain('aria-label={t("canvas.minimap.collapse")}');
    expect(minimap).toContain("canvas-minimap-fab");
    expect(minimap).toContain("canvas-minimap-toggle");
    expect(canvas).toContain("<CanvasMinimap");
    expect(canvas).not.toContain("{!formationView && !panelMaximized ? (");
    expect(components).toContain(".operations-canvas.is-formation-view .canvas-minimap,");
    expect(components).toContain(".operations-canvas.is-formation-view .canvas-minimap-fab,");
    expect(components).toContain(".operations-canvas.is-panel-maximized .canvas-minimap,");
    expect(components).toContain(".operations-canvas.is-panel-maximized .canvas-minimap-fab,");
    expect(components).toContain(".operations-canvas.is-companion-layout .canvas-minimap,");
    expect(components).toContain(".operations-canvas.is-companion-layout .canvas-minimap-fab {");
    // 모드 프레임은 최대화 아래에서만 물러난다 — 최대화 geometry는 캔버스 전체라 프레임의 10px
    // 인셋을 네 변 모두 넘고, 프레임은 z-index 76이라 패널 위에 브래킷을 찍는다. companion은
    // 프레임이 뜨는 두 모드에서 18px 인셋 슬롯에 머무르므로 경계를 지울 이유가 없다.
    expect(components).toContain(".operations-canvas.is-panel-maximized .canvas-mode-frame {");
    expect(components).not.toContain(".operations-canvas.is-companion-layout .canvas-mode-frame");
    // 물러남은 즉시, 복귀는 패널 geometry가 슬롯으로 돌아온 뒤다 — display 토글로 되돌리면
    // 복원 전환 동안 브래킷이 다시 패널 위에 찍힌다.
    const modeFrameBlock = components.match(/\.canvas-mode-frame \{[^}]*\}/)?.[0] ?? "";
    expect(modeFrameBlock).toContain("transition: opacity var(--duration-base) var(--ease-glide) var(--duration-slow);");
    expect(modeFrameBlock).not.toContain("display:");
    const maximizedFrameBlock = components.match(/\.operations-canvas\.is-panel-maximized \.canvas-mode-frame \{[^}]*\}/)?.[0] ?? "";
    expect(maximizedFrameBlock).toContain("opacity: 0;");
    expect(maximizedFrameBlock).toContain("transition-delay: 0s;");
    expect(maximizedFrameBlock).not.toContain("display: none;");
    for (const sharedModeClass of [
      "canvas-mode-frame",
      "canvas-mode-bracket",
      "canvas-mode-curtain",
      "canvas-mode-curtain-kicker",
      "canvas-mode-curtain-ruler",
      // Cruise 복귀도 진입과 같은 커튼을 쓴다 — 모드 전환 연출은 세 모드가 한 문법을 공유한다.
      "canvas-cruise-curtain",
    ]) {
      expect(canvas).toContain(sharedModeClass);
      expect(components).toContain(`.${sharedModeClass}`);
    }
    expect(canvas).not.toContain("canvas-mode-hud");
    expect(components).not.toContain(".canvas-mode-hud");
    // 하단 대기 레일은 제거됐다 — 사이드바 '대기'가 이미 같은 순서를 쥐고 있어, 두 곳이 동시에
    // "처리할 것이 있다"고 말하면 시선이 화면 아래위로 갈라진다. 화면 하단은 컴포저의 자리다.
    expect(canvas).not.toContain("canvas-triage-rail");
    expect(components).not.toContain(".canvas-triage-rail");
    // 스포트라이트·덱 밀도는 War Room 트레이(커맨드 밴드)가 소유한다 — 모드 전용 컨트롤은
    // 캔버스 구석이 아니라 그 모드의 트레이 한 곳에 모인다.
    expect(canvas).not.toContain("canvas-triage-density-chip");
    // OFF의 지속 맥동은 검토 전 신호다 — 지목·미룸 항목은 deck 카드에서도 레일 칩과 동일하게 제외한다.
    expect(canvas).toContain("!entry.picked && !isTriageOperationDeferred(entry.operation.id)");
    // 치워두기의 두 번 눌러 확정 안내는 패널 안 HUD가 소유한다 — 레일이 사라져도 이 기능은 그대로다.
    expect(canvas).toContain("setAsideArmed");
    expect(canvas).not.toMatch(/canvas-triage-(?:frame|bracket|hud(?:-eye|-name)?|curtain-kicker|curtain-ruler)/);
    expect(components).toContain("radial-gradient(100% 80% at 50% 42%, var(--canvas-sea-core), var(--canvas-sea-mid) 78%)");
    expect(components).toContain("background-size: 48px 48px !important;");
    expect(components).toContain(".canvas-formation-guide {");
    expect(components).toContain(".canvas-operation-formation-slot {");
    expect(contextMenu).not.toContain("canvas-context-menu-head");
    expect(contextMenu).toContain('aria-label={t("canvas.menu.etc")}');
    expect(contextMenu).toContain("operation-launch-provider-glyph--etc");
    // 그룹 머리글은 캔버스 메뉴 전체에서 한 클래스뿐이다 — 머리글 문법이 갈라지면 머리글과 첫
    // 항목 사이 간격이 그룹마다 어긋난다(Etc가 하위 항목에 붙어 보였던 회귀).
    expect(contextMenu).not.toContain("canvas-context-menu-plugin");
    expect(components).not.toContain(".canvas-context-menu-plugin");
    expect(contextMenu).not.toContain("CanvasContextMenuMode");
    expect(contextMenu).not.toContain("canvas-context-menu-tabs");
    expect(contextMenu).not.toContain("Formation view");
    expect(contextMenu).not.toContain("ResetGlyph");
    expect(contextMenu).not.toContain("onToggleRadar");
    expect(contextMenu).not.toContain("onTogglePerimeter");
  });

  it("uses opaque token surfaces without blur or deprecated accent variables", () => {
    const css = OWNED_SOURCES.filter((path) => path.endsWith(".css")).map(source).join("\n");
    expect(css).not.toMatch(/backdrop-filter|--op-accent|--chip-accent/);
    expect(css).toContain("background: var(--surface-glass)");
    expect(css).toContain(":focus-visible");
    // brass 채움 버튼은 전용 on-brass 텍스트 티어를 소비한다 — abyss 재결합은 라이트 AA 회귀다.
    expect(css).toMatch(/\.fc-btn--primary \{[^}]*color: var\(--text-on-brass\);/);
  });

  // 텍스트 3티어만 대비를 통제하므로 원료 잉크를 color에 직접 쓰면 판독 하한을 한곳에서 보장할 수 없다.
  it("keeps text color on the semantic three-tier token grammar", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      for (const declaration of cssDeclarations(masked, "color")) {
        if (!RAW_TEXT_INK_TOKENS.test(declaration.value)) continue;
        const blockStart = masked.lastIndexOf("{", declaration.index);
        const selectorStart = masked.lastIndexOf("}", blockStart) + 1;
        const selector = masked.slice(selectorStart, blockStart);
        // Mode instrument chrome has host-approved literal brass/fog blends; adjacent CSS doctrine
        // comments distinguish these decorative labels from semantic body-copy color.
        if (selector.includes(".canvas-mode-curtain-kicker")
          || selector.includes(".canvas-formation-guide-index")) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 가변 서체도 위계는 3티어뿐이므로 임의 숫자 굵기가 흩어지면 같은 역할의 위계를 읽을 수 없다.
  it("keeps product font weight on the regular, medium, and bold token tiers", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskFontFaceBlocks(css);
      for (const declaration of cssDeclarations(masked, "font-weight")) {
        if (!NUMERIC_FONT_WEIGHT.test(declaration.value)) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
      for (const declaration of cssDeclarations(masked, "font")) {
        const beforeLineHeight = declaration.value.split("/", 1)[0]!;
        if (!/(?:^|\s)(?:[1-9]\d{0,2}|1000)(?=\s|$)/.test(beforeLineHeight)) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 미정의 var 참조는 조용히 무효화되어 의도와 다르게 상속되므로 정의 또는 명시된 런타임 주입이 필요하다.
  it("requires every referenced custom property to have a CSS definition or runtime injection", () => {
    const globallyDefined = new Set(
      CSS_THEME_SOURCES.flatMap((theme) => [...customPropertyDefinitions(externalSource(theme))]),
    );
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      const defined = new Set([...globallyDefined, ...customPropertyDefinitions(css)]);
      const reference = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      let match: RegExpExecArray | null;
      while ((match = reference.exec(masked)) !== null) {
        const name = match[1]!;
        if (defined.has(name) || RUNTIME_CUSTOM_PROPERTY_ALLOWLIST.has(name)) continue;
        const line = lineAt(css, match.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps user identity on the mark grammar and off the caption fill and state border channel", () => {
    const frame = source("canvas/operation-frame.tsx");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const components = source("styles/components.css");
    const markBlock = components.match(/\.canvas-operation-id-mark \{[^}]*\}/)?.[0] ?? "";
    const chipAccentBlock = components.match(/\.side-bar-chip\[style\*="--user-accent"\]::before \{[^}]*\}/)?.[0] ?? "";
    const minimapDotBlock = components.match(/\.canvas-minimap-operation\[style\*="--user-accent"\]::after \{[^}]*\}/)?.[0] ?? "";
    const accentSources = [frame, chip, components].join("\n");

    expect(frame).toContain('{ "--user-accent": accentColor }');
    expect(frame).toContain('className="canvas-operation-id-mark"');
    expect(chip).toContain('{ "--user-accent": accentValue }');
    // Map의 좌측 스파인과 캡션 워시는 폐기됐다 — 패널 본문과 언포커스 캡션은 어떤 정체성
    // 색도 지지 않고, 정체성은 캡션 위 마크에서 말한다. 선택자·렌더·클래스 어느 쪽으로도
    // 되살아나면 캡션이 패널과 한 면이라는 계약이 조용히 깨진다.
    expect(components).not.toContain(".canvas-operation-spine");
    expect(frame).not.toContain("canvas-operation-spine");
    expect(components).not.toContain('.canvas-operation[style*="--user-accent"] .canvas-operation-titlebar {');
    expect(components).not.toContain('.canvas-operation[style*="--user-accent"].is-active > .canvas-operation-titlebar {');
    expect(components).not.toContain("color-mix(in oklch, var(--user-accent) 10%, var(--surface-panel))");
    // 정체성은 보더 채널을 소유하지 않는다 — 보더는 상태(brass/aurora/coral) 전용.
    expect(components).not.toContain("border-color: var(--user-accent)");
    expect(markBlock).toContain("width: 8px;");
    expect(markBlock).toContain("height: 14px;");
    expect(markBlock).toContain("background: var(--user-accent);");
    expect(chipAccentBlock).toContain("width: 3px;");
    expect(chipAccentBlock).toContain("top: 7px;");
    expect(chipAccentBlock).toContain("bottom: 7px;");
    expect(chipAccentBlock).toContain("background: var(--user-accent);");
    expect(chipAccentBlock).toContain("pointer-events: none;");
    expect(chipAccentBlock).not.toMatch(/animation/);
    expect(minimapDotBlock).toContain("background: var(--user-accent);");
    // 3개 소비처: 미니맵 도트 · 명판 마크 · 사이드바 칩 스파인.
    // Map에서 accent는 마크에만 머물고, 3px 스파인은 레일(사이드바 칩)에만 남는다.
    expect(components.match(/var\(--user-accent\)/g)).toHaveLength(3);
    expect(accentSources).not.toMatch(/--op-accent|--chip-accent/);
  });

  it("pins the caption group label — dot carries the only group colour, the name rides a neutral tier", () => {
    const frame = source("canvas/operation-frame.tsx");
    const components = source("styles/components.css");
    const labelBlock = components.match(/\.canvas-operation-group-label \{[^}]*\}/)?.[0] ?? "";
    const dotBlock = components.match(/\.canvas-operation-group-dot \{[^}]*\}/)?.[0] ?? "";

    // 그룹 톤 주입은 --group-mark 하나다. --grp-color는 사이드바 존 표면 전용이라 캡션으로 넘어오지 않는다.
    expect(frame).toContain('{ "--group-mark": groupColor }');
    expect(frame).toContain('className="canvas-operation-group-label"');
    expect(components).not.toMatch(/\.canvas-operation[^{}]*--grp-color/);
    expect(dotBlock).toContain("background: var(--group-mark);");
    expect(dotBlock).toContain("width: 7px;");
    expect(dotBlock).toContain("height: 7px;");

    // 색은 도트 하나만 진다 — 라벨에 테두리·채움·그룹색 글자를 얹으면 32px 캡션 안에서
    // 아랫변 2px 상태 레일과 같은 굵기의 색선이 겹쳐 두 채널이 한 덩어리로 뭉친다(#699 실측).
    expect(labelBlock).not.toMatch(/border|background/);
    expect(labelBlock).toContain("color: var(--text-tertiary);");
    expect(components).toContain(".canvas-operation.is-active > .canvas-operation-titlebar .canvas-operation-group-label {");
    expect(components).toMatch(/\.canvas-operation\.is-active > \.canvas-operation-titlebar \.canvas-operation-group-label \{\s*color: var\(--text-secondary\);/);

    // 라벨은 제목보다 먼저 양보한다 — 최소 폭(320px)에서 긴 그룹 이름이 Operation 제목을 밀어내면
    // 캡션의 1순위 정보가 뒤집힌다.
    expect(labelBlock).toContain("flex: 0 6 auto;");
    expect(labelBlock).toContain("max-width: min(34%, 15ch);");
    expect(labelBlock).toContain("min-width: 0;");
    expect(components).toMatch(/\.canvas-operation-group-name \{[^}]*text-overflow: ellipsis;/);

    // 정체성 채널에는 애니메이션을 걸지 않는다. 포커스 색 전환만 두고, reduced-motion에서 단락한다.
    expect(labelBlock).not.toMatch(/animation/);
    const reducedMotion = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".canvas-operation-group-label,");
  });

  it("pins the AI Gateway capability-class badge grammar — ink rank, no signal colour, dashed for unclassed", () => {
    // 등급은 Operation 상태가 아니라 프로바이더가 자기 라인업에 대해 주장하는 속성이다.
    // 신호색을 빌리면 같은 행에서 등급이 상태처럼 읽혀 활동 축과 서로를 부정한다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    const badgeRules = [...css.matchAll(/([^{}]*\.ai-gateway-class-badge[^{}]*)\{([^}]*)\}/g)];
    expect(badgeRules.length).toBeGreaterThan(0);
    for (const [, , body] of badgeRules) {
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
    }

    // 서열은 테두리·글자의 잉크 농도로만 말하고, standard가 그 기준선이라 자기 규칙을 갖지
    // 않는다. 가운데 등급에 규칙이 생기는 순간 세 등급이 서로 독립이 되어 서열이 사라진다.
    const base = css.match(/^\.ai-gateway-class-badge \{[^}]*\}/m)?.[0] ?? "";
    expect(base).toContain("border: 1px solid var(--surface-rim);");
    expect(base).toContain("color: var(--text-secondary);");
    expect(css).not.toContain(".ai-gateway-class-badge.is-standard");

    const flagship = css.match(/\.ai-gateway-class-badge\.is-flagship \{[^}]*\}/)?.[0] ?? "";
    expect(flagship).toContain("border-color: var(--surface-rim-strong);");
    expect(flagship).toContain("color: var(--text-primary);");

    const light = css.match(/\.ai-gateway-class-badge\.is-light \{[^}]*\}/)?.[0] ?? "";
    expect(light).toContain("color: var(--text-tertiary);");
    expect(light).toMatch(/border-color: color-mix\(in oklch, var\(--surface-rim\) \d+%, transparent\);/);

    // 등급 없는 라우팅 별칭은 서열의 한 칸이 아니라 서열 밖이다 — 농도를 한 단 더 내리는
    // 대신 파선으로 가른다. 농도로 갈랐다면 light보다 약한 네 번째 등급으로 읽힌다.
    const unclassed = css.match(/\.ai-gateway-class-badge\.is-unclassed \{[^}]*\}/)?.[0] ?? "";
    expect(unclassed).toContain("border-style: dashed;");
    expect(unclassed).not.toContain("border-color:");
  });

  it("pins the Operation provider mark grammar — one tone table, ink only, no state repaint", () => {
    // 사이드바 칩·커맨드 밴드·팔레트·War Room 카드는 같은 Operation을 네 곳에서 센다. 표면이
    // 각자 톤을 적으면 한 곳만 고쳐도 컴파일은 되고 같은 Operation이 두 색으로 보인다 — 대조표는
    // .operation-provider-mark 한 곳에만 있어야 하고, 표면 클래스는 치수만 소유한다.
    const css = source("styles/components.css");
    for (const provider of ["claude", "codex", "cursor", "kimi", "opencode", "xai"]) {
      expect(css).toContain(`.operation-provider-mark.is-${provider} { color: var(--provider-${provider}); }`);
    }
    // 공급자는 정체성 축이다 — 마크의 잉크에만 머물러야 하므로 배경·테두리로 번지지 않고,
    // 신호색·brass를 빌려 상태·위치 채널과 충돌하지도 않는다.
    for (const [, body] of css.matchAll(/\.operation-provider-mark[^{}]*\{([^}]*)\}/g)) {
      expect(body).not.toMatch(/background|border|box-shadow/);
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
    }
    // 정체성은 포커스·활성으로 다시 칠하지 않는다. 명령 행 글리프가 brass로 반응하는 것과
    // 달리, 공급자 마크는 어느 상태에서도 같은 톤을 유지해야 같은 Operation으로 읽힌다.
    expect(css).not.toMatch(/\.is-active[^{}]*\.operation-provider-mark/);

    // 네 표면 모두 공용 마크 클래스를 통해 톤을 받는다 — 하나라도 자기 색을 적으면 대조표가 갈라진다.
    expect(source("sidebar/operations-side-bar-chip.tsx")).toContain("operation-provider-mark is-${entry.launchProvider}");
    expect(source("components/command-band.tsx")).toContain("operation-provider-mark is-${activeLaunchProvider}");
    expect(source("components/operation-search.tsx")).toContain("operation-provider-mark is-${entry.launchProvider}");
    // 해석은 한 함수 — 표면마다 다른 규칙을 적으면 같은 Operation이 두 마크를 갖는다.
    expect(source("sidebar/operations-side-bar.tsx")).toContain('from "../operation-mark.js"');
  });

  it("pins the AI Gateway provider-priority toggle grammar — ink rank only, no signal colour, no brass", () => {
    // 소진 순서는 상태가 아니라 사용자 선호다. 신호색이나 brass를 빌리는 순간 같은 카드의
    // 상태·위치 채널과 충돌해 순위가 활동처럼 읽힌다 — 등급 배지와 같은 잉크 문법을 강제한다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    const toggleRules = [...css.matchAll(/([^{}]*\.ai-gateway-priority[^{}]*)\{([^}]*)\}/g)];
    expect(toggleRules.length).toBeGreaterThan(0);
    for (const [, , body] of toggleRules) {
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
    }
    const ranked = css.match(/\.ai-gateway-priority-toggle\.is-ranked \{[^}]*\}/)?.[0] ?? "";
    expect(ranked).toContain("border-color: var(--surface-rim-strong);");
    expect(ranked).toContain("color: var(--text-primary);");

    // 말풍선은 hover와 키보드 포커스 양쪽에서 열려야 한다 — 포인터만 여는 요약은 키보드
    // 사용자에게는 존재하지 않는 설명이 된다.
    const tip = css.match(/\.ai-gateway-priority-tip \{[^}]*\}/)?.[0] ?? "";
    expect(tip).toContain("visibility: hidden;");
    expect(tip).toContain("pointer-events: none;");
    expect(css).toContain(".ai-gateway-priority-toggle:hover + .ai-gateway-priority-tip,");
    expect(css).toContain(".ai-gateway-priority-toggle:focus-visible + .ai-gateway-priority-tip {");

    // 말풍선의 기준 상자는 토글이 아니라 헤드 행이고 상한은 그 폭이다 — 토글 기준으로 두면
    // 시작점이 행 중간이라 어떤 상한을 줘도 좁은 화면에서 오른쪽으로 넘친다.
    expect(tip).toContain("max-width: 100%;");
    const head = css.match(/\.ai-gateway-provider-head \{[^}]*\}/)?.[0] ?? "";
    expect(head).toContain("position: relative;");
    // 좁아지면 부제부터 접혀야 글리프·이름·토글이 잘리지 않는다.
    expect(head).toContain("flex-wrap: wrap;");
  });

  it("pins the AI Gateway effort badge grammar — chip shell, segmented selection, no disclosure", () => {
    // 강도 배지는 속성 칩 줄에서 유일한 컨트롤이다. 껍데기는 칩 문법(알약·mono·9.5px)을
    // 그대로 쓰고 선택만 세그먼트 문법으로 말해야, 같은 줄의 속성 칩들과 한 몸으로 읽힌다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    const shell = css.match(/^\.ai-gateway-effort \{[^}]*\}/m)?.[0] ?? "";
    expect(shell).toContain("border-radius: var(--radius-pill);");
    expect(shell).toMatch(/border: 1px solid color-mix\(in oklch, var\(--surface-rim\) \d+%, transparent\);/);
    // 다섯 칸 사다리는 좁은 설정 카드보다 넓어진다. 한 줄을 고집하거나 넘침을 잘라내면
    // 오른쪽 단계가 카드 밖에서 눌리지 않으므로, 접히기만 하고 감춰지지는 않아야 한다.
    expect(shell).toContain("flex-wrap: wrap;");
    expect(shell).not.toContain("overflow: hidden;");

    // 켜진 단계는 사다리 위의 위치이지 Operation 상태가 아니다 — 신호색을 빌리면 같은 카드의
    // 활동 축과 충돌하므로, 코어 segmented와 같은 brass 워시+brass ink+inset 링만 쓴다.
    const on = css.match(/\.ai-gateway-effort-level\.is-on \{[^}]*\}/)?.[0] ?? "";
    expect(on).toContain("background: color-mix(in oklch, var(--brass) 16%, transparent);");
    expect(on).toContain("color: var(--brass-ink);");
    expect(on).toContain("box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--brass) 38%, transparent);");
    for (const [, , body] of css.matchAll(/([^{}]*\.ai-gateway-effort[^{}]*)\{([^}]*)\}/g)) {
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive)[a-z-]*\)/);
    }

    // 마지막 한 단계는 켜진 채로 잠긴다. 흐려지면 꺼진 것으로 읽히므로 opacity를 내리지 않는다.
    const lockedOn = css.match(/\.ai-gateway-effort-level\.is-on:disabled \{[^}]*\}/)?.[0] ?? "";
    expect(lockedOn).toContain("cursor: not-allowed;");
    expect(lockedOn).not.toContain("opacity");

    // 배지가 사다리 전체를 이미 보여주므로 접기 표면은 존재하지 않는다.
    expect(css).not.toContain(".ai-gateway-levels");
    expect(css).not.toContain(".ai-gateway-model-entry");
    expect(externalSource(TERMINAL_AGENT_PATH)).not.toContain("ai-gateway-levels-toggle");
  });

  it("pins the quota meter grammar — one signal channel, neutral clock tick, hatched forecast", () => {
    // 쿼터 막대는 세 겹이 한 트랙에 사는 유일한 표면이다. 채움은 게이트웨이의 압력 판정을
    // 그대로 입고, 경과 눈금은 창의 시계라 신호색을 갖지 않으며, 예측은 아직 쓰지 않은 몫이라
    // 빗금으로만 말한다. 셋 중 하나가 채널을 바꾸면 같은 그림이 정반대를 뜻하게 된다.
    const css = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");

    // (a) 심각도는 --meter-accent 한 채널로만 흐른다 — 채움과 빗금이 각자 색을 집으면
    // 한 막대가 두 판정을 말한다. 기준선(normal)은 중립 잉크라 신호색을 쓰지 않는다.
    const meterBase = css.match(/^\.quota-meter \{[^}]*\}/m)?.[0] ?? "";
    expect(meterBase).toContain("--meter-accent: var(--ink-fog);");
    expect(css).toMatch(/\.quota-meter--warning \{[^}]*--meter-accent: var\(--warn\);/);
    expect(css).toMatch(/\.quota-meter--critical \{[^}]*--meter-accent: var\(--coral\);/);
    const fill = css.match(/\.quota-meter__fill \{[^}]*\}/)?.[0] ?? "";
    expect(fill).toContain("background: var(--meter-accent);");

    // (b) 예측은 아직 쓰지 않은 몫이다 — 단색으로 칠하는 순간 이미 쓴 양으로 읽힌다.
    const projection = css.match(/\.quota-meter__projection \{[^}]*\}/)?.[0] ?? "";
    expect(projection).toContain("repeating-linear-gradient(");
    expect(projection).not.toMatch(/background:\s*var\(--meter-accent\)/);

    // (c) 경과 눈금은 상태가 아니라 시계다 — 신호색을 빌리면 위험 표식으로 읽히고,
    // 채움이 이 눈금보다 앞섰는지 뒤졌는지를 비교하는 기준 자체가 사라진다.
    const elapsedMark = css.match(/\.quota-meter__elapsed \{[^}]*\}/)?.[0] ?? "";
    expect(elapsedMark).toMatch(/background: color-mix\(in oklab, var\(--text-primary\) \d+%, transparent\);/);
    expect(elapsedMark).not.toMatch(/var\(--(?:warn|coral|positive|aurora|brass)/);

    // (d) 세 겹은 트랙 안에 갇힌다 — 100%를 넘긴 예측이 새면 이웃 미터 위에 그려진다.
    const bar = css.match(/\.quota-meter__bar \{[^}]*\}/)?.[0] ?? "";
    expect(bar).toContain("position: relative;");
    expect(bar).toContain("overflow: hidden;");
  });

  it("pins the quota legend as a footer-bounded disclosure that focus cannot hold open", () => {
    const css = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");
    const panel = externalSource(QUOTA_PANEL_PATH).replace(/\r\n/g, "\n");

    // 말풍선의 기준 상자는 버튼이 아니라 푸터다 — 레일은 240px까지 좁아지고 패널 슬롯은
    // overflow:hidden이라, 버튼에 걸린 고정 폭은 좁은 레일에서 왼쪽이 잘려 읽히지 않는다.
    const footer = css.match(/\.quota-footer \{[^}]*\}/)?.[0] ?? "";
    expect(footer).toContain("position: relative;");
    const legend = css.match(/^\.quota-legend \{[^}]*\}/m)?.[0] ?? "";
    expect(legend).not.toContain("position: relative;");
    const bubble = css.match(/\.quota-legend__bubble \{[^}]*\}/)?.[0] ?? "";
    expect(bubble).toContain("left: 16px;");
    expect(bubble).toContain("right: 16px;");
    expect(bubble).toContain("width: auto;");
    expect(bubble).toContain("max-width: 268px;");

    // 포커스는 표시를 결정하지 않는다 — :focus-within으로 열면 Escape가 상태를 내려도
    // 포커스가 버튼에 남아 말풍선은 보이는 채로 aria-expanded만 false가 되어,
    // 눈에 보이는 것과 접근성 트리가 서로를 부정한다.
    expect(css).not.toMatch(/\.quota-legend[^{}]*:focus-within/);
    expect(panel).toContain("aria-expanded={pinned}");
    expect(panel).toContain('if (event.key === "Escape") setPinned(false);');
  });

  it("pins the shared panel motion layer and existence choreography grammar", () => {
    const components = source("styles/components.css");
    // (a) 공통 모션 레이어의 duration/easing은 토큰 표기만 — 리터럴 ms 진입 금지.
    const baseBlock = components.match(/^\.canvas-operation \{[^}]*\}/m)?.[0] ?? "";
    // stagger는 geometry 4속성 전용 CSS 변수 채널로만 흐른다 — inline transition-delay는
    // 존재 전환(opacity/visibility)의 per-property 지연을 덮어쓰므로 그 진입 자체를 봉인한다.
    for (const property of ["left", "top", "width", "height"]) {
      expect(baseBlock).toContain(`${property} var(--duration-slow) var(--ease-glide) var(--panel-stagger-delay, 0s)`);
    }
    expect(baseBlock).toContain("opacity var(--duration-base) var(--ease-glide),");
    expect(baseBlock).toContain("transform var(--duration-base) var(--ease-glide),");
    expect(baseBlock).not.toContain("opacity var(--duration-base) var(--ease-glide) var(--panel-stagger-delay");
    expect(baseBlock).toContain("visibility 0s linear 0s");
    expect(baseBlock).not.toMatch(/\d+ms/);
    const minimizedBlock = components.match(/\.canvas-operation\.is-minimized \{[^}]*\}/)?.[0] ?? "";
    expect(minimizedBlock).toContain("visibility 0s linear var(--duration-base)");
    expect(minimizedBlock).not.toMatch(/\d+ms/);
    // (b) 드래그·리사이즈 조작 중에는 공통 transition을 통째로 끊는다.
    const draggingBlock = components.match(/\.canvas-operation\.is-dragging \{[^}]*\}/)?.[0] ?? "";
    expect(draggingBlock).toContain("transition: none;");
    // (b') 사이드바 접기/펼치기도 같은 억제를 받는다. 사이드바의 width 전환이 중앙 트랙을 매 프레임
    // 리플로우시키는 동안 이 프레임이 자기 글라이드로 뒤따르면 상자가 사이드바보다 오래 움직이고,
    // 그동안 터미널은 옛 격자로 남는다. 플래그 소유자는 side-bar-motion.ts의 width 전환 이벤트다.
    const sideBarAnimatingBlock = components.match(/body\[data-side-bar-animating="true"\] \.canvas-operation \{[^}]*\}/)?.[0] ?? "";
    expect(sideBarAnimatingBlock).toContain("transition: none;");
    // (c) components.css의 reduced-motion 통합 블록이 캔버스 패널·companion 프레임을 커버한다.
    // is-minimized(0,2,0)는 .canvas-operation(0,1,0)을 이기므로 반드시 블록 안에 함께 명시된다.
    const reducedMotionBlock = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotionBlock).toMatch(/\.canvas-operation,\s*\.canvas-operation\.is-minimized \{\s*transition: none;\s*\}/);
    expect(reducedMotionBlock).toMatch(/\.canvas-companion-frame \{\s*animation: none;\s*\}/);
    // 모션 억제 축은 OS의 prefers-reduced-motion 하나다 — 콘솔 설정 축(.reduce-panel-motion)은 퇴역했고,
    // 재도입되면 미디어 쿼리 블록과 규칙이 갈라지므로 셀렉터 자체를 봉인한다.
    expect(components).not.toContain(".reduce-panel-motion");
    // (d) 존재 전환 keyframe은 panel-enter로 일반화 — companion 전용 명칭은 퇴역하고 실제 사용까지 고정한다.
    expect(components).toContain("@keyframes panel-enter");
    expect(components).toContain("animation: panel-enter var(--duration-slow) var(--ease-glide) both;");
    expect(components).not.toContain("companion-frame-enter");
    // (e) 안무 표면(칩 도착 맥동·고스트)도 reduced-motion 블록 안에서 무효화된다.
    expect(reducedMotionBlock).toContain(".side-bar-chip.is-arrival-pulse {");
    expect(reducedMotionBlock).toContain(".panel-motion-ghost {");
    // Watch Deck 칸이 자기 패널에 실어 주는 도착·착지 신호도 같은 reduced-motion 봉인을 공유한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-cell.is-landed > .canvas-triage-deck-mount > .canvas-operation,");
    // 지도 점의 착지 플래시도 칸과 같은 봉인을 공유한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-map-dot.is-landed,");
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-cell.is-arriving > .canvas-triage-deck-mount > .canvas-operation,");
    // 스포트라이트 OFF의 지속 맥동은 움직임을 빼고도 정지한 aurora 링으로 읽혀야 한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-cell.is-fresh > .canvas-triage-deck-mount > .canvas-operation,");
    // 작전지도 LOD 전환(cross-fade·마커 강조)도 같은 봉인 안에서 즉시 상태로 떨어진다.
    expect(reducedMotionBlock).toContain(".canvas-triage-map,");
    expect(reducedMotionBlock).toContain(".canvas-triage-map-dot,");
    expect(reducedMotionBlock).toContain(".canvas-triage-map-dot-label {");
    // 지도 점의 대기 링 맥동과 전 상태 유영도 같은 봉인에 들어가고, 대기 신호는 정지 링 폴백으로 남는다.
    expect(reducedMotionBlock).toContain(".canvas-triage-map-dot.is-awaiting::after,");
    expect(reducedMotionBlock).toContain(".canvas-triage-deck.is-map-mode .canvas-triage-map-dot,");
    // 착지 flash 우선 규칙은 봉인 항목들보다 세다 — 결합 셀렉터를 봉인에 직접 올린다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck.is-map-mode .canvas-triage-map-dot.is-landed,");
    // 지도 Quick-Look 등장 연출도 같은 봉인을 공유한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-map-quicklook,");
    expect(reducedMotionBlock).toContain("transform: scale(1.35);");
    // 밀도 변형(카드↔점)은 JS가 reduced-motion에서 프레임 자체를 만들지 않고, 남은 표면
    // cross-fade만 봉인에서 끊는다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck.is-map-mode .canvas-triage-deck-band-cards,");
  });

  it("pins the dormant resume feedback grammar — pending pulse, error card, and reduced-motion fallback", () => {
    const components = source("styles/components.css");
    // (a) pending pulse는 opacity 2단 맥동 하나뿐 — 새 안무는 keyframe과 사용처가 함께 고정된다.
    expect(components).toContain("@keyframes dormant-resume-pulse");
    expect(components).toContain(".canvas-operation-dormant-action--pending {\n  animation: dormant-resume-pulse");
    // (b) 접근성 폭백: pulse는 전용 reduced-motion 블록에서 무효화된다.
    const pendingReducedMotion = components.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.canvas-operation-dormant-action--pending \{\s*animation: none;\s*\}\s*\}/)?.[0] ?? "";
    expect(pendingReducedMotion).toContain("animation: none;");
    // (c) 에러 카드 문법: 상태 채널은 signal/neutral 토큰만, 회복 액션의 강조는 brass(focus/hover) 채널만.
    const errorBlock = components.match(/\.canvas-operation-dormant--error \{[^}]*\}/)?.[0] ?? "";
    expect(errorBlock).toContain("cursor: default;");
    const errorText = components.match(/\.canvas-operation-dormant-error \{[^}]*\}/)?.[0] ?? "";
    expect(errorText).toContain("color: var(--text-secondary);");
    const ghostAction = components.match(/\.canvas-operation-dormant-action--ghost \{[^}]*\}/)?.[0] ?? "";
    expect(ghostAction).toContain("color: var(--text-secondary);");
    const ghostHover = components.match(/\.canvas-operation-dormant-action--ghost:hover,[^]*?\{[^}]*\}/)?.[0] ?? "";
    expect(ghostHover).toContain("color: var(--brass-bright);");
    // (d) pending/disabled 중에는 hover 강조가 다시 점화하지 않는다.
    const disabledHover = components.match(/\.canvas-operation-dormant:disabled:hover \{[^}]*\}/)?.[0] ?? "";
    expect(disabledHover).toContain("var(--brass) 10%");
  });

  it("pins the demoted dormant shelf outside the live queue", () => {
    const sidebar = source("sidebar/triage-side-bar.tsx");
    const components = source("styles/components.css");
    const shelf = components.match(/\.triage-side-bar-dormant-shelf \{[^}]*\}/)?.[0] ?? "";
    const caption = components.match(/\.triage-side-bar-caption \{[^}]*\}/)?.[0] ?? "";

    expect(sidebar).toContain('const livingSections = sections.filter((section) => section.status !== "ended")');
    expect(sidebar).toContain('className="operations-side-bar-chips triage-side-bar-sections"');
    // 선반은 Operation 메뉴를 갖지 않는 표면이므로 브라우저 메뉴도 열지 않는다 — 칩의
    // menuEnabled=false는 핸들러를 떼기만 하므로 억제는 선반 자신이 진다.
    expect(sidebar).toMatch(/<footer className="triage-side-bar-dormant-shelf" onContextMenu=\{\(event\) => event\.preventDefault\(\)\}>/);
    expect(sidebar).toContain('<ol className="triage-side-bar-dormant-list"');
    expect(sidebar).toContain("defaultCollapsed");
    expect(sidebar.indexOf('className="triage-side-bar-dormant-shelf"')).toBeGreaterThan(
      sidebar.indexOf('className="operations-side-bar-chips triage-side-bar-sections"'),
    );
    expect(shelf).toContain("border-top: 1px solid var(--surface-rim);");
    expect(shelf).not.toMatch(/var\(--(?:brass|aurora|warn|coral|positive)/);
    expect(caption).toMatch(/color: var\(--text-(?:primary|secondary|tertiary|on-brass)\)/);
    expect(caption).toMatch(/font-weight: var\(--weight-(?:regular|medium|bold)\)/);
  });

  it("collapses sidebar chip actions out of layout until hover or focus-within", () => {
    const components = source("styles/components.css");
    const restingActions = components.match(/\.side-bar-chip-close,\n\.side-bar-chip-minimize \{[^}]*\}/)?.[0] ?? "";
    const revealedActions = components.match(/\.side-bar-chip:hover \.side-bar-chip-close,[^]*?\.side-bar-chip:focus-within \.side-bar-chip-minimize \{[^}]*\}/)?.[0] ?? "";
    const armedClose = components.match(/\.side-bar-chip \.side-bar-chip-close\.is-armed \{[^}]*\}/)?.[0] ?? "";

    expect(restingActions).toContain("flex: 0 0 0;");
    expect(restingActions).toContain("width: 0;");
    expect(restingActions).toContain("height: 0;");
    expect(restingActions).toContain("margin-left: calc(-1 * var(--space-2));");
    expect(restingActions).toContain("overflow: hidden;");
    expect(restingActions).toContain("opacity: 0;");
    expect(restingActions).toContain("width var(--duration-base) var(--ease-spring)");
    expect(restingActions).toContain("margin-left var(--duration-base) var(--ease-spring)");
    expect(restingActions).toContain("opacity var(--duration-base) var(--ease-spring)");
    expect(revealedActions).toContain("flex: none;");
    expect(revealedActions).toContain("width: 20px;");
    expect(revealedActions).toContain("height: 20px;");
    expect(revealedActions).toContain("margin-left: 0;");
    expect(revealedActions).toContain("opacity: 1;");
    expect(revealedActions).toContain("pointer-events: auto;");
    expect(armedClose).toContain("width: auto;");
    expect(armedClose).toContain("margin-left: 0;");
    expect(armedClose).toContain("border: 1px solid color-mix(in oklch, var(--coral) 50%, transparent);");
    expect(armedClose).toContain("opacity: 1;");
    expect(armedClose).toContain("pointer-events: auto;");
    expect(components.indexOf(".side-bar-chip .side-bar-chip-close.is-armed")).toBeGreaterThan(components.indexOf(".side-bar-chip:hover .side-bar-chip-close"));
    expect(components).toContain(".side-bar-chip-close,\n  .side-bar-chip-minimize {\n    transition-duration: 0.01ms;");
    expect(components).toContain(".side-bar-chip .side-bar-chip-close.is-armed {\n    animation: none;");
  });

  it("keeps Formation and maximize store contracts without the retired focus mode", () => {
    const store = source("canvas/canvas-store.ts");
    expect(store).toContain("toggleFormationView");
    expect(store).not.toContain("MapFullscreen");
    expect(store).toContain("setMaximizedOperationId");
  });

  it("pins the non-durable STATUS regroup signal and identity channel grammar", () => {
    const app = source("app.tsx");
    const operations = source("pages/operations.tsx");
    const sidebar = source("sidebar/operations-side-bar.tsx");
    const sideBarStore = source("sidebar/operations-side-bar-store.ts");
    const idleArrival = source("operation-idle-arrival.ts");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const components = source("styles/components.css");

    expect(operations).toContain('event.code === "KeyS" && !event.shiftKey');
    expect(operations).toContain("toggleSideBarStatusAxis();");
    expect(sidebar).toContain('title={t("sidebar.theater.sortByStatusTitle")}');
    expect(sidebar).toContain("groupTheaterStatusEntries(");
    expect(sidebar).toContain("minimizedIds.has(entry.operation.id) && !dormantIds.has(entry.operation.id)");
    expect(sidebar).toContain("<StatusRecoveryShelves");
    expect(components).toContain(".side-bar-status-section--minimized {");
    expect(sidebar).toContain("trackOperationActivityTransitions({");
    expect(sidebar).toContain("const landedIds = consumeStatusLandings();");
    expect(sidebar).not.toContain("recordStatusTransitions(movedIds);");
    expect(app).toContain("useEffect(() => subscribeOperationActivityTracking(), []);");
    expect(sidebar).toContain("if (!statusAxis) {");
    expect(chip).toContain("reorderEnabled && event.altKey && event.shiftKey");
    expect(chip).toContain('className="side-bar-chip-unseen"');
    expect(chip).not.toContain("statusAxis && idleUnseen");
    expect(sideBarStore).toContain("let statusAxis = false;");
    expect(sideBarStore).toContain("let statusTransitionTicks = new Map<string, number>();");
    expect(idleArrival).toContain("let idleArrivalIds = new Set<string>();");
    expect(sideBarStore).toContain("let previousActivityById = new Map<string, SideBarStatus>();");
    expect(sideBarStore).toContain("let baselinedLiveActivityIds = new Set<string>();");
    expect(sideBarStore).toContain("let pendingStatusLandingIds = new Set<string>();");
    expect(idleArrival).toContain("export function subscribeIdleArrival(");
    expect(sideBarStore).not.toContain("idleUnseenIds");
    expect(sideBarStore).not.toContain("STORAGE_KEY_STATUS");
    expect(sideBarStore).not.toContain("fleet-console.operations.status");

    // Doctrine: status-section border/dot/count are signal-owned, while the chip group mark
    // consumes only resolveAccentColor identity values and never repaints the status beacon.
    expect(sidebar).toContain("groupMarkByGroupId.get(entry.operation.groupId)");
    expect(components).toContain(".tenant-beacon.is-awaiting,\n.canvas-triage-map-dot.is-awaiting,\n.side-bar-status-section--awaiting {");
    expect(components).toMatch(/\.tenant-beacon\.is-idle,\s*\.canvas-triage-map-dot\.is-idle,\s*\.side-bar-status-section--idle\s*\{[^}]*--activity-color:\s*var\(--positive\)/);
    expect(components).toContain(".tenant-beacon.is-ended,\n.canvas-triage-map-dot.is-ended,\n.side-bar-status-section--ended {");
    expect(components).toContain("--activity-color: var(--ink-fog);");
    expect(components).toMatch(/\.tenant-beacon\.is-background,\s*\.canvas-triage-map-dot\.is-background,\s*\.side-bar-status-section--background\s*\{[^}]*--activity-color:\s*var\(--warn\)/);
    expect(components).toMatch(/\.canvas-triage-map-dot \{[^}]*background:\s*var\(--activity-color\)/);
    // War Room 덱은 자기 상태 축을 갖지 않는다 — 칸에 선 것이 패널이라 캡션 비콘이 이 선언을 그대로 받는다.
    expect(components).not.toContain(".canvas-triage-deck-card");
    expect(components).toMatch(/\.canvas-triage-map-dot\.is-background \{[^}]*background:\s*none;[^}]*border-color:\s*var\(--activity-color\)/);
    expect(components).toContain("--status-color: var(--activity-color);");
    expect(components).toContain("border-left: 3px solid var(--status-color);");
    expect(components).toMatch(/\.side-bar-status-section--background \{[^}]*border-left-style:\s*dashed/);
    expect(components).toMatch(/\.side-bar-status-section--background \.side-bar-status-header__dot \{[^}]*background:\s*none;[^}]*border:\s*1\.5px solid var\(--activity-color\)/);
    expect(components).toContain("background: var(--group-mark);");
    expect(components).toMatch(/\.side-bar-chip-unseen \{[^}]*background:\s*var\(--positive\)/);
    expect(components).toMatch(/\.side-bar-chip--unseen \{[^}]*border-color:\s*color-mix\(in oklch, var\(--positive\)/);
    // 미확인 완료는 패널 아웃라인이 아니라 캡션 아랫변 레일이 나른다 — 상시 aura는 사라졌다.
    expect(components).toMatch(/\.canvas-operation\.is-unseen \{[^}]*--caption-rail:\s*var\(--positive\)/);
    expect(components).not.toContain(".canvas-operation.is-unseen.is-active {");
    expect(components).toMatch(/\.side-bar-status-header__unseen::before \{[^}]*background:\s*var\(--positive\)/);
    expect(components).toContain(".side-bar-status-axis-live-tick,");
    expect(components).toContain(".side-bar-status-header--awaiting .side-bar-status-header__dot {");
  });

  it("pins the selectable Right Rail panel behavior contract", () => {
    const rail = source("styles/rail.css");
    const rightRail = source("rail/right-rail.tsx");
    const railStore = source("rail/rail-store.ts");
    expect(rail).toContain(".right-rail.is-overlay");
    expect(rail).toContain(".right-rail.is-switching");
    // Doctrine: the overlay slot ::before composites its glass layers over an opaque
    // var(--ink-deep) final layer — maritime/carbon --surface-glass-strong is a 78~80%
    // alpha token, so without the underlay the slider's 100% endpoint can never be opaque.
    expect(rail).toMatch(/\.right-rail\.is-overlay \.right-rail-panel-slot::before \{[^}]*\)\s*,\s*var\(--ink-deep\);/);
    // Doctrine: keep both WebKit and Firefox track styling so the continuous
    // opacity control communicates its filled range in either engine.
    expect(rail).toContain(".right-rail-alpha-slider::-moz-range-progress");
    expect(rightRail).toContain("useRailPanelBehavior");
    expect(rightRail).toContain("right-rail-float-toggle");
    expect(rightRail).toContain("right-rail-alpha-slider");
    expect(rightRail).toContain("is-switching");
    expect(railStore).toContain("fleet-console.rail.panelBehavior");
    // Doctrine: Operation panels keep a 32px attached caption. The Activity Rail
    // does not — its head is hover-reveal chrome so the body uses the full slot.
    // Hide with opacity+transform only (never display/visibility) so keyboard
    // focus can still enter and reveal it; reveal entry stays pointermove-gated
    // with an intent delay so scroll-under-pointer never triggers it.
    expect(rail).toContain(".right-rail-panel-head-reveal");
    expect(rail).toMatch(/\.right-rail-panel-head-reveal \{[^}]*pointer-events:\s*none/);
    expect(rail).toMatch(/\.right-rail-panel-head-reveal\.is-revealed \{[^}]*pointer-events:\s*auto/);
    expect(rail).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^{]*\.right-rail-panel-head-reveal/);
    expect(rail).toContain(".right-rail-panel-peek");
    expect(rail).not.toContain("grid-template-rows: 32px minmax(0, 1fr);");
    expect(rightRail).toContain("HEAD_REVEAL_INTENT_DELAY_MS");
    expect(rightRail).not.toMatch(/onPointerEnter=\{(?:handleSlotPointerMove|holdHeadOpen)/);
    expect(source("styles/components.css")).toContain(".canvas-operation.is-top-edge .canvas-operation-titlebar");
    expect(source("styles/components.css")).toContain(".canvas-operation.is-top-edge .canvas-operation-resize--n");
    expect(source("canvas/operation-frame.tsx")).toContain("DRAG_THRESHOLD_PX");
    expect(source("canvas/operation-frame.tsx")).toContain("capturing: false");
  });

  it("pins the popup opacity underlay contract", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    const scuttlebuttCss = externalSource(SCUTTLEBUTT_CSS_PATH);
    // Doctrine: scrim-backed popup cards, floating menus, and anchored guidance cards
    // composite their glass layers over an opaque var(--ink-deep) final layer —
    // maritime/carbon/whites glass tokens carry 60~82% alpha, so without the underlay they
    // bleed the canvas through and legibility collapses (canonical doctrine comment:
    // .whatsnew-card in components.css). Non-popup glass surfaces keep the themes'
    // translucent glass identity untouched.
    const componentsPopupSelectors = [
      ".whatsnew-card",
      ".commissioning-card",
      ".control-curtain-card",
      ".control-reclaimed-card",
      ".directory-browser-card",
      ".add-host-card",
      ".codex-reading-sheet",
      ".app-toast",
      ".command-band-system-menu",
      ".group-context-menu-card",
      ".accent-popover-card",
      ".theater-menu",
      ".operation-search-card",
      ".quick-launch-card",
      ".feature-tour-card",
    ];
    // Quick Launch 오버레이도 fleet-pop을 타므로 억제 절을 함께 못 박는다 — 규칙 옆에 붙은
    // 자체 reduced-motion 블록은 .fc-select__* 선례와 같은 형태다.
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.quick-launch-overlay \{\s*animation: none;\s*\}/);
    for (const selector of componentsPopupSelectors) {
      const scoped = selector.replace(/\./g, "\\.");
      expect(components).toMatch(new RegExp(`${scoped} \\{[^}]*\\),\\s*var\\(--ink-deep\\);`));
    }
    expect(layout).toMatch(/\.command-band-menu \{[^}]*\),\s*var\(--ink-deep\);/);
    expect(skillsCss).toMatch(/\.skills-overlay-dialog \{[^}]*\),\s*var\(--ink-deep\);/);
    expect(skillsCss).toMatch(/\.skills-toast \{[^}]*\),\s*var\(--ink-deep\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__artifact-menu \{[^}]*var\(--ink-deep\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__export-menu \{[^}]*var\(--ink-deep\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__slash \{[^}]*var\(--ink-deep\);/);
    // Quaker aides float over the Map — the same glass token that is opaque on Instrument
    // is 78~82% alpha on every other theme, so the speech surfaces need the underlay too.
    for (const selector of [
      ".scuttlebutt-bird-tag",
      ".scuttlebutt-bird-say",
      ".scuttlebutt-arrival-bubble",
      ".scuttlebutt-answer-bubble",
      ".scuttlebutt-departure-bubble",
      ".scuttlebutt-chat-card",
    ]) {
      const scoped = selector.replace(/\./g, "\\.");
      expect(scuttlebuttCss).toMatch(new RegExp(`${scoped} \\{[\\s\\S]*?\\),\\s*var\\(--ink-deep\\);`));
    }
  });

  it("pins the Command Band and closed-chrome contracts", () => {
    const app = source("app.tsx");
    const commandBand = source("components/command-band.tsx");
    const theme = source("styles/theme.css");
    const layout = source("styles/layout.css");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");
    expect(app).toContain("<CommandBand operationsViewVisible={operationsViewVisible} />");
    expect(app).not.toContain("FocusMode");
    expect(app).not.toContain("is-focus-mode");
    expect(app).not.toContain("GlobalNavigation");
    expect(layout).not.toContain("--console-gnb-height");
    expect(layout).not.toContain("is-focus-mode");
    expect(theme).toContain("--chrome-band-height: 44px;");
    expect(commandBand).toContain('className="command-band-button command-band-sidebar-toggle"');
    expect(commandBand).toContain("<BrandHome />");
    expect(commandBand).toContain("<CommandBandSystemCluster />");
    expect(commandBand).toContain("onClick={handleSideBarToggle}");
    expect(commandBand).toContain('className="command-band-button command-band-search"');
    expect(commandBand).toContain("onClick={toggleOperationSearch}");
    expect(commandBand).toContain('className="command-band-button command-band-viewmode"');
    expect(commandBand).toContain('className="command-band-button command-band-rail-toggle"');
    expect(commandBand).toContain("onClick={handleRailToggle}");
    // 두 패널 토글은 라우트가 아니라 뷰 모드로만 걸린다 — /operations 밖에서도 밴드에 상주하고,
    // 눌리면 Operations로 돌아가 그 표면을 펼친다(사라지는 조작 표면 + 무음 단축키 금지).
    expect(commandBand).toContain("const panelTogglesVisible = viewMode.effective !== \"mobile\";");
    expect(commandBand).toContain("{panelTogglesVisible ? <button type=\"button\" className=\"command-band-button command-band-sidebar-toggle\"");
    expect(commandBand).toContain("{panelTogglesVisible ? <button type=\"button\" className=\"command-band-button command-band-rail-toggle\"");
    expect(commandBand).toContain(`      </div>
      {operationsViewVisible ? <div ref={mapControlsRef} className={\`command-band-map-controls\${sideBar.collapsed ? " is-docked" : ""}\`}>`);
    // 접힘 도킹 구분선은 맵 컨트롤의 첫 플로우 자식이다 — 도킹 상태에서만 display로 나타나
    // 좌측 컨트롤군과 클러스터를 formation-divider 문법의 hairline으로 잇는다.
    expect(commandBand).toContain('<span className="command-band-dock-divider" aria-hidden="true" />');
    expect(commandBand).toContain('aria-label={t("chrome.commandBand.resetCanvasView")}');
    expect(commandBand).toContain("<ResetViewIcon />");
    expect(commandBand).toContain("onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })}");
    // 캔버스 모드는 세그먼트 스위치 하나가 단독으로 소유한다 — 모드별 도구를 밴드에 상시
    // 늘어놓으면 다른 모드의 도구를 눌러 무경고로 모드를 이탈시킬 수 있다(2026-08 격자 클릭 사고).
    expect(commandBand).toContain('className="command-band-mode-switch" role="group" aria-label={t("chrome.commandBand.canvasMode")}');
    // 모드는 낱말로, 모드 전용 도구는 아이콘으로 말한다 — 세그먼트에 아이콘을 더하면 클러스터가
    // 375px까지 벌어져 1280px 밴드에서 중앙 브레드크럼이 사라진다(2026-08 실측).
    expect(commandBand).toContain('{ id: "cruise", label: "Cruise", titleKey: "chrome.commandBand.modeCruise" },');
    expect(commandBand).toContain('{ id: "tactical", label: "Tactical", titleKey: "chrome.commandBand.modeTactical" },');
    expect(commandBand).toContain('{ id: "warRoom", label: "War Room", titleKey: "chrome.commandBand.modeWarRoom" },');
    expect(commandBand).not.toMatch(/<mode\.Icon \/>/);
    expect(commandBand).toContain('const canvasMode: CanvasMode = triageActive ? "warRoom" : formationView ? "tactical" : "cruise";');
    expect(commandBand).toContain('aria-pressed={canvasMode === mode.id}');
    // 트레이는 활성 모드의 도구만 마운트한다 — 비활성 모드 도구는 disabled가 아니라 부재다.
    expect(commandBand).toContain('{canvasMode === "cruise" ? <div className="command-band-mode-tray"');
    expect(commandBand).toContain('{canvasMode === "tactical" ? <div className="command-band-mode-tray"');
    expect(commandBand).toContain('{canvasMode === "warRoom" ? <div className="command-band-mode-tray"');
    expect(commandBand).toContain("onClick={cycleTriageDeckZoomPreset}");
    expect(commandBand).toContain("onClick={() => setTriageSpotlightEnabled(!triageSpotlightEnabled)}");
    // 값은 남기되 낱말은 두지 않는다 — 아이콘 + 배율 수치.
    expect(commandBand).toContain("<DensityIcon /><span>{triageDeckZoomLive.toFixed(1)}×</span>");
    expect(commandBand).toContain('<span className="command-band-mode-tray-divider" aria-hidden="true" />');
    // 같은 레이아웃 재클릭은 무시한다 — selectFormationLayout은 동일 레이아웃에서 모드를 끄는데,
    // 모드 이탈 권한은 Cruise 세그먼트만 갖는다.
    expect(commandBand).toContain("onClick={() => { if (formationLayout !== layout.id) selectFormationLayout(layout.id); }}");
    expect(commandBand).toContain("aria-pressed={formationLayout === layout.id}");
    // Tactical은 Theater별 상태라 활성 Theater로, War Room은 전역 모드라 등록된 Theater 존재로 게이트한다.
    expect(commandBand).toContain('disabled={mode.id === "tactical" ? state.activeTheaterId === null : state.theaters.length === 0}');
    // 모드 이름은 번역하지 않는 제품 고유 명칭이다 — 로케일 메시지에 이름을 넣으면 두 벌이 생긴다.
    expect(commandBand).not.toMatch(/t\("chrome\.commandBand\.(triage|formationView)"\)/);
    const sidebar = source("sidebar/operations-side-bar.tsx");
    expect(sidebar).not.toContain("side-bar-formation-group");
    expect(sidebar).not.toContain("side-bar-theater-add-btn");
    expect(sidebar).toContain('className="side-bar-ghost-theater-row"');
    expect(sidebar).toContain('className="side-bar-ghost-theater-anchor"');
    expect(sidebar).not.toContain('className="side-bar-ghost-theater-row" onClick={openTheaterBrowser} disabled={addingTheater} aria-label');
    expect(sidebar).toContain('aria-label={t("sidebar.list.aria")}');
    expect(sidebar).not.toContain("restoreMinimized");
    expect(sidebar).not.toContain("Formation view including minimized panels");
    expect(components).toContain(".side-bar-ghost-theater-anchor {");
    expect(components).toContain("border: 1px dashed var(--ink-rim);");
    expect(components).not.toContain(".side-bar-formation-group {");
    expect(components).not.toContain(".side-bar-theater-add-btn {");
    expect(layout).toContain(".command-band-mode-switch {");
    expect(layout).toContain(".command-band-mode-seg {");
    expect(layout).toContain(".command-band-mode-tray-divider {");
    // 맵 컨트롤 클러스터는 컨테이너 플로우 배치다 — 개별 절대 위치 + 매직 오프셋(구 116px)은
    // 버튼 추가 시 겹침으로 깨지므로(선별 처리 아이콘 덮임 사고) 다시 도입하지 않는다.
    expect(layout).toContain(".command-band-map-controls {");
    // 앵커는 상태 이원제다: 펼침 = 사이드바 경계선(폭 미러), 접힘 = 좌측 컨트롤군 끝(도킹 앵커).
    // 옛 사이드바 폭에 고정하면 접힘 시 경계 없는 밴드 한가운데에 떠 보인다(2026-08 부유 사고).
    expect(layout).toContain("left: calc(var(--command-band-map-anchor, var(--command-band-left-width, 280px)) + var(--space-2));");
    expect(commandBand).toContain('"--command-band-map-anchor": `${mapControlsAnchor}px`,');
    expect(commandBand).toContain("const mapControlsAnchor = commandBandMapControlsAnchor(sideBar.collapsed, sideBar.width, leftContentEnd);");
    expect(commandBand).toContain("const centerGutter = commandBandCenterGutter(mapControlsAnchor - stageLeftWidth, mapControlsWidth);");
    // 글라이드는 접힘/펼침 앵커 전환 전용 — 드래그 리사이즈는 :has 게이트로 즉시 추종을 유지한다.
    expect(layout).toContain("transition: left 200ms ease;");
    expect(layout).toContain('body:has(.operations-side-bar[data-resizing="true"]) .command-band-map-controls { transition: none; }');
    expect(layout).toContain(".command-band-dock-divider {");
    expect(layout).toContain(".command-band-map-controls.is-docked .command-band-dock-divider {");
    expect(layout).not.toContain(".command-band-mode-switch {\n  position: absolute;");
    // 구 문법(모드 전용 도구를 밴드에 상시 노출)의 잔재는 남기지 않는다.
    expect(layout).not.toContain(".command-band-formation-group {");
    expect(layout).not.toContain(".command-band-triage-toggle {");
    // 데스크톱은 사이드바 폭을 그대로 미러하고, 모바일 셸에는 미러할 사이드바가 없으므로
    // 좌측 트랙이 내용 크기로 접힌다. 두 갈래를 한 줄로 고정해 한쪽만 바뀌는 표류를 막는다.
    expect(commandBand).toContain('"--command-band-left-width": viewMode.effective === "mobile" ? "min-content" : `${sideBar.width}px`');
    expect(layout).toContain("grid-template-columns: var(--command-band-stage-left) minmax(var(--command-band-center-gutter), 1fr) minmax(0, max-content) minmax(var(--command-band-center-gutter), 1fr) var(--command-band-stage-right);");
    const commandBandCenterBlock = layout.match(/\.command-band-center \{[^}]*\}/)?.[0] ?? "";
    const commandBandLeftBlocks = [...layout.matchAll(/\.command-band-left \{[^}]*\}/g)].map((match) => match[0]);
    const commandBandRightBlocks = [...layout.matchAll(/\.command-band-right \{[^}]*\}/g)].map((match) => match[0]);
    // 바깥 트랙은 실제 스테이지 경계(접힌 사이드바 0, 접힌 레일 스트립 0)를 담고, 좌측 캡과 우측
    // 클러스터는 여백 트랙까지 걸쳐 밴드 양끝에 붙는다. 좌우 여백 트랙은 동일 하한을 공유한다 —
    // 어느 한쪽이라도 어긋나면 브레드크럼이 스테이지 중심에서 밀린다.
    expect(layout).toContain(".command-band.is-utility {\n  grid-template-columns: auto minmax(0, 1fr) minmax(0, max-content) auto 0px;\n}");
    expect(layout).toContain("  --command-band-center-gutter: 44px;");
    expect(layout).toContain("  --command-band-stage-left: var(--command-band-left-width, 280px);");
    expect(layout).toContain("  --command-band-stage-right: 0px;");
    expect(commandBandLeftBlocks.some((block) => block.includes("grid-column: 1 / 3;"))).toBe(true);
    expect(commandBandCenterBlock).toContain("grid-column: 3;");
    expect(commandBandRightBlocks.some((block) => block.includes("grid-column: 4 / 6;"))).toBe(true);
    expect(commandBand).toContain('"--command-band-stage-left": viewMode.effective === "mobile" ? "min-content" : `${stageLeftWidth}px`,');
    expect(commandBand).toContain('"--command-band-stage-right": `${stageRightWidth}px`,');
    // 접힌 뒤에도 여백 하한을 주입하면 고정 트랙 합이 밴드 폭을 넘어 우측 컨트롤이 화면 밖으로
    // 밀린다(넓힌 사이드바를 접었을 때 특히). 주입값과 판정값을 분리해 고정한다.
    expect(commandBand).toContain("const injectedCenterGutter = centerBreadcrumbVisible ? centerGutter : 0;");
    expect(commandBand).toContain('"--command-band-center-gutter": `${injectedCenterGutter}px`,');
    expect(commandBand).toContain("{centerBreadcrumbVisible ? <div className=\"command-band-center\">");
    // 접힘은 편집 중이던 input을 언마운트하는데 blur가 발화하지 않는다 — 취소를 빼면 다시 넓혔을 때
    // 포커스 없는 스테일 draft로 되살아나 키보드로 빠져나올 수 없다.
    expect(commandBand).toContain("    if (!rename.renaming) return;\n    renameTargetOperationIdRef.current = null;\n    rename.cancel();");
    // 밴드 조상에 container-type을 걸면 contain:layout이 stacking context를 만들어
    // .command-band-menu(z-index:45)가 우현 레일 아래로 깔린다 — 판정은 JS 실측 전용.
    expect(layout).not.toContain("container-type");
    expect(layout).toContain("width: var(--command-band-left-width, 280px);");
    expect(commandBandCenterBlock).toContain("justify-content: center;");
    expect(commandBandCenterBlock).not.toContain("overflow:");
    expect(commandBandRightBlocks.some((block) => block.includes("justify-content: flex-end;"))).toBe(true);
    const rightRail = source("rail/right-rail.tsx");
    const railStore = source("rail/rail-store.ts");
    for (const legacyRightRailCoupling of ["rightRailWidth", "setRightRailWidth", "useRightRailWidth", "--command-band-right-width"]) {
      expect(commandBand).not.toContain(legacyRightRailCoupling);
      expect(rightRail).not.toContain(legacyRightRailCoupling);
      expect(railStore).not.toContain(legacyRightRailCoupling);
    }
    expect(rightRail).not.toContain("ResizeObserver");
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band {');
    // 브랜드 홈(a)·rename(input)까지 no-drag — button만 겨냥하면 데스크톱 드래그 영역이 클릭을 삼킨다.
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band button,');
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band a,');
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band input {');
    expect(layout).toContain('html[data-desktop-shell="true"][data-desktop-platform="darwin"] .command-band-left {');
    expect(commandBand).toContain("onDoubleClick={beginRename}");
    expect(commandBand).toContain("commandBandRenameCommitTarget");
    expect(commandBand).not.toContain("shouldCloseCommandBandContextDeck");
    expect(commandBand).not.toContain("data-carrier");
    expect(commandBand).not.toContain("<PathContextDeck");
    expect(layout).toContain("padding-inline-start: 88px;");
    expect(layout).toContain("max(0px, 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))");
    expect(layout).toContain("@media (prefers-reduced-motion: reduce)");
    expect(layout).toContain(".command-band-left {");
    expect(components).toContain(".operations-side-bar.is-closed");
    // 상단 크롬 좌측 블록은 사이드바와 같은 폭·표면·우측 경계선으로 그 열의 상단 캡이 된다.
    // 그래서 펼침 상태에서만 카드의 상단 테두리·안쪽 라운드를 해제한다 — 세 규칙이 함께 살아
    // 있어야 한 열 한가운데의 이중 hairline과 우측 경계선 단절이 재발하지 않는다.
    const commandBandLeftBlock = layout.match(/\.command-band-left \{[^}]*\}/)?.[0] ?? "";
    expect(commandBandLeftBlock).toContain("border-right: 1px solid var(--surface-rim);");
    expect(commandBandLeftBlock).toContain("background: var(--surface-chrome);");
    // 사이드바도 같은 크롬 표면을 소비해야 캡과 한 열로 읽힌다 — glass 회귀를 여기서 잡는다.
    const sideBarBlock = components.match(/^\.operations-side-bar \{[^}]*\}/m)?.[0] ?? "";
    expect(sideBarBlock).toContain("background: var(--surface-chrome);");
    // 패널은 하나의 면이다 — 본체·캡션·본문 거터가 모두 --surface-panel을 소비해야 창 하나로 읽힌다.
    // 셋 중 하나라도 다른 값을 잡으면 캡션 이음새나 터미널 둘레 액자 테가 되살아난다.
    const operationBlock = components.match(/^\.canvas-operation \{[^}]*\}/m)?.[0] ?? "";
    expect(operationBlock).toContain("background: var(--surface-panel);");
    expect(operationBlock).not.toContain("--surface-window");
    const titlebarBlock = components.match(/^\.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(titlebarBlock).toContain("background: var(--surface-panel);");
    expect(titlebarBlock).toContain("background var(--duration-base) var(--ease-spring)");
    // 캡션 아웃라인은 본문과 같은 --surface-rim이다. inherit는 본문 윗변을 비운 뒤
    // 계산색이 갈라져 캡션만 선이 빠진다.
    expect(titlebarBlock).toContain("border: 1px solid var(--surface-rim);");
    expect(titlebarBlock).toContain("border-bottom-width: 0;");
    expect(titlebarBlock).toContain("border-bottom-style: none;");
    expect(titlebarBlock).not.toContain("border-color: inherit;");
    expect(titlebarBlock).not.toContain("border-bottom: none;");
    const panelBodyBlock = components.match(/^\.canvas-operation-terminal \{[^}]*\}/m)?.[0] ?? "";
    expect(panelBodyBlock).toContain("background: var(--surface-panel);");
    // 레일 Shell 카드도 같은 면이다 — 이 기본 규칙의 소비처는 레일 하나뿐이고, 유리로 되돌리면
    // 카드가 자기 안의 xterm과 갈린다(불투명 xterm 배경은 반투명 유리를 따라갈 수 없다).
    const terminalShellBlock = components.match(/^\.terminal-shell \{[^}]*\}/m)?.[0] ?? "";
    expect(terminalShellBlock).toContain("background: var(--surface-panel);");
    // 휴면은 패널 면 위의 상태다 — 톤을 낮추는 베이스 레이어가 돌아오면 창 안에 다른 면이 생긴다.
    const dormantBlock = components.match(/^\.canvas-operation-dormant \{[^}]*\}/m)?.[0] ?? "";
    expect(dormantBlock).toContain("background: radial-gradient(");
    expect(dormantBlock).not.toContain("var(--ink-deep)");
    // 캡이 실재하는 상태로 한정한다 — 자동 은닉 풀스크린은 밴드가 fixed로 흐름에서 빠져 캡이
    // 없고, 사이드바가 뷰포트 최상단에 닿는다. 무조건 해제하면 그 화면에서 마감이 사라진다.
    // 도킹한 풀스크린은 밴드가 흐름으로 돌아와 다시 캡이 되므로 같은 해제를 받아야 한다.
    const expandedSideBarBlock =
      components.match(/\.console-shell:has\(\.command-band:not\(\.is-fullscreen\)\) \.operations-side-bar\.is-expanded,\n\.console-shell:has\(\.command-band\.is-docked\) \.operations-side-bar\.is-expanded \{[^}]*\}/)?.[0] ?? "";
    expect(expandedSideBarBlock).toContain("border-top: none;");
    expect(expandedSideBarBlock).toContain("border-top-right-radius: 0;");
    expect(components).not.toMatch(/^\.operations-side-bar\.is-expanded \{/m);
    expect(layout).toContain(".command-band.is-fullscreen {");
    // 접거나 풀스크린이면 상단 캡이 없으므로 부유 카드 문법이 그대로 남는다.
    expect(components).toContain("border-radius: 0 var(--radius-xl) 0 0;");
    expect(layout).toContain(".command-band-left.is-collapsed {");
    expect(components).not.toContain(".float-handle");
    expect(components).not.toContain("focus-mode-reveal");
    expect(rail).toContain(".right-rail.is-closed");
    expect(layout).not.toContain(".command-band-context-separator {");
    expect(layout).toContain(".command-band-theater-cluster {");
    expect(layout).not.toContain("--command-band-carrier");
    expect(commandBand).toContain("useFullscreenCommandBand");
    // 엣지 스트립은 자동 은닉일 때만 존재한다 — 도킹 중에 남기면 스테이지 최상단을 가로챈다.
    expect(commandBand).toContain("const edgeRevealActive = fullscreen.isFullscreen && !fullscreen.isDocked;");
    expect(commandBand).toContain('className={`command-band-edge-reveal${edgeRevealActive ? " is-fullscreen" : ""}`}');
    expect(commandBand).toContain('aria-label={t("chrome.commandBand.showCommandBand")}');
    expect(commandBand).toContain('aria-pressed={fullscreen.isDocked}');
    expect(commandBand).toContain("inert={commandBandHidden || undefined}");
    expect(commandBand).toContain("onKeyDown={(event) => { if (event.key === \"Tab\") fullscreen.reveal(); }}");
    expect(layout).toContain(".command-band.is-fullscreen {");
    expect(layout).toContain("position: fixed;");
    expect(layout).toContain("transform: translateY(-100%);");
    expect(layout).toContain("transition: transform var(--duration-base) var(--ease-glide);");
    expect(layout).toContain(".command-band-edge-reveal.is-fullscreen {");
    expect(layout).toContain("height: 8px;");
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band-edge-reveal {');
    // 도킹은 흐름 복귀다 — position/transform을 되돌리지 않으면 "계속 보이기"가 44px을 계속 덮는다.
    const dockedBandBlock = layout.match(/\.command-band\.is-fullscreen\.is-docked \{[^}]*\}/)?.[0] ?? "";
    expect(dockedBandBlock).toContain("position: relative;");
    expect(dockedBandBlock).toContain("transform: none;");
    // 떠 있을 때의 z-index를 물려받으면 그보다 낮은 오버레이(What's new는 35) 위에 밴드가
    // 그려지고 클릭까지 받는다 — 도킹은 창 모드와 같은 쌓임으로 돌아가야 한다.
    expect(dockedBandBlock).toContain("z-index: auto;");
    const whatsNewOverlayBlock = components.match(/\.whatsnew-overlay \{[^}]*\}/)?.[0] ?? "";
    expect(whatsNewOverlayBlock).toContain("z-index: 35;");
    // 모달 뒤로 물러나는 것은 떠 있는 밴드뿐이다 — 도킹된 밴드에 걸면 44px 빈 띠만 남는다.
    expect(layout).toContain('body:has([aria-modal="true"]:not([hidden])) .command-band.is-fullscreen:not(.is-docked),');
    // aria-pressed가 화면에 흔적을 남기지 않던 회귀를 막는다 — 밴드 토글의 눌림은 brass 채움이다.
    const pressedBandButtonBlock = layout.match(/\.command-band-button\[aria-pressed="true"\] \{[^}]*\}/)?.[0] ?? "";
    expect(pressedBandButtonBlock).toContain("background: color-mix(in oklch, var(--brass) 12%, transparent);");
    expect(pressedBandButtonBlock).toContain("color: var(--brass-ink);");
  });

  it("keeps long What's new content inside the scrollable body without shrinking controls", () => {
    const components = source("styles/components.css");
    const cardBlock = components.match(/\.whatsnew-card \{[^}]*\}/)?.[0] ?? "";
    const bodyBlock = components.match(/\.whatsnew-body \{[^}]*\}/)?.[0] ?? "";
    const bodyChildrenBlock = components.match(/\.whatsnew-body > \* \{[^}]*\}/)?.[0] ?? "";

    expect(cardBlock).toContain("grid-template-rows: auto minmax(0, 1fr) auto;");
    expect(cardBlock).toContain("overflow: hidden;");
    expect(bodyBlock).toContain("display: flex;");
    expect(bodyBlock).toContain("flex-direction: column;");
    expect(bodyBlock).toContain("min-height: 0;");
    expect(bodyBlock).toContain("overflow: auto;");
    expect(bodyChildrenBlock).toContain("flex: none;");
  });

  it("bounds the Codex navigator host so long Wiki entry lists keep native scrolling", () => {
    const components = source("styles/components.css");
    const navigatorLayout = source("codex/styles/layout.css");
    const railHostBlock = components.match(/\.codex-rail-host \{[^}]*\}/)?.[0] ?? "";
    const splitRailHostBlock = components.match(/\.codex-rail-host\.is-split \{[^}]*\}/)?.[0] ?? "";
    const navPaneBlock = components.match(/\.codex-nav-pane \{[^}]*\}/)?.[0] ?? "";
    const hostBlock = components.match(/\.codex-rail-host > \.codex-host,\n\.codex-nav-pane > \.codex-host \{[^}]*\}/)?.[0] ?? "";
    const navigatorBlock = navigatorLayout.match(/\.codex-navigator \{[^}]*\}/)?.[0] ?? "";
    const navigatorScrollBlock = navigatorLayout.match(/\.codex-navigator-scroll \{[^}]*\}/)?.[0] ?? "";

    expect(railHostBlock).toContain("height: 100%;");
    expect(railHostBlock).toContain("min-height: 0;");
    expect(splitRailHostBlock).toContain("display: grid;");
    expect(splitRailHostBlock).toContain("grid-template-rows: minmax(0, 1fr);");
    expect(splitRailHostBlock).toContain("height: 100%;");
    expect(splitRailHostBlock).toContain("min-height: 0;");
    expect(navPaneBlock).toContain("display: flex;");
    expect(navPaneBlock).toContain("flex-direction: column;");
    expect(navPaneBlock).toContain("min-height: 0;");
    expect(navPaneBlock).toContain("overflow: hidden;");
    expect(hostBlock).toContain("height: 100%;");
    expect(hostBlock).toContain("min-height: 0;");
    expect(navigatorBlock).toContain("display: flex;");
    expect(navigatorBlock).toContain("flex-direction: column;");
    expect(navigatorBlock).toContain("min-height: 0;");
    expect(navigatorBlock).toContain("height: 100%;");
    expect(navigatorScrollBlock).toContain("flex: 1;");
    expect(navigatorScrollBlock).toContain("min-height: 0;");
    expect(navigatorScrollBlock).toContain("overflow-y: auto;");
  });

  it("locks Command Band coordinate invariance to tint-only state changes", () => {
    const layout = source("styles/layout.css");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");
    // .command-band-left.is-collapsed 블록은 톤 전환(배경·경계색)만 가진다 —
    // 위치·크기·여백 속성이 들어오는 순간 좌표 불변 계약이 깨진다.
    const collapsedBlocks = layout.match(/^\.command-band-left\.is-collapsed \{[^}]*\}/gm) ?? [];
    expect(collapsedBlocks).toHaveLength(1);
    const collapsedDeclarations = (collapsedBlocks[0] ?? "")
      .replace(/^\.command-band-left\.is-collapsed \{/, "")
      .replace(/\}$/, "")
      .split(";")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(collapsedDeclarations.length).toBeGreaterThan(0);
    for (const declaration of collapsedDeclarations) {
      expect(declaration).toMatch(/^(?:background|border-color):/);
    }
    // 어떤 상태 셀렉터도 밴드 버튼의 기하를 조건부로 겨냥하지 못한다.
    const statefulBandButtonRule =
      /(?:is-closed|is-collapsed|data-sidebar|data-rail)[^{]*\.command-band-(?:button|sidebar-toggle|search|rail-toggle)|\.command-band-(?:button|sidebar-toggle|search|rail-toggle)[^{]*(?:is-closed|is-collapsed)/;
    expect(layout).not.toMatch(statefulBandButtonRule);
    expect(components).not.toMatch(statefulBandButtonRule);
    expect(rail).not.toMatch(statefulBandButtonRule);
    // reduced-motion 단락이 미디어 블록 내부에서 크롬 전환을 실제로 끊는지 블록 스코프로 고정한다.
    const reducedMotionBlock = layout.slice(layout.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotionBlock).toContain(".operations-side-bar,");
    expect(reducedMotionBlock).toContain(".right-rail,");
    expect(reducedMotionBlock).toContain(".command-band-map-controls,");
    expect(reducedMotionBlock).toContain(".command-band-left {");
    expect(reducedMotionBlock).toContain("transition: none !important;");
    expect(reducedMotionBlock).toContain(".command-band-dock-divider { animation: none !important; }");
  });

  it("keeps the Instrument base tokens and selector while blocking legacy palette escapes", () => {
    const theme = source("styles/theme.css");
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    expect(theme).toContain(':root[data-theme="instrument"]');
    expect(base).toContain("--ink-abyss: oklch(13% 0.014 245);");
    expect(base).toContain("--brass: oklch(80% 0.085 78);");
    expect(base).toContain("--ink-muted: oklch(64% 0.012 245);");
    expect(base).toContain("--aurora: oklch(77% 0.085 200);");
    expect(base).toContain("--coral: oklch(68% 0.13 25);");
    expect(base).toContain("--warn: oklch(75% 0.08 90);");
    expect(base).toContain("--positive: oklch(76% 0.11 160);");
    expect(base).toContain("--canvas-sea-core: oklch(13% 0.018 245);");
    expect(base).toContain("color-mix(in oklch, var(--brass) 16%, transparent)");
    expect(base).not.toMatch(/--brass(?:-[a-z-]+)?:\s*oklch\([^;]*\b0\.13\b/);
    expect(theme).toContain(':root[data-theme="maritime"]');
    expect(theme).toContain(':root[data-theme="carbon"]');
    expect(theme).toContain(':root[data-theme="whites"]');
    expect(theme).toContain("--brass: oklch(78% 0.13 75);");
    expect(theme).toContain("--ink-muted: oklch(75% 0.02 248);");
    expect(theme).toContain("--ink-muted: oklch(72% 0.005 250);");
    // 라이트 단일종(Whites)의 대기는 오트밀 웜 뉴트럴(hue 95~100)이다 — 청색(hue 250대) 대기 회귀를 차단한다.
    expect(theme).toContain("--ink-abyss: oklch(97% 0.003 100);");
    expect(theme.match(/^:root \{/gm)).toHaveLength(1);
    // Legacy dark 테마는 팔레트 토큰만 — 광학·color-scheme과 형상·타이포 오버라이드는 진입 불가.
    const darkVariantBlocks = theme.match(/^:root\[data-theme="(?:maritime|carbon)"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(darkVariantBlocks).toHaveLength(3);
    for (const block of darkVariantBlocks) {
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^--(?:ink|brass|aurora|coral|warn|positive|apex|crest|canvas|surface|hairline|text|id)[a-z-]*:$/);
      }
    }
    // Light 테마만 팔레트 + 광학(color-scheme/shadow/scrollbar/신호 ink·halo/본문 regular 굵기 보정)을 허용한다.
    // --weight-regular 단일 예외: 밝은 배경의 얇은 스템 광학 보정 — medium/bold 티어 오버라이드는 계속 차단.
    const lightVariantBlocks = theme.match(/^:root\[data-theme="whites"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(lightVariantBlocks).toHaveLength(1);
    for (const block of lightVariantBlocks) {
      expect(block).toContain("color-scheme: light;");
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^(?:--(?:ink|brass|aurora|coral|warn|positive|apex|crest|canvas|surface|hairline|text|id|provider|shadow|scrollbar)[a-z-]*|--weight-regular|color-scheme):$/);
      }
    }
    // 신호 ink 티어는 base에서 별칭으로 존재해 다크 3종이 var 간접으로 base 신호색을 상속한다.
    for (const ink of ["--brass-ink", "--aurora-ink", "--coral-ink", "--warn-ink", "--positive-ink"]) {
      expect(base).toContain(`${ink}: var(`);
      expect(theme.match(new RegExp(`${ink}:`, "g"))).toHaveLength(2);
    }
    // 크롬 표면 티어도 같은 별칭 구조다 — base가 glass 별칭을 제공해 다크 3종이 var 간접으로 상속하고,
    // 라이트(Whites)만 종이 표면보다 어두운 자체 리터럴로 분화한다(작업면 최명면 극성).
    expect(base).toContain("--surface-chrome: var(--surface-glass);");
    expect(theme.match(/--surface-chrome:/g)).toHaveLength(2);
    expect(theme).toContain("--surface-chrome: oklch(96% 0.004 100);");
    // 라이트 캔버스는 종이(터미널 98.2%)보다 어둡고 크롬보다 밝은 중간층이다 —
    // 이 순서가 무너지면 작업면 최명면 극성이 다시 뒤집힌다.
    expect(theme).toContain("--canvas-abyss: oklch(97.8% 0.003 100);");
    // brass 채움 위 텍스트 티어 — 다크는 abyss 별칭, 라이트는 페이지 배경과 독립된 자체 리터럴로
    // AA 4.5:1을 보장한다(abyss 결합 시 페이지 배경 조정이 버튼 대비를 함께 끌어내린다).
    expect(base).toContain("--text-on-brass: var(--ink-abyss);");
    expect(theme.match(/--text-on-brass:/g)).toHaveLength(2);
    expect(theme).toContain("--text-on-brass: oklch(99.5% 0.004 95);");
    // Operation 패널 면 티어 — 네 테마 모두가 값을 가지며 전부 작업면(터미널 필드) 톤이다.
    // Whites는 종이가 최명면이어야 한다: 크롬(96%)보다도, 패널 둘레에서 실측되는 sea 그라디언트
    // (L 94.9~96.6)보다도 밝아야 창이 책상에 녹지 않는다. 프레임 톤(ink-deep 95.5%)으로 내리면
    // 둘레 대비가 0.05까지 무너진 것이 실측으로 확인됐다.
    expect(base).toContain("--surface-panel: var(--ink-deep);");
    expect(theme).not.toContain("--surface-window");
    expect(theme.match(/--surface-panel:/g)).toHaveLength(4);
    expect(theme).toContain("--surface-panel: oklch(23% 0.03 248);");
    expect(theme).toContain("--surface-panel: oklch(19% 0.008 252);");
    expect(theme).toContain("--surface-panel: oklch(98.2% 0.004 100);");
    expect(theme.match(/--surface-panel: var\(--ink-deep\);/g)).toHaveLength(1);
    // 라이트 종이는 크롬보다 밝다 — 이 부등호가 뒤집히면 시선이 크롬으로 끌리는 극성 역전이다.
    const whitesBlock = theme.slice(theme.indexOf(':root[data-theme="whites"]'));
    expect(whitesBlock).toContain("--surface-chrome: oklch(96% 0.004 100);");
    // 얹히는 면은 패널 면에서 한 칸 물러난다 — 다크는 위(ink-mid), 라이트는 아래(ink-deep).
    expect(base).toContain("--surface-panel-raised: var(--ink-mid);");
    expect(whitesBlock).toContain("--surface-panel-raised: var(--ink-deep);");
    expect(theme.match(/--surface-panel-raised:/g)).toHaveLength(2);
    expect(theme).not.toContain("--surface-frame");
    expect(theme).not.toMatch(/#fff(?:fff)?\b/i);
    expect(theme).not.toMatch(/body::(?:before|after)/);
  });

  it("keeps every Operation panel body on the one panel surface", () => {
    const theme = source("styles/theme.css");
    const surface = fs.readFileSync(fileURLToPath(TERMINAL_SURFACE_PATH), "utf8");
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");

    // xterm은 CSS 변수를 못 받으므로 계산값을 읽어 넘긴다 — 이 경로가 사라지면 터미널 필드가
    // 토큰과 갈라져 캡션 이음새가 되살아난다.
    expect(surface).toContain('getComputedStyle(document.documentElement).getPropertyValue("--surface-panel")');
    expect(surface).toContain("...base, background: resolvePanelSurface(");

    // ITheme의 background 리터럴은 토큰을 못 읽는 환경의 폴백일 뿐이다 — 테마별로 theme.css의
    // --surface-panel과 같은 값이어야 폴백이 다른 면을 그리지 않는다.
    const themeBlockOf = (selector: string) => {
      const start = theme.indexOf(selector);
      return start < 0 ? "" : theme.slice(start, theme.indexOf("\n}", start));
    };
    const fallbackOf = (constName: string) => {
      const start = surface.indexOf(`const ${constName}: ITheme = {`);
      const block = start < 0 ? "" : surface.slice(start, surface.indexOf("\n};", start));
      return block.match(/background: "([^"]+)"/)?.[1] ?? "";
    };
    const baseTheme = theme.slice(0, theme.indexOf(':root[data-theme="'));
    const inkDeepOf = (block: string) => block.match(/--ink-deep: (oklch\([^)]*\));/)?.[1] ?? "";
    expect(fallbackOf("INSTRUMENT_TERMINAL_THEME")).toBe(inkDeepOf(baseTheme));
    expect(fallbackOf("MARITIME_TERMINAL_THEME")).toBe("oklch(23% 0.03 248)");
    expect(fallbackOf("CARBON_TERMINAL_THEME")).toBe("oklch(19% 0.008 252)");
    expect(fallbackOf("WHITES_TERMINAL_THEME")).toBe("oklch(98.2% 0.004 100)");

    // 채팅 뷰도 같은 본문이다 — 자기 면(ink-abyss)으로 되돌아가면 채팅 패널만 두 장으로 읽힌다.
    const chatRootBlock = chat.match(/^\.agent-chat \{[^}]*\}/m)?.[0] ?? "";
    expect(chatRootBlock).toContain("background: var(--surface-panel);");
    expect(chatRootBlock).not.toContain("--surface-window");
    expect(chatRootBlock).not.toContain("transition: background");
    const chatNodeBlock = chat.match(/^\.agent-chat-turn-node \{[^}]*\}/m)?.[0] ?? "";
    expect(chatNodeBlock).toContain("background: var(--surface-panel);");
    expect(chatNodeBlock).not.toContain("--surface-window");
    // 상단 세션 띠바와 하단 스트립은 둘 다 폐기됐다 — 지속 크롬으로 패널 높이를 쓰면서 누를 것이
    // 하나도 없었다. 로그는 캡션부터 패널 바닥까지 이어지고, 그 자리는 떠 있는 회신 버튼이 대신한다.
    expect(chat).not.toContain(".agent-chat-head");
    expect(chat).not.toContain(".agent-chat-strip");
    // 두 뷰의 전환 진입은 같은 칩 클래스를 공유한다 — 같은 자리·같은 모양이라야 한 쌍으로 읽힌다.
    const chatView = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    const terminalEntry = fs.readFileSync(fileURLToPath(TERMINAL_AGENT_PATH), "utf8");
    expect(chatView).toContain('className="agent-chat-mode-chip"');
    expect(terminalEntry).toContain('className="agent-chat-mode-chip"');
    // 회신 버튼은 로그 위에 떠 있는 컨트롤이라 신호 채널을 쓰지 않는다 — brass(위치·포커스)만
    // hover/focus에 오르고, 쉬는 상태는 패널 위 한 칸 물러난 면과 hairline이 진다.
    const chatReplyBlock = chat.match(/^\.agent-chat-reply \{[^}]*\}/m)?.[0] ?? "";
    expect(chatReplyBlock).toContain("background: var(--surface-panel-raised);");
    expect(chatReplyBlock).toContain("border: 1px solid var(--hairline-strong);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(chatReplyBlock).not.toContain(signal);
    }
    const chatReplyHoverBlock = chat.match(/^\.agent-chat-reply:hover,\n\.agent-chat-reply:focus-visible \{[^}]*\}/m)?.[0] ?? "";
    expect(chatReplyHoverBlock).toContain("border-color: var(--brass);");
    expect(chatReplyHoverBlock).toContain("outline: none;");
    // Follow 칩은 "바닥을 놓쳤다"는 상태라 쉬는 면에 aurora를 진다. brass는 hover/focus만.
    const chatFollowBlock = chat.match(/^\.agent-chat-follow \{[^}]*\}/m)?.[0] ?? "";
    expect(chatFollowBlock).toContain("background: var(--surface-panel-raised);");
    expect(chatFollowBlock).toContain("color: var(--aurora-ink);");
    expect(chatFollowBlock).toContain("left: 50%");
    for (const signal of ["--positive", "--warn", "--coral", "--brass"]) {
      expect(chatFollowBlock).not.toContain(signal);
    }
    const chatFollowHoverBlock = chat.match(/^\.agent-chat-follow:hover,\n\.agent-chat-follow:focus-visible \{[^}]*\}/m)?.[0] ?? "";
    expect(chatFollowHoverBlock).toContain("border-color: var(--brass);");
    expect(chatFollowHoverBlock).toContain("outline: none;");
    // 떠 있는 컨트롤은 자기 몫의 로그 여백을 함께 가진다 — 스크롤 컨테이너가 그만큼 비워 두지
    // 않으면 바닥까지 내린 마지막 줄이 컨트롤 뒤에 갇혀 스크롤로도 빠져나오지 못한다.
    // 위아래 두 여백이 각자의 컨트롤(전환 칩 32px · 회신 버튼 40px)을 넘어서는지 함께 고정한다.
    const chatLogBlock = chat.match(/^\.agent-chat-log \{[^}]*\}/m)?.[0] ?? "";
    const chatLogPadding = chatLogBlock.match(/padding: ([^;]+);/)?.[1] ?? "";
    expect(chatLogPadding).toContain("calc(var(--space-3) + 34px)");
    expect(chatLogPadding).toContain("calc(var(--space-3) + 45px)");
    const replySize = Number(chatReplyBlock.match(/height: (\d+)px;/)?.[1]);
    const logBottom = Number(chatLogPadding.match(/calc\(var\(--space-3\) \+ (\d+)px\)\s*$/)?.[1]);
    expect(logBottom).toBeGreaterThan(replySize);
    // 로그 위에 얹히는 면은 --surface-panel-raised로만 물러난다 — 잉크 티어를 직접 잡으면
    // 테마마다 다른 방향(다크는 위, 라이트는 아래)이 한 값으로 굳어 한쪽 테마에서 위계가 무너진다.
    // 스크림은 예외다 — ink-abyss 기반 오버레이는 제품 전역 관례이며 패널 면 위계와 무관하다.
    expect(chat).not.toContain("var(--ink-deep)");
    expect(chat.match(/var\(--ink-abyss\)/g) ?? []).toHaveLength(1);
  });

  it("pins the access-link QR colors outside every theme", () => {
    const theme = source("styles/theme.css");
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    // A QR is read by a camera, and the spec assumes dark modules on a light field. Letting a theme
    // repaint it would make a single-use credential's delivery depend on the owner's theme.
    const sourceTokens = {
      "--qr-field": "oklch(94% 0.008 90)",
      "--qr-module": "oklch(13% 0.014 245)",
    } as const;

    for (const [token, value] of Object.entries(sourceTokens)) {
      expect(base).toContain(`${token}: ${value};`);
      expect(theme.match(new RegExp(`${token}:`, "g"))).toHaveLength(1);
    }

    // And the symbol must consume them rather than carrying its own literals.
    const components = source("styles/components.css");
    expect(components).toContain("background: var(--qr-field);");
    expect(components).toContain("fill: var(--qr-module);");
  });

  it("pins immutable Scuttlebutt QK source colors to the base Instrument palette", () => {
    const theme = source("styles/theme.css");
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    const sourceTokens = {
      "--scuttlebutt-qk-ink-abyss": "oklch(13% 0.014 245)",
      "--scuttlebutt-qk-ink-deep": "oklch(16.5% 0.016 245)",
      "--scuttlebutt-qk-ink-veil": "oklch(23.5% 0.02 245)",
      "--scuttlebutt-qk-ink-rim": "oklch(29% 0.018 245)",
      "--scuttlebutt-qk-ink-spectral": "oklch(70% 0.012 245)",
      "--scuttlebutt-qk-ink-pearl": "oklch(94% 0.008 90)",
      "--scuttlebutt-qk-brass": "oklch(80% 0.085 78)",
      "--scuttlebutt-qk-brass-deep": "var(--scuttlebutt-qk-brass)",
      "--scuttlebutt-qk-id-crimson": "oklch(72% 0.065 25)",
      "--scuttlebutt-qk-id-amber": "oklch(76% 0.062 70)",
      "--scuttlebutt-qk-id-moss": "oklch(74% 0.06 140)",
      "--scuttlebutt-qk-id-cerulean": "oklch(73% 0.062 235)",
      "--scuttlebutt-qk-id-rose": "oklch(73% 0.06 350)",
    } as const;

    for (const [token, value] of Object.entries(sourceTokens)) {
      expect(base).toContain(`${token}: ${value};`);
      expect(theme.match(new RegExp(`${token}:`, "g"))).toHaveLength(1);
    }
  });

  it("keeps real GNB producers aligned with the static CSS gates", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const commandBand = source("components/command-band.tsx");
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    // 디스플레이 서체 생산자는 커맨드 밴드의 브랜드 워드마크 하나뿐이다 — layout.css 단독 소유.
    expect(components).not.toMatch(/font-family:\s*var\(--font-display\)/);
    expect(layout.match(/font-family:\s*var\(--font-display\)/g)).toHaveLength(1);
    expect(commandBand).toContain('className="command-band-brand-wordmark"');
    expect(components).not.toMatch(/data-sidebar-state="(?:rail|list|detail)"/);
    expect(components).not.toContain("global-navigation");
    expect(components).not.toContain("data-signature");
    expect(terminalAgent).not.toContain("data-signature");
    expect(skillsCss).not.toMatch(/color-mix\([^)]*\b(?:black|white)\b/);
  });

  it("pins the Session Analyst chat-grammar surfaces", () => {
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    // 드로어 바닥은 오퍼레이션 패널과 같은 --surface-panel 한 장이다. pillar로 되돌아가면 안 되고,
    // 포커스 워시(--surface-window)는 캡션 전용이므로 본문이 따라가서도 안 된다.
    expect(terminalAnalysisCss).toContain("background: var(--surface-panel);");
    expect(terminalAnalysisCss).not.toContain("surface-pillar");
    expect(terminalAnalysisCss).not.toContain("surface-window");
    // 얹히는 카드·버블·칩은 raised 티어 한 칸으로 물러난다.
    expect(terminalAnalysisCss).toContain("var(--surface-panel-raised)");
    // 상단 밴드 대신 떠 있는 칩 줄 + 채팅 뷰의 턴 스파인 문법을 쓴다.
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__chips \{/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__turn-node \{/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__receipt > summary \{/);
    // 사용자 발화 정체성은 --id-cerulean 워시 문법(디스패치 버블과 동형)만 쓴다.
    expect(terminalAnalysisCss).toContain("color-mix(in oklch, var(--id-cerulean) 10%, var(--surface-panel-raised))");
    // 아티팩트는 드로어 안의 모드다 — 모드 세그먼트가 있고, 세로 핸들과 두 번째 컴패니언은 되살아나면 안 된다.
    const terminalChatCss = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const terminalAgentEntry = externalSource(TERMINAL_AGENT_PATH);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__modechip \{/);
    expect(terminalAnalysisCss).not.toContain(".session-analyst-handle");
    // Analyst 진입은 뷰 칩 클러스터의 일원이다 — 채팅 전환 칩과 같은 줄·같은 문법.
    expect(terminalChatCss).toMatch(/\.agent-view-chip-row \{/);
    expect(terminalChatCss).toContain(".agent-view-chip-row .agent-chat-mode-chip");
    expect(terminalAgentEntry).toContain('className="agent-chat-mode-chip agent-analyst-chip"');
    expect(terminalAgentEntry).not.toContain("ANALYST_ARTIFACTS_COMPANION_ID");
  });

  it("keeps the retired carrier identity grammar out of the product", () => {
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const theme = source("styles/theme.css");

    // 캐리어 스트림과 함장 정체성 토큰은 함께 퇴역했다 — 어느 한쪽만 되살아나도 잡는다.
    expect(theme).not.toContain("--captain-");
    expect(theme).not.toContain("--carrier-");
    expect(terminalAnalysisCss).not.toContain("carrier-stream-column");
    expect(terminalAnalysisCss).not.toContain("carrier-sortie-ribbon");
    expect(terminalAnalysisCss).not.toContain("data-captain");
    expect(terminalAgent).not.toContain("data-captain");
  });

  it("pins the launch-kind description grammar and keeps the menu free of decoration tokens", () => {
    const components = source("styles/components.css");
    const contextMenu = source("canvas/canvas-context-menu.tsx");
    // 줄머리 앵커가 필요하다 — 앵커 없이는 `--annotated` 하위 배치 규칙이 먼저 잡힌다.
    const descriptionBlock = components.match(/^\.operation-launch-menu-description \{[^}]*\}/m)?.[0] ?? "";
    const reasonCell = components.match(/\.operation-launch-menu-item--annotated \.operation-launch-menu-reason \{[^}]*\}/)?.[0] ?? "";

    // 설명과 비활성 사유는 라벨 아래 줄에 선다 — 같은 행에 두면 긴 종류 이름이 잘린다.
    expect(reasonCell).toContain("grid-row: 2;");
    expect(reasonCell).toContain("grid-column: 2 / -1;");
    expect(descriptionBlock).toContain("color: var(--text-tertiary);");
    expect(descriptionBlock).toContain("font-family: var(--font-body);");
    expect(descriptionBlock).not.toMatch(/font-weight:\s*\d/);

    // 실행 메뉴에는 별도 표식 배지를 두지 않는다 — 종류 구분은 라벨 괄호 안과 무배경 한 단어
    // 대비가 들고 있다. 배지가 돌아오면 brass 채널을 빌리는 doctrine 예외가 다시 필요해지므로
    // 여기서 막는다.
    expect(components).not.toContain("operation-launch-menu-badge");

    // 캔버스 메뉴는 실행 목록이지 설명서가 아니다. 설명 문장은 항목 안에 남아 접근 이름에는
    // 실리되 시각적으로는 접히고(--quiet), 짚은 항목의 것만 메뉴 옆 어사이드에 펴진다.
    // 상시 두 줄로 되돌아오면 항목 하나가 33px에서 50px로 불어나므로 트립와이어를 건다.
    const quietBlock = components.match(/^\.operation-launch-menu-description--quiet \{[^}]*\}/m)?.[0] ?? "";
    expect(quietBlock).toContain("position: absolute;");
    expect(quietBlock).toContain("clip-path: inset(50%);");
    const briefBlock = components.match(/^\.operation-launch-menu-brief \{[^}]*\}/m)?.[0] ?? "";
    expect(briefBlock).toContain("grid-row: 1;");
    expect(briefBlock).toContain("font-family: var(--font-body);");
    expect(briefBlock).not.toMatch(/background|border-radius/);
    expect(contextMenu).toContain('className="operation-launch-menu-brief"');
    expect(contextMenu).toContain("operation-launch-menu-description operation-launch-menu-description--quiet");

    // 역할·플러그인·동작 이름을 반복하던 시각 헤더는 제거한다. 메뉴 역할은 aria-label이,
    // Terminal Shell의 별도 성격은 최하단 Etc 그룹이 맡는다.
    expect(components).not.toContain(".canvas-context-menu-reticle");
    expect(contextMenu).not.toContain('className="canvas-context-menu-reticle"');
    expect(contextMenu).not.toContain("canvas-context-menu-head");
    expect(components).not.toContain(".canvas-context-menu-head {");
    expect(contextMenu).toContain('aria-label={menuLabel}');
    expect(contextMenu).toContain('aria-label={t("canvas.menu.etc")}');
    expect(contextMenu).toContain("operation-launch-provider-glyph--etc");

    // 폭은 세 곳이 함께 알아야 한다. 하나만 고치면 컴파일은 되고 치수만 조용히 어긋난다.
    // 폭은 컨테이너가 단일 소유자다. 컨테이너에 폭이 없으면 설명 어사이드의 100%가 메뉴
    // 오른쪽이 아니라 왼쪽 모서리를 가리켜 설명이 메뉴 위를 덮는다(실측으로 확인).
    expect(contextMenu).toContain("const MENU_WIDTH = 264;");
    expect(components).toMatch(/\.operation-launch-control--canvas \{[^}]*--canvas-menu-width: 264px;[^}]*width: var\(--canvas-menu-width\);/);
    expect(components).toContain(".canvas-context-menu {\n  width: var(--canvas-menu-width);");
    expect(components).toMatch(/\.operation-launch-control--canvas \.operation-launch-menu \{[^}]*min-width: var\(--canvas-menu-width\);/);
    // 캔버스 전용 패딩은 두 클래스를 함께 짚어야 한다 — 한 클래스면 뒤쪽의 .theater-menu와
    // 특이도가 같아 조용히 지고 8px로 남는다(실측으로 확인한 함정).
    expect(components).toContain(".operation-launch-menu.canvas-context-menu {\n  padding: var(--space-1);");

    // 메뉴 조상 관계가 올바라야 menuitem이 유효하다. dialog로 되돌아가면 ARIA가 깨진다.
    expect(contextMenu).toContain('role="menu"');
    expect(contextMenu).not.toContain('role="dialog"');
  });

  it("keeps the remote NAT endpoint on the established token grammar without warn hover", () => {
    const settings = source("pages/global-settings.tsx");
    const components = source("styles/components.css");

    expect(settings).toContain('t("settings.remote.listenAddress")');
    expect(settings).toContain('t("settings.remote.listenPresets")');
    expect(settings).toContain('aria-pressed={selected}');
    expect(settings).toContain('draft.publicEndpointEnabled ? (');
    expect(settings).toContain('t("settings.remote.advertisedHost")');
    expect(settings).toContain('className="remote-route-preview"');
    expect(settings).toContain('className="remote-acknowledgment"');
    expect(components).toContain(".remote-endpoint-grid");
    expect(components).toContain(".remote-interface-preset.is-selected");
    expect(components).toContain("var(--surface-rim-strong)");
    expect(components).not.toMatch(/remote-(?:acknowledgment|port-control):hover[^\n]*var\(--warn/);
    expect(components).not.toMatch(/remote-[^\n{]*\{[^}]*#[0-9a-f]{3,8}/i);
  });

  it("keeps the access-link entry in the host box and out of Settings", () => {
    const systemCluster = source("components/command-band-system-cluster.tsx");
    const settings = source("pages/global-settings.tsx");
    const dialog = source("components/add-host-dialog.tsx");

    // 추가는 관리보다 위에 선다 — 목록을 고르러 온 사람이 먼저 만나는 것은 새 콘솔을 붙이는 일이다.
    const addAt = systemCluster.indexOf('t("chrome.hosts.add")');
    const manageAt = systemCluster.indexOf('t("chrome.hosts.manage")');
    expect(addAt).toBeGreaterThan(-1);
    expect(manageAt).toBeGreaterThan(addAt);

    // 입력 화면은 팝업 하나가 소유한다. 설정에 두 번째 폼이 생기면 오류 문장과 검증이 갈라진다.
    // (.remote-link-field는 발급된 액세스 링크를 **보여 주는** 자리에도 쓰이므로 클래스로 판정하지
    //  않는다 — 판정은 링크를 받는 입력 자체, 즉 그 placeholder와 POST 호출로 한다.)
    expect(settings).toContain("<AddHostDialog");
    expect(settings).not.toContain("settings.remote.hosts.addPlaceholder");
    expect(settings).not.toContain("addRemoteHost");
    expect(dialog).toContain("settings.remote.hosts.addPlaceholder");
    expect(dialog).toContain("addRemoteHost");

    // 포털이 아니면 팝업이 자기 자신을 inert로 만든다(control-curtain과 같은 계약).
    expect(dialog).toContain("createPortal");
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("shell.inert = true");
  });

  it("keeps the v4 navigation, Theater, map, CLI, and rail visual producers", () => {
    const systemCluster = source("components/command-band-system-cluster.tsx");
    const sidebar = source("sidebar/operations-side-bar.tsx");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const minimap = source("canvas/canvas-minimap.tsx");
    const commandBand = source("components/command-band.tsx");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");

    expect(source("canvas/canvas-context-menu.tsx")).not.toContain("CanvasContextMenuMode");
    expect(systemCluster).toContain('className="command-band-system-menu" role="menu"');
    expect(systemCluster).toContain('t("chrome.system.settings")');
    expect(systemCluster).toContain('t("chrome.system.keyboardShortcuts")');
    expect(systemCluster).toContain("openWhatsNew");
    expect(components).toContain(".command-band-system-cluster {");
    expect(components).not.toContain(".side-bar-brand-foot");

    expect(sidebar).toContain("hasCustomGroups && section.entries.length > 0");
    expect(sidebar).toContain("theaterInitials(theater.label)");
    expect(chip).toContain("side-bar-chip-status");
    expect(chip).toContain('if (visual === "background") return "tenant-beacon is-background"');
    expect(chip).toContain('if (visual === "awaiting") return "tenant-beacon is-awaiting"');
    expect(chip).not.toContain("is-attention");
    expect(components).toContain(".side-bar-chip:focus-within .side-bar-chip-close");
    expect(components).toContain(".side-bar-chip--minimized .side-bar-chip-name {\n  color: var(--ink-muted);");
    expect(components).toContain(".side-bar-chip--minimized .side-bar-chip-op-icon {\n  opacity: 0.62;");
    expect(components).not.toMatch(/\.side-bar-chip--minimized \{[^}]*opacity/);

    expect(minimap).not.toContain("is-plugin");
    expect(components).not.toContain(".canvas-minimap-operation.is-plugin");
    const operationFrame = source("canvas/operation-frame.tsx");
    expect(operationFrame).toContain('className="canvas-operation-identity-name"');
    expect(operationFrame).toContain('className="canvas-operation-identity-input"');
    expect(operationFrame).toContain("useInlineRename");
    expect(operationFrame).toContain("onDoubleClick={beginRename}");
    expect(operationFrame).toContain("onKeyDown={beginRenameFromKeyboard}");
    expect(operationFrame).toContain("onKeyDown={handleRenameKeyDown}");
    expect(operationFrame).toContain("onBlur={rename.handleBlur}");
    expect(operationFrame).toContain("onPointerDown={stopIdentityPointer}");
    expect(operationFrame).toContain("onBegin: () => {\n      disarmClose();\n    },");
    const identityPointerBlock = operationFrame.match(/const stopIdentityPointer = \([^]*?\n  };/)?.[0] ?? "";
    expect(identityPointerBlock).toContain("if (rename.renaming) event.stopPropagation();");
    expect(identityPointerBlock).toContain("disarmClose();");
    expect(identityPointerBlock).not.toContain("onActivate();");
    expect(operationFrame).toContain('event.key !== "Enter" && event.key !== "F2"');
    expect(operationFrame).toContain("rename.renaming ? (");
    expect(operationFrame).not.toContain("!active && rename.renaming");
    expect(operationFrame).toContain('className="canvas-operation-window-controls"');
    expect(operationFrame).toContain("`canvas-operation-glance-hud${glanceHud.armedMessageKey ? \" is-armed-set-aside\" : \"\"}`");
    expect(operationFrame).toContain('className="canvas-operation-glance-hud-name"');
    expect(operationFrame).toContain('className="canvas-operation-glance-hud-index"');
    expect(operationFrame).toContain('className="canvas-operation-glance-hud-keys"');
    expect(operationFrame).toContain('className="canvas-operation-glance-hud-arm"');
    expect(operationFrame).toContain("restoreIdentityFocusRef.current = true;");
    expect(operationFrame).toContain("identityTriggerRef.current?.focus()");
    expect(operationFrame).toContain('t("canvas.frame.renameTitle"');
    expect(source("canvas/canvas.tsx")).toContain("onRename: (operationId: string, title: string) => void;");
    expect(source("pages/operations.tsx")).toContain("onRename={handleRename}");
    expect(components).toContain(".canvas-operation-identity-name,");
    expect(components).toContain("font-family: var(--font-body);");
    expect(components).toContain("font-size: calc(var(--font-body-size) * 0.92);");
    const identityInputBlock = components.match(/^\.canvas-operation-identity-input \{\n  flex: 1 1 auto;[^}]*\}/m)?.[0] ?? "";
    expect(identityInputBlock).toContain("width: min(28ch, 34vw);");
    expect(identityInputBlock).not.toContain("width: 0;");
    expect(components).toContain("top: -32px;");
    expect(components).toContain("background-clip: padding-box;");
    const shellCaptionBlock = components.match(/\.canvas-operation--shell \.canvas-operation-titlebar \{[^}]*\}/)?.[0] ?? "";
    expect(shellCaptionBlock).toContain("background-clip: padding-box;");
    const captionSeamBlock = components.match(/\.canvas-operation:has\(> \.canvas-operation-titlebar\) \{[^}]*\}/)?.[0] ?? "";
    expect(captionSeamBlock).toContain("border-top-width: 0;");
    expect(captionSeamBlock).toContain("border-top-style: none;");
    expect(captionSeamBlock).not.toContain("border-top: none;");
    expect(components).toContain("border-radius: 999px;");
    expect(components).toContain("color: var(--text-secondary);");
    // 캡션 구조 선은 본문과 같은 --surface-rim을 직접 칠한다. inherit와
    // 1px solid inherit 단축은 선언이 버려지거나 계산색이 갈라진다.
    expect(components).not.toContain("border-color: inherit;");
    expect(components).not.toContain("border: 1px solid inherit;");
    // 패널 아웃라인은 상태를 놓았다 — 포커스는 캡션 워시, 상태는 캡션 아랫변 레일이 나른다.
    // 포커스는 선을 쓰지 않는다: 상태 레일과 같은 굵기의 brass 선이 캡션 위아래에 겹치면
    // warn과 brass가 한 덩어리 금색으로 읽힌다. 워시는 캡션만 진다 — 채팅 본문까지
    // 따라가면 활성 패널 전체가 다른 면으로 바뀐다.
    expect(components).toContain(".canvas-operation.is-active > .canvas-operation-titlebar {");
    expect(components).toContain("color-mix(in oklab, var(--brass) 10%, var(--surface-panel))");
    expect(components).not.toContain("--surface-window");
    expect(components).not.toContain(".canvas-operation-titlebar::before");
    expect(components).toContain("background: var(--caption-rail, transparent);");
    // 도착 플래시는 지속 상태(is-unseen)가 아니라 전이를 표시하는 일시 클래스에만 건다 —
    // is-unseen에 걸면 Theater 재진입 리마운트마다 다시 돈다.
    expect(components).toContain(".canvas-operation.is-unseen-arriving > .canvas-operation-titlebar::after {");
    expect(components).not.toMatch(/\.canvas-operation\.is-unseen > \.canvas-operation-titlebar::after \{\n\s*animation: caption-rail-arrive/);
    expect(operationFrame).toContain('arrivalFlash ? "is-unseen-arriving" : ""');
    expect(operationFrame).toContain("previousUnseenRef");
    // 정체성은 캡션 채움을 소유하지 않는다 — 언포커스는 --surface-panel, 포커스는 brass
    // 워시 하나만. 창 면 변수로 올리면 채팅 본문까지 따라간다.
    expect(components).not.toContain('.canvas-operation[style*="--user-accent"] .canvas-operation-titlebar {');
    expect(components).not.toContain('.canvas-operation[style*="--user-accent"].is-active > .canvas-operation-titlebar {');
    expect(components).not.toContain("color-mix(in oklab, var(--brass) 10%, color-mix(in oklch, var(--user-accent) 10%, var(--surface-panel)))");
    expect(components).not.toContain('.canvas-operation[style*="--user-accent"]:not(.is-active) .canvas-operation-titlebar {');
    // oklch 믹스는 hue를 극좌표 호로 보간한다 — brass(78)+ink-rim(245) 62%는 hue 141(초록)에
    // 착지해 위치 채널이 신호 채널 positive(160) 옆에 앉았다. 캡션 워시는 oklab으로 섞는다.
    expect(components).not.toContain("color-mix(in oklch, var(--brass) 62%, var(--ink-rim))");
    // 소비처가 사라진 진행광(running light) 변수는 함께 회수했다.
    expect(components).not.toContain("--uw-tint");
    expect(components).not.toContain("--uw-glow");
    expect(source("styles/theme.css")).not.toContain("--uw-angle");
    // 포커스가 상태를 덮던 우선순위 규칙은 채널이 갈린 뒤로 존재 이유가 없다.
    expect(components).not.toContain(".canvas-operation.is-running.is-active {");
    expect(components).toContain(".canvas-operation-window-controls {");
    const windowControlsBlock = components.match(/\.canvas-operation-window-controls \{[^}]*\}/)?.[0] ?? "";
    expect(windowControlsBlock).toContain("margin-left: auto;");
    expect(windowControlsBlock).toContain("max-width: none;");
    expect(windowControlsBlock).not.toContain("max-width: 0;");
    const windowControlsLastButtonBlock = components.match(/\.canvas-operation-window-controls > \.canvas-operation-icon-button:last-child \{[^}]*\}/)?.[0] ?? "";
    expect(windowControlsLastButtonBlock).toContain("margin-inline-end: 0;");
    expect(components).toContain(".operations-canvas.is-glance .canvas-operation-glance-hud {");
    expect(components).not.toContain(".canvas-triage-rail-arm {");
    expect(components).toContain(".canvas-operation-glance-hud-arm {");
    // 무장 안내는 Alt 홀드와 무관하게 떠 있어야 한다 — 확인 기한이 1.5초뿐이다.
    expect(components).toContain(".canvas-operation-glance-hud.is-armed-set-aside {");
    expect(components).toContain("/* 두 번 눌러 확정 중인 위험 상태만 coral 채널을 쓰며");
    expect(components).toContain(".canvas-operation .canvas-operation-window-controls .canvas-operation-icon-button.is-armed-close {");
    // Tactical/War Room/최대화는 슬롯을 32px 내려 캡션을 본문 밖에 둔다.
    // Tactical grid/rows 행 보폭은 같은 32px를 본문 피치에 넣어 아래 행 캡션이 위 칸을 침범하지 않는다.
    expect(source("canvas/canvas-store.ts")).toContain("export const OPERATION_WINDOW_CAPTION_HEIGHT = 32");
    expect(source("canvas/canvas-store.ts")).toContain("const rowStride = gap + OPERATION_WINDOW_CAPTION_HEIGHT");
    // Station Keeping도 같은 32px를 충돌 상자에 넣는다 — 본문 AABB만 보면 아래 캡션이 위를 침범한다.
    expect(source("canvas/canvas-store.ts")).toContain("function stationKeepingFrameFor");
    expect(source("canvas/canvas-store.ts")).toContain("function resolveStationKeepingPosition");
    expect(source("canvas/canvas.tsx")).toContain("const TITLEBAR_OUTSET_PX = OPERATION_WINDOW_CAPTION_HEIGHT");
    expect(source("canvas/canvas.tsx")).toContain("y: TITLEBAR_OUTSET_PX");
    expect(source("canvas/canvas.tsx")).toContain("TITLEBAR_OUTSET_PX * effectiveZoom");
    expect(source("canvas/coordinates.ts")).toContain("y: 18 + OPERATION_WINDOW_CAPTION_HEIGHT");
    expect(source("canvas/coordinates.ts")).toContain("canvasSize.height - 36 - OPERATION_WINDOW_CAPTION_HEIGHT");
    expect(source("canvas/coordinates.ts")).toContain("export function operationWindowFrameFor");
    expect(source("canvas/canvas.tsx")).toContain("operationWindowFrameFor(geometry)");
    expect(source("canvas/operation-frame.tsx")).not.toContain("canvas-operation-drag-edge");
    expect(source("canvas/operation-frame.tsx")).not.toContain('className="canvas-operation-cli"');
    expect(components).toContain(".canvas-operation-beacon-button {");
    expect(components).toContain("border: 1px solid var(--surface-rim);");
    expect(components).toContain("left: -1px;");
    expect(components).toContain("name → beacon → 상시 컨트롤");
    const canvas = source("canvas/canvas.tsx");
    expect(canvas).toContain("export function useGlanceHold(): boolean");
    expect(canvas).toContain('event.code === "AltLeft" || event.code === "AltRight"');
    expect(canvas).toContain("event.ctrlKey || event.metaKey");
    expect(canvas).toContain("isBlockingDialogOpen()");
    expect(canvas).toContain('glanceVisible ? "is-glance" : ""');
    expect(canvas).toContain('window.addEventListener("blur", clearGlance)');
    expect(canvas).toContain('document.addEventListener("visibilitychange", handleVisibilityChange)');
    expect(source("styles/layout.css")).toContain(".command-band-operation-kind { display: flex; align-items: center; flex: none; line-height: 0; }");
    expect(source("styles/layout.css")).not.toContain(".command-band-operation-attribute");
    expect(commandBand).not.toContain("command-band-operation-attribute");
    expect(commandBand).toContain("command-band-operation-kind operation-provider-mark is-${activeLaunchProvider}");
    expect(commandBand).toContain('<rect x="1.75" y="3" width="12.5" height="10" rx="2.4"');
    expect(rail).toContain("width: 44px");
  });

  it("forbids native product selects in Console core, SDK, and built-in plugins", () => {
    const hits = findRawProductSelects();
    expect(hits, hits.map((hit) => `${hit.file}:${hit.line} ${hit.snippet}`).join("\n")).toEqual([]);
  });

  it("detects JSX and createElement native select factories with the AST scanner", () => {
    const jsxText = '<select value="x" />\n<div><select /></div>';
    const jsxSource = ts.createSourceFile("fixture.tsx", jsxText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const factoryText = 'createElement("select", { value: "x" });\nReact.createElement("select", null);';
    const factorySource = ts.createSourceFile("fixture.ts", factoryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(findRawProductSelectsInSourceFile(jsxSource, "fixture.tsx", jsxText).map((hit) => hit.line)).toEqual([1, 2]);
    expect(findRawProductSelectsInSourceFile(factorySource, "fixture.ts", factoryText).map((hit) => hit.line)).toEqual([1, 2]);
  });

  it("pins the shared SDK Select listbox grammar and stacking contract", () => {
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");
    const selectBlockStart = components.indexOf("/* ── Shared SDK Select listbox grammar");
    expect(selectBlockStart).toBeGreaterThan(-1);
    const selectBlock = components.slice(selectBlockStart);

    expect(selectBlock).toContain("--z-select-popover: 40;");
    expect(selectBlock).toContain(".fc-select__popup {");
    expect(selectBlock).toContain("z-index: var(--z-select-popover);");
    expect(selectBlock).toContain("border: 1px solid var(--surface-rim);");
    expect(selectBlock).toContain("background: color-mix(in oklch, var(--ink-mid) 48%, transparent);");
    expect(selectBlock).toContain("color: var(--text-primary);");
    expect(selectBlock).toContain("font-weight: var(--weight-medium); font-size: 13px; line-height: 1.2; font-family: var(--font-body);");
    expect(selectBlock).toContain("padding: 0 13px;");
    expect(selectBlock).toContain("box-shadow: inset 0 1px 0 color-mix(in oklch, var(--ink-pearl) 5%, transparent);");
    expect(selectBlock).toContain("border-color: color-mix(in oklch, var(--brass) 58%, var(--surface-rim));");
    expect(selectBlock).toContain("background: color-mix(in oklch, var(--brass) 12%, transparent);");
    expect(selectBlock).toContain('content: "✓";');
    expect(selectBlock).toContain("font-style: italic;");
    expect(selectBlock).toContain(".fc-select--compact .fc-select__trigger {");
    expect(selectBlock).toContain(
      "font-weight: var(--weight-regular);\n  font-size: 9px;\n  line-height: 1;\n  font-family: var(--font-mono);",
    );
    expect(selectBlock).toContain("padding: 8px 16px 8px 10px;");
    expect(selectBlock).toContain(".fc-select__popup--compact { min-width: min(160px, calc(100vw - 16px)); }");
    expect(selectBlock).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.fc-select__trigger,\s*\.fc-select__caret,\s*\.fc-select__popup,\s*\.fc-select__option \{\s*transition: none;\s*\}\s*\}/);

    expect(selectBlock).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(selectBlock).not.toMatch(/\boklch\(/);
    expect(selectBlock).not.toMatch(/\brgb\(/);

    expect(rail).toContain("--z-rail: 10;");
    expect(components).toContain(".group-context-menu-overlay {");
    expect(components).toContain("z-index: 60;");
    expect(Number("--z-rail: 10;".match(/\d+/)?.[0])).toBeLessThan(40);
    expect(40).toBeLessThan(60);
  });

  // 모바일 세션 Close는 coral 무장·brass 포커스·44px 바닥을 데스크톱 프레임과 공유한다.
  // mobile.css는 OWNED_SOURCES에 올리지 않는다 — 탭 레일도 같은 파일에 있고, 이 문법은 이 핀이 담당한다.
  it("pins the mobile session close arm grammar — coral danger, brass focus, 44px floor", () => {
    const css = source("styles/mobile.css");
    const close = css.match(/^\.mobile-session-close \{[^}]*\}/m)?.[0] ?? "";
    expect(close).toContain("min-width: 44px;");
    expect(close).toContain("min-height: 44px;");
    const armed = css.match(/^\.mobile-session-close\.is-armed \{[^}]*\}/m)?.[0] ?? "";
    expect(armed).toContain("border: 1px solid color-mix(in oklch, var(--coral) 50%, transparent);");
    expect(armed).toContain("background: color-mix(in oklch, var(--coral) 20%, transparent);");
    expect(armed).toContain("color: var(--coral-ink);");
    expect(armed).toContain("animation: chip-close-arm 1.5s linear forwards;");
    const focus = css.match(/^\.mobile-session-close:focus-visible \{[^}]*\}/m)?.[0] ?? "";
    expect(focus).toContain("outline: 2px solid color-mix(in srgb, var(--brass) 55%, transparent);");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mobile-session-close\.is-armed \{\s*animation: none;/);
  });
});

describe("Effort track interaction grammar", () => {
  it("pins the apex tier channel and its reduced-motion cutoff", () => {
    const components = source("styles/components.css");
    const theme = source("styles/theme.css");
    const ultraRule = components.match(/\.effort-track\[data-apex="true"\]\[data-effort-level="ultra"\] \{[^}]*\}/)?.[0] ?? "";
    const maxRule = components.match(/\.effort-track\[data-apex="true"\]\[data-effort-level="max"\] \{[^}]*\}/)?.[0] ?? "";
    expect(ultraRule).toContain("var(--apex)");
    expect(maxRule).toContain("var(--crest)");

    const themeBlocks = [theme.slice(0, theme.indexOf(':root[data-theme="'))];
    for (const name of ["maritime", "carbon", "whites"]) {
      const start = theme.lastIndexOf(`:root[data-theme="${name}"] {`);
      themeBlocks.push(theme.slice(start, theme.indexOf("\n}", start)));
    }
    for (const block of themeBlocks) {
      expect(block).toContain("--apex:");
      expect(block).toContain("--crest:");
    }

    expect(components).toMatch(/\.effort-track-apex-burst \{\s*animation: none;\s*\}/);
    expect(components).toMatch(/effort-ultracode-wave/);
    expect(components).toMatch(/\.effort-track-value\[data-effort-level="ultra"\] \{\s*animation: none;/);

    // 티어 모션은 전부 티어 채널(crest/apex) 안에서만 놀고, 감속 모션에서 정적 상태로 남는다.
    for (const keyframes of [
      "effort-max-ember-wave",
      "effort-max-ember-flicker",
      "effort-max-molten-drift",
      "effort-max-crest-breathe",
      "effort-ultra-aurora-drift",
      "effort-ultra-twinkle",
    ]) {
      expect(components).toContain(`@keyframes ${keyframes}`);
    }
    // 게이트 뒤 MAX 라벨(엠버)은 감속 모션에서 정적 crest 글로우로 돌아간다 —
    // 게이트 없는 max 라벨과 같은 모습이 되는 것이 계약이다.
    expect(components).toMatch(/\.effort-track-value\[data-apex="true"\]\[data-effort-level="max"\] \{\s*animation: none;/);
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.effort-track\[data-apex="true"\]\[data-effort-level="ultra"\] \.effort-track-fill \{\s*animation: none;/);
  });

  it("pins the Quick Launch ultracode recognition grammar", () => {
    const components = source("styles/components.css");
    const composer = source("components/quick-launch.tsx");

    // 바에는 인식 칩을 두지 않는다 — 90px 알약이 실행 버튼을 둘째 줄로 떨어뜨렸다.
    // 상태는 고지 줄·단어 하이라이트·테두리 링이 말한다.
    expect(components).not.toMatch(/\.quick-launch-ultracode \{/);
    expect(composer).not.toContain('className="quick-launch-ultracode"');

    // 인식은 apex 채널 하나로만 말한다 — 신호 토큰(aurora/warn/coral/positive)도, 위치 채널(brass)도
    // 빌리지 않는다. 점화·순항 호와 고지 줄이 그 채널을 쓴다.
    const rimRule = components.slice(components.indexOf(".quick-launch-card.is-ultracode {"));
    const rimBlock = rimRule.slice(0, rimRule.indexOf("@keyframes quick-launch-ultracode-rim"));
    for (const signal of ["--aurora", "--warn", "--coral", "--positive", "--brass"]) {
      expect(rimBlock, signal).not.toContain(signal);
    }

    // 단어 하이라이트는 강도 트랙 ULTRACODE 값과 같은 물결을 공유한다 — 같은 능력이면 같은 어휘다.
    const tokenRule = components.slice(components.indexOf(".quick-launch-ultracode-token {"));
    const tokenBlock = tokenRule.slice(0, tokenRule.indexOf("}"));
    expect(tokenBlock).toContain("animation: effort-ultracode-wave 2.6s linear infinite;");
    // 미러 층이라 자족 폭을 바꾸는 속성은 못 쓴다 — 쓰면 보이는 글자와 캐럿이 어긋난다.
    for (const metric of ["font-weight", "letter-spacing", "word-spacing", "font-size", "font-stretch", "text-transform"]) {
      expect(tokenBlock, metric).not.toContain(`${metric}:`);
    }

    // 도는 호는 @property로 등록된 각도와 폭을 쓴다(미등록이면 커스텀 속성이 계단으로 튄다).
    expect(components).toContain("@property --quick-launch-rim-angle");
    expect(components).toContain("@property --quick-launch-rim-spread");
    expect(components).toContain("@keyframes quick-launch-ultracode-ignite");
    expect(components).toContain("@keyframes quick-launch-ultracode-bead");
    expect(components).toMatch(/@keyframes quick-launch-ultracode-rim \{\s*to \{ --quick-launch-rim-angle: 360deg; \}\s*\}/);
    // 점화가 끝난 뒤에야 순항에 올라탄다 — 완성된 호가 갑자기 붙으면 이질감이 난다.
    expect(components).toMatch(/quick-launch-ultracode-ignite 900ms[\s\S]*quick-launch-ultracode-rim 2\.8s linear 900ms infinite/);
    // 무한 애니메이션은 규약의 예외이므로 근거가 규칙 옆에 남아 있어야 한다.
    expect(components).toContain("[doctrine]");

    // 감속 모션: 점화·구슬·순항은 세우되 상태는 남긴다 — 정지한 링과 단색 apex 단어.
    const quickLaunchReduced = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce) {\n  .quick-launch-overlay {"));
    expect(quickLaunchReduced).toContain(".quick-launch-card.is-ultracode::before,");
    expect(quickLaunchReduced).toContain(".quick-launch-card.is-ultracode::after,");
    expect(quickLaunchReduced).toMatch(/\.quick-launch-card\.is-ultracode::before \{\s*content: none;\s*\}/);
    expect(quickLaunchReduced).toMatch(/\.quick-launch-ultracode-token \{\s*background-image: none;\s*color: var\(--apex-ink\);\s*\}/);

    // Backspace 해제는 키 반복도, 수식 키가 붙은 삭제(⌥/Ctrl 단어·⌘ 줄)도 먹지 않는다 —
    // 가로채면 방금 친 단어를 지우려던 키가 아무것도 지우지 않는다.
    expect(composer).toContain('event.key === "Backspace" && !event.repeat && ultracodeArmed');
    expect(composer).toContain("&& !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey");
    // 무장은 문면과 해제 여부에서만 나온다 — 멘션 행선지는 이 판정에 들어가지 않는다.
    // 이 단어는 실행 좌표가 아니라 프롬프트가 실려 가는 곳이면 어디든 함께 가는 원문의 일부다.
    expect(composer).toContain("const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;");
    // 고지 줄은 무장 동안 상주한다. 접히는 field·bar 밖에 살기 때문에, 물러난 바에서는
    // 컴포넌트가 직접 내려야 한다 — 남겨 두면 한 줄로 물러났다는 도킹이 상태 줄 하나를 더 이고 선다.
    expect(composer).toContain("{ultracodeArmed && !showStrip ? (");
  });

  it("pins the chat start-view arming grammar", () => {
    const components = source("styles/components.css");
    const composer = source("components/quick-launch.tsx");

    // 바 첫 줄의 여유가 0이라 이 상태는 **칩을 두지 않는다** — 칩 하나가 서면 바가 두 줄로 접힌다.
    // 무장은 카드 외곽선과 입력 위 안내줄이 함께 진다.
    expect(composer).not.toMatch(/quick-launch-start-view-chip/);
    expect(composer).toContain('${chatStart ? " is-chat-start" : ""}');
    expect(composer).toContain('<p className="quick-launch-start-view-notice" role="status">');

    // 채널은 ultracode와 같은 apex다 — 둘 다 신호(상태)도 위치(brass)도 아닌 "기본 밖의 선택"이다.
    // 구별은 색이 아니라 모션이 진다: ultracode는 도는 conic 링, 여기는 정지한 테두리.
    const armed = components.slice(components.indexOf(".quick-launch-card.is-chat-start {"));
    const armedBlock = armed.slice(0, armed.indexOf("}"));
    expect(armedBlock).toMatch(/border-color: color-mix\(in oklch, var\(--apex\)/);
    for (const signal of ["--aurora", "--warn", "--coral", "--positive", "--brass"]) {
      expect(armedBlock, signal).not.toContain(signal);
    }
    expect(armedBlock).not.toContain("animation:");

    // 되돌리기는 문장의 일부다 — 알약으로 세우면 두지 않기로 한 배지가 안내줄로 옮겨 앉는다.
    const undo = components.slice(components.indexOf(".quick-launch-start-view-undo {"));
    const undoBlock = undo.slice(0, undo.indexOf("}"));
    expect(undoBlock).toContain("background: none;");
    expect(undoBlock).toContain("border: 0;");
    expect(undoBlock).not.toContain("border-radius: 999px;");

    // 시작 뷰 선택은 실행 종류가 스스로 선언했을 때만 선다 — core가 어느 플러그인이 채팅을
    // 아는지 알면 안 된다.
    expect(composer).toContain('const chatStartAvailable = target?.kind.launchViews?.includes("chat") === true;');
    expect(composer).not.toMatch(/pluginId === "terminal"/);
  });

  it("pins the chat question-card grammar — aurora carries the wait, brass stays on location", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 카드는 대기를 말한다 — 그 채널은 코어 활동축이 awaiting에 쓰는 aurora와 같아야 한다.
    // 다른 신호 토큰이 섞이면 같은 사실이 두 색으로 갈라진다.
    const card = block(".agent-chat-ask");
    expect(card).toContain("color-mix(in oklch, var(--aurora)");
    for (const signal of ["--warn", "--coral", "--positive", "--brass"]) {
      expect(card, signal).not.toContain(signal);
    }
    expect(block(".agent-chat-ask-badge")).toContain("color: var(--aurora);");

    // 선택지는 중립으로 서고 brass는 hover·focus에서만 오른다(위치·포커스 채널).
    const option = block(".agent-chat-ask-option");
    expect(option).toContain("border: 1px solid var(--hairline);");
    expect(option).not.toContain("--brass");
    expect(chat).toContain(".agent-chat-ask-option:hover:not(:disabled),");
    expect(chat).toMatch(/\.agent-chat-ask-option\[aria-pressed="true"\] \{/);

    // 자유 입력은 대화 입력창이 아니라 그 질문에만 사는 칸이다 — 파선이 그 임시성을 지고,
    // 포커스에서만 실선이 된다.
    expect(block(".agent-chat-ask-input")).toContain("border: 1px dashed var(--hairline-strong);");
    expect(chat).toContain("border-style: solid;");

    // 주 동작만 brass를 채운다. 보조 동작은 채움을 양보하고 테두리로 남는다.
    expect(block(".agent-chat-ask-send")).toContain("background: var(--brass);");
    expect(block(".agent-chat-ask-send.is-quiet")).toContain("background: transparent;");

    // 답한 줄은 스텝 문법에 합류한다 — 성공은 positive, 답하지 않은 채 끝난 것은 coral.
    expect(block(".agent-chat-ask-settled")).toContain("background: var(--surface-panel-raised);");
    expect(chat).toContain(".agent-chat-ask-settled-mark { flex: none; color: var(--positive); }");
    expect(chat).toMatch(/\.agent-chat-ask-settled\.is-open \.agent-chat-ask-settled-mark[\s\S]{0,120}color: var\(--coral-ink\);/);

    // 기다림의 맥동은 모션이므로 reduced-motion에서 멈춘다.
    const reduced = chat.slice(chat.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".agent-chat-ask-dot");
  });

  it("pins the persistent apex toggle and the pixel-anchored gap", () => {
    const components = source("styles/components.css");
    const trackSource = source("components/effort-track.tsx");

    // 게이트 장치는 트랙 우측의 ✦ 토글 하나다. 닫힘·열림이 같은 26px 버튼의 두 상태라
    // 마운트 교체(26px→18px)가 없고, 게이트가 열려도 라벨이 밀리지 않는다.
    expect(components).toContain(".effort-track-apex-toggle");
    expect(components).not.toContain("effort-track-apex-collapse");
    expect(trackSource).toContain('className="effort-track-apex-toggle"');
    expect(trackSource).not.toContain("effort-track-apex-collapse");
    expect(trackSource).toContain("aria-expanded={apexOpen}");

    // 폭과 모든 좌표가 한 간격 변수를 공유한다 — 게이트가 열려도 기존 스톱·손잡이가 움직이지
    // 않는 픽셀 앵커의 근거. 크롬 28px = 패딩 26px + 1px 테두리 둘(border-box).
    expect(components).toContain("--effort-track-gap: calc((var(--effort-closed-track-width) - 28px) / var(--effort-closed-intervals));");
    expect(components).toContain("width: calc(28px + var(--effort-track-gap) * var(--effort-intervals));");
    expect(trackSource).toContain("var(--effort-track-gap)");

    // 스윕의 티어 분화: MAX는 구리빛 스윕, ULTRACODE는 스윕 대신 ✦ 별빛.
    expect(components).toMatch(/data-effort-level="max"\] \.effort-track-fill::after \{[^}]*var\(--crest\)/);
    expect(components).toMatch(/data-effort-level="ultra"\] \.effort-track-fill::before,[\s\S]{0,120}::after \{[^}]*content: "✦"/);
  });

  it("pins the effort tone ramp between the reading floor and brass, with no signal channel borrowed", () => {
    const components = source("styles/components.css");
    // 끝 앵커는 줄머리로 잡는다 — `.effort-track-shell {`는 앞선 `.operation-launch-effort-menu
    // .effort-track-shell {`에도 부분 문자열로 걸려, 그대로 쓰면 램프 앞을 가리켜 빈 슬라이스가 된다.
    const ramp = components.slice(
      components.indexOf('[data-effort-level] { --effort-tone:'),
      components.indexOf("\n.effort-track-shell {"),
    );
    expect(ramp).not.toBe("");

    // 램프는 판독 하한(--text-tertiary)에서 출발해 --brass-ink에서 끝난다. 양 끝을 안쪽으로
    // 접어 두면 구간이 좁아져, 한 번에 한 값만 보이는 트랙에서 단이 바뀌어도 색이 그대로인
    // 것처럼 읽힌다 — 최고 일상 단은 brass 그 자체이고, 최저 단만 하한에서 살짝 띄운다.
    expect(ramp).toContain('[data-effort-level="auto"] { --effort-tone: var(--text-tertiary); }');
    expect(ramp).toContain('[data-effort-level="xhigh"] { --effort-tone: var(--brass-ink); }');
    expect(ramp).toMatch(/\[data-effort-level="low"\] \{ --effort-tone: color-mix\(in oklab, var\(--brass-ink\) 10%/);

    // 보간은 oklab이다. oklch로 섞으면 중간 단이 tertiary의 hue와 brass 사이 호를 따라가
    // positive·coral 같은 상태 채널을 강도 라벨이 흉내 낸다.
    for (const rung of ["low", "medium", "high"]) {
      expect(ramp, rung).toContain(`[data-effort-level="${rung}"] { --effort-tone: color-mix(in oklab, var(--brass-ink)`);
    }

    // 일상 단은 brass 한 채널 안에서만 논다 — 게이트 뒤 두 단만 자기 채널로 갈라진다.
    for (const signal of ["--aurora", "--warn", "--coral", "--positive"]) {
      expect(ramp, signal).not.toContain(signal);
    }
    expect(ramp).toContain('[data-effort-level="max"] { --effort-tone: var(--crest-ink); }');
    expect(ramp).toContain('[data-effort-level="ultra"] { --effort-tone: var(--apex-ink); }');
  });

  it("pins the Quick Launch effort row grammar — value tone yields to the location channel", () => {
    const components = source("styles/components.css");
    const composer = source("components/quick-launch.tsx");

    // 덱 행은 트랙과 같은 좌표(data-effort-level)로 색을 읽는다 — 라벨 문자열은 번역·모델마다
    // 달라 색의 기준이 될 수 없다.
    expect(composer).toContain("data-effort-level={row.effortLevel}");
    expect(composer).toContain("data-apex={row.apex ? true : undefined}");

    // 값 톤은 활성 행에 올라가지 않는다. brass는 위치·초점 채널이라, 값 톤이 그 자리를 침범하면
    // "지금 보고 있는 행"과 "높은 단"이 서로를 흉내 낸다.
    expect(components).toMatch(
      /\.quick-launch-command-row\[data-effort-level\]:not\(\.is-active\) \.quick-launch-mention-name \{\s*color: var\(--effort-tone\);/,
    );
    expect(components).toMatch(/\.quick-launch-mention-row\.is-active \.quick-launch-mention-name \{\s*color: var\(--brass\);/);

    // 자동은 사다리 위의 한 단이 아니라 사다리를 쓰지 않는 상태다 — 트랙의 파선 어휘를 공유한다.
    expect(components).toMatch(
      /\.quick-launch-command-row\[data-effort-level="auto"\] \.quick-launch-mention-name \{[^}]*text-decoration: underline dashed;/,
    );

    // 문구는 실제로 열리는 단에서 유도한다 — max만 내놓는 모델(Codex Luna 계열·Kimi K3 등)에서
    // 고정 문구는 열리지 않는 단을 약속한다. 세 표면(덱 문 행·바 트랙·캔버스 트랙)이 같은 유도를
    // 쓰므로 문구가 갈라지지 않는다.
    const common = source("i18n/messages/common.ts");
    const canvasMenu = source("canvas/canvas-context-menu.tsx");
    expect(common).toContain('"launchVariants.effort.apexToggle": "Show {tiers}"');
    expect(common).toContain('"launchVariants.effort.apexCollapse": "Hide {tiers}"');
    for (const surface of [composer, canvasMenu]) {
      expect(surface).toMatch(/apexToggleLabel=\{t\("launchVariants\.effort\.apexToggle", \{ tiers: gatedEffortNames\(/u);
      expect(surface).toMatch(/apexCollapseLabel=\{t\("launchVariants\.effort\.apexCollapse", \{ tiers: gatedEffortNames\(/u);
    }

    // 두 표면은 여는 것이 다르므로 이름의 원천도 다르다. 트랙은 사다리에서 문을 세우니 사다리
    // 기준(gatedEffortNames)을, 덱은 chips에 실린 단만 행으로 내니 자기 판정과 같은 원천
    // (deck.gatedNames)을 쓴다. 한쪽 기준을 다른 쪽에 빌려 주면 열리지 않는 단이 이름에 실린다.
    expect(composer).toMatch(/\{ tiers: deck\.gatedNames \}/u);
    expect(composer).not.toMatch(/const tiers = gatedEffortNames\(selectedRow\);/u);
    expect(source("quick-launch.ts")).toMatch(/gatedNames: offeredGated\.map\(\(chip\) => chip\.label\)\.join\("·"\),/u);

    // 문 행은 listbox 안에 산다. option role이 지원하지 않는 aria-expanded를 달면 무시되거나
    // 무효로 읽히므로, 여는지 접는지는 라벨 자체가 말한다("… 펼치기" ↔ "… 접기").
    expect(composer).not.toContain("aria-expanded={row.gate");

    // 문 행은 apex 채널로만 말한다(트랙의 ✦ 토글과 같은 어휘). 신호 토큰도 위치 채널도 빌리지 않는다.
    const gateRule = components.match(/\.quick-launch-command-row\.is-gate \.quick-launch-mention-name \{[^}]*\}/)?.[0] ?? "";
    const gateGlyph = components.match(/\.quick-launch-command-gate-glyph \{[^}]*\}/)?.[0] ?? "";
    expect(gateRule).toContain("var(--apex-ink)");
    expect(gateGlyph).toContain("var(--apex-ink)");
    for (const signal of ["--aurora", "--warn", "--coral", "--positive", "--brass)"]) {
      expect(gateRule, signal).not.toContain(signal);
      expect(gateGlyph, signal).not.toContain(signal);
    }
  });

  it("holds the deck's apex motion to the track's condition and reduced-motion cutoff", () => {
    const components = source("styles/components.css");

    // 덱은 트랙과 같은 키프레임을 쓴다 — 같은 능력이면 같은 어휘다. MAX의 이글거림은 트랙과
    // 똑같이 data-apex(게이트 뒤 티어)에만 붙어, 게이트 없는 모델의 max는 정적 글로우에 머문다.
    expect(components).toMatch(
      /\.quick-launch-command-row\[data-apex="true"\]\[data-effort-level="max"\]:not\(\.is-active\) \.quick-launch-mention-name \{[\s\S]*?animation:\s*\n?\s*effort-max-ember-wave 2\.1s linear infinite,\s*\n?\s*effort-max-ember-flicker 1\.7s linear infinite;/,
    );
    expect(components).toMatch(
      /\.quick-launch-command-row\[data-effort-level="ultra"\]:not\(\.is-active\) \.quick-launch-mention-name \{[\s\S]*?animation: effort-ultracode-wave 2\.6s linear infinite;/,
    );

    // 덱은 트랙과 달리 여러 행이 동시에 보인다 — 모션은 게이트 뒤 두 단으로 끝나고, 일상 5단은
    // 정적 톤만 가진다. 여섯 줄이 동시에 일렁이면 목록이 아니라 배경이 된다.
    for (const rung of ["low", "medium", "high", "xhigh", "auto"]) {
      expect(components, rung).not.toMatch(
        new RegExp(`\\.quick-launch-command-row\\[data-effort-level="${rung}"\\][^{]*\\{[^}]*animation:`),
      );
    }

    // 감속 모션에서는 트랙과 같은 자리로 돌아간다 — MAX는 정적 crest 글로우, ULTRACODE는 apex ink.
    const reduced = components.slice(components.indexOf(".quick-launch-command-row[data-effort-level]"));
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.quick-launch-command-row\[data-apex="true"\]\[data-effort-level="max"\]:not\(\.is-active\) \.quick-launch-mention-name \{\s*animation: none;[\s\S]*?color: var\(--crest-ink\);/,
    );
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.quick-launch-command-row\[data-effort-level="ultra"\]:not\(\.is-active\) \.quick-launch-mention-name \{\s*animation: none;[\s\S]*?color: var\(--apex-ink\);/,
    );
  });

  it("pins the provider band as the sole supplier mark in the command deck", () => {
    const components = source("styles/components.css");
    const composer = source("components/quick-launch.tsx");

    // 밴드가 스크롤을 따라 붙기 때문에 행 마크를 걷어낼 수 있다. 두 규칙은 한 쌍이다 —
    // sticky를 잃으면 스크롤한 목록에서 모델 이름만 남고 공급자를 잃는다.
    const bandRule = components.match(/\.quick-launch-command-deck \.quick-launch-pop-band \{[^}]*\}/)?.[0] ?? "";
    expect(bandRule).toContain("position: sticky");
    expect(bandRule).toContain("var(--ink-deep)");
    expect(composer).not.toMatch(/id: `model-\$\{row\.id\}`,[\s\S]{0,200}?quick-launch-kind-icon/);

    // 행은 밴드 라벨 자리(패딩 + 글리프 16px + 간격 6px)에서 시작한다 — 항목이 자기 머리글보다
    // 바깥에서 시작하면 소속이 역전돼 읽힌다.
    expect(components).toMatch(
      /\.quick-launch-command-group\.is-banded \.quick-launch-command-row \{\s*padding-left: calc\(var\(--space-2\) \+ 22px\);/,
    );

    // '@' 멘션 덱의 행 마크는 남는다 — 그쪽 밴드는 Theater 이름이라 공급자를 말하지 않고,
    // 행 글리프가 유일한 출처 표식이다. 모델 덱과 같은 이유로 지우면 그쪽이 회귀한다.
    expect(composer).toContain("launchProviderGlyph(entry.launchProvider)");
  });

  it("pins the shared effort track's pointer preview motion", () => {
    const components = source("styles/components.css");
    const quickLaunch = source("components/quick-launch.tsx");
    const canvasMenu = source("canvas/canvas-context-menu.tsx");
    const preview = components.match(/\.effort-track-stop\[data-previewed="true"\] \{[^}]*\}/)?.[0] ?? "";
    const knobHover = components.match(/\.effort-track:hover \.effort-track-knob \{[^}]*\}/)?.[0] ?? "";

    // 한 공유 계기가 Quick Launch와 캔버스 실행 메뉴 양쪽의 hover 문법을 소유한다.
    expect(quickLaunch).toContain("<EffortTrack");
    expect(canvasMenu).toContain("<EffortTrack");
    expect(preview).toContain("background: var(--brass)");
    expect(preview).toContain("transform: scale(3)");
    expect(knobHover).toContain("transform: scale(1.1)");
    // 모션을 줄인 환경에서도 어떤 단을 가리키는지는 정적인 brass ring으로 남는다.
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.effort-track:hover \.effort-track-knob,[\s\S]*\.effort-track-stop\[data-previewed="true"\] \{\s*transform: none;/);
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.effort-track-stop\[data-previewed="true"\] \{\s*box-shadow: 0 0 0 2px var\(--brass\);/);
  });
});

// War Room 덱의 한 칸은 카드가 아니라 그 Operation의 실제 패널이 서는 자리다. 이 계약이 풀리면
// 화면은 조용히 예전 동작 — 덱이 자기 카드 얼굴을 따로 그리고 본문을 transform으로 줄여 글자까지
// 뭉개던 축소판 — 으로 돌아간다.
describe("War Room deck panel grammar", () => {
  const deck = source("canvas/triage-watch-deck.tsx");
  const canvas = source("canvas/canvas.tsx");
  const frame = source("canvas/operation-frame.tsx");
  const components = source("styles/components.css");

  it("lets the deck draw a place and the canvas put the real panel in it", () => {
    // 덱은 자리와 그 자리의 주인만 말한다 — 얼굴을 조립하는 조각이 남아 있으면 두 물건이 된다.
    expect(deck).toContain("onPanelSlotRefRef.current?.(operationId, element)");
    expect(deck).toContain("ref={slotRefFor(operation.id)}");
    expect(deck).toContain("data-triage-deck-card={operation.id}");
    // 패널을 만들 수 없는 kind는 자리가 끝까지 빈다 — 그 칸도 어느 Operation인지는 말해야 한다.
    expect(deck).toContain("data-fallback-title={operation.title}");
    const fallback = components.match(/\.canvas-triage-deck-mount:empty::after \{[^}]*\}/)?.[0] ?? "";
    expect(fallback).toContain("content: attr(data-fallback-title);");
    expect(deck).not.toContain("TriageDeckCardFace");
    expect(deck).not.toContain("OperationBodySlot");
    // 패널은 끝까지 캔버스 소유다 — portal은 DOM 부모만 바꾸므로 상태·이벤트·pool 배선이 유지된다.
    expect(canvas).toContain("createPortal(frame, options.deckSlot, operation.id)");
    expect(canvas).toContain("deckTile={options.deckSlot !== null}");
    // 무대와 companion은 칸을 쓰지 않는다 — 렌더가 프레임과 companion 프레임을 한 벌로 내놓으므로,
    // companion을 연 패널을 칸으로 들여보내면 캔버스 좌표를 지닌 companion까지 타일 안에 갇힌다.
    expect(canvas).toContain("const deckSlot = operationTriageStage || operationCompanion ? null : triageDeckSlots.get(operation.id) ?? null;");
  });

  it("keeps the deck tile off the canvas coordinate system", () => {
    // 칸이 크기를 정하는데 프레임이 캔버스 좌표를 인라인으로 실으면 패널이 칸을 넘치거나 어긋난다.
    expect(frame).toMatch(/const frameStyle = deckTile \? \{/);
    const tile = components.match(/\.canvas-operation\.is-deck-tile \{[^}]*\}/)?.[0] ?? "";
    expect(tile).toContain("position: relative;");
    expect(tile).toContain("width: auto;");
    expect(tile).toContain("height: auto;");
    // 캡션은 창 밖(-32px)에 설 수 없다 — 위 행의 칸을 덮는다. 덱에서만 흐름 안으로 들어온다.
    const tileCaption = components.match(/\.canvas-operation\.is-deck-tile > \.canvas-operation-titlebar \{[^}]*\}/)?.[0] ?? "";
    expect(tileCaption).toContain("position: relative;");
  });

  it("lets the shell rewrap to the tile instead of scaling a snapshot of it", () => {
    // PTY 리사이즈 허용이 이 구조의 목적이다 — 축소 fit 산술이 되살아나면 글자가 다시 뭉개진다.
    expect(deck).not.toContain("resolveTriagePreviewFit");
    expect(deck).not.toContain("surfaceScale");
    expect(components).not.toContain("canvas-triage-deck-card-preview");
    expect(components).not.toContain("canvas-triage-deck-card");
  });

  it("magnifies the cell so the panel and its caption take one transform", () => {
    const cell = components.match(/\.canvas-triage-deck-cell\.is-quicklook \{[^}]*\}/)?.[0] ?? "";
    expect(cell).toContain("transform: scale(var(--triage-quicklook-scale");
    // 밀도 변형도 같은 칸의 transform이다 — 둘은 공존하지 않으므로 한 소유자로 충분하다.
    expect(components).toContain(".canvas-triage-deck-cell.is-morphing {");
    // 전이 소유가 칸이므로 reduced-motion도 칸을 끊는다.
    const reducedMotion = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toMatch(/\.canvas-triage-deck-cell \{\s*transition: none;\s*\}/);
  });

  it("keeps the deck tile's live body out of reach of both pointer and keyboard", () => {
    // 승격 면은 포인터만 가로챈다 — 본문을 inert로 빼지 않으면 키보드는 그 면을 지나쳐 살아 있는
    // 터미널 textarea·컴포저로 들어가고, 읽는 자리여야 할 칸에 실제 입력이 들어간다.
    expect(frame).toContain('inert={deckTile ? true : undefined}');
    // 캡션은 inert가 아니다 — 최소화·닫기는 키보드로도 닿아야 한다.
    expect(frame).not.toMatch(/canvas-operation-titlebar"[^>]*inert/);
  });

  it("hides Analyst and Chat-view chips on a deck tile and keeps them on the stage", () => {
    // 카드 본문은 inert이고 승격 면이 클릭을 가로채므로 칩은 눌러도 동작하지 않는다.
    // 무대에 오른 패널은 is-deck-tile이 아니므로 칩이 기존처럼 보인다.
    const terminalChatCss = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-view-chip-row");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-mode-chip");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-dormant-open");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-follow");
    const hide = terminalChatCss.match(/\.canvas-operation\.is-deck-tile \.agent-view-chip-row,\s*\n\.canvas-operation\.is-deck-tile \.agent-chat-mode-chip,\s*\n\.canvas-operation\.is-deck-tile \.agent-chat-dormant-open,\s*\n\.canvas-operation\.is-deck-tile \.agent-chat-follow \{[^}]*\}/)?.[0] ?? "";
    expect(hide).toContain("display: none;");
    // 선택(무대) 축은 카드 클래스의 부재다 — is-active나 is-quicklook에 묶이면 카드이면서
    // 선택된 칸, 또는 확대된 칸에서 다시 그려진다.
    expect(hide).not.toContain("is-active");
    expect(hide).not.toContain("is-quicklook");
    // 회신 버튼은 칩 줄이 아니다 — 별도 규칙으로 숨기면 이 계약이 깨져야 한다.
    expect(terminalChatCss).not.toContain(".canvas-operation.is-deck-tile .agent-chat-reply");
    // 칩을 숨긴 카드에서는 그 자리를 피하던 상단 여백만 거둔다. 하단은 회신 버튼이 쓴다.
    const logOnTile = terminalChatCss.match(/\.canvas-operation\.is-deck-tile \.agent-chat-log \{[^}]*\}/)?.[0] ?? "";
    expect(logOnTile).toContain("padding-top: var(--space-3);");
    expect(logOnTile).not.toContain("45px");
  });

  it("gives the promotion surface the body and leaves the caption its own controls", () => {
    // 덱에서 패널의 본문은 읽는 것이지 조작하는 것이 아니다 — 본문 위를 덮는 면이 클릭 한 번을
    // 승격으로 받고, 캡션은 그 위에 남아 창 컨트롤이 자기 클릭을 지킨다.
    const pick = components.match(/\.canvas-triage-deck-pick \{[^}]*\}/)?.[0] ?? "";
    expect(pick).toContain("inset: 0;");
    // 캡션(z-index 7)보다 아래 — 그 위로 올리면 창 컨트롤을 되살릴 자손 선택자가 필요해지고,
    // 그 규칙이 공용 컨트롤 블록보다 앞서 잡혀 계약 검사를 오탐시킨다.
    expect(pick).toContain("z-index: 5;");
    expect(deck).toContain('className="canvas-triage-deck-pick"');
  });

  it("raises the hovered cell onto the plate for the map Quick-Look", () => {
    // 지도 모드에서도 확대창은 같은 패널이다 — 별도 얼굴을 그리면 밀도마다 다른 물건이 된다.
    expect(deck).toContain('${mapLook ? "is-map-quicklook" : ""}');
    const raised = components.match(/\.canvas-triage-deck\.is-map-mode \.canvas-triage-deck-band-cards \.canvas-triage-deck-cell\.is-map-quicklook \{[^}]*\}/)?.[0] ?? "";
    expect(raised).toContain("position: fixed;");
    expect(raised).toContain("visibility: visible;");
    expect(raised).toContain("pointer-events: none;");
  });

  it("reads quick-look layout coordinates from the cell that owns positioning", () => {
    // 칸이 position: relative라 그 안의 좌표는 칸 기준 0이다 — grid 기준 offset과 빼려면 좌표를
    // 칸에서 읽어야 하고, 안쪽 요소에서 읽으면 복귀 flight 목적지가 grid 모서리로 무너진다.
    expect(deck).toContain('target.closest<HTMLElement>(".canvas-triage-deck-cell")');
    expect(deck).toContain("layoutBox.offsetLeft - grid.offsetLeft");
    expect(deck).not.toContain("target.offsetLeft - grid.offsetLeft");
  });

  it("keeps the minimized shelf neutral and above the dormant shelf", () => {
    const sidebar = source("sidebar/triage-side-bar.tsx");
    const shelf = components.match(/\.triage-side-bar-minimized-shelf \{[^}]*\}/)?.[0] ?? "";
    const section = components.match(/\.side-bar-status-section--minimized \{[^}]*\}/)?.[0] ?? "";
    expect(shelf).toContain("border-top: 1px solid var(--surface-rim);");
    // 최소화는 활동 상태가 아니라 표시 선택이다 — 상태 축의 신호색도, 휴면이 쓰는 brass 혼합도 빌리지 않는다.
    expect(shelf).not.toMatch(/var\(--(?:brass|aurora|warn|coral|positive)/);
    expect(section).toContain("--activity-color: var(--ink-fog);");
    expect(section).not.toMatch(/var\(--(?:brass|aurora|warn|coral|positive)/);
    // 손에 가까운 순서: 살아 있는 축 → 내가 내린 것 → 세션이 스스로 잠든 것.
    expect(sidebar.indexOf('className="triage-side-bar-minimized-shelf"')).toBeGreaterThan(
      sidebar.indexOf('className="operations-side-bar-chips triage-side-bar-sections"'),
    );
    expect(sidebar.indexOf('className="triage-side-bar-dormant-shelf"')).toBeGreaterThan(
      sidebar.indexOf('className="triage-side-bar-minimized-shelf"'),
    );
  });
});
