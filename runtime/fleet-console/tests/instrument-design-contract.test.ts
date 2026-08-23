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
const TERMINAL_CHAT_COMPOSER_PATH = new URL("../../fleet-plugins/terminal/client/agent/chat/composer.tsx", import.meta.url);
const TERMINAL_CHAT_CSS_PATH = new URL("../../fleet-plugins/terminal/client/agent/chat/chat.css", import.meta.url);
const QUOTA_CSS_PATH = new URL("../../fleet-plugins/quota/client/quota.css", import.meta.url);
const QUOTA_PANEL_PATH = new URL("../../fleet-plugins/quota/client/rail-panel.tsx", import.meta.url);
const SDK_RAIL_TYPES_PATH = new URL("../sdk/rail/types.ts", import.meta.url);
const SDK_CAPTION_ACTIONS_PATH = new URL("../sdk/components/caption-actions.tsx", import.meta.url);
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
] as const;

const FORBIDDEN_DECORATION = /radar-sweep|operations-radar|BACKGROUND_ANIMATION_STORAGE_KEY|PERIMETER_ANIMATION_STORAGE_KEY|Panel pulse|perimeter-orbit|notification-wake-pulse|AnchorIcon/;
// 활자 사다리의 최대 단은 --t-xl(22px)이다. 그 위는 브랜드 워드마크·빈 상태 일러스트처럼
// 소비처가 한 곳뿐이고 서로 다른 이유로 존재하는 디스플레이 크기라 사다리 밖에 둔다.
const DISPLAY_SIZE_FLOOR_PX = 24;
// 스켈레톤은 C≈0.012~0.02의 저채도 대역에 산다. 그 위의 유채색은 theme.css에서만 정의된다.
const ACHROMATIC_CHROMA_CEILING = 0.03;
// sRGB 표기(hex·rgb)에서 같은 경계 — 세 채널의 폭이 이보다 좁으면 색이 아니라 깊이를 나른다.
const ACHROMATIC_CHANNEL_SPREAD = 12;
// hsl 표기는 채도를 직접 적으므로 그 값으로 같은 경계를 판정한다.
const ACHROMATIC_SATURATION_CEILING_PERCENT = 10;
// rem은 root 기준이고 이 셸은 root 크기를 재정의하지 않으므로 브라우저 기본값이 환산 기준이다.
const ROOT_FONT_SIZE_PX = 16;
// 색을 싣는 속성만 검사한다 — font-family 등에 낱말이 스쳐도 색 리터럴이 아니다.
const COLOR_BEARING_PROPERTY_PATTERN =
  "color|background|background-color|border-color|border|outline-color|outline|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|column-rule-color";
// CSS 명명색 전체 집합. 손으로 고른 일부만 적으면 빠뜨린 낱말(chartreuse·cornflowerblue…)이
// 그대로 통과해 게이트가 지키는 척만 한다 — 목록은 전수여야 판정에 쓸 수 있다.
const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
  "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
  "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
  "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
]);
// 세 채널이 같은(또는 거의 같은) 명명색은 깊이 리터럴과 같은 이유로 통과시킨다.
const ACHROMATIC_NAMED_COLORS = new Set([
  "black", "white", "gray", "grey", "darkgray", "darkgrey", "dimgray", "dimgrey",
  "lightgray", "lightgrey", "silver", "gainsboro", "whitesmoke", "snow",
]);
// font-size가 텍스트가 아니라 도형을 재는 자리들 — 글리프 문자('×' '✦' '↻' 꺾쇠)의 크기이거나,
// 치수가 박힌 상자(아바타·숫자 배지·이니셜 마크) 안이라 사다리로 올리면 넘치거나 잘린다.
const RAW_FONT_SIZE_EXEMPT_SELECTORS = [
  ".add-host-close",
  ".pair-close",
  ".settings-disclosure-toggle::after",
  ".canvas-shortcuts-or",
  ".thought-chevron",
  ".tool-chip-glyph",
  ".timeline-chevron",
  ".effort-track-fill::after",
  ".effort-track-fill::before",
  ".app-toast-close",
  ".directory-browser-close",
  ".directory-browser-sector-advance",
  ".whatsnew-close",
  ".skills-overlay-close",
  ".quick-launch-mark",
  ".alerts-icon-badge",
  ".fexp-refresh-btn",
  ".history-commit-avatar",
  ".session-analyst__receipt-chev",
  ".session-analyst__ev",
  ".agent-chat-fold-chev",
] as const;
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
  // Chat context popover TSX injects the category-stack luminance step (0–5).
  "--agent-chat-ctx-step",
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

// 깊이 리터럴은 채널이 서로 같다(검정·흰색 계열). 색을 띠기 시작하면 채널이 갈라지므로,
// 세 채널의 최대-최소 폭으로 무채색 여부를 가른다 — oklch의 chroma 상한과 같은 역할이다.
function isAchromaticChannels(channels: number[]): boolean {
  if (channels.length < 3 || channels.some((value) => !Number.isFinite(value))) return false;
  const [red, green, blue] = channels as [number, number, number];
  return Math.max(red, green, blue) - Math.min(red, green, blue) <= ACHROMATIC_CHANNEL_SPREAD;
}

function isAchromaticHex(digits: string): boolean {
  const expand = (value: string) => Number.parseInt(value.length === 1 ? value.repeat(2) : value, 16);
  if (digits.length === 3 || digits.length === 4) {
    return isAchromaticChannels([...digits.slice(0, 3)].map(expand));
  }
  if (digits.length === 6 || digits.length === 8) {
    return isAchromaticChannels([0, 2, 4].map((offset) => expand(digits.slice(offset, offset + 2))));
  }
  return false;
}

function isAchromaticRgb(args: string): boolean {
  const channels = args
    .split("/", 1)[0]!
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .slice(0, 3)
    .map((token) => (token.endsWith("%") ? (Number.parseFloat(token) * 255) / 100 : Number.parseFloat(token)));
  return isAchromaticChannels(channels);
}

function isAchromaticHsl(args: string): boolean {
  const saturation = args
    .split("/", 1)[0]!
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)[1];
  if (saturation === undefined) return false;
  const value = Number.parseFloat(saturation);
  return Number.isFinite(value) && value <= ACHROMATIC_SATURATION_CEILING_PERCENT;
}

