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
const SDK_RAIL_TYPES_PATH = new URL("../sdk/rail/types.ts", import.meta.url);
const SDK_VERSION_PATH = new URL("../sdk/version.ts", import.meta.url);
const OWNED_SOURCES = [
  "app.tsx",
  "canvas/canvas-store.ts",
  "canvas/canvas-grid.tsx",
  "canvas/canvas-context-menu.tsx",
  "canvas/canvas-minimap.tsx",
  "canvas/canvas.tsx",
  "pages/operations.tsx",
  "components/command-band.tsx",
  "components/side-bar-brand-foot.tsx",
  "sidebar/operations-side-bar.tsx",
  "styles/theme.css",
  "styles/components.css",
  "styles/layout.css",
  "styles/rail.css",
  "styles/rail-alerts.css",
  "rail/plans.css",
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
  // Sidebar TSX injects transient drag offsets for chips and group headers.
  "--drag-dy",
  // Sidebar TSX injects the persisted group tone used by group-scoped surfaces.
  "--grp-color",
  // Sidebar chip TSX injects the group marker tone for each rendered mark.
  "--group-mark",
  // What's New TSX injects each section's reveal delay.
  "--whatsnew-delay",
  // Command Band TSX injects the measured left sidebar width.
  "--command-band-left-width",
  // Right Rail TSX injects the current panel width.
  "--right-rail-panel-width",
  // Right Rail TSX injects the user-selected overlay opacity.
  "--right-rail-overlay-alpha",
  // Repository Rail TSX injects the user-resized workspace tree width.
  "--ws-tree-width",
  // Terminal Carriers TSX injects the selected captain identity tone.
  "--cap-color",
  // Canvas context menu TSX injects the viewport-derived height ceiling for its own box.
  "--canvas-menu-max-height",
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
    ]) {
      expect(canvas).toContain(sharedModeClass);
      expect(components).toContain(`.${sharedModeClass}`);
    }
    expect(canvas).not.toContain("canvas-mode-hud");
    expect(components).not.toContain(".canvas-mode-hud");
    expect(canvas).toContain("canvas-triage-rail-current");
    expect(canvas).toContain("canvas-triage-rail-cleared");
    // 두 번 눌러 확정 안내는 레일이 아니라 패널 안 HUD가 소유한다 — 확인 순간에 시선이 화면 하단으로 내려가지 않게.
    expect(canvas).not.toContain("canvas-triage-rail-arm");
    expect(canvas).not.toMatch(/canvas-triage-(?:frame|bracket|hud(?:-eye|-name)?|curtain-kicker|curtain-ruler)/);
    expect(components).toContain("radial-gradient(100% 80% at 50% 42%, var(--canvas-sea-core), var(--canvas-sea-mid) 78%)");
    expect(components).toContain("background-size: 48px 48px !important;");
    expect(components).toContain(".canvas-formation-guide {");
    expect(components).toContain(".canvas-operation-formation-slot {");
    expect(contextMenu).toContain('<p className="canvas-context-menu-section">{t("canvas.menu.launch")}</p>');
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
    expect(washBlock).toContain("color-mix(in oklch, var(--user-accent) 10%, var(--ink-mid))");
    expect(chipAccentBlock).toContain("width: 3px;");
    expect(chipAccentBlock).toContain("top: 7px;");
    expect(chipAccentBlock).toContain("bottom: 7px;");
    expect(chipAccentBlock).toContain("background: var(--user-accent);");
    expect(chipAccentBlock).toContain("pointer-events: none;");
    expect(chipAccentBlock).not.toMatch(/animation/);
    expect(minimapDotBlock).toContain("background: var(--user-accent);");
    expect(components.match(/var\(--user-accent\)/g)).toHaveLength(5);
    expect(accentSources).not.toMatch(/--op-accent|--chip-accent/);
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
    const explicitReducedMotionStart = components.indexOf(".reduce-panel-motion .canvas-operation,");
    const explicitReducedMotionBlock = components.slice(
      explicitReducedMotionStart,
      components.indexOf("@media (prefers-reduced-motion: reduce)", explicitReducedMotionStart),
    );
    expect(explicitReducedMotionBlock).toMatch(/\.reduce-panel-motion \.canvas-operation,\s*\.reduce-panel-motion \.canvas-operation\.is-minimized \{\s*transition: none;\s*\}/);
    expect(explicitReducedMotionBlock).toMatch(/\.reduce-panel-motion \.canvas-companion-frame,\s*\.reduce-panel-motion \.side-bar-chip\.is-arrival-pulse \{\s*animation: none;\s*\}/);
    // (d) 존재 전환 keyframe은 panel-enter로 일반화 — companion 전용 명칭은 퇴역하고 실제 사용까지 고정한다.
    expect(components).toContain("@keyframes panel-enter");
    expect(components).toContain("animation: panel-enter var(--duration-slow) var(--ease-glide) both;");
    expect(components).not.toContain("companion-frame-enter");
    // (e) 안무 표면(칩 도착 맥동·고스트)도 reduced-motion 블록 안에서 무효화된다.
    expect(reducedMotionBlock).toContain(".side-bar-chip.is-arrival-pulse {");
    expect(reducedMotionBlock).toContain(".panel-motion-ghost {");
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
    expect(sidebar).toContain("groupOperationsByStatus(allEntries, getStatusTransitionTick, t)");
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
    expect(components).toContain("--status-color: var(--positive);");
    expect(components).toContain("--status-color: color-mix(in oklch, var(--brass) 55%, var(--ink-rim));");
    expect(components).toContain("border-left: 3px solid var(--status-color);");
    expect(components).toContain("background: var(--group-mark);");
    expect(components).toMatch(/\.side-bar-chip-unseen \{[^}]*background:\s*var\(--positive\)/);
    expect(components).toMatch(/\.side-bar-chip--unseen \{[^}]*border-color:\s*color-mix\(in oklch, var\(--positive\)/);
    expect(components).toMatch(/\.canvas-operation\.is-unseen \{[^}]*border-color:\s*var\(--positive\)/);
    expect(components).toContain(".canvas-operation.is-unseen.is-active {");
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
    // alpha token, so without the underlay the Solid(100) preset can never be opaque.
    expect(rail).toMatch(/\.right-rail\.is-overlay \.right-rail-panel-slot::before \{[^}]*\)\s*,\s*var\(--ink-deep\);/);
    expect(rightRail).toContain("useRailPanelBehavior");
    expect(rightRail).toContain("right-rail-float-toggle");
    expect(rightRail).toContain("is-switching");
    expect(railStore).toContain("fleet-console.rail.panelBehavior");
  });

  it("pins the popup opacity underlay contract", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    // Doctrine: scrim-backed popup cards and floating menus composite their glass layers
    // over an opaque var(--ink-deep) final layer — maritime/carbon glass tokens carry
    // 60~80% alpha, so without the underlay popups bleed the canvas through and legibility
    // collapses (canonical doctrine comment: .whatsnew-card in components.css). Non-popup
    // glass surfaces keep the themes' translucent glass identity untouched.
    const componentsPopupSelectors = [
      ".whatsnew-card",
      ".commissioning-card",
      ".directory-browser-card",
      ".codex-reading-sheet",
      ".app-toast",
      ".brand-foot-dropup-menu",
      ".group-context-menu-card",
      ".accent-popover-card",
      ".theater-menu",
      ".operation-search-card",
    ];
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
    expect(commandBand).toContain('<FleetBrandHome className="command-band-brand" />');
    expect(commandBand).toContain("onClick={() => setSideBarCollapsed(!sideBar.collapsed)}");
    expect(commandBand).toContain('className="command-band-button command-band-search"');
    expect(commandBand).toContain("onClick={toggleOperationSearch}");
    expect(commandBand).toContain('className="command-band-button command-band-viewmode"');
    expect(commandBand).toContain('className="command-band-button command-band-rail-toggle"');
    expect(commandBand).toContain("onClick={toggleRailChrome}");
    expect(commandBand).toContain(`      </div>
      {operationsViewVisible ? <div ref={mapControlsRef} className="command-band-map-controls">`);
    expect(commandBand).toContain('aria-label={t("chrome.commandBand.resetCanvasView")}');
    expect(commandBand).toContain("<ResetViewIcon />");
    expect(commandBand).toContain("onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })}");
    expect(commandBand).toContain("disabled={state.activeTheaterId === null}");
    expect(commandBand).toContain('className="command-band-formation-divider"');
    expect(commandBand).toContain('onClick={() => selectFormationLayout("grid")}');
    expect(commandBand).toContain('onClick={() => selectFormationLayout("columns")}');
    expect(commandBand).toContain('onClick={() => selectFormationLayout("rows")}');
    expect(commandBand).toContain('aria-pressed={formationView && formationLayout === "grid"}');
    expect(commandBand).toContain('aria-pressed={formationView && formationLayout === "columns"}');
    expect(commandBand).toContain('aria-pressed={formationView && formationLayout === "rows"}');
    expect((commandBand.match(/disabled=\{state\.activeTheaterId === null\}/g) ?? []).length).toBe(5);
    expect(commandBand).toContain('className="command-band-triage-toggle"');
    expect(commandBand).toContain("aria-pressed={triageActive}");
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
    expect(layout).toContain(".command-band-formation-group {");
    // 맵 컨트롤 클러스터는 컨테이너 플로우 배치다 — 개별 절대 위치 + 매직 오프셋(구 116px)은
    // 버튼 추가 시 겹침으로 깨지므로(선별 처리 아이콘 덮임 사고) 다시 도입하지 않는다.
    expect(layout).toContain(".command-band-map-controls {");
    expect(layout).toContain("left: calc(var(--command-band-left-width, 280px) + var(--space-2));");
    expect(layout).not.toContain(".command-band-triage-toggle {\n  position: absolute;");
    expect(layout).not.toContain(".command-band-formation-group .command-band-formation-seg + .command-band-formation-seg {");
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
    expect(commandBandLeftBlock).toContain("background: var(--surface-glass);");
    // 캡이 실재하는 상태로 한정한다 — 풀스크린은 밴드가 fixed로 흐름에서 빠져 자동 은닉되므로
    // 캡이 없고, 사이드바가 뷰포트 최상단에 닿는다. 무조건 해제하면 그 화면에서 마감이 사라진다.
    const expandedSideBarBlock =
      components.match(/\.console-shell:has\(\.command-band:not\(\.is-fullscreen\)\) \.operations-side-bar\.is-expanded \{[^}]*\}/)?.[0] ?? "";
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
    expect(commandBand).toContain('className={`command-band-edge-reveal${fullscreen.isFullscreen ? " is-fullscreen" : ""}`}');
    expect(commandBand).toContain('aria-label={t("chrome.commandBand.showCommandBand")}');
    expect(commandBand).toContain('aria-pressed={fullscreen.isPinned}');
    expect(commandBand).toContain("inert={commandBandHidden || undefined}");
    expect(commandBand).toContain("onKeyDown={(event) => { if (event.key === \"Tab\") fullscreen.reveal(); }}");
    expect(layout).toContain(".command-band.is-fullscreen {");
    expect(layout).toContain("position: fixed;");
    expect(layout).toContain("transform: translateY(-100%);");
    expect(layout).toContain("transition: transform var(--duration-base) var(--ease-glide);");
    expect(layout).toContain(".command-band-edge-reveal.is-fullscreen {");
    expect(layout).toContain("height: 8px;");
    expect(layout).toContain('html[data-desktop-shell="true"] .command-band-edge-reveal {');
    expect(layout).toContain('body:has([aria-modal="true"]:not([hidden])) .command-band.is-fullscreen,');
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
    expect(reducedMotionBlock).toContain(".command-band-left {");
    expect(reducedMotionBlock).toContain("transition: none !important;");
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
    expect(theme).toContain(':root[data-theme="daywatch"]');
    expect(theme).toContain(':root[data-theme="whites"]');
    expect(theme).toContain(':root[data-theme="drydock"]');
    expect(theme).toContain("--brass: oklch(78% 0.13 75);");
    expect(theme).toContain("--ink-muted: oklch(75% 0.02 248);");
    expect(theme).toContain("--ink-muted: oklch(72% 0.005 250);");
    expect(theme).toContain("--ink-abyss: oklch(96% 0.008 245);");
    expect(theme).toContain("--ink-abyss: oklch(97.3% 0.004 250);");
    expect(theme).toContain("--ink-abyss: oklch(95% 0.015 235);");
    expect(theme.match(/^:root \{/gm)).toHaveLength(1);
    // Legacy dark 테마는 팔레트 토큰만 — 광학·color-scheme과 형상·타이포 오버라이드는 진입 불가.
    const darkVariantBlocks = theme.match(/^:root\[data-theme="(?:maritime|carbon)"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(darkVariantBlocks).toHaveLength(3);
    for (const block of darkVariantBlocks) {
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^--(?:ink|brass|aurora|coral|warn|positive|canvas|surface|hairline|text|id)[a-z-]*:$/);
      }
    }
    // Light 테마만 팔레트 + 광학(color-scheme/shadow/scrollbar/신호 ink·halo/본문 regular 굵기 보정)을 허용한다.
    // --weight-regular 단일 예외: 밝은 배경의 얇은 스템 광학 보정 — medium/bold 티어 오버라이드는 계속 차단.
    const lightVariantBlocks = theme.match(/^:root\[data-theme="(?:daywatch|whites|drydock)"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(lightVariantBlocks).toHaveLength(3);
    for (const block of lightVariantBlocks) {
      expect(block).toContain("color-scheme: light;");
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^(?:--(?:ink|brass|aurora|coral|warn|positive|canvas|surface|hairline|text|id|carrier|shadow|scrollbar)[a-z-]*|--weight-regular|color-scheme):$/);
      }
    }
    // 신호 ink 티어는 base에서 별칭으로 존재해 다크 3종이 var 간접으로 base 신호색을 상속한다.
    for (const ink of ["--brass-ink", "--aurora-ink", "--coral-ink", "--warn-ink", "--positive-ink"]) {
      expect(base).toContain(`${ink}: var(`);
      expect(theme.match(new RegExp(`${ink}:`, "g"))).toHaveLength(4);
    }
    expect(theme).not.toMatch(/#fff(?:fff)?\b/i);
    expect(theme).not.toMatch(/body::(?:before|after)/);
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

  it("keeps real GNB and captain producers aligned with the static CSS gates", () => {
    const components = source("styles/components.css");
    const brandFoot = source("components/side-bar-brand-foot.tsx");
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    expect(components.match(/font-family:\s*var\(--font-display\)/g)).toHaveLength(1);
    expect(brandFoot).toContain('className="brand-foot-wordmark"');
    expect(components).not.toMatch(/data-sidebar-state="(?:rail|list|detail)"/);
    expect(components).not.toContain("global-navigation");
    expect(components).not.toContain("data-signature");
    expect(terminalAnalysisCss).toContain(".carrier-stream-column__captain-dot {");
    expect(terminalAgent).toContain('className="carrier-stream-column__captain-dot"');
    expect(terminalAgent).not.toContain("data-signature");
    expect(skillsCss).not.toMatch(/color-mix\([^)]*\b(?:black|white)\b/);
  });

  it("maps only known Carrier Stream captain dots through captain identity tokens", () => {
    const terminalAnalysisCss = externalSource(TERMINAL_ANALYSIS_CSS_PATH);
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const captainIds = ["nimitz", "genesis", "sentinel", "vanguard"] as const;

    expect(terminalAnalysisCss).not.toMatch(/\.carrier-stream-column__captain-dot \{[^}]*background:/);
    expect(terminalAnalysisCss.match(/\.carrier-stream-column__captain-dot\[data-captain="/g)).toHaveLength(4);
    for (const id of captainIds) {
      expect(terminalAnalysisCss).toContain(`.carrier-stream-column__captain-dot[data-captain="${id}"] { background: var(--captain-${id}); }`);
    }
    expect(terminalAgent).toContain("resolveCarrierCaptain(job.ownerCarrierId)");
    expect(terminalAnalysisCss).not.toContain('data-captain="kirov"');
    expect(terminalAnalysisCss).not.toContain("--captain-kirov");
    expect(terminalAnalysisCss).not.toMatch(/data-captain\s*=\s*["']ohio["']/i);
    expect(terminalAnalysisCss).not.toContain("--captain-ohio");
    expect(terminalAnalysisCss).not.toContain('data-captain="chronicle"');
    expect(terminalAnalysisCss).not.toContain("--captain-chronicle");
    expect(terminalAnalysisCss).not.toContain('data-captain="tempest"');
    expect(terminalAnalysisCss).not.toContain("--captain-tempest");
  });

  it("keeps the v4 navigation, Theater, map, CLI, and rail visual producers", () => {
    const brandFoot = source("components/side-bar-brand-foot.tsx");
    const sidebar = source("sidebar/operations-side-bar.tsx");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const minimap = source("canvas/canvas-minimap.tsx");
    const commandBand = source("components/command-band.tsx");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");

    expect(source("canvas/canvas-context-menu.tsx")).not.toContain("CanvasContextMenuMode");
    expect(brandFoot).toContain('className="brand-foot-dropup-menu" role="menu"');
    expect(brandFoot).toContain('t("chrome.brandFoot.systemMenu")');
    expect(brandFoot).toContain('t("chrome.brandFoot.keyboardShortcuts")');
    expect(brandFoot).toContain("openWhatsNew");
    expect(components).toContain(".side-bar-brand-foot {");

    expect(sidebar).toContain("hasCustomGroups && section.entries.length > 0");
    expect(sidebar).toContain("theaterInitials(theater.label)");
    expect(chip).toContain("side-bar-chip-status");
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
    expect(components).toContain("font-size: calc(var(--font-body-size) * 0.86);");
    const identityInputBlock = components.match(/^\.canvas-operation-identity-input \{\n  flex: 1 1 auto;[^}]*\}/m)?.[0] ?? "";
    expect(identityInputBlock).toContain("width: min(28ch, 34vw);");
    expect(identityInputBlock).not.toContain("width: 0;");
    expect(components).toContain("top: calc(-1 * var(--space-3));");
    expect(components).toContain("border-radius: 999px;");
    expect(components).toContain("background: var(--ink-mid);");
    expect(components).toContain("color: var(--text-secondary);");
    expect(components).toContain(".canvas-operation.is-active .canvas-operation-titlebar {");
    expect(components).toContain("color-mix(in oklch, var(--brass) 62%, var(--ink-rim))");
    expect(components).toContain(".canvas-operation-window-controls {");
    expect(components).toContain("max-width: 0;");
    const windowControlsBlock = components.match(/\.canvas-operation-window-controls \{[^}]*\}/)?.[0] ?? "";
    expect(windowControlsBlock).toContain("overflow-x: clip;");
    expect(windowControlsBlock).toContain("overflow-y: visible;");
    const windowControlsLastButtonBlock = components.match(/\.canvas-operation-window-controls > \.canvas-operation-icon-button:last-child \{[^}]*\}/)?.[0] ?? "";
    expect(windowControlsLastButtonBlock).toContain("margin-inline-end: var(--space-1);");
    expect(components).toContain(".operations-canvas.is-glance .canvas-operation-glance-hud {");
    expect(components).not.toContain(".canvas-triage-rail-arm {");
    expect(components).toContain(".canvas-operation-glance-hud-arm {");
    // 무장 안내는 Alt 홀드와 무관하게 떠 있어야 한다 — 확인 기한이 1.5초뿐이다.
    expect(components).toContain(".canvas-operation-glance-hud.is-armed-set-aside {");
    expect(components).toContain("/* 두 번 눌러 확정 중인 위험 상태만 coral 채널을 쓰며");
    // armed-close는 hover 전개 규칙(0-4-0)과 같은 특이도의 후순위여야 Close? 라벨이 잘리지 않는다.
    expect(components).toContain(".canvas-operation .canvas-operation-window-controls .canvas-operation-icon-button.is-armed-close {");
    // Formation(y=0 슬롯)과 일반 맵 뷰의 뷰포트-상대 상단 밀착 패널은 명판을 내부 인셋으로 전환한다.
    expect(components).toContain(".operations-canvas.is-formation-view .canvas-operation-titlebar,");
    expect(components).toContain(".canvas-operation.is-top-edge .canvas-operation-titlebar {");
    expect(source("canvas/canvas.tsx")).toContain("TITLEBAR_OUTSET_PX * effectiveZoom");
    expect(source("canvas/operation-frame.tsx")).not.toContain('className="canvas-operation-cli"');
    expect(components).toContain(".canvas-operation-beacon-button {");
    expect(components).toContain("border: 1px solid var(--surface-rim);");
    expect(components).toContain("right: var(--space-3);");
    expect(components).toContain("name → beacon → collapsed controls");
    const canvas = source("canvas/canvas.tsx");
    expect(canvas).toContain("export function useGlanceHold(): boolean");
    expect(canvas).toContain('event.code === "AltLeft" || event.code === "AltRight"');
    expect(canvas).toContain("event.ctrlKey || event.metaKey");
    expect(canvas).toContain("isBlockingDialogOpen()");
    expect(canvas).toContain('glanceVisible ? "is-glance" : ""');
    expect(canvas).toContain('window.addEventListener("blur", clearGlance)');
    expect(canvas).toContain('document.addEventListener("visibilitychange", handleVisibilityChange)');
    expect(source("styles/layout.css")).toContain(".command-band-operation-kind { display: flex; align-items: center; line-height: 0; }");
    expect(source("styles/layout.css")).toContain("background: color-mix(in oklch, var(--ink-fog) 10%, transparent);");
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
    expect(selectBlock).toMatch(/\.reduce-panel-motion \.fc-select__trigger,\s*\.reduce-panel-motion \.fc-select__caret,\s*\.reduce-panel-motion \.fc-select__popup,\s*\.reduce-panel-motion \.fc-select__option \{\s*transition: none;\s*\}/);
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
});
