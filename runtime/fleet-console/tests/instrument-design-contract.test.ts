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
const TERMINAL_AGENT_PATH = new URL("../../fleet-plugins/terminal/client/agent/index.tsx", import.meta.url);
const TERMINAL_ANALYSIS_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/analysis.css", import.meta.url);
const TERMINAL_AGENT_CLI_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/agent-cli.css", import.meta.url);
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

  it("keeps user identity on the spine+mark grammar and off the state border channel", () => {
    const frame = source("canvas/operation-frame.tsx");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const components = source("styles/components.css");
    const spineBlock = components.match(/\.canvas-operation-spine \{[^}]*\}/)?.[0] ?? "";
    const markBlock = components.match(/\.canvas-operation-id-mark \{[^}]*\}/)?.[0] ?? "";
    const washBlock = components.match(/\.canvas-operation\[style\*="--user-accent"\] \.canvas-operation-titlebar \{[^}]*\}/)?.[0] ?? "";
    const chipAccentBlock = components.match(/\.side-bar-chip\[style\*="--user-accent"\]::before \{[^}]*\}/)?.[0] ?? "";
    const minimapDotBlock = components.match(/\.canvas-minimap-operation\[style\*="--user-accent"\]::after \{[^}]*\}/)?.[0] ?? "";
    const accentSources = [frame, chip, components].join("\n");

    expect(frame).toContain('{ "--user-accent": accentColor }');
    expect(frame).toContain('className="canvas-operation-spine"');
    expect(frame).toContain('className="canvas-operation-id-mark"');
    expect(chip).toContain('{ "--user-accent": accentValue }');
    // 정체성은 보더 채널을 소유하지 않는다 — 보더는 상태(brass/aurora/coral) 전용.
    expect(components).not.toContain("border-color: var(--user-accent)");
    expect(spineBlock).toContain("width: 3px;");
    expect(spineBlock).toContain("background: var(--user-accent);");
    expect(spineBlock).toContain("pointer-events: none;");
    expect(spineBlock).not.toMatch(/animation|box-shadow/);
    expect(markBlock).toContain("width: 8px;");
    expect(markBlock).toContain("height: 14px;");
    expect(markBlock).toContain("background: var(--user-accent);");
    expect(washBlock).toContain("color-mix(in oklch, var(--user-accent) 10%, var(--surface-frame))");
    expect(washBlock).toContain("background-clip: padding-box");
    expect(chipAccentBlock).toContain("width: 3px;");
    expect(chipAccentBlock).toContain("top: 7px;");
    expect(chipAccentBlock).toContain("bottom: 7px;");
    expect(chipAccentBlock).toContain("background: var(--user-accent);");
    expect(chipAccentBlock).toContain("pointer-events: none;");
    expect(chipAccentBlock).not.toMatch(/animation/);
    expect(minimapDotBlock).toContain("background: var(--user-accent);");
    // 6번째 소비처는 정체성 워시 위에 포커스 워시를 겹치는 결합 규칙이다 — 새 채널이 아니라
    // 같은 워시를 포커스 상태에서 다시 적는 자리이므로 accent는 여전히 spine+mark+wash에 머문다.
    expect(components.match(/var\(--user-accent\)/g)).toHaveLength(6);
    expect(accentSources).not.toMatch(/--op-accent|--chip-accent/);
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
    // 사이드바 칩·커맨드 밴드·팔레트는 같은 Operation을 세 곳에서 센다. 세 표면이 각자 톤을
    // 적으면 한 곳만 고쳐도 컴파일은 되고 같은 Operation이 두 색으로 보인다 — 대조표는
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

    // 세 표면 모두 공용 마크 클래스를 통해 톤을 받는다 — 하나라도 자기 색을 적으면 대조표가 갈라진다.
    expect(source("sidebar/operations-side-bar-chip.tsx")).toContain("operation-provider-mark is-${entry.launchProvider}");
    expect(source("components/command-band.tsx")).toContain("operation-provider-mark is-${activeLaunchProvider}");
    expect(source("components/operation-search.tsx")).toContain("operation-provider-mark is-${entry.launchProvider}");
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
    // Watch Deck 상태 맥동과 착지 flash도 같은 reduced-motion 봉인을 공유한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-card.is-running .canvas-triage-deck-card-dot,");
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-card.is-landed,");
    // 지도 점의 착지 플래시도 카드와 같은 봉인을 공유한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-map-dot.is-landed,");
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-card.is-arriving,");
    // 스포트라이트 OFF의 지속 맥동은 움직임을 빼고도 정지한 aurora 링으로 읽혀야 한다.
    expect(reducedMotionBlock).toContain(".canvas-triage-deck-card.is-fresh,");
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

    expect(sidebar).toContain('const livingSections = sections.filter((section) => section.status !== "dormant")');
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
    expect(components).toContain(".tenant-beacon.is-awaiting,\n.canvas-triage-deck-card.is-awaiting,\n.canvas-triage-map-dot.is-awaiting,\n.side-bar-status-section--awaiting {");
    expect(components).toMatch(/\.tenant-beacon\.is-idle,\s*\.canvas-triage-deck-card\.is-idle,\s*\.canvas-triage-map-dot\.is-idle,\s*\.side-bar-status-section--idle\s*\{[^}]*--activity-color:\s*var\(--positive\)/);
    expect(components).toContain(".tenant-beacon.is-dormant,\n.canvas-triage-deck-card.is-dormant,\n.canvas-triage-map-dot.is-dormant,\n.side-bar-status-section--dormant {");
    expect(components).toContain("--activity-color: color-mix(in oklch, var(--brass) 55%, var(--ink-rim));");
    expect(components).toMatch(/\.tenant-beacon\.is-background,\s*\.canvas-triage-deck-card\.is-background,\s*\.canvas-triage-map-dot\.is-background,\s*\.side-bar-status-section--background\s*\{[^}]*--activity-color:\s*var\(--warn\)/);
    expect(components).toMatch(/\.canvas-triage-deck-card-dot \{[^}]*background:\s*var\(--activity-color\)/);
    expect(components).toMatch(/\.canvas-triage-map-dot \{[^}]*background:\s*var\(--activity-color\)/);
    expect(components).toMatch(/\.canvas-triage-deck-card\.is-background \.canvas-triage-deck-card-dot \{[^}]*background:\s*none;[^}]*border:\s*1\.5px solid var\(--activity-color\)/);
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
    // Doctrine: the panel head is a 32px caption attached above the slot. It does
    // not take a body row and does not hover-reveal. The body keeps the full slot
    // height; PTY/plugin geometry is unaware of the caption.
    expect(rail).toContain(".right-rail-panel-head {");
    expect(rail).toContain("grid-template-rows: 32px minmax(0, 1fr);");
    expect(rail).not.toContain("height: calc(100% + 32px);");
    expect(source("styles/components.css")).toContain(".canvas-operation.is-top-edge .canvas-operation-titlebar");
    expect(source("styles/components.css")).toContain(".canvas-operation.is-top-edge .canvas-operation-resize--n");
    expect(source("canvas/operation-frame.tsx")).toContain("DRAG_THRESHOLD_PX");
    expect(source("canvas/operation-frame.tsx")).toContain("capturing: false");
    const railHead = rail.match(/^\.right-rail-panel-head \{[^}]*\}/m)?.[0] ?? "";
    expect(railHead).toContain("height: 32px;");
    expect(railHead).toContain("min-height: 32px;");
    expect(rail).not.toContain(".right-rail-panel-head-reveal");
    expect(rail).not.toContain(".right-rail-panel-peek");
    expect(rightRail).not.toContain("HEAD_REVEAL_INTENT_DELAY_MS");
    expect(rightRail).not.toMatch(/onPointerEnter=\{(?:handleSlotPointerMove|holdHeadOpen)/);
  });

  it("pins the popup opacity underlay contract", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
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
    // Operation 창 본체·타이틀바는 --surface-frame을 소비한다 — ink-mid 재결합은 라이트 최암면 회귀다.
    const operationBlock = components.match(/^\.canvas-operation \{[^}]*\}/m)?.[0] ?? "";
    expect(operationBlock).toContain("background: var(--surface-frame);");
    const titlebarBlock = components.match(/^\.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(titlebarBlock).toContain("background: var(--surface-frame);");
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
    // Operation 창 프레임 티어 — 다크는 ink-mid 별칭(기존 렌더 유지), 라이트는 ink-deep 별칭으로
    // GNB(밴드)와 같은 크롬 패밀리에 정렬해 프레임이 라이트 최암면이 되는 것을 막는다.
    expect(base).toContain("--surface-frame: var(--ink-mid);");
    expect(theme.match(/--surface-frame:/g)).toHaveLength(2);
    expect(theme.match(/--surface-frame: var\(--ink-deep\);/g)).toHaveLength(1);
    expect(theme).not.toMatch(/#fff(?:fff)?\b/i);
    expect(theme).not.toMatch(/body::(?:before|after)/);
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
    // inherit은 단축 전체가 아니라 border-color만 받는다. 1px solid inherit은 선언이 버려진다.
    expect(components).toContain("border-width: 1px;");
    expect(components).toContain("border-style: solid;");
    expect(components).toContain("border-color: inherit;");
    expect(components).not.toContain("border: 1px solid inherit;");
    // 패널 아웃라인은 상태를 놓았다 — 포커스는 캡션 채움 워시, 상태는 캡션 아랫변 레일이 나른다.
    // 포커스는 선을 쓰지 않는다: 상태 레일과 같은 굵기의 brass 선이 캡션 위아래에 겹치면
    // warn과 brass가 한 덩어리 금색으로 읽힌다.
    expect(components).toContain(".canvas-operation.is-active > .canvas-operation-titlebar {");
    expect(components).toContain("background: color-mix(in oklab, var(--brass) 10%, var(--surface-frame));");
    expect(components).not.toContain(".canvas-operation-titlebar::before");
    expect(components).toContain("background: var(--caption-rail, transparent);");
    // 도착 플래시는 지속 상태(is-unseen)가 아니라 전이를 표시하는 일시 클래스에만 건다 —
    // is-unseen에 걸면 Theater 재진입 리마운트마다 다시 돈다.
    expect(components).toContain(".canvas-operation.is-unseen-arriving > .canvas-operation-titlebar::after {");
    expect(components).not.toMatch(/\.canvas-operation\.is-unseen > \.canvas-operation-titlebar::after \{\n\s*animation: caption-rail-arrive/);
    expect(operationFrame).toContain('arrivalFlash ? "is-unseen-arriving" : ""');
    expect(operationFrame).toContain("previousUnseenRef");
    // 정체성 워시와 포커스 워시는 같은 표면을 다투지 않는다 — 결합 규칙이 둘을 겹쳐 칠한다.
    expect(components).toContain('.canvas-operation[style*="--user-accent"].is-active > .canvas-operation-titlebar {');
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
    expect(source("canvas/canvas.tsx")).toContain("const TITLEBAR_OUTSET_PX = OPERATION_WINDOW_CAPTION_HEIGHT");
    expect(source("canvas/canvas.tsx")).toContain("y: TITLEBAR_OUTSET_PX");
    expect(source("canvas/canvas.tsx")).toContain("TITLEBAR_OUTSET_PX * effectiveZoom");
    expect(source("canvas/coordinates.ts")).toContain("y: 18 + 32");
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

// War Room Quick-Look은 확대창 안의 프리뷰를 화면상 실물 크기(1:1)로 세운다. 배율 산술은
// triage-deck-quicklook.test.ts가 고정하지만, 산술이 맞아도 배선이 끊기거나 전이 소유가 옮겨가면
// 화면은 조용히 예전 동작 — 같은 축소판이 커지기만 하는 확대 — 으로 돌아간다.
describe("War Room Quick-Look actual-size grammar", () => {
  const deck = source("canvas/triage-watch-deck.tsx");
  const components = source("styles/components.css");

  it("hands a card its own magnification only while its Quick-Look is open", () => {
    expect(deck).toContain("surfaceScale={isQuicklook ? quicklook.scale : 0}");
  });

  it("treats the map Quick-Look window as a magnified surface standing at its own size", () => {
    expect(deck).toContain("surfaceScale={1}");
  });

  it("feeds the floor into the fit and re-measures when the floor moves", () => {
    expect(deck).toContain("resolveTriagePreviewMinScale(surfaceScale)");
    // Quick-Look 배율은 열린 채로도 재계산된다(recordRects) — deps에서 빠지면 뷰포트가 그대로인
    // 동안 fit이 낡은 하한에 머물러 확대창이 1:1을 잃는다.
    expect(deck).toMatch(/\[bottomChrome, innerHeight, innerWidth, minScale\]/);
  });

  it("leaves the preview transform without a transition of its own", () => {
    const inner = components.match(/\.canvas-triage-deck-card-preview-inner \{[^}]*\}/)?.[0] ?? "";
    expect(inner).not.toBe("");
    // fit은 덱 줌 tween과 창 리사이즈마다 매 프레임 다시 잡힌다 — 여기 전이를 걸면 프리뷰가
    // 카드보다 뒤처져 화면 배율이 1:1을 벗어나고 가장자리에 빈 띠가 뜬다.
    expect(inner).not.toContain("transition");
  });

  // 프레임은 카드가 내준 칸을 그대로 채운다 — 프레임 자체가 칸보다 작아지면 그 차이가 카드 안의
  // 빈 띠가 되어, 산술이 막은 여백을 CSS가 되돌려 놓는다. 채움은 grid 항목의 stretch 기본값에
  // 기대므로, 명시적 크기나 정렬이 들어오는 순간 조용히 풀린다 — 부재를 검사하는 이유다.
  it("lets the preview frame fill the cell the card hands it", () => {
    const frame = components.match(/\.canvas-triage-deck-card-preview \{[^}]*\}/)?.[0] ?? "";
    expect(frame).not.toBe("");
    // 확정 크기는 stretch를 start로 바꿔 칸을 남긴다(css-align §6.3). 비율·상한·정렬도 마찬가지다.
    expect(frame).not.toMatch(/\n\s*(?:width|height|max-width|max-height|aspect-ratio|align-self|justify-self|inset|top|bottom):/);
    // min-width/min-height는 0으로만 허용한다 — grid 자식의 축소 하한을 푸는 용도다.
    expect(frame).toContain("min-width: 0;");
    expect(frame).toContain("min-height: 0;");
    // 넘치는 출력은 프레임에서 잘려야 한다. 이것이 풀리면 카드 밖으로 글자가 새어 나온다.
    expect(frame).toContain("overflow: hidden;");
    // 프레임 크기는 덱 줌 tween마다 다시 잡히므로 전이를 걸면 출력과 프레임이 서로를 쫓는다.
    expect(frame).not.toContain("transition");
  });

  // 삭제하면 조용히 깨지는 배선 — 산술은 순수 함수 테스트가 지키지만, 그 함수에 무엇이 들어가는지는
  // 여기서만 고정된다. bottomChrome이 0으로 흘러 들어가면 Agent CLI의 컴포저와 상태줄이 프레임
  // 안으로 되돌아오는데(실측 490×333 칸에서 화면상 81.6px), 순수 함수 테스트는 전부 green이다.
  it("carries the body-declared bottom chrome all the way into the fit", () => {
    const canvas = source("canvas/canvas.tsx");
    // kind가 선언한 값을 core가 그대로 싣는다 — 미선언은 0이고, core는 그 구조를 알지 못한다.
    expect(canvas).toContain("bottomChrome: descriptor.previewBottomChrome?.() ?? 0");
    // 카드 면이 그 값을 프리뷰로 넘기고, 프리뷰가 fit으로 넘긴다.
    expect(deck).toContain("bottomChrome={preview.bottomChrome}");
    expect(deck).toMatch(/resolveTriagePreviewFit\(\s*\{[^}]*\},\s*\{[^}]*\},\s*bottomChrome,/);
  });

  // 프리뷰의 측정 크기가 카드를 따라가면 FitAddon이 PTY cols/rows를 타일 크기로 재조정해 실세션
  // 레이아웃이 깨진다 — 이 판 전체가 transform scale만 쓰는 이유이자 가장 비싼 회귀다.
  it("keeps the preview body at the panel's own pixel size, never the card's", () => {
    expect(deck).toContain("const innerWidth = Math.max(320, config.geometry.width);");
    expect(deck).toContain("const innerHeight = Math.max(200, config.geometry.height);");
    // 인라인 크기는 그 두 값이어야 한다. 뷰포트 측정값이 여기 들어오면 계약이 뒤집힌다.
    expect(deck).toMatch(/width:\s*innerWidth,\s*\n\s*height:\s*innerHeight,/);
    const inner = components.match(/\.canvas-triage-deck-card-preview-inner \{[^}]*\}/)?.[0] ?? "";
    expect(inner).toContain("position: absolute;");
  });

  it("keeps the magnification transition on the card that owns it", () => {
    const card = components.match(/\.canvas-triage-deck-card \{[^}]*\}/)?.[0] ?? "";
    expect(card).toContain("transform var(--duration-slow)");
  });

  it("magnifies the cell so the card and its window controls take one transform", () => {
    // 확대가 카드에만 걸리면 카드의 형제인 창 컨트롤이 따라가지 못해 확대된 카드 위에서 손잡이가
    // 제자리에 남는다. 배율은 칸이 지고, 카드는 테두리·그림자만 입는다.
    const cell = components.match(/\.canvas-triage-deck-cell\.is-quicklook \{[^}]*\}/)?.[0] ?? "";
    expect(cell).toContain("transform: scale(var(--triage-quicklook-scale");
    const card = components.match(/\.canvas-triage-deck-card\.is-quicklook \{[^}]*\}/)?.[0] ?? "";
    expect(card).not.toBe("");
    expect(card).not.toContain("transform:");
    // 손잡이는 카드 크롬과 같은 1/배율 되돌림을 받아 확대 중에도 24px을 지킨다.
    const controls = components.match(/\.canvas-triage-deck-cell\.is-quicklook \.canvas-triage-deck-card-controls \{[^}]*\}/)?.[0] ?? "";
    expect(controls).toContain("1 / var(--triage-quicklook-scale");
    // 전이 소유가 칸으로 옮겨졌으므로 reduced-motion도 칸을 끊어야 한다 — 카드만 끊으면 확대가 움직인다.
    const reducedMotion = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toMatch(/\.canvas-triage-deck-cell,\s*\.canvas-triage-deck-card-controls \{\s*transition: none;\s*\}/);
  });

  it("reads quick-look layout coordinates from the cell that owns positioning", () => {
    // 칸이 position: relative라 카드의 offsetLeft/Top은 칸 안의 0이다 — grid 기준 offset과 빼려면
    // 좌표를 칸에서 읽어야 하고, 카드에서 읽으면 복귀 flight 목적지가 grid 모서리로 무너진다.
    const deck = source("canvas/triage-watch-deck.tsx");
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

  it("keeps deck card window controls always visible as a recorded exception", () => {
    // 사이드바 20px·캔버스 24px 손잡이는 hover/focus 전까지 0×0으로 접히지만, deck 카드의 손잡이는
    // 접지 않는다: 카드가 그 자체로 버튼이라 접힌 손잡이를 찾을 단서가 없고, 카드 위 hover는 400ms 뒤
    // Quick-Look 확대를 불러 "올려서 찾는" 동작이 확대와 경합한다. 예외는 CSS 옆 주석으로 남는다.
    const control = components.match(/\.canvas-triage-deck-card-control \{[^}]*\}/)?.[0] ?? "";
    expect(control).not.toBe("");
    expect(control).toContain("width: 24px");
    expect(control).toContain("height: 24px");
    expect(control).toMatch(/opacity:\s*0\.55/);
    expect(components).toContain("도트린 예외 — 다른 창 컨트롤");
    // 닫기는 다른 표면과 같은 두 번 누르기 무장을 그대로 쓴다.
    const armed = components.match(/\.canvas-triage-deck-card-control\.is-armed-close \{[^}]*\}/)?.[0] ?? "";
    expect(armed).toContain("chip-close-arm 1.5s");
  });
});