// 선언이 속한 규칙의 선택자. 예외를 파일:줄로 적으면 그 위에 한 줄만 들어와도 조용히 빗나가므로,
// 무엇을 면제했는지가 이름으로 남는 선택자를 기준으로 삼는다.
function selectorAt(masked: string, index: number): string {
  const blockStart = masked.lastIndexOf("{", index);
  if (blockStart === -1) return "";
  const selectorStart = Math.max(masked.lastIndexOf("}", blockStart), masked.lastIndexOf("{", blockStart - 1)) + 1;
  return masked.slice(selectorStart, blockStart).trim();
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

  it("keeps one control grammar on the caption band", () => {
    const components = source("styles/components.css");
    const frame = source("canvas/operation-frame.tsx");
    const shelf = externalSource(SDK_CAPTION_ACTIONS_PATH);

    // 마크 버튼은 창 컨트롤과 한 선택자에서 규칙을 받는다 — 밴드 하나가 두 벌의 격자를 갖지 않게.
    const grid = components.match(/\.canvas-operation-icon-button,\n\.fleet-caption-action \{[^}]*\}/)?.[0]
      ?? components.match(/\.fleet-caption-action \{[^}]*\}/)?.[0] ?? "";
    expect(grid).toContain("width: 24px;");
    expect(grid).toContain("height: 24px;");
    const svgSize = components.match(/\.canvas-operation-icon-button svg,\n\.fleet-caption-action svg \{[^}]*\}/)?.[0] ?? "";
    expect(svgSize).toContain("width: 14px;");

    // 위치 채널은 oklab으로만 섞는다 — oklch의 hue 호가 brass를 초록·자홍에 내려놓았다(실측).
    const pressed = components.match(/\.canvas-operation-icon-button\.is-active,\n\.fleet-caption-action\[aria-pressed="true"\] \{[^}]*\}/)?.[0] ?? "";
    expect(pressed).toContain("color-mix(in oklab, var(--brass) 60%, var(--surface-rim))");
    expect(pressed).toContain("color-mix(in oklab, var(--brass) 22%, var(--surface-glass))");
    expect(pressed).not.toContain("color-mix(in oklch, var(--brass) 60%");
    const hover = components.match(/\.canvas-operation-icon-button:hover,[\s\S]{0,200}?\.fleet-caption-action:focus-visible \{[^}]*\}/)?.[0] ?? "";
    expect(hover).toContain("color-mix(in oklab, var(--brass) 45%, var(--surface-rim))");

    // 진행은 aurora(상태)로, 위치는 brass로 — 한 버튼 위에서도 두 채널이 겹치지 않는다.
    const live = components.match(/\.fleet-caption-action-live \{[^}]*\}/)?.[0] ?? "";
    expect(live).toContain("background: var(--aurora);");
    expect(live).not.toContain("--brass");

    // 라벨 없는 마크가 서는 줄이므로 이름표는 전부 같은 말풍선이다 — 브라우저 기본 title은 쓰지 않는다.
    expect(shelf).toContain('className="fleet-caption-slot"');
    expect(shelf).toContain('className="fleet-caption-tip"');
    expect(frame).toContain("<CaptionTipHost label={t(\"canvas.frame.openMenuTitle\")}>");
    expect(frame).not.toMatch(/canvas-operation-icon-button[\s\S]{0,400}?title=\{t\(/);
    const tip = components.match(/\.fleet-caption-tip \{[^}]*\}/)?.[0] ?? "";
    expect(tip).toContain("right: 0;");
    expect(tip).toContain("pointer-events: none;");

    // 이름표는 겨누는 동안만 뜬다 — 클릭이 남긴 포커스로 열면 눌러도 그 자리에 남는 버튼(최대화)에서
    // 풍선이 붙박이가 된다. 키보드로 짚어 온 포커스만 겨눔으로 친다.
    const tipReveal = components.match(/\.fleet-caption-slot:hover \.fleet-caption-tip,\n[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(tipReveal).toContain(":has(:focus-visible)");
    expect(tipReveal).not.toContain(":focus-within");

    // 폭을 아는 것은 밴드다 — 뜻이 사라지는 컨트롤은 캡션 컨테이너 질의로 물러난다.
    const titlebar = components.match(/^\.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(titlebar).toContain("container-type: inline-size;");
    expect(components).toMatch(/@container \(max-width: 721px\) \{[\s\S]{0,300}?data-caption-action="reading-width"/);
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
    expect(rightRail).toContain("[theaterId, theaterLabel, api, language, theme, onLaunchOperation]");
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

  it("keeps the Map canvas out of the keyboard focus order", () => {
    const canvas = source("canvas/canvas.tsx");
    const theme = source("styles/theme.css");
    // tabindex=-1이면 채팅 로그처럼 포커스 불가한 본문을 누른 뒤 Enter가 바다에 brass 링을 남긴다.
    expect(canvas).not.toContain("tabIndex={-1}");
    expect(canvas).not.toContain("canvasRef.current?.focus()");
    expect(theme).toContain("body:focus-visible,");
    expect(theme).toContain("html:focus-visible {");
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
    // 캡션은 순번을 싣지 않는다 — 번호는 빈 자리를 가리키는 가이드만 진다.
    expect(components).not.toContain(".canvas-operation-formation-slot {");
    expect(contextMenu).not.toContain("canvas-context-menu-head");
    expect(contextMenu).not.toContain('canvas.menu.etc');
    expect(contextMenu).not.toContain("operation-launch-provider-glyph--etc");
    // 그룹 머리글은 캔버스 메뉴 전체에서 한 클래스뿐이다.
    expect(contextMenu).not.toContain("canvas-context-menu-plugin");
    expect(components).not.toContain(".canvas-context-menu-plugin");
    expect(contextMenu).not.toContain("CanvasContextMenuMode");
    expect(contextMenu).not.toContain("canvas-context-menu-tabs");
    expect(contextMenu).not.toContain("Formation view");
    expect(contextMenu).not.toContain("ResetGlyph");
    expect(contextMenu).not.toContain("onToggleRadar");
    expect(contextMenu).not.toContain("onTogglePerimeter");
  });

  it("keeps backdrop blur on the liquid glass channels without deprecated accent variables", () => {
    const css = OWNED_SOURCES.filter((path) => path.endsWith(".css")).map(source).join("\n");
    expect(css).not.toMatch(/--op-accent|--chip-accent/);
    // 리퀴드 글래스 계약: backdrop-filter는 theme.css의 glass 채널(var(--glass-backdrop-*))만
    // 소비한다. raw blur를 표면에 직접 들면 세 게이트(@supports 미달·prefers-reduced-transparency·
    // 설정 data-glass="off")가 그 표면을 놓쳐 불투명 폴백 계약이 깨진다.
    const backdropDeclarations = css.match(/(?:-webkit-)?backdrop-filter:[^;\n]*;/g) ?? [];
    expect(backdropDeclarations.length).toBeGreaterThan(0);
    for (const declaration of backdropDeclarations) {
      expect(declaration).toMatch(/^(?:-webkit-)?backdrop-filter: var\(--glass-backdrop-(?:strong|soft|scrim)\);$/);
    }
    // 게이트와 폴백 기본값은 theme.css에 존재해야 한다 — 채널 기본값이 곧 구 불투명 계약이다.
    const theme = source("styles/theme.css");
    expect(theme).toContain("--glass-underlay: var(--ink-deep);");
    expect(theme).toContain(':root:not([data-glass="off"])');
    expect(theme).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(theme).toMatch(/@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
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

  // 굵기를 3티어로 묶어 놓고 크기를 raw px로 열어 두면, 표면마다 자기 스케일을 발명해 같은
  // 역할이 화면마다 다른 크기로 선다(실측 32종·반픽셀 151회, 같은 Rail 슬롯 본문이 10.5~13px).
  // 사다리 최대가 22px이므로 24px 이상은 디스플레이 영역으로 사다리 밖에 둔다.
  it("keeps product font size on the type-scale token ladder", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskFontFaceBlocks(css);
      const record = (index: number, value: string) => {
        const line = lineAt(css, index);
        const selector = selectorAt(masked, index);
        if (RAW_FONT_SIZE_EXEMPT_SELECTORS.some((exempt) => selector.includes(exempt))) return;
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      };
      // 단위는 px 하나가 아니다 — rem은 root 기준의 절대값이라 px와 등가이고, 그대로 두면 한
      // 플러그인만 다른 단위 체계에 남는다. em/%/ch는 부모 상대라는 다른 축이므로 사다리가
      // 관여하지 않고, 계산 함수는 그 안의 px만 본다.
      const offLadder = (value: string): boolean => {
        if (/var\(\s*--t-(?:2xs|xs|sm|md|base|lg|xl)\s*\)/.test(value)) return false;
        if (/var\(\s*--font-body-size\s*\)/.test(value)) return false;
        // Codex 서브앱이 자기 --font-size-* 스케일을 갖고 있고, 공유 마크다운과 코어 일부가
        // 그 토큰을 함께 소비한다(총 113곳). 두 어휘를 합칠지는 이 사다리와 별개의 결정이라
        // 아직 내려지지 않았으므로 여기 이름으로 적어 둔다 — 조용한 통과가 아니라 선언된
        // 미결 사항으로 남기고, 합치기로 하면 이 한 줄이 사라진다.
        if (/var\(\s*--font-size-[a-z0-9-]+\s*\)/.test(value)) return false;
        // 그 밖의 커스텀 프로퍼티는 새 어휘를 여는 통로다 — 별칭 하나가 자기 스케일을 열면
        // 사다리는 이름만 남는다. 값을 읽을 수 없으므로 참조 자체를 거부한다.
        if (/var\(\s*--/.test(value)) return true;
        // 절대 크기가 하나라도 적혀 있으면 그 값이 판정을 진다. 상대 단위가 섞인 계산 함수
        // (clamp(11px, 2vw, 15px))를 상대 축으로 놓아 주면 그 안의 절대 하한이 게이트를 빠져나간다.
        const sizes = [...value.matchAll(/([0-9.]+)(px|rem)\b/g)].map(([, amount, unit]) =>
          unit === "rem" ? Number(amount) * ROOT_FONT_SIZE_PX : Number(amount),
        );
        // 절대 크기가 없으면 부모 상대(em·%·ch) 축이다 — 사다리가 관여하지 않는다.
        if (sizes.length === 0) return false;
        return Math.min(...sizes) < DISPLAY_SIZE_FLOOR_PX;
      };
      for (const declaration of cssDeclarations(masked, "font-size")) {
        if (offLadder(declaration.value)) record(declaration.index, declaration.value);
      }
      // font 단축 표기도 같은 축이다 — 여기로 새면 게이트가 절반만 지킨다.
      for (const declaration of cssDeclarations(masked, "font")) {
        if (offLadder(declaration.value.split("/", 1)[0]!)) record(declaration.index, declaration.value);
      }
    }
    expect(violations).toEqual([]);
  });

  // 라운드 어휘는 xs·md·pill 셋뿐이다. raw 999px가 살아 있으면 같은 캡슐을 두 이름으로 부르게 되고,
  // 퇴역한 sm·lg·xl이 되살아나면 이름이 다시 값보다 많아진다.
  it("keeps border radius on the three-name vocabulary", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      for (const declaration of cssDeclarations(masked, "border-radius")) {
        if (!/999px|--radius-(?:sm|lg|xl)\b/.test(declaration.value)) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
      for (const match of masked.matchAll(/var\(\s*--radius-(?:sm|lg|xl)\b/g)) {
        violations.push(`${consoleRelativePath(file)}:${lineAt(css, match.index)} retired radius token`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 유채색 raw 리터럴은 두 규칙을 한 번에 깬다 — 스켈레톤의 채도 봉투를 넘고, 테마별 재조율을 받지 못한다.
  // 깊이를 나르는 근사 무채색(그림자·스크림·시트)은 console CLAUDE.md가 명시한 예외라 통과시킨다.
  // 문법은 oklch 하나가 아니다 — hex·rgb·hsl로 적은 유채색도 같은 두 규칙을 깨므로 함께 막고,
  // 채널을 해석할 수 없는 함수형(color()/lab()/lch())은 통과시키지 않는다.
  it("keeps chromatic color literals inside theme.css", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      if (CSS_THEME_SOURCES.some((theme) => fileURLToPath(theme) === file)) continue;
      // markdown/styles.css는 vendored highlight.js 팔레트(github-dark ↔ github) 전체가 파일 상단
      // doctrine 주석으로 예외 선언된 표면이다. 신택스 역할색은 --syntax-* 채널이 따로 지고 있다.
      if (file === fileURLToPath(new URL("markdown/styles.css", CONSOLE_ROOT))) continue;
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      const report = (index: number, snippet: string) => {
        violations.push(`${consoleRelativePath(file)}:${lineAt(css, index)} ${snippet}`);
      };
      for (const match of masked.matchAll(/oklch\(\s*[0-9.]+%?\s+([0-9.]+)\s/g)) {
        if (Number(match[1]) < ACHROMATIC_CHROMA_CEILING) continue;
        report(match.index, match[0].trim());
      }
      for (const match of masked.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
        if (isAchromaticHex(match[1]!)) continue;
        report(match.index, match[0]);
      }
      for (const match of masked.matchAll(/\brgba?\(([^)]*)\)/g)) {
        if (isAchromaticRgb(match[1]!)) continue;
        report(match.index, match[0]);
      }
      for (const match of masked.matchAll(/\bhsla?\(([^)]*)\)/g)) {
        if (isAchromaticHsl(match[1]!)) continue;
        report(match.index, match[0]);
      }
      for (const match of masked.matchAll(/\b(?:color|lab|lch|hwb)\(/g)) {
        report(match.index, match[0]);
      }
      // 명명색도 리터럴이다. 단 토큰 이름 자체가 색 낱말을 품고 있으므로(--coral·--id-plum·
      // --id-teal), var() 참조를 먼저 지운 값에서만 낱말을 찾는다 — 지우지 않으면 정상 토큰
      // 소비가 통째로 위반으로 잡힌다.
      for (const declaration of cssDeclarations(masked, COLOR_BEARING_PROPERTY_PATTERN)) {
        const stripped = declaration.value.replace(/var\(\s*--[A-Za-z0-9_-]+/g, " ");
        for (const word of stripped.matchAll(/[A-Za-z]{3,}/g)) {
          const name = word[0]!.toLowerCase();
          if (!CSS_NAMED_COLORS.has(name) || ACHROMATIC_NAMED_COLORS.has(name)) continue;
          report(declaration.index, name);
          break;
        }
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
      // 대체값을 함께 적은 참조는 이 게이트가 막으려는 위험이 아니다 — 정의가 없으면 조용히 상속되는 게
      // 아니라 적어 둔 값으로 떨어진다. 호출부가 채우는 훅(--fc-select-compact-tone)과 다른 시트가 여는
      // 채널(--effort-tone)이 이 형태를 쓴다.
      const reference = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g;
      let match: RegExpExecArray | null;
      while ((match = reference.exec(masked)) !== null) {
        const name = match[1]!;
        if (match[2] === ",") continue;
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

  it("pins the Shell caption Theater label — neutral meta, no colour mark, yields before the title", () => {
    const frame = source("canvas/operation-frame.tsx");
    const canvas = source("canvas/canvas.tsx");
    const components = source("styles/components.css");
    const labelBlock = components.match(/\.canvas-operation-theater-label \{[^}]*\}/)?.[0] ?? "";

    expect(canvas).toContain("operation.type === \"shell\"");
    expect(frame).toContain('className="canvas-operation-theater-label"');
    expect(labelBlock).not.toMatch(/border|background/);
    expect(labelBlock).toContain("color: var(--text-tertiary);");
    expect(labelBlock).toContain("flex: 0 8 auto;");
    expect(labelBlock).toContain("max-width: min(40%, 18ch);");
    expect(labelBlock).toContain("min-width: 0;");
    expect(labelBlock).toContain("text-overflow: ellipsis;");
    expect(labelBlock).not.toMatch(/animation/);
    expect(components).toMatch(/\.canvas-operation\.is-active > \.canvas-operation-titlebar \.canvas-operation-theater-label \{\s*color: var\(--text-secondary\);/);
    const reducedMotion = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".canvas-operation-theater-label,");
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
    // 공급자 마크는 실행 표면(검색·Quick Launch·실행 메뉴)에만 남는다 — 사이드바 칩·커맨드 밴드의
    // 이름 왼쪽 슬롯은 활동 상태가 가져갔다. 남은 표면이 각자 톤을 적으면 한 곳만 고쳐도 컴파일은
    // 되고 같은 Operation이 두 색으로 보인다 — 대조표는 .operation-provider-mark 한 곳에만 있어야
    // 하고, 표면 클래스는 치수만 소유한다.
    const css = source("styles/components.css");
    for (const provider of ["antigravity", "claude", "codex", "cursor", "kimi", "opencode", "xai"]) {
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

    // 남은 표면은 공용 마크 클래스를 통해 톤을 받는다 — 자기 색을 적으면 대조표가 갈라진다.
    expect(source("components/operation-search.tsx")).toContain("operation-provider-mark is-${entry.launchProvider}");
    // 목록 표면은 공급자를 세지 않는다 — 그 자리는 활동 상태가 소유한다.
    expect(source("sidebar/operations-side-bar-chip.tsx")).not.toContain("operation-provider-mark");
    expect(source("components/command-band.tsx")).not.toContain("operation-provider-mark");
  });

  it("pins the provider tone table as one axis — every gateway provider named on both surfaces", () => {
    // 공급자 색 대조표는 --provider-* 축 하나다. 표에서 빠진 공급자는 컴파일도 렌더도 실패하지
    // 않고 조용히 회색으로 떨어지며, AI Gateway 칩의 경우 톤이 미정의라 color-mix()가 통째로
    // 무효화되어 테두리·배경까지 사라진다 — 같은 공급자가 두 화면에서 다른 마크로 읽힌다.
    const providers = ["antigravity", "codex", "cursor", "kimi", "opencode", "xai"] as const;
    const theme = source("styles/theme.css");
    for (const provider of providers) {
      expect(theme).toMatch(new RegExp(`--provider-${provider}: oklch\\(`));
    }

    const gatewayCss = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    for (const provider of providers) {
      expect(gatewayCss).toContain(
        `.ai-gateway-provider.is-${provider} { --ai-gateway-provider-tone: var(--provider-${provider}); }`,
      );
    }
    // 톤은 --provider-* 말고 다른 축에서 빌려오지 않는다 — --id-*를 빌리면 같은 공급자가
    // Quota 레일과 다른 색으로 불린다.
    for (const [, body] of gatewayCss.matchAll(/\.ai-gateway-provider\.is-[a-z]+ \{([^}]*)\}/g)) {
      expect(body).toMatch(/var\(--provider-[a-z]+\)/);
    }

    // Quota 레일은 Claude Code까지 세므로 한 공급자가 더 많다.
    const quotaCss = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");
    for (const provider of [...providers, "claude"]) {
      expect(quotaCss).toContain(`.quota-provider__mark--${provider} {\n  color: var(--provider-${provider});\n}`);
    }
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
    expect(fill).toContain("background: color-mix(in oklab, var(--meter-accent) var(--meter-weight), transparent);");
    // 심각도는 색상과 무게를 함께 탄다 — 종이 위에서 명도는 무게의 반대라 색상만 갈면
    // 평상 막대가 위험 막대보다 무거워진다. 세 단이 모두 무게를 집어야 사다리가 성립한다.
    expect(meterBase).toContain("--meter-weight: var(--gauge-weight-quiet);");
    expect(css).toMatch(/\.quota-meter--warning \{[^}]*--meter-weight: var\(--gauge-weight-warn\);/);
    expect(css).toMatch(/\.quota-meter--critical \{[^}]*--meter-weight: var\(--gauge-weight-critical\);/);

    // (b) 예측은 아직 쓰지 않은 몫이다 — 단색으로 칠하는 순간 이미 쓴 양으로 읽힌다.
    const projection = css.match(/\.quota-meter__projection \{[^}]*\}/)?.[0] ?? "";
    expect(projection).toContain("repeating-linear-gradient(");
    expect(projection).not.toMatch(/background:\s*var\(--meter-accent\)/);
    // 빗금은 채움의 분수로 따라간다 — 고정 42%로 두면 채움이 가벼워진 테마에서 "아직 안 쓴 몫"이
    // "이미 쓴 몫"보다 무거워져 막대가 정반대를 말한다.
    expect(projection).toContain("calc(var(--meter-weight) * 0.42)");

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
    const caption = components.match(/\.side-bar-status-header \{[^}]*\}/)?.[0] ?? "";
    const captionToggle = components.match(/\.side-bar-status-header__toggle \{[^}]*\}/)?.[0] ?? "";

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
    expect(caption).toContain("background: transparent;");
    expect(captionToggle).toContain("border-left: 3px solid var(--status-color);");
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
    const idleArrival = source("operation-marks.ts");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const components = source("styles/components.css");
    const theme = source("styles/theme.css");
    const activity = source("operation-activity.ts");
    const commandBand = source("components/command-band.tsx");
    const watchDeck = source("canvas/triage-watch-deck.tsx");

    expect(operations).toContain('event.code === "KeyS" && !event.shiftKey');
    expect(operations).toContain("toggleSideBarStatusAxis();");
    // 축 스위치는 사이드바에 하나만 선다 — Theater 행에 되돌리면 배치가 스코프를 속인다.
    expect(sidebar).not.toContain('className="side-bar-status-axis-toggle"');
    expect(sidebar).toContain('className="operations-side-bar-axis"');
    expect(sidebar).toContain('data-sidebar-axis={statusAxis ? "status" : "group"}');
    expect(sidebar).toContain('title={t("sidebar.theater.sortByStatusTitle")}');
    expect(sidebar).toContain("groupTheaterStatusEntries(");
    expect(sidebar).toContain("minimizedIds.has(entry.operation.id) && !dormantIds.has(entry.operation.id)");
    expect(sidebar).toContain("<StatusRecoveryShelves");
    expect(sidebar).not.toContain("triage-side-bar-caption");
    expect(components).not.toContain(".triage-side-bar-caption");
    expect(components).toContain(".side-bar-status-section--minimized {");
    expect(sidebar).toContain("trackOperationActivityTransitions({");
    expect(sidebar).toContain("const landedIds = consumeStatusLandings();");
    expect(sidebar).not.toContain("recordStatusTransitions(movedIds);");
    expect(app).toContain("useEffect(() => subscribeOperationActivityTracking(), []);");
    expect(sidebar).toContain("if (!statusAxis) {");
    expect(chip).toContain("reorderEnabled && event.altKey && event.shiftKey");
    // 미확인 도착은 상태 마크와 같은 사실이다(idle + idleArrival = 표시 활동 AWAITING). 칩은 그 사실을
    // 마크 하나로만 말한다 — 우측 점·행 틴트·헤더 카운트 배지는 같은 화면에서의 중복 발화였다.
    expect(chip).not.toContain("side-bar-chip-unseen");
    expect(chip).not.toContain("idleUnseen");
    expect(sidebar).not.toContain("idleUnseen");
    expect(sidebar).not.toContain("side-bar-status-header__unseen");
    // 그룹축·복구 선반이 raw idle을 그리면 도착한 Operation이 축마다 다른 상태를 말한다 — 그래서
    // 모든 사이드바 표면이 마크 축을 읽는다(아래 마크/섹션 계약이 그 배선을 고정한다).
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

    // Doctrine: status-section border/count are signal-owned, while the chip group mark
    // consumes only resolveAccentColor identity values and never repaints the status beacon.
    // The group header does not repeat the rounded activity mark; chips and panels already do.
    expect(sidebar).toContain("groupMarkByGroupId.get(entry.operation.groupId)");
    expect(components).toContain(".tenant-beacon.is-awaiting,\n.canvas-triage-map-dot.is-awaiting,\n.side-bar-status-section--awaiting {");
    // 미확인 완료는 유휴와 같은 --positive를 받는다 — 색은 "끝난 일"을 말하고, 미확인은 모션이 말한다.
    expect(components).toMatch(/\.tenant-beacon\.is-idle,\s*\.tenant-beacon\.is-unseen,\s*\.canvas-triage-map-dot\.is-idle,\s*\.canvas-triage-map-dot\.is-unseen,\s*\.side-bar-status-section--idle\s*\{[^}]*--activity-color:\s*var\(--positive\)/);
    expect(components).toContain(".tenant-beacon.is-ended,\n.canvas-triage-map-dot.is-ended,\n.side-bar-status-section--ended {");
    expect(components).toContain("--activity-color: var(--ink-fog);");
    expect(components).toMatch(/\.tenant-beacon\.is-background,\s*\.canvas-triage-map-dot\.is-background\s*\{[^}]*--activity-color:\s*var\(--warn\)/);
    expect(components).toMatch(/\.canvas-triage-map-dot \{[^}]*background:\s*var\(--activity-color\)/);
    // War Room 덱은 자기 상태 축을 갖지 않는다 — 칸에 선 것이 패널이라 캡션 비콘이 이 선언을 그대로 받는다.
    expect(components).not.toContain(".canvas-triage-deck-card");
    expect(components).toMatch(/\.canvas-triage-map-dot\.is-background \{[^}]*background:\s*none;[^}]*border-color:\s*var\(--activity-color\)/);
    expect(components).toContain("--status-color: var(--activity-color);");
    expect(components).toContain("border-left: 3px solid var(--status-color);");
    expect(components).not.toMatch(/\.side-bar-status-section \{[^}]*border-left:\s*3px solid var\(--status-color\)/);
    expect(components).toMatch(/\.side-bar-status-header__toggle \{[^}]*border-left:\s*3px solid var\(--status-color\)/);
    expect(components).not.toContain(".side-bar-status-section--background");
    expect(sidebar).not.toContain("side-bar-status-header__dot");
    expect(components).not.toContain(".side-bar-status-header__dot");
    expect(components).toContain("background: var(--group-mark);");
    // 세 단계 아코디언(Theater / Group / Status)은 + / … 액션과 같은 보더 링으로 hover에
    // 응답한다. 화살표 색만 바꾸면 포인터 아래 표면의 버튼 경계가 드러나지 않는다.
    const theaterActivate = components.match(/\.side-bar-theater-activate \{[^}]*\}/)?.[0] ?? "";
    const theaterDraggingActivate = components.match(/\.side-bar-theater-header--dragging \.side-bar-theater-activate \{[^}]*\}/)?.[0] ?? "";
    const theaterChevronHover = components.match(/\.side-bar-theater-header\.is-active \.side-bar-theater-activate:hover \.side-bar-theater-chevron,[\s\S]*?\}/)?.[0] ?? "";
    const sharedIconHover = components.match(/\.side-bar-theater-row-btn:hover,[\s\S]*?\.side-bar-group-header__toggle:focus-visible \{[^}]*\}/)?.[0] ?? "";
    const statusToggleHover = components.match(/\.side-bar-status-header__toggle:hover \{[^}]*\}/)?.[0] ?? "";
    expect(theaterActivate).toContain("cursor: pointer;");
    expect(theaterActivate).not.toContain("cursor: inherit;");
    expect(theaterDraggingActivate).toContain("cursor: grabbing;");
    expect(theaterChevronHover).toContain("border-color: var(--hairline-strong);");
    expect(sharedIconHover).toContain("border-color: var(--hairline-strong);");
    expect(components).toMatch(/\.side-bar-group-header__toggle:focus-visible \{\s*outline: 2px solid var\(--brass\);/);
    expect(statusToggleHover).toContain("border-color: var(--hairline-strong);");
    expect(statusToggleHover).toContain("border-left-color: var(--status-color);");
    expect(statusToggleHover).not.toContain("--brass");
    expect(components).toMatch(/\.side-bar-status-header__toggle:focus-visible \{[^}]*outline: 2px solid var\(--brass\);/);
    // 사이드바에는 미확인 도착 전용 표면이 없다 — 상태 마크가 그 사실을 혼자 나른다.
    expect(components).not.toContain(".side-bar-chip-unseen");
    expect(components).not.toContain(".side-bar-chip--unseen");
    expect(components).not.toContain(".side-bar-status-header__unseen");
    // 마크 축은 진짜 대기(aurora 1.8s 호출 맥동)와 미확인 완료(positive 3.6s 느린 점등)를 갈라 그린다.
    // 두 사실이 한 색이면 화면은 "사람을 기다리는 중"과 "안 본 채 끝난 것"을 구별해 주지 못한다.
    expect(components).toMatch(/\.tenant-beacon\.is-unseen \{[^}]*background:\s*var\(--activity-color\);[^}]*box-shadow:\s*0 0 10px 1px var\(--activity-glow\);\s*animation:\s*beacon-unseen-blink 3\.6s/);
    expect(components).toMatch(/\.tenant-beacon\.is-awaiting \{[^}]*animation:\s*aurora-pulse 1\.8s/);
    // 키프레임은 --activity-glow가 사는 이 파일에 있어야 하고, 0%/100%가 완전 점등이어야 한다 —
    // reduced-motion이 iteration-count를 1로 자를 때 꺼진 채 남으면 신호가 사라진다.
    expect(components).toMatch(/@keyframes beacon-unseen-blink \{\s*0%,\s*100% \{\s*opacity: 1;/);
    expect(theme).not.toContain("@keyframes beacon-unseen-blink");
    // 지도 점은 유영 애니메이션이 점 자체를 소유하므로 느린 점등을 ::after 후광에 싣는다.
    expect(components).toMatch(/\.canvas-triage-map-dot\.is-unseen::after \{[^}]*animation:\s*beacon-unseen-blink 3\.6s/);
    expect(components).toMatch(/\.canvas-triage-map-dot\.is-unseen\.is-deferred::after \{[^}]*animation:\s*none/);
    // 마크 축과 섹션 축은 갈라진 채로 각자의 자리에 실린다 — 하나로 합치면 색이 칸을 따라간다.
    expect(activity).toContain('return activity === "idle" && idleArrivalIds.has(operationId) ? "unseen" : activity;');
    expect(activity).toContain('return activity === "idle" && idleArrivalIds.has(operationId) ? "awaiting" : activity;');
    // 생성 지점은 raw 활동과 마크만 싣는다 — 섹션 승격을 여기서도 해 두면 groupOperationsByStatus가
    // 같은 계산을 다시 해 값이 겹치고, 겹친 값은 어느 표면에도 드러나지 않아 틀려도 아무 테스트가 죽지 않는다.
    expect(sidebar).toContain("mark: resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds }),");
    expect(sidebar).toContain("      status: activity,");
    expect(sidebar).not.toContain("status: resolveOperationDisplayActivity({");
    expect(chip).toContain("const markVisual = mark ?? status;");
    expect(commandBand).toContain("status={resolveOperationMarkVisual({");
    expect(watchDeck).toContain("const visual = operationMarkVisual(resolveOperationMarkVisual({");
    // 미확인 완료는 패널 아웃라인이 아니라 캡션 아랫변 레일이 나른다 — 상시 aura는 사라졌다.
    expect(components).toMatch(/\.canvas-operation\.is-unseen \{[^}]*--caption-rail:\s*var\(--positive\)/);
    expect(components).not.toContain(".canvas-operation.is-unseen.is-active {");
    expect(components).toContain(".side-bar-status-axis-live-tick {");
    // 대기 틱의 호스트는 Theater 정체성 표식이다 — 전역 스위치 위에서는 어느 Theater인지가 지워진다.
    expect(sidebar).toMatch(/side-bar-theater-anchor[\s\S]{0,400}side-bar-status-axis-live-tick/);
  });

  it("pins the selectable Right Rail panel behavior contract", () => {
    const rail = source("styles/rail.css");
    const rightRail = source("rail/right-rail.tsx");
    const railStore = source("rail/rail-store.ts");
    expect(rail).toContain(".right-rail.is-overlay");
    expect(rail).toContain(".right-rail.is-switching");
    // Doctrine: the overlay slot ::before composites its glass layers over the
    // --glass-underlay channel — its default is the old opaque var(--ink-deep), so with the
    // liquid glass gate closed the slider's 100% endpoint stays fully opaque, and with the
    // gate open the same channel turns transparent under backdrop blur.
    expect(rail).toMatch(/\.right-rail\.is-overlay \.right-rail-panel-slot::before \{[^}]*\)\s*,\s*var\(--glass-underlay\);/);
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
    // composite their tint layers over the --glass-underlay channel and carry
    // backdrop-filter via the --glass-backdrop-* channels (canonical doctrine comment:
    // .whatsnew-card in components.css). The channel defaults reproduce the old opaque
    // contract exactly — underlay = var(--ink-deep), tint = the old surface tokens,
    // blur = none — so any closed gate (@supports, prefers-reduced-transparency,
    // data-glass="off") restores full opacity. Painting raw --surface-* or var(--ink-deep)
    // directly on a popup is a regression: that surface would escape the gates.
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
      ".theater-menu",
      ".operation-search-card",
      ".quick-launch-card",
      ".feature-tour-card",
      ".glass-welcome-card",
    ];
    // Quick Launch 오버레이도 fleet-pop을 타므로 억제 절을 함께 못 박는다 — 규칙 옆에 붙은
    // 자체 reduced-motion 블록은 .fc-select__* 선례와 같은 형태다.
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.quick-launch-overlay \{\s*animation: none;\s*\}/);
    for (const selector of componentsPopupSelectors) {
      const scoped = selector.replace(/\./g, "\\.");
      expect(components).toMatch(new RegExp(`${scoped} \\{[^}]*\\),\\s*var\\(--glass-underlay\\);`));
      expect(components).toMatch(new RegExp(`${scoped} \\{[^}]*backdrop-filter: var\\(--glass-backdrop-strong\\);`));
    }
    expect(layout).toMatch(/\.command-band-menu \{[^}]*\),\s*var\(--glass-underlay\);/);
    expect(skillsCss).toMatch(/\.skills-overlay-dialog \{[^}]*\),\s*var\(--glass-underlay\);/);
    expect(skillsCss).toMatch(/\.skills-toast \{[^}]*\),\s*var\(--glass-underlay\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__artifact-menu \{[^}]*var\(--glass-underlay\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__export-menu \{[^}]*var\(--glass-underlay\);/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__slash \{[^}]*var\(--glass-underlay\);/);
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
      expect(scuttlebuttCss).toMatch(new RegExp(`${scoped} \\{[\\s\\S]*?\\),\\s*var\\(--glass-underlay\\);`));
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
    expect(layout).toMatch(/\.command-band-left::before \{[^}]*background: var\(--glass-tint-chrome\);/);
    // 사이드바도 같은 크롬 표면을 소비해야 캡과 한 열로 읽힌다 — glass 회귀를 여기서 잡는다.
    const sideBarBlock = components.match(/^\.operations-side-bar \{[^}]*\}/m)?.[0] ?? "";
    expect(components).toMatch(/\.operations-side-bar::before \{[^}]*background: var\(--glass-tint-chrome\);/);
    // 패널은 하나의 면이다 — 루트가 panel 유리 틴트를, 캡션·본문 팬은 panel-face(게이트 열림 시
    // transparent)를 소비해 유리 한 장으로 읽힌다. 자식이 자기 틴트를 들면 이중 알파 얼룩이 된다.
    const operationBlock = components.match(/^\.canvas-operation \{[^}]*\}/m)?.[0] ?? "";
    expect(operationBlock).toContain("background: var(--glass-tint-panel);");
    expect(operationBlock).toContain("backdrop-filter: var(--glass-backdrop-soft);");
    expect(operationBlock).not.toContain("--surface-window");
    const titlebarBlock = components.match(/^\.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(titlebarBlock).toContain("background: var(--glass-tint-panel-face);");
    expect(titlebarBlock).toContain("background var(--duration-base) var(--ease-spring)");
    // 캡션 아웃라인은 본문과 같은 --surface-rim이다. inherit는 본문 윗변을 비운 뒤
    // 계산색이 갈라져 캡션만 선이 빠진다.
    expect(titlebarBlock).toContain("border: 1px solid var(--surface-rim);");
    expect(titlebarBlock).toContain("border-bottom-width: 0;");
    expect(titlebarBlock).toContain("border-bottom-style: none;");
    expect(titlebarBlock).not.toContain("border-color: inherit;");
    expect(titlebarBlock).not.toContain("border-bottom: none;");
    const panelBodyBlock = components.match(/^\.canvas-operation-terminal \{[^}]*\}/m)?.[0] ?? "";
    expect(panelBodyBlock).toContain("background: var(--glass-tint-panel-face);");
    // 레일 Shell 카드도 같은 면이다 — xterm이 terminal 유리 채널을 따라 반투명해지므로
    // 카드 면도 panel-face로 물러나 유리 한 장으로 읽힌다(게이트가 닫히면 둘 다 불투명 복원).
    const terminalShellBlock = components.match(/^\.terminal-shell \{[^}]*\}/m)?.[0] ?? "";
    expect(terminalShellBlock).toContain("background: var(--glass-tint-panel-face);");
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
    expect(components).toContain("border-radius: 0 var(--radius-md) 0 0;");
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
        expect(declaration.trim()).toMatch(/^--(?:ink|brass|aurora|coral|warn|positive|apex|crest|canvas|surface|hairline|text|id|glass)[a-z-]*:$/);
      }
    }
    // Light 테마만 팔레트 + 광학(color-scheme/shadow/scrollbar/신호 ink·halo/계기 무게/본문 regular 굵기 보정)을
    // 허용한다. --weight-regular 단일 예외: 밝은 배경의 얇은 스템 광학 보정 — medium/bold 티어 오버라이드는 계속 차단.
    // [doctrine] --gauge-* 는 형상이 아니라 **무게**를 정한다. 종이 위에서 명도는 무게의 반대이므로,
    // 다크의 명도 순서를 그대로 상속하면 채워진 계기의 사다리가 뒤집힌다(실측: 평상 L44.9가 위험 L52.0보다 무거움).
    // 그래서 이 채널만은 라이트가 자기 값으로 분화해야 하며, 형상·타이포 오버라이드 차단은 그대로 유지된다.
    const lightVariantBlocks = theme.match(/^:root\[data-theme="whites"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(lightVariantBlocks).toHaveLength(1);
    for (const block of lightVariantBlocks) {
      expect(block).toContain("color-scheme: light;");
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^(?:--(?:ink|brass|aurora|coral|warn|positive|apex|crest|canvas|surface|hairline|text|id|provider|shadow|scrollbar|gauge|glass)[a-z-]*|--weight-regular|color-scheme):$/);
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
    expect(surface).toContain('getComputedStyle(document.documentElement).getPropertyValue("--glass-tint-terminal")');
    expect(fs.readFileSync(fileURLToPath(new URL("../../fleet-plugins/terminal/client/shared/terminal-options.ts", import.meta.url)), "utf8")).toContain("allowTransparency: true");
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
    expect(chatRootBlock).toContain("background: var(--glass-tint-panel-face);");
    expect(chatRootBlock).not.toContain("--surface-window");
    expect(chatRootBlock).not.toContain("transition: background");
    const chatNodeBlock = chat.match(/^\.agent-chat-turn-node \{[^}]*\}/m)?.[0] ?? "";
    expect(chatNodeBlock).toContain("background: var(--glass-tint-panel);");
    expect(chatNodeBlock).not.toContain("--surface-window");
    // 상단 세션 띠바는 여전히 폐기 상태다 — 지속 크롬으로 패널 높이를 쓰면서 누를 것이 없었다.
    expect(chat).not.toContain(".agent-chat-head");
    // 하단 스트립 금지는 좁혀졌다. 폐기 사유는 "지속 크롬인데 누를 것이 없다"였고, 백그라운드
    // 작업 스트립은 그 두 조건을 모두 뒤집는다: 살아 있는 잡이 있는 동안에만 서고(지속이 아니다),
    // 눌러서 Work 탭으로 가는 문이다(누를 것이 있다). 대신 원래의 걱정 — 패널 높이를 잡아먹는 것 —
    // 은 계약으로 남는다: 떠 있어야 하고 로그 흐름에서 자리를 차지하면 안 된다.
    const chatStripBlock = chat.match(/^\.agent-chat-strip \{[^}]*\}/m)?.[0] ?? "";
    expect(chatStripBlock).toContain("position: absolute;");
    expect(chatStripBlock).toContain("cursor: pointer;");
    const chatView0 = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    expect(chatView0).toContain('className="agent-chat-strip"');
    // 로그 위에 떠 있는 줄은 Follow 하나뿐이다. 잡 스트립은 잡이 사는 내내 상주하므로 읽는
    // 칼럼 위에 둘 수 없고(실측: 문장 31px을 덮었다), 컴포저 프레임의 위 모서리에 걸터앉는다.
    // Follow는 바닥을 놓친 동안에만 서는 일시적 문이라 그 자리를 물려받아도 상주하지 않는다.
    const chatFollowBottom = chat.match(/^\.agent-chat-follow \{[^}]*\}/m)?.[0].match(/bottom: ([^;]+);/)?.[1] ?? "";
    expect(chatStripBlock).toContain("bottom: calc(-1 * var(--space-2));");
    expect(chatStripBlock).toContain("transform: translate(-50%, 50%);");
    expect(chatFollowBottom).toBe("var(--space-3)");
    expect(chat).not.toContain(".agent-chat-log.has-strip");
    expect(chatView0).not.toContain("has-strip");
    // 컴포저에 걸터앉는 줄은 그 프레임과 같은 폭을 상한으로 쓴다. 회신·중지 버튼 자리를 비우던
    // 264px은 그 두 버튼이 컴포저 안으로 들어간 뒤로 빈 예약이었고, 좁은 패널에서 잡 이름만 먼저
    // 잘랐다 — 사라진 것을 계속 피하는 여백은 계약이 아니라 흔적이다.
    expect(chatStripBlock).toContain("max-width: min(var(--agent-chat-composer-measure), calc(100% - 2 * var(--space-3)));");
    expect(chatStripBlock).not.toContain("40px + var(--space-2) + 72px");
    // 카드에는 컴포저가 없으므로 걸터앉을 프레임도 없다 — 그쪽만 원래 앵커로 되돌린다.
    const stripOnTileBlock = chat.match(/\.canvas-operation\.is-deck-tile \.agent-chat-strip \{[^}]*\}/)?.[0] ?? "";
    expect(stripOnTileBlock).toContain("bottom: var(--space-3);");
    expect(stripOnTileBlock).toContain("transform: translateX(-50%);");
    // 잡이 하나도 없으면 렌더되지 않는다 — 조건 없이 서면 폐기 사유가 그대로 되살아난다.
    // 스트립은 두 형태로 서고(도는 중 · 다 끝남), 둘 다 잡이 있을 때만 선다.
    expect(chatView0).toContain("!workOpen && openJobs.length > 0 ? (");
    expect(chatView0).toContain("!workOpen && hasJobs && openJobs.length === 0 ? (");
    // 탭은 폐기됐다. 두 면을 갈아 끼우면 대화가 통째로 사라지는데, 백그라운드 작업은 대화를
    // 대신하는 것이 아니라 대화 **옆에서** 동시에 돈다 — 하나를 고르게 만들면 무엇이 도는지
    // 보려고 무엇을 물었는지를 잃는다. 스트립 하나가 유일한 문이고, 문은 면을 나란히 연다.
    expect(chat).not.toContain(".agent-chat-tab");
    expect(chatView0).not.toContain('role="tablist"');
    // 대화 면은 어떤 경로로도 숨지 않는다. 이 표면 전체가 존재하는 이유가 그것이다.
    expect(chatView0).not.toContain("agent-chat-log${view");
    const chatSplitBlock = chat.match(/^\.agent-chat-split \{[^}]*\}/m)?.[0] ?? "";
    expect(chatSplitBlock).toContain("flex-direction: row;");
    // 컬럼이 서랍으로 접히는 기준은 **패널 폭**이다. 뷰포트로 가르면 넓은 창 안의 좁은 덱
    // 타일에서 두 컬럼이 서고, 어느 쪽도 읽을 수 없는 폭이 된다.
    expect(chatRootBlock).toContain("container-type: inline-size;");
    expect(chat).toContain("@container (max-width: 719px)");
    // 읽기 폭 프리셋은 measure 변수 하나만 갈아끼운다 — 로그 컬럼·하단 스트립·덱 타일 스트립이
    // 전부 이 변수를 경유하므로, 세 값(100ch/140ch/100%)이 표면을 한 몸으로 묶는 계약이다.
    expect(chatRootBlock).toContain("--agent-chat-measure: 100ch;");
    expect(chat).toMatch(/\.agent-chat\[data-reading-width="wide"\] \{\s*--agent-chat-measure: 140ch;\s*\}/);
    expect(chat).toMatch(/\.agent-chat\[data-reading-width="full"\] \{\s*--agent-chat-measure: 100%;\s*\}/);
    // 쉬는 스트립은 신호 채널을 쓰지 않는다 — aurora는 "지금 돈다"이고, 쉬는 상태에는 그 사실이 없다.
    const chatStripRestBlock = chat.match(/^\.agent-chat-strip\.is-rest \{[^}]*\}/m)?.[0] ?? "";
    expect(chatStripRestBlock).toContain("color: var(--text-tertiary);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(chatStripRestBlock).not.toContain(signal);
    }
    // 중지는 실패가 아니다 — 사용자가 스스로 끊은 결말에 coral을 붙이면 자기가 누른 버튼의
    // 결과를 고장으로 읽는다. 성공도 아니므로 positive도 아니고, 남는 것은 중립 잉크다.
    const chatFoldStoppedBlock = chat.match(/^\.agent-chat-fold-stopped \{[^}]*\}/m)?.[0] ?? "";
    expect(chatFoldStoppedBlock).toContain("var(--text-secondary)");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(chatFoldStoppedBlock).not.toContain(signal);
    }
    // 눌리는 집계 줄은 쉬는 상태에서도 눌린다고 말해야 한다. 이전에는 9px --hairline-strong이라
    // 안 눌리는 줄과 사실상 구별되지 않았다(두 줄이 같은 클래스·같은 활자·같은 색이고 차이는
    // 이 글리프 하나뿐이다). 어포던스는 꺾쇠가, 가독성은 이름이 각각 진다 — 섞으면 "진한 이름 =
    // 눌림"이라는 거짓 규칙이 생기고, 이름 있는 정적 줄이 거짓 어포던스를 갖는다.
    // 도는 구간의 한 줄. 예전에는 최근 스텝 여덟 개가 전폭 행으로 흘러가는 것이 "일하는 중"의
    // 증거였고, 실측하면 그 행들이 로그 가시 영역의 58%를 먹었다 — 읽는 자리를 도구 목록이
    // 밀어냈다. 지금은 이 한 줄이 같은 말을 하므로, 라이브 창이 되살아나지 않는 것이 계약이다.
    expect(chatView0).not.toContain("LIVE_STEP_WINDOW");
    // [doctrine] 진행은 이미 링(aurora)이 말한다. 물결은 "이 줄이 아직 자라고 있다"를 말하므로
    // 색 채널을 하나도 빌리지 않는 명도 스윕이다 — 같은 기법을 쓰는 ULTRACODE 물결이 apex를
    // 쓰는 것과 갈리는 지점이 바로 이것이고, 신호를 빌리면 링과 두 번 말하게 된다.
    const chatLiveTextBlock = chat.match(/^\.agent-chat-live-text \{[^}]*\}/m)?.[0] ?? "";
    expect(chatLiveTextBlock).toContain("background-clip: text;");
    expect(chatLiveTextBlock).toContain("color: transparent;");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--apex", "--id-"]) {
      expect(chatLiveTextBlock, signal).not.toContain(signal);
    }
    // 물결은 끊기지 않고 되풀이해야 한다. 배경 위치 퍼센트는 (상자 폭 - 이미지 폭)을 기준으로
    // 재므로 한 바퀴의 이동량은 |ΔP|/100 x (이미지 폭 - 상자 폭)이고, 그것이 타일 한 폭의
    // 정수배가 아니면 마지막 프레임이 첫 프레임과 어긋나 되풀이 지점에서 도약한다(옛 값
    // 300% x 200 = 4W 대 타일 3W). 200%에서 200%->0%는 2 x (2W - W) = 2W = 타일 한 폭이다.
    expect(chatLiveTextBlock).toContain("background-size: 200% 100%;");
    const chatLiveSweepBlock = chat.match(/@keyframes agent-chat-live-sweep \{[^}]*\}[^}]*\}/)?.[0] ?? "";
    expect(chatLiveSweepBlock).toContain("from { background-position: 200% 0; }");
    expect(chatLiveSweepBlock).toContain("to { background-position: 0% 0; }");
    // 타일 경계가 보이지 않으려면 그라데이션 양 끝이 같은 잉크여야 한다.
    expect(chatLiveTextBlock).toContain("var(--text-tertiary) 0%,");
    expect(chatLiveTextBlock).toContain("var(--text-tertiary) 100%");
    // 진행 중 턴 헤드의 시계도 같은 물결을 진다 — 집계 줄과 같은 사실("이 턴이 아직 살아
    // 있다")을 말하는 자리라 어휘가 갈리면 안 된다. 다만 이 자리의 잉크는 tertiary이므로
    // 봉인의 기본 채움(secondary)을 덮어써야 모션을 끈 것이 밝기 변화로 읽히지 않는다.
    expect(chatView0).toContain('<span className="agent-chat-live-text" aria-hidden="true">');
    expect(chatView0).toContain('t("terminal.chat.turnWorking"');
    expect(chat).toMatch(
      /\.agent-chat-turn-head \.agent-chat-live-text \{\s*color: var\(--text-tertiary\);\s*\}/,
    );
    // 물결 봉인은 모션만 죽이고 줄은 남긴다. `color: transparent`가 남으면 글자가 통째로
    // 사라지므로 그라데이션과 채움을 함께 되돌려야 한다(ULTRACODE 물결과 같은 함정).
    const chatLiveSealBlock = chat.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-chat-live-text \{[^}]*\}/)?.[0] ?? "";
    expect(chatLiveSealBlock).toContain("animation: none;");
    expect(chatLiveSealBlock).toContain("background-image: none;");
    expect(chatLiveSealBlock).toContain("color: var(--text-secondary);");
    // 원장에 서는 잡은 카드가 아니라 한 줄이다. 카드의 몸(종류·누구·토큰·도구·소요)은 작업 면이
    // 이미 더 자세히 지고 있었고, 원장에서는 읽는 흐름을 두 줄짜리 상자로 끊었다. 남는 것은
    // "여기서 태어났다"와 거기로 가는 문뿐이므로 면도 테두리도 두르지 않는다.
    const chatJobAnchorBlock = chat.match(/^\.agent-chat-job-anchor \{[^}]*\}/m)?.[0] ?? "";
    expect(chatJobAnchorBlock).toContain("background: none;");
    expect(chatJobAnchorBlock).toContain("border: none;");
    expect(chatJobAnchorBlock).toContain("border-bottom: 1px dashed var(--hairline-strong);");
    // 글자만큼만 넓다 — 블록으로 두면 파선이 패널을 가로질러 구분선으로 읽힌다(실측 적발).
    expect(chatJobAnchorBlock).toContain("width: max-content;");
    expect(chatView0).toContain('className={`agent-chat-job-anchor ${jobStateClass(job)}`}');
    // 카드 자체는 남는다 — 작업 면이 그 몸의 주인이다.
    expect(chatView0).toContain("function JobCard(");
    const chatTallyChevBlock = chat.match(/^\.agent-chat-tally-chev \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyChevBlock).toContain("color: var(--text-tertiary);");
    expect(chatTallyChevBlock).not.toContain("--hairline-strong");
    const chatTallyNameBlock = chat.match(/^\.agent-chat-tally-name \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyNameBlock).toContain("color: var(--text-secondary);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(chatTallyNameBlock).not.toContain(signal);
    }
    // 잡의 종류는 상태가 아니다 — 글리프와 모노 라벨이 가르고, 어떤 신호 토큰도 쓰지 않는다.
    const chatJobGlyphBlock = chat.match(/^\.agent-chat-job-glyph \{[^}]*\}/m)?.[0] ?? "";
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--id-"]) {
      expect(chatJobGlyphBlock).not.toContain(signal);
    }
    // 계열 표식은 잡 글리프와 같은 알파벳을 넓힌 것이다 — 같은 일을 두 면이 다른 기호로 부르면
    // 표식이 어휘가 아니라 장식이 된다. 색은 쥐지 않는다: 계열은 어떤 채널에도 속하지 않고,
    // 잉크를 쥐면 도는 줄의 물결이 이 글자에서만 끊긴다(배경 클립은 투명한 자식만 통과시킨다).
    const chatTallyGlyphBlock = chat.match(/^\.agent-chat-tally-glyph \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyGlyphBlock).not.toContain("color:");
    expect(chatTallyGlyphBlock).toContain("width: 1em;");
    const chatView0Glyphs = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    for (const [family, glyph] of [["delegate", "◆"], ["run", "❯"], ["workflow", "⣿"]] as const) {
      expect(chatView0Glyphs, family).toContain(`${family}: "${glyph}",`);
    }
    // 표식과 그 문구는 한 덩어리다 — 절 사이 간격을 그대로 쓰면 표식이 앞 절 끝에 붙어 읽힌다.
    const chatTallyClauseBlock = chat.match(/^\.agent-chat-tally-clause \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyClauseBlock).toContain("gap: var(--space-1);");
    // 집계 줄의 자식은 링·글자 묶음·꺾쇠 셋뿐이고 줄바꿈은 묶음이 자기 안에서 진다. 여기서
    // wrap을 열면 절이 많은 줄에서 꺾쇠가 홀로 다음 줄로 떨어진다(감싸는 flex는 좁아지기보다
    // 넘기기를 먼저 고른다).
    const chatTallyBlock = chat.match(/^\.agent-chat-tally \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyBlock).toContain("flex-wrap: nowrap;");
    // 두 뷰의 전환 진입은 캡션 밴드의 한 버튼이 진다 — 목적지 마크만 바뀐다.
    const chatView = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    const chatComposer = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_COMPOSER_PATH), "utf8");
    const terminalEntry = fs.readFileSync(fileURLToPath(TERMINAL_AGENT_PATH), "utf8");
    expect(chatView).not.toContain("agent-chat-mode-chip");
    expect(chatView).not.toContain("agent-view-chip-row");
    // 구간 문장은 답변과 같은 마크다운 경로다. italic을 통째로 씌우면 `**굵게**`가 별표로 남고
    // 문장만 기울어진다 — 기울임은 문법(*강조*)이 질 몫이다.
    expect(chatView).toContain('className="agent-chat-ledger-note markdown-body"');
    expect(chat).toContain(".agent-chat .agent-chat-ledger-note.markdown-body");
    expect(chat).not.toMatch(/\.agent-chat-ledger-note[^{]*\{[^}]*font-style:\s*italic/);
    // 그 문장은 이 면에서 가장 밝다. tertiary였을 때 집계 줄과 같은 잉크라 스트리밍 중에는
    // 문장과 장부가 한 덩어리 회색이었다. secondary로는 갈리지 않는다 — 잉크 스케일에서
    // secondary(L70)와 tertiary(L64)는 6포인트뿐이라 실측에서 같은 회색으로 읽혔다.
    const chatNoteInkBlock = chat.match(
      /\.agent-chat \.agent-chat-ledger-note\.markdown-body p,\s*\n\.agent-chat \.agent-chat-ledger-note\.markdown-body li \{[^}]*\}/,
    )?.[0] ?? "";
    expect(chatNoteInkBlock).toContain("color: var(--text-primary);");
    expect((terminalEntry.match(/actionId="view-switch"/g) ?? [])).toHaveLength(2);
    expect(terminalEntry).toContain("<CaptionTerminalGlyph />");
    expect(terminalEntry).toContain("<CaptionChatGlyph />");
    // 패널 컴포저는 언제나 서 있다 — 접힘도, 되돌아오는 쉬는 줄도 없다.
    expect(chat).not.toContain(".agent-chat-composer-rest");
    expect(chatView).not.toContain("ComposerRestStrip");
    // 면을 두르지 않는다: 밴드(구분선 + 한 단 올라간 배경)를 두면 패널 안에 또 하나의 패널이
    // 생겨, 가운데에 선 컴포저와 아래로 내려앉은 컴포저가 다른 물건으로 읽힌다.
    const composerBlock = chat.match(/^\.agent-chat-composer \{[^}]*\}/m)?.[0] ?? "";
    expect(composerBlock).not.toContain("border-top");
    expect(composerBlock).not.toContain("background");
    // 자리는 그대로 in-flow다 — 컴포저가 떠서 대화의 마지막 줄을 덮으면 안 된다.
    expect(composerBlock).toContain("flex: none;");
    expect(composerBlock).not.toContain("position: absolute");
    // 쓰는 자리는 기본 읽기 폭에 정렬한다 — 상한일 뿐 고정폭이 아니라 좁아지면 따라 줄어든다.
    // 읽기 폭 프리셋은 이 상한을 갈지 않는다: 전체 폭으로 읽는 사람도 쓰는 자리는 같은 폭이라야
    // 프리셋을 바꿀 때마다 입력창이 화면을 가로지르지 않는다.
    const composerFrameBlock = chat.match(/^\.agent-chat-composer-frame \{[^}]*\}/m)?.[0] ?? "";
    expect(composerFrameBlock).toContain("max-width: var(--agent-chat-composer-measure);");
    expect(composerFrameBlock).toContain("margin-inline: auto;");
    for (const preset of ["wide", "full"]) {
      const presetBlock = chat.match(new RegExp(`\\.agent-chat\\[data-reading-width="${preset}"\\] \\{[^}]*\\}`))?.[0] ?? "";
      expect(presetBlock, preset).toContain("--agent-chat-measure:");
      expect(presetBlock, preset).not.toContain("--agent-chat-composer-measure");
    }
    // 실행 중에는 현재 턴의 중지와 다음 턴의 예약을 분리해 함께 세운다. 중지는 행동이지 오류
    // 상태가 아니므로 중립 잉크를 쓰고, signal token은 빌리지 않는다.
    expect(chat).not.toContain(".agent-chat-stop");
    expect(chatView).not.toContain('className="agent-chat-stop"');
    const composerStopBlock = chat.match(/^\.agent-chat-composer-stop \{[^}]*\}/m)?.[0] ?? "";
    expect(composerStopBlock).toContain("color: var(--text-secondary);");
    expect(chatComposer).toContain('className="agent-chat-composer-stop"');
    expect(chatComposer).toContain("is-queue");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral"]) {
      expect(composerStopBlock, signal).not.toContain(signal);
    }
    const composerFrameFocusBlock = chat.match(/^\.agent-chat-composer-frame:focus-within \{[^}]*\}/m)?.[0] ?? "";
    expect(composerFrameFocusBlock).toContain("border-color: var(--brass);");
    const composerArmedBlock = chat.match(/^\.agent-chat-composer-send\.is-armed \{[^}]*\}/m)?.[0] ?? "";
    expect(composerArmedBlock).toContain("background: var(--brass);");
    expect(composerArmedBlock).toContain("color: var(--text-on-brass);");
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
    // 위쪽 34px은 전환 칩 줄의 몫이었고, 그 줄이 캡션으로 떠난 지금 로그는 패널 상단에서 바로
    // 시작한다. 아래 여백만 남아 자기 컨트롤(작업 스트립)을 넘어서는지 고정한다.
    const chatLogBlock = chat.match(/^\.agent-chat-log \{[^}]*\}/m)?.[0] ?? "";
    const chatLogPadding = chatLogBlock.match(/padding: ([^;]+);/)?.[1] ?? "";
    expect(chatLogPadding.startsWith("var(--space-3) ")).toBe(true);
    expect(chatLogPadding).not.toContain("34px");
    expect(chatLogPadding).toContain("calc(var(--space-3) + 45px)");
    // 아래 여백이 피하는 것은 이제 작업 스트립이다 — 중지는 컴포저의 발사 자리로 들어가
    // 더 이상 로그 위에 얹히지 않는다.
    const stripSize = Number(chatStripBlock.match(/height: (\d+)px;/)?.[1] ?? 0);
    const logBottom = Number(chatLogPadding.match(/calc\(var\(--space-3\) \+ (\d+)px\)\s*$/)?.[1]);
    expect(logBottom).toBeGreaterThan(stripSize);
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
    expect(terminalAnalysisCss).toContain("background: var(--glass-tint-panel-face);");
    expect(terminalAnalysisCss).not.toContain("surface-pillar");
    expect(terminalAnalysisCss).not.toContain("surface-window");
    // 얹히는 카드·버블·칩은 raised 티어 한 칸으로 물러난다.
    expect(terminalAnalysisCss).toContain("var(--surface-panel-raised)");
    // 정체·상태·모드는 호스트 캡션 밴드가 진다 — 본문 위에 떠서 첫 문단을 가리지 않는다.
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__chips \{/);
    expect(terminalAnalysisCss).not.toMatch(/\.session-analyst__chips \{[^}]*position: absolute/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__turn-node \{/);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__receipt > summary \{/);
    // 끝난 턴의 접힘은 채팅 원장의 `.agent-chat-fold`와 같은 문법이다 — 문장이지 카드가 아니다.
    // 알약(면·테두리)으로 되돌아가면 이 줄이 결말을 말하는 문장이 아니라 물건으로 읽힌다.
    const analystReceiptSummary = terminalAnalysisCss.match(/\.session-analyst__receipt > summary \{[^}]*\}/)?.[0] ?? "";
    expect(analystReceiptSummary).not.toContain("border:");
    expect(analystReceiptSummary).not.toContain("background:");
    expect(analystReceiptSummary).not.toContain("radius-pill");
    // 결말의 성패는 스파인 노드가 진다 — 접힘 줄이 ✓를 또 들면 두 곳이 같은 말을 한다.
    expect(terminalAnalysisCss).not.toContain(".session-analyst__receipt-mark");
    // 물결은 채팅 원장의 것과 한 벌이다. 값이 갈라지면 같은 사실을 두 면이 다른 속도로 말한다.
    // 줄머리에 못을 박는다 — 앵커 없는 `.session-analyst__live-text {`는 합성 규칙의
    // `strong.session-analyst__live-text {` 꼬리에도 물린다.
    const analystWave = terminalAnalysisCss.match(/^\.session-analyst__live-text \{[^}]*\}/m)?.[0] ?? "";
    expect(analystWave).toContain("background-size: 200% 100%;");
    expect(analystWave).toContain("background-clip: text;");
    expect(analystWave).toContain("color: transparent;");
    expect(analystWave).toContain("animation: analyst-live-sweep 2.4s linear infinite;");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--apex", "--id-"]) {
      expect(analystWave, signal).not.toContain(signal);
    }
    // 되풀이는 이음매가 없어야 한다 — 이동량이 타일 한 폭의 정수배여야 마지막 프레임이 첫
    // 프레임과 같다(200% 이미지에 ΔP 200 = 2W = 타일 한 폭).
    expect(terminalAnalysisCss).toMatch(
      /@keyframes analyst-live-sweep \{\s*from \{ background-position: 200% 0; \}\s*to \{ background-position: 0% 0; \}/,
    );
    // 펄스 문구는 애니메이션을 둘 진다(도착 + 물결). 합성하지 않으면 도착 애니메이션이 같은
    // 속성을 더 높은 특정성으로 쥐고 있어 물결이 조용히 죽고 정지된 그라데이션만 남는다.
    expect(terminalAnalysisCss).toMatch(
      /\.session-analyst__pulse-copy strong\.session-analyst__live-text \{[\s\S]*?analyst-stage-enter[\s\S]*?analyst-live-sweep 2\.4s linear infinite;/,
    );
    // 봉인은 모션만 죽인다 — `color: transparent`가 남으면 글자가 통째로 사라진다.
    const analystSeal = terminalAnalysisCss.match(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.session-analyst__live-text \{[^}]*\}/,
    )?.[0] ?? "";
    expect(analystSeal).toContain("animation: none;");
    expect(analystSeal).toContain("background-image: none;");
    expect(analystSeal).toContain("color: var(--text-secondary);");
    // 사용자 발화 정체성은 --id-cerulean 워시 문법(디스패치 버블과 동형)만 쓴다.
    expect(terminalAnalysisCss).toContain("color-mix(in oklch, var(--id-cerulean) 10%, var(--surface-panel-raised))");
    // 아티팩트는 드로어 안의 모드다 — 모드 세그먼트가 있고, 세로 핸들과 두 번째 컴패니언은 되살아나면 안 된다.
    const terminalChatCss = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const terminalAgentEntry = externalSource(TERMINAL_AGENT_PATH);
    expect(terminalAnalysisCss).toMatch(/\.session-analyst__modechip \{/);
    expect(terminalAnalysisCss).not.toContain(".session-analyst-handle");
    // Analyst 진입은 캡션 동작 선반의 첫 버튼이다 — 전환·읽기 폭과 같은 줄·같은 문법.
    expect(terminalChatCss).not.toContain(".agent-view-chip-row");
    expect(terminalChatCss).not.toContain(".agent-analyst-chip");
    expect(terminalAgentEntry).toContain('actionId="analyst"');
    expect(terminalAgentEntry).toContain("<CaptionAnalystGlyph />");
    expect(terminalAgentEntry).toContain("captionActions: (context) => <AgentCaptionActions context={context} />");
    // 캡션 밴드는 호스트가 자리를 비워 둔다 — 채우지 않으면 빈 띠가 남고 프레임의 위 모서리가 각진다.
    expect(terminalAgentEntry).toContain("caption: (context) => <AnalystCaption context={context} />");
    expect(terminalAgentEntry).not.toContain("hideCaption");
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

    // 역할·플러그인·동작 이름을 반복하던 시각 헤더는 제거한다. 메뉴 역할은 aria-label이 맡고,
    // Terminal Shell은 rail 실행으로 이동해 Etc 그룹을 만들지 않는다.
    expect(components).not.toContain(".canvas-context-menu-reticle");
    expect(contextMenu).not.toContain('className="canvas-context-menu-reticle"');
    expect(contextMenu).not.toContain("canvas-context-menu-head");
    expect(components).not.toContain(".canvas-context-menu-head {");
    expect(contextMenu).toContain('aria-label={menuLabel}');
    expect(contextMenu).not.toContain('canvas.menu.etc');
    expect(contextMenu).not.toContain("operation-launch-provider-glyph--etc");

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
    const statusIcon = source("components/operation-status-icon.tsx");
    const nameMark = source("components/operation-name-mark.tsx");
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
    // 이름 왼쪽 칸의 조형 선택은 한 모듈이 소유한다 — 표면마다 "Shell이면 글리프" 분기를 다시 적으면
    // 같은 사실이 표면 수만큼의 조형으로 갈라진다. 칩·밴드·모바일이 모두 이 문을 지난다.
    expect(chip).toContain('import { OperationNameMark } from "../components/operation-name-mark.js"');
    expect(nameMark).toContain('import { ShellGlyph } from "@fleet-console/sdk/components/shell-glyph"');
    expect(nameMark).toContain("if (isShellOperation(operation)) return <ShellKindMark");
    expect(nameMark).toContain('return <OperationStatusIcon status={status}');
    // 상태 마크 해석은 여전히 상태 아이콘 하나가 소유한다 — 종류 분기는 그 위층의 다른 질문이다.
    expect(statusIcon).toContain('if (visual === "background") return "tenant-beacon is-background"');
    expect(statusIcon).toContain('if (visual === "awaiting") return "tenant-beacon is-awaiting"');
    // 종류 마크는 신호 채널도 위치 채널도 빌리지 않는다 — 활동 토큰 묶음 밖에 선다.
    expect(components).toMatch(/\.shell-kind-mark \{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*color:\s*var\(--text-secondary\)/);
    expect(components).not.toMatch(/\.shell-kind-mark \{[^}]*(box-shadow|animation)/);
    expect(components).toMatch(/\.canvas-triage-map-dot\.is-shell \{[^}]*background:\s*none;[^}]*opacity:\s*1;[^}]*color:\s*var\(--text-secondary\)/);
    // 활동 토큰 묶음에 종류를 끼워 넣으면 Shell이 다시 상태 축의 한 값으로 읽힌다.
    expect(components).not.toContain(".canvas-triage-map-dot.is-shell,");
    expect(components).not.toContain(".tenant-beacon.is-shell");
    expect(chip).not.toContain("is-attention");
    expect(components).toContain(".side-bar-chip:focus-within .side-bar-chip-close");
    expect(components).toContain(".side-bar-chip--minimized .side-bar-chip-name {\n  color: var(--ink-muted);");
    expect(components).toContain(".side-bar-chip--minimized .side-bar-chip-status {\n  opacity: 0.62;");
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
    expect(components).toContain("border-radius: var(--radius-pill);");
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
    expect(components).toContain("color-mix(in oklab, var(--brass) 10%, var(--glass-tint-panel-face))");
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
    expect(components).toContain(".canvas-operation-more-button {");
    expect(components).toContain("border: 1px solid var(--surface-rim);");
    expect(components).toContain("left: -1px;");
    expect(components).toContain("name → More → 상시 컨트롤");
    const canvas = source("canvas/canvas.tsx");
    expect(canvas).toContain("export function useGlanceHold(): boolean");
    expect(canvas).toContain('event.code === "AltLeft" || event.code === "AltRight"');
    expect(canvas).toContain("event.ctrlKey || event.metaKey");
    expect(canvas).toContain("isBlockingDialogOpen()");
    expect(canvas).toContain('glanceVisible ? "is-glance" : ""');
    expect(canvas).toContain('window.addEventListener("blur", clearGlance)');
    expect(canvas).toContain('document.addEventListener("visibilitychange", handleVisibilityChange)');
    expect(source("styles/layout.css")).toContain(".command-band-operation-status { margin-right: 2px; }");
    expect(source("styles/layout.css")).not.toContain(".command-band-operation-attribute");
    expect(commandBand).not.toContain("command-band-operation-attribute");
    expect(commandBand).toContain('className="command-band-operation-status"');
    expect(commandBand).toContain('<rect x="1.75" y="3" width="12.5" height="10" rx="2.4"');
    expect(rail).toContain("width: 44px");
  });

  it("pins the caption status rail motion grammar — one motion per state, hierarchy, phase lock", () => {
    const components = source("styles/components.css");
    const operationFrame = source("canvas/operation-frame.tsx");
    // 상태마다 운동의 종류가 다르다. 왕복(travel)은 turn 하나만 소유한다 — 진행 위치가 옮겨
    // 간다는 사실을 말하는 형태라, 옮겨 갈 지점이 없는 나머지 상태가 빌리면 뜻이 갈라진다.
    expect(components).toContain("animation: caption-rail-travel 3.8s ease-in-out infinite;");
    expect(components).toContain("animation: caption-rail-flow 6.5s linear infinite;");
    expect(components).toContain("animation: caption-rail-call 2.4s var(--ease-glide) infinite;");
    expect(components).toContain("animation: caption-rail-tide 4.4s var(--ease-glide) infinite;");
    expect(components).toContain("@keyframes caption-rail-flow");
    expect(components).toContain("@keyframes caption-rail-call");
    expect(components).toContain("@keyframes caption-rail-tide");
    // background·unseen이 운동 없이 색만 다른 정지선으로 되돌아가지 않도록 사용처를 고정한다.
    const backgroundRail = components.match(/\.canvas-operation\.is-running--background > \.canvas-operation-titlebar::after \{[^}]*\}/)?.[0] ?? "";
    expect(backgroundRail).toContain("animation: caption-rail-flow");
    expect(components).toMatch(/\.canvas-operation\.is-unseen > \.canvas-operation-titlebar::after \{\s*animation: caption-rail-tide/);
    // 흐름의 이동량은 타일 한 주기와 같아야 한다 — background-position의 퍼센트는
    // (영역 폭 − 이미지 폭) 기준이라 타일 주기와 어긋나고, 한 바퀴 끝에서 그림이 튄다.
    expect(backgroundRail).toContain("background-size: 160px 100%;");
    expect(components).toMatch(/@keyframes caption-rail-flow \{\s*from \{\s*background-position: 0 0;\s*\}\s*to \{\s*background-position: -160px 0;/);
    expect(components).not.toMatch(/@keyframes caption-rail-flow \{[^}]*background-position: -\d+% 0/);
    // 밝기 위계는 어느 순간에도 뒤집히지 않는다 — awaiting 하한 > unseen 하한 > background 마루.
    // 옛 맥동은 하한 0.34로 background 상시값(0.45)보다 어두워지는 구간이 있었다.
    expect(backgroundRail).toContain("opacity: 0.55;");
    expect(components).toMatch(/@keyframes caption-rail-call \{[^@]*50% \{\s*opacity: 0\.62;/);
    expect(components).toMatch(/@keyframes caption-rail-tide \{[^@]*50% \{\s*opacity: 0\.58;/);
    expect(components).not.toContain("@keyframes caption-rail-pulse");
    // 시작·끝은 완전 점등이다 — reduced-motion이 반복을 1회로 잘라도 레일이 꺼진 채 남지 않는다.
    expect(components).toMatch(/@keyframes caption-rail-call \{\s*0%,\s*100% \{\s*opacity: 1;/);
    expect(components).toMatch(/@keyframes caption-rail-tide \{\s*0%,\s*100% \{\s*opacity: 1;/);
    // reduced-motion: 색이 갈라 주는 상태는 색면으로 단락하고, turn과 색을 공유하는
    // background만 점선으로 형상을 남긴다 — 균일 warn 선 둘이 겹치면 두 상태가 한 그림이 된다.
    // 슬라이스 기준을 캡션 폴백 블록 자체로 잡는다 — 파일 앞쪽 @media부터 자르면 미디어 밖의
    // 일반 상태 규칙이 먼저 매치되어 폴백이 비어 있어도 통과한다.
    const captionReducedMotion = components.slice(
      components.indexOf("  .canvas-operation.is-running--turn > .canvas-operation-titlebar::after,"),
    );
    expect(captionReducedMotion).toContain("  .canvas-operation.is-unseen > .canvas-operation-titlebar::after,");
    const reducedBackgroundRail = captionReducedMotion.match(/ {2}\.canvas-operation\.is-running--background > \.canvas-operation-titlebar::after \{[^}]*\}/)?.[0] ?? "";
    expect(reducedBackgroundRail).toContain("animation: none;");
    expect(reducedBackgroundRail).toContain("repeating-linear-gradient(90deg, var(--warn) 0 7px, transparent 7px 13px)");
    // 위상은 문서 타임라인 원점에 묶는다 — 상태 진입 시각이 다르면 같은 상태의 패널들이
    // 제각각 깜빡인다. 도착 플래시(전이)와 turn 트래블은 이 잠금에 들어가지 않는다.
    expect(operationFrame).toContain('const PHASE_LOCKED_RAIL_ANIMATIONS = new Set(["caption-rail-flow", "caption-rail-call", "caption-rail-tide"]);');
    expect(operationFrame).toContain("animation.startTime = 0;");
    expect(operationFrame).toMatch(/PHASE_LOCKED_RAIL_ANIMATIONS\.has\(\(animation as CSSAnimation\)\.animationName\)/);
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
    expect(selectBlock).toContain("font-weight: var(--weight-medium); font-size: var(--t-md); line-height: 1.2; font-family: var(--font-body);");
    expect(selectBlock).toContain("padding: 0 13px;");
    expect(selectBlock).toContain("box-shadow: inset 0 1px 0 color-mix(in oklch, var(--ink-pearl) 5%, transparent);");
    expect(selectBlock).toContain("border-color: color-mix(in oklch, var(--brass) 58%, var(--surface-rim));");
    expect(selectBlock).toContain("background: color-mix(in oklch, var(--brass) 12%, transparent);");
    expect(selectBlock).toContain('content: "✓";');
    expect(selectBlock).toContain("font-style: italic;");
    expect(selectBlock).toContain(".fc-select--compact .fc-select__trigger {");
    // compact 트리거는 칩 문법의 모노 티어(11px)를 쓴다 — 본문 14px 옆에서 9px는 라벨이 아니라 흔적이 된다.
    expect(selectBlock).toContain(
      "font-weight: var(--weight-regular);\n  font-size: var(--t-xs);\n  line-height: 1;\n  font-family: var(--font-mono);",
    );
    // 호출부가 트리거 글자색을 자기 채널로 넘겨받는 유일한 통로 — 미설정이면 기본 티어를 그대로 쓴다.
    expect(selectBlock).toContain("color: var(--fc-select-compact-tone, var(--text-secondary));");
    expect(selectBlock).toContain("padding: 7px 16px 7px 10px;");
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
    // 물결은 끊기지 않고 되풀이해야 한다. 배경 위치 퍼센트는 (상자 폭 - 이미지 폭)을 기준으로
    // 재므로 한 바퀴의 이동량 |dP|/100 x (이미지 폭 - 상자 폭)이 타일 한 폭의 정수배여야
    // 마지막 프레임이 첫 프레임과 같다. 200%/dP 200 = 2W = 타일 한 폭이다. 이 물결을 쓰는
    // 자리는 넷(강도 트랙 값·QL 토큰·QL 멘션 이름·Chat 좌표 칩)이고 값이 갈라지면 안 된다.
    expect(components).toMatch(
      /@keyframes effort-ultracode-wave \{\s*to \{ background-position: -200% 0; \}\s*\}/,
    );
    expect(components).not.toContain("effort-ultracode-wave 2.6s");
    expect(components.match(/animation: effort-ultracode-wave 1\.9s linear infinite;/g)?.length).toBe(3);
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

  it("pins the gauge weight channel so light never inherits the dark lightness order", () => {
    const components = source("styles/components.css");
    const quota = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");
    const theme = source("styles/theme.css");
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    const whites = theme.slice(theme.indexOf(':root[data-theme="whites"]'));

    // 계기 무게는 테마마다 갈리는 값이다 — base가 채널을 열고 라이트가 전부 분화한다.
    // 한 토큰이라도 라이트에서 빠지면 그 자리만 다크의 명도 순서를 상속해 사다리가 부분적으로 뒤집힌다.
    const GAUGE_TOKENS = [
      "--gauge-face", "--gauge-face-lift", "--gauge-face-lift-strong",
      "--gauge-fill", "--gauge-apex", "--gauge-crest", "--gauge-rim",
      "--gauge-texture", "--gauge-drift",
      "--gauge-weight-quiet", "--gauge-weight-warn", "--gauge-weight-critical",
    ] as const;
    for (const token of GAUGE_TOKENS) {
      expect(base).toContain(`${token}:`);
      expect(whites).toContain(`${token}:`);
      expect(theme.match(new RegExp(`${token}:`, "g"))).toHaveLength(2);
    }

    // 라이트의 무게 사다리는 단조 증가해야 한다 — 이 부등호가 무너지면 평상 막대가 위험 막대보다
    // 무거워지는 실측 결함으로 되돌아간다.
    const weightOf = (token: string): number => {
      const match = whites.match(new RegExp(`${token}: (\\d+)%;`));
      expect(match).not.toBeNull();
      return Number(match![1]);
    };
    const quiet = weightOf("--gauge-weight-quiet");
    const warn = weightOf("--gauge-weight-warn");
    const critical = weightOf("--gauge-weight-critical");
    // 평상은 반드시 신호 두 단보다 가벼워야 한다. 신호 단은 base 명도(L55·L52)가 이미 비텍스트
    // 대비 3:1 하한(합성 L≤60)에 붙어 있어 무게를 더 뺄 수 없다 — 그래서 사다리를 세우는 여유는
    // 중립 잉크 한 단에만 있고, 신호 단이 평상보다 가벼워지는 순간 다시 뒤집힌다.
    expect(quiet).toBeLessThan(warn);
    expect(warn).toBeLessThanOrEqual(critical);
    // 다크 3종은 지금 그림 그대로다 — base는 사다리를 쓰지 않는다(전부 100%).
    expect(base).toContain("--gauge-weight-quiet: 100%;");
    expect(base).toContain("--gauge-weight-critical: 100%;");

    // 손잡이는 "가장 밝은 면"이지 "바탕의 반대"가 아니다 — --text-primary를 쓰면 라이트에서
    // near-black(L22.5) 덩어리가 되어 화면에서 가장 어두운 불투명체가 된다.
    const knob = components.match(/^\.effort-track-knob \{[^}]*\}/m)?.[0] ?? "";
    expect(knob).toContain("background: var(--gauge-face);");
    expect(knob).not.toContain("var(--text-primary)");
    expect(base).toContain("--gauge-face: var(--text-primary);");

    // 합성 그림자 목록 안의 halo는 절대 `none`이 될 수 없다 — 목록 가운데의 none은 선언 전체를
    // 무효로 만들어 라이트에서 게이트 티어 손잡이의 링이 통째로 사라진다.
    expect(whites).not.toMatch(/--(?:apex|crest|brass|positive)-halo: none;/);
    expect(components).toMatch(/var\(--crest-halo\),\s*var\(--gauge-face-lift\);/);
    expect(components).toMatch(/var\(--apex-halo\),\s*var\(--gauge-face-lift\);/);

    // 게이트 티어의 결·표류는 팔레트 토큰으로 꺼진다 — components.css는 테마 분기를 갖지 않는다.
    expect(components).not.toContain('data-theme=');
    expect(components).toMatch(/animation-play-state: var\(--gauge-drift\);/);
    expect(components).toContain("color-mix(in oklch, var(--text-on-brass) var(--gauge-texture), transparent)");

    // 쿼터 막대의 테두리도 같은 채널이다 — 라이트에서는 채움이 옅어져 액자만 남는다.
    const bar = quota.match(/\.quota-meter__bar \{[^}]*\}/)?.[0] ?? "";
    expect(bar).toContain("border: 1px solid var(--gauge-rim);");
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
    expect(tokenBlock).toContain("animation: effort-ultracode-wave 1.9s linear infinite;");
    expect(tokenBlock).toContain("background-size: 200% 100%;");
    // 미러 층이라 자족 폭을 바꾸는 속성은 못 쓴다 — 쓰면 보이는 글자와 캐럿이 어긋난다.
    for (const metric of ["font-weight", "letter-spacing", "word-spacing", "font-size", "font-stretch", "text-transform"]) {
      expect(tokenBlock, metric).not.toContain(`${metric}:`);
    }

    // 도는 호는 @property로 등록된 각도와 폭을 쓴다(미등록이면 커스텀 속성이 계단으로 튄다).
    expect(components).toContain("@property --quick-launch-rim-angle");
    expect(components).toContain("@property --quick-launch-rim-spread");
    expect(components).toContain("@keyframes quick-launch-ultracode-ignite");
    expect(components).toContain("@keyframes quick-launch-ultracode-bead");
    // 순항 키프레임은 시작 각도를 스스로 적어야 한다. `to`만 두면 시작점을 밑에 깔린 값에서
    // 빌리는데, 앞 순번 점화가 `both`로 채워 둔 끝값 360deg가 거기 앉아 있어 순항이 360deg에서
    // 360deg로 돌았다 — 재생은 running인 채 링만 정지했다. 조성만 고정하던 이 계약이 그 정지를
    // 초록으로 통과시켰으므로, 여기서는 시작점 자체를 고정한다.
    expect(components).toMatch(
      /@keyframes quick-launch-ultracode-rim \{\s*from \{ --quick-launch-rim-angle: 0deg; \}\s*to \{ --quick-launch-rim-angle: 360deg; \}\s*\}/,
    );
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

  it("pins the chat composer ultracode grammar — same recognition, apex frame, static border", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const composer = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_COMPOSER_PATH), "utf8");

    // 인식·미러·해제 문법은 Quick Launch와 같은 부품(sdk/composer)에서 온다 — 이 조립은
    // 상태와 표식만 진다. 무장은 초안과 해제 여부에서만 나온다.
    expect(composer).toContain('} from "@fleet-console/sdk/composer";');
    expect(composer).toContain("const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;");
    expect(composer).toContain('${ultracodeArmed ? " is-ultracode" : ""}');
    expect(composer).toContain('renderUltracodeHighlight(draft, ultracodeTokens, "agent-chat-composer-ultracode-token")');
    expect(composer).toContain('<p className="agent-chat-composer-ultracode-notice" role="status">');

    // Backspace 해제는 키 반복도, 수식 키가 붙은 삭제(⌥/Ctrl 단어·⌘ 줄)도 먹지 않는다 —
    // 가로채면 방금 친 단어를 지우려던 키가 아무것도 지우지 않는다(Quick Launch와 같은 계약).
    expect(composer).toContain('event.key === "Backspace" && !event.repeat && ultracodeArmed');
    expect(composer).toContain("&& !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey");

    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 무장 프레임은 apex 채널 하나로만 말한다 — 신호 토큰(aurora/warn/coral/positive)도, 위치
    // 채널(brass)도 빌리지 않는다. Quick Launch의 도는 conic 링과 달리 여기는 정지한 테두리다
    // (좌표의 is-ultracode가 이 면에서 이미 내린 결정). apex×중립 혼합은 oklab이다(hue 호 관통 방지).
    const frame = block(".agent-chat-composer-frame.is-ultracode");
    expect(frame).toMatch(/border-color: color-mix\(in oklab, var\(--apex\)/);
    for (const signal of ["--aurora", "--warn", "--coral", "--positive", "--brass"]) {
      expect(frame, signal).not.toContain(signal);
    }

    // 단어 하이라이트는 좌표 ULTRACODE·강도 트랙과 같은 물결을 공유한다 — 같은 능력이면 같은 어휘다.
    const token = block(".agent-chat-composer-ultracode-token");
    expect(token).toContain("animation: agent-chat-ultracode-wave 1.9s linear infinite;");
    expect(token).toContain("background-size: 200% 100%;");
    // 미러 층이라 자족 폭을 바꾸는 속성은 못 쓴다 — 쓰면 보이는 글자와 캐럿이 어긋난다.
    for (const metric of ["font-weight", "letter-spacing", "word-spacing", "font-size", "font-stretch", "text-transform"]) {
      expect(token, metric).not.toContain(`${metric}:`);
    }

    // 점화는 유한 애니메이션(both)이라 무한 예외에 기대지 않는다 — 상시로 도는 것은 단어 물결뿐이다.
    expect(chat).toContain("@keyframes agent-chat-composer-ignite");

    // 감속 모션: 점화·물결은 세우되 상태는 남긴다 — 정지한 apex 테두리와 단색 apex 단어.
    // 두 규칙 모두 봉인 블록에서만 이 형태를 띤다(무장 블록은 테두리·글로우를 더 얹는다).
    expect(chat).toMatch(/\.agent-chat-composer-frame\.is-ultracode \{\s*animation: none;\s*\}/);
    expect(chat).toMatch(/\.agent-chat-composer-ultracode-token \{\s*animation: none;\s*background-image: none;\s*color: var\(--apex-ink\);\s*-webkit-text-fill-color: var\(--apex-ink\);/);
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
    expect(undoBlock).not.toContain("border-radius: var(--radius-pill);");

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

  it("pins the chat session-coordinate grammar — neutral by default, apex only for ultracode", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const view = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 좌표는 상태(신호)도 위치(brass)도 정체성도 아니다 — 기본형은 어떤 채널도 타지 않는다.
    const chip = block(".agent-chat-coord");
    expect(chip).toContain("border: 1px solid var(--hairline);");
    for (const channel of ["--aurora", "--warn", "--coral", "--positive", "--brass", "--id-"]) {
      expect(chip, channel).not.toContain(channel);
    }

    // 색을 얻는 것은 강도 한 자리이고, 그 어휘는 런치 트랙의 것이다: MAX는 crest, ULTRACODE는 apex.
    expect(block('.agent-chat-coord-effort[data-effort-level="max"]')).toContain("color: var(--crest-ink);");
    const ultra = block('.agent-chat-coord-effort[data-effort-level="ultra"]');
    expect(ultra).toContain("var(--apex-ink)");
    expect(ultra).toContain("animation: agent-chat-ultracode-wave 1.9s linear infinite;");
    // 라이브 물결과 같은 이음매 계약: 200% 이미지에 dP 200이면 한 바퀴의 이동량이 정확히
    // 타일 한 폭이라 되풀이 프레임이 첫 프레임과 같다(옛 240%/dP 240은 3.36W 대 2.4W였다).
    expect(ultra).toContain("background-size: 200% 100%;");
    expect(chat).toMatch(
      /@keyframes agent-chat-ultracode-wave \{\s*from \{ background-position: 0 0; \}\s*to \{ background-position: -200% 0; \}/,
    );

    // apex를 중립 토큰과 섞을 때는 oklab이다 — oklch는 짧은 hue 호를 지나 라이트 테마에서
    // apex(295)와 종이색(100) 사이가 coral(신호 채널)을 관통한다.
    expect(block(".agent-chat-coord.is-ultracode")).toContain("color-mix(in oklab, var(--apex)");

    // 물결은 모션이므로 감속에서 멈춘다. 그라데이션을 지우면서 채움도 되돌려야 글자가 남는다.
    const reduced = chat.slice(chat.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(
      /\.agent-chat-coord-effort\[data-effort-level="ultra"\] \{[\s\S]*?animation: none;[\s\S]*?-webkit-text-fill-color: var\(--apex-ink\);/,
    );

    // 좌표를 말하는 자리는 이제 이 배지 하나다 — 로그 첫 줄의 태생 기록이 퇴역했으므로
    // 좁은 폭에서도 배지가 물러나지 않는다(물러나면 좌표를 볼 길이 사라진다).
    expect(chat).not.toContain(".agent-chat-birth");
    expect(chat).not.toMatch(/@container \([^)]*\) \{\s*\.agent-chat-coord \{\s*display: none;/);

    // 좌표는 사실이지 컨트롤이 아니다 — 세션이 실행 정책을 소유하므로 여기서 바꿀 수 없고,
    // 누를 수 있게 그리면 거짓 약속이 된다.
    expect(view).toMatch(/<span\s+className=\{`agent-chat-coord\$\{/);
    expect(view).not.toMatch(/className="agent-chat-coord"[\s\S]{0,200}onClick/);

    // 이름만으로는 같은 자리에 선 두 모델이 어디서 온 것인지 말하지 못한다 — 공급자 글리프가
    // 마크 자리를 잇는다. 색은 정체성 톤이 아니라 배지의 글자 티어를 따른다(좌표는 정체성
    // 채널을 빌리지 않는다).
    expect(view).toContain("launchProviderGlyph(coordinates.provider)");
    const glyph = block(".agent-chat-coord-glyph");
    expect(glyph).toContain("color: var(--text-tertiary);");
    for (const channel of ["--id-", "--provider-", "--aurora", "--coral"]) {
      expect(glyph, channel).not.toContain(channel);
    }
  });

  it("pins the persistent apex toggle and the pixel-anchored gap", () => {
    const components = source("styles/components.css");
    // 트랙 원본은 컴포저 블록 패키지(sdk/composer)에 산다 — sdk/components/effort-track.tsx는
    // 하위호환 재수출 셔임이라 계약이 읽을 소스가 아니다.
    const trackSource = externalSource(new URL("sdk/composer/effort-track.tsx", CONSOLE_ROOT));

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
    // 스윕은 계속 crest 열을 말하되 무게는 계기 채널이 정한다 — base에서 --gauge-crest는 var(--crest)다.
    expect(components).toMatch(/data-effort-level="max"\] \.effort-track-fill::after \{[^}]*var\(--gauge-crest\)/);
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
      /\.quick-launch-command-row\[data-effort-level="ultra"\]:not\(\.is-active\) \.quick-launch-mention-name \{[\s\S]*?animation: effort-ultracode-wave 1\.9s linear infinite;/,
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
    expect(bandRule).toContain("var(--glass-tint-deep)");
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
    const tileCaption = components.match(/^\.canvas-operation\.is-deck-tile > \.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(tileCaption).toContain("position: relative;");
  });

  it("lets the shell rewrap to the tile instead of scaling a snapshot of it", () => {
    // PTY 리사이즈 허용이 이 구조의 목적이다 — 축소 fit 산술이 되살아나면 글자가 다시 뭉개진다.
    expect(deck).not.toContain("resolveTriagePreviewFit");
    expect(deck).not.toContain("surfaceScale");
    expect(components).not.toContain("canvas-triage-deck-card-preview");
    expect(components).not.toContain("canvas-triage-deck-card");
  });

  it("never magnifies a hovered card — the cell's transform belongs to the density morph alone", () => {
    // hover 확대는 폐기됐다. 겨눈 칸은 링으로만 말하고(아래 hover 계약), 칸을 키우지 않는다 —
    // 확대는 이웃을 덮어 판 전체를 읽지 못하게 만드는 조작이었다.
    expect(components).not.toContain(".canvas-triage-deck-cell.is-quicklook");
    expect(components).not.toContain("--triage-quicklook-scale");
    expect(deck).not.toContain("is-quicklook\"");
    // 칸의 transform 소유자는 밀도 변형 하나뿐이다.
    expect(components).toContain(".canvas-triage-deck-cell.is-morphing {");
    // 전이 소유가 칸이므로 reduced-motion도 칸을 끊는다.
    const reducedMotion = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toMatch(/\.canvas-triage-deck-cell \{\s*transition: none;\s*\}/);
  });

  it("closes the deck tile's state ring across its caption", () => {
    // 카드뷰 캡션은 흐름 안으로 들어오며 자기 보더를 내려놓으므로 윗변을 이을 주체가 패널뿐이다.
    // is-deck-tile 블록의 border-top 1px은 캡션 이음새 규칙과 같은 (0,2,0)이고 이음새가 뒤라서
    // 졌다 — 상태 맥동이 좌·하·우만 칠하는 열린 U가 된다. :has()로 (0,3,0)을 만든 예외가
    // 실제로 이기는 규칙이므로, 이 예외가 사라지면 U가 되돌아온다.
    const tileSeamExemption = components.match(/\.canvas-operation\.is-deck-tile:has\(> \.canvas-operation-titlebar\) \{[^}]*\}/)?.[0] ?? "";
    expect(tileSeamExemption).toContain("border-top-width: 1px;");
    expect(tileSeamExemption).toContain("border-top-style: solid;");
    // 예외는 반드시 이음새 규칙 뒤에 온다 — 앞에 두면 같은 승부를 다시 진다.
    expect(components.indexOf(tileSeamExemption))
      .toBeGreaterThan(components.indexOf(".canvas-operation:has(> .canvas-operation-titlebar) {"));
    // 떠 있는 캡션(Cruise·Tactical·companion)의 계약은 그대로다.
    const tileCaption = components.match(/^\.canvas-operation\.is-deck-tile > \.canvas-operation-titlebar \{[^}]*\}/m)?.[0] ?? "";
    expect(tileCaption).toContain("border: 0;");
  });

  it("puts the deck card's hover mark on the cell, never on the pulsing panel", () => {
    // is-fresh·is-arriving·is-landed가 패널의 border-color와 box-shadow를 키프레임으로 물고 있어,
    // 같은 두 속성에 얹은 hover 선언은 애니메이션 오리진에 진다 — 신호가 가장 급한 카드에서만
    // 위치 마크가 사라지는 조용한 실패다. 그래서 위치는 칸의 box-shadow가 소유한다.
    const hover = components.match(/\.canvas-triage-deck-cell:hover:not\(\.is-morphing\),\n\.canvas-triage-deck-cell:has\(> \.canvas-triage-deck-pick:focus-visible\):not\(\.is-morphing\) \{[^}]*\}/)?.[0] ?? "";
    expect(hover).toContain("box-shadow: 0 0 0 1px color-mix(in oklch, var(--brass) 42%, transparent);");
    expect(hover).toContain("z-index: 6;");
    // 변형 중인 칸은 자기 그림자와 z-index를 이미 소유한다 — 제외하지 않으면 그 칸이 떨어진다.
    expect(hover).not.toContain("--shadow-floating");
    // 위치 마크는 패널의 맥동 속성을 절대 건드리지 않는다.
    expect(components).not.toContain(".canvas-triage-deck-cell:hover > .canvas-triage-deck-mount > .canvas-operation {");
    // 링이 패널의 10px 라운드를 따라가려면 그 링을 그리는 칸에도 같은 반경이 있어야 한다.
    const cellBase = components.match(/\n\.canvas-triage-deck-cell \{[^}]*\}/)?.[0] ?? "";
    expect(cellBase).toContain("border-radius: var(--radius-md);");
    // 포인터와 키보드가 같은 마크를 받는다. 본문 안쪽 링(pick:focus-visible)은 그대로 남는다.
    expect(components).toContain(".canvas-triage-deck-pick:focus-visible {");
    // 겨눈 카드의 캡션 워시는 포커스 패널과 같은 한 값이다 — 새 값을 만들지 않는다.
    const wash = components.match(/\.canvas-triage-deck-cell:hover \.canvas-operation\.is-deck-tile > \.canvas-operation-titlebar,\n[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(wash).toContain("background: color-mix(in oklab, var(--brass) 10%, var(--glass-tint-panel-face));");
    expect(wash).toContain("background-clip: padding-box;");
  });

  it("mixes the map quick-look border in oklab so brass stays on the location channel", () => {
    // oklch는 hue를 극좌표 짧은 호로 보간한다. brass(78)와 surface-rim(245)의 60% 믹스는
    // 실측 hue 144.8(Instrument)·144.2(Maritime)·354(Carbon)에 착지해, 위치 채널이 신호 채널
    // positive(160·152) 옆에 앉거나 마젠타로 넘어갔다. 같은 함정을 캡션 포커스 워시가 이미
    // oklab으로 옮겨 해결했다. War Room 안에서는 지도 점 hover(raw brass)·카드 hover와
    // 같은 색이어야 하므로 이 자리도 oklab이다.
    const mapQuicklook = components.match(/\.canvas-triage-deck-cell\.is-map-quicklook > \.canvas-triage-deck-mount > \.canvas-operation \{[^}]*\}/)?.[0] ?? "";
    expect(mapQuicklook).toContain("border-color: color-mix(in oklab, var(--brass) 60%, var(--surface-rim));");
    expect(mapQuicklook).not.toContain("in oklch");
  });

  it("keeps the deck tile's live body out of reach of both pointer and keyboard", () => {
    // 승격 면은 포인터만 가로챈다 — 본문을 inert로 빼지 않으면 키보드는 그 면을 지나쳐 살아 있는
    // 터미널 textarea·컴포저로 들어가고, 읽는 자리여야 할 칸에 실제 입력이 들어간다.
    expect(frame).toContain('inert={deckTile ? true : undefined}');
    // 캡션은 inert가 아니다 — 최소화·닫기는 키보드로도 닿아야 한다.
    expect(frame).not.toMatch(/canvas-operation-titlebar"[^>]*inert/);
  });

  it("hides Analyst, Chat-view, stop, and composer chrome on a deck tile and keeps them on the stage", () => {
    // 카드 본문은 inert이고 승격 면이 클릭을 가로채므로 컨트롤은 눌러도 동작하지 않는다.
    // 무대에 오른 패널은 is-deck-tile이 아니므로 컨트롤이 기존처럼 보인다.
    const terminalChatCss = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    // 분석가·전환·읽기 폭은 캡션 선반으로 옮겨 갔고, 카드에서는 호스트가 그 선반을 아예 넘기지
    // 않는다 — CSS로 감추는 것이 아니라 태어나지 않는다.
    expect(canvas).toContain("descriptor.captionActions === undefined || options.deckSlot !== null ? null");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-dormant-open");
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-follow");
    // 카드뷰에서는 컴포저가 스트립조차 서지 않는다 — 입력은 무대에 올라야 가능한 행동이다.
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-composer");
    // 컴포저가 물러난 자리에는 그 받침(중앙 배치용 비율)도 함께 물러난다 — 남겨 두면 대화가
    // 카드 위쪽으로 몰린다.
    expect(terminalChatCss).toContain(".canvas-operation.is-deck-tile .agent-chat-settle");
    const hide = terminalChatCss.match(/\.canvas-operation\.is-deck-tile \.agent-chat-dormant-open,[\s\S]{0,400}?\.canvas-operation\.is-deck-tile \.agent-chat-composer \{[^}]*\}/)?.[0] ?? "";
    expect(hide).toContain("display: none;");
    // 선택(무대) 축은 카드 클래스의 부재다 — is-active나 지도 확대창 클래스에 묶이면 카드이면서
    // 선택된 칸, 또는 판 위로 끌어올린 칸에서 다시 그려진다.
    expect(hide).not.toContain("is-active");
    expect(hide).not.toContain("is-quicklook");
    // 카드의 로그는 초대 하한만 되돌린다. 여백은 손대지 않는다 — 피할 부유 칩이 사라져 베이스가
    // 이미 space-3이고, 하단 45px는 작업 스트립의 몫이라 단축 padding으로 덮으면 죽는다.
    const logOnTile = terminalChatCss.match(/\.canvas-operation\.is-deck-tile \.agent-chat-log \{[^}]*\}/)?.[0] ?? "";
    expect(logOnTile).toContain("min-height: 0;");
    expect(logOnTile).not.toContain("45px");
    expect(logOnTile).not.toContain("padding-bottom");
    expect(logOnTile).not.toMatch(/(?:^|[^-])padding:/);
    // 회신·중지가 없으면 스트립이 그 폭을 비우지 않는다. 스트립 자체는 숨기지 않는다.
    const stripOnTile = [...terminalChatCss.matchAll(/\.canvas-operation\.is-deck-tile \.agent-chat-strip \{[^}]*\}/g)].map((match) => match[0]);
    expect(stripOnTile).toHaveLength(1);
    expect(stripOnTile[0]).toContain("max-width: min(var(--agent-chat-measure), calc(100% - 2 * var(--space-3)));");
    expect(stripOnTile[0]).not.toContain("40px");
    expect(stripOnTile[0]).not.toContain("72px");
    expect(stripOnTile[0]).not.toContain("display: none");
    expect(hide).not.toContain("agent-chat-strip");
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
