import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANE_CONTAINER_INSET_ALLOWANCE,
  PANE_WIDTH_CLASS_PX,
  resolvePaneDefaultWidth,
} from "../core/client/src/chrome/rail/pane-width.js";

const CONSOLE_ROOT = new URL("../", import.meta.url);
const CLIENT_ROOT = new URL("../core/client/src/", import.meta.url);
const PRODUCT_SOURCE_ROOTS = [
  new URL("core/client/src/", CONSOLE_ROOT),
  new URL("features/", CONSOLE_ROOT),
] as const;
const CSS_SOURCE_ROOTS = [
  new URL("core/client/src/", CONSOLE_ROOT),
  new URL("features/", CONSOLE_ROOT),
] as const;
const STANDALONE_CSS_SOURCES = [
  new URL("foundation/markdown/styles.css", CONSOLE_ROOT),
  new URL("foundation/font-picker/styles.css", CONSOLE_ROOT),
] as const;
const CODEX_COMPONENTS_CSS_PATH = new URL("features/codex/client/codex/styles/components.css", CONSOLE_ROOT);
const CODEX_LAYOUT_CSS_PATH = new URL("features/codex/client/codex/styles/layout.css", CONSOLE_ROOT);
const CSS_THEME_SOURCES = [
  new URL("core/client/src/styles/theme.css", CONSOLE_ROOT),
  new URL("features/codex/client/codex/styles/theme.css", CONSOLE_ROOT),
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
const SCUTTLEBUTT_CSS_PATH = new URL("../features/scuttlebutt/client/styles.css", import.meta.url);
const TERMINAL_AGENT_PATH = new URL("../features/execution/client/agent/index.tsx", import.meta.url);
const TERMINAL_AGENT_CLI_CSS_PATH = new URL("../features/execution/client/agent/agent-cli.css", import.meta.url);
const TERMINAL_SURFACE_PATH = new URL("../features/execution/client/terminal/shared/terminal-surface.tsx", import.meta.url);
const TERMINAL_CHAT_VIEW_PATH = new URL("../features/execution/client/agent/chat/chat-view.tsx", import.meta.url);
const TERMINAL_CHAT_COMPOSER_PATH = new URL("../features/execution/client/agent/chat/composer.tsx", import.meta.url);
const TERMINAL_CHAT_COORDINATE_MENU_PATH = new URL("../features/execution/client/agent/chat/coordinate-menu.tsx", import.meta.url);
const TERMINAL_CHAT_CSS_PATH = new URL("../features/execution/client/agent/chat/chat.css", import.meta.url);
const QUOTA_CSS_PATH = new URL("../features/quota/client/quota.css", import.meta.url);
const QUOTA_PANEL_PATH = new URL("../features/quota/client/quota-panel.tsx", import.meta.url);
const FILE_EXPLORER_CSS_PATH = new URL("../features/file-explorer/client/explorer.css", import.meta.url);
const REPOSITORY_CSS_PATH = new URL("../features/repository/client/repository.css", import.meta.url);
const FONT_PICKER_CSS_PATH = new URL("../foundation/font-picker/styles.css", import.meta.url);
const ONBOARDING_CSS_PATH = new URL("../features/onboarding/client/onboarding.css", import.meta.url);
const SDK_RAIL_TYPES_PATH = new URL("../features/workspace/shared/rail.ts", import.meta.url);
const SDK_CAPTION_ACTIONS_PATH = new URL("../features/workspace/client/components/caption-actions.tsx", import.meta.url);
const OWNED_SOURCES = [
  "app/app.tsx",
  "../../../features/workspace/client/conversation/new-session.tsx",
  "../../../features/workspace/client/conversation/new-session.css",
  "../../../features/workspace/client/objective-records.tsx",
  "chrome/components/command-band-system-cluster.tsx",
  "../../../features/workspace/client/sidebar/objective-records-side-bar.tsx",
  "styles/theme.css",
  "styles/components.css",
  "styles/layout.css",
  "styles/rail.css",
] as const;

const FORBIDDEN_DECORATION = /radar-sweep|objective-records-radar|BACKGROUND_ANIMATION_STORAGE_KEY|PERIMETER_ANIMATION_STORAGE_KEY|Panel pulse|perimeter-orbit|notification-wake-pulse|AnchorIcon/;
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
  ".effort-track-fill::after",
  ".effort-track-fill::before",
  ".app-toast-close",
  ".directory-browser-close",
  ".directory-browser-sector-advance",
  ".whatsnew-close",
  ".alerts-icon-badge",
  ".fexp-refresh-btn",
  ".history-commit-avatar",
  ".agent-chat-fold-chev",
] as const;
const RAW_TEXT_INK_TOKENS = /var\(\s*--ink-(?:fog|rim|spectral|pearl)\b/;
// color 값 안의 정확한 base brass. --brass-ink·--brass-glow·--brass-bright는 닫는 괄호가 바로 오지 않아 빠진다.
const TEXT_BASE_BRASS = /var\(\s*--brass\s*\)/;
const NUMERIC_FONT_WEIGHT = /^(?:[1-9]\d{0,2}|1000)\b/;
const RUNTIME_CUSTOM_PROPERTY_ALLOWLIST = new Set([
  // Sidebar chip and cluster-row TSX inject each Objective's identity accent through inline styles.
  "--user-accent",
  // Sidebar TSX injects its measured width for the shell layout.
  "--side-bar-width",
  // Sidebar TSX injects transient drag offsets for chips and group headers.
  "--drag-dy",
  // Sidebar TSX injects the persisted group tone used by group-scoped surfaces.
  "--grp-color",
  // Sidebar chip TSX injects the group marker tone for each rendered mark.
  "--group-mark",
  // Accent swatch TSX injects each --id-* tone onto its own swatch dot.
  "--accent-swatch-color",
  // What's New TSX injects each section's reveal delay.
  "--whatsnew-delay",
  // Right Rail TSX injects the current panel width.
  "--right-rail-panel-width",
  // SDK SettingsSlider injects the filled-track stop, aligned to the knob center.
  "--slider-fill",
  // Repository Rail TSX injects the user-resized workspace tree width.
  "--ws-tree-width",
  // Repository commit/compare inspector TSX injects the user-resized dock file-list width.
  "--ws-dock-files-width",
  // Chat context popover TSX injects the category-stack luminance step (0–5).
  "--agent-chat-ctx-step",
]);

function source(path: string): string {
  return fs.readFileSync(new URL(path, CLIENT_ROOT), "utf8").replace(/\r\n/g, "\n");
}

/* theme.css의 모바일 팔레트 구역은 Console 테마가 아니라 모바일 배치의 루트 오버레이다. 테마 사이의
   토큰 분화 수를 세는 단언은 그 앞(데스크톱 테마 구역)만 본다 — 모바일 구역은 자기 계약이 고정한다. */
const MOBILE_PALETTE_MARKER = "/* ── 모바일 팔레트";

function desktopThemeSource(): string {
  const theme = source("styles/theme.css");
  const start = theme.indexOf(MOBILE_PALETTE_MARKER);
  return start < 0 ? theme : theme.slice(0, start);
}

/* 선언 스캔용 — 콜론을 담은 주석 한 줄이 팔레트 선언으로 오독되는 것을 막는다. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
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
  it("keeps the Codex health popover below blocking modal layers", () => {
    const codexComponents = externalSource(CODEX_COMPONENTS_CSS_PATH);
    const popover = codexComponents.match(/\.codex-nav-health-popover \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(popover).toContain("position: fixed;");
    expect(popover).toContain("z-index: 70;");
    expect(popover).not.toContain("var(--z-overlay)");
  });

  it("collapses backend API rows against their Settings card width", () => {
    const components = source("styles/components.css");
    const section = components.match(/\.backend-api-section \{[^}]*\}/)?.[0] ?? "";
    const narrowContainer = components.match(/@container \(max-width: 720px\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(section).toContain("container-type: inline-size;");
    expect(narrowContainer).toContain(".backend-api-row {");
    expect(narrowContainer).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(components).not.toMatch(/@media \(max-width: 720px\) \{\s*\.backend-api-row/);
  });

  it("keeps the interaction control recipe theme-owned", () => {
    const theme = source("styles/theme.css");
    const root = theme.match(/^:root \{[\s\S]*?^\}/m)?.[0] ?? "";
    // Quiet Controls C′: rest는 침묵이 아니라 낮은 목소리다(2026-09-01 저장소 실측 재가) —
    // 동사·컨트롤은 rest 채널(--control-rest)의 면만으로 쉬는 몸을 알리고, 테두리는 상태가
    // 소유한다. 입력 필드만 --control-field 면 + 헤어라인을 유지한다. 지속 상태는 accent가 아니라 세 문장으로 갈린다 —
    // 배타 선택 = 극저대비 워시(wash) + 잉크 대비 + 2px brass 다텀, 독립 ON = 잉크(tint),
    // 불리언 ON = 워시 + brass 글리프. 열림·focus-within은 open-rim이 진다.
    for (const token of [
      "--control-hover-fill",
      "--control-hover-rim",
      "--control-rest",
      "--control-rest-hover",
      "--control-field",
      "--control-wash",
      "--control-wash-hover",
      "--control-tint-fill",
      "--control-tint-ink",
      "--control-open-rim",
      "--control-focus-ring",
      "--control-disabled-opacity",
    ]) expect(root).toContain(`${token}:`);
    expect(root).toContain("--control-hover-fill: color-mix(in oklab, var(--brass) 8%, transparent);");
    expect(root).toContain("--control-tint-fill: color-mix(in oklab, var(--brass) 9%, transparent);");
    expect(root).toContain("--control-open-rim: color-mix(in oklab, var(--brass) 56%, var(--surface-rim));");
    // 워시는 잉크 사다리의 한 칸이 아니라 테마별 리터럴이다 — 라이트가 자기 값으로 재조율한다
    // (다크는 화이트 워시, 라이트는 잉크 워시로 극이 뒤집힌다).
    for (const name of ["light"]) {
      const blocks = theme.match(new RegExp(`^:root\\[data-theme="${name}"\\] \\{[\\s\\S]*?\\n\\}`, "gm")) ?? [];
      expect(blocks.some((block) => block.includes("--control-wash:") && block.includes("--control-wash-hover:"))).toBe(true);
      // rest·field도 같은 극성 재조율 대상이다 — 라이트의 field는 잉크 워시가 아니라 종이보다 밝은 실색.
      expect(blocks.some((block) => block.includes("--control-rest:") && block.includes("--control-field:"))).toBe(true);
    }
    // 옛 selected recipe(테두리+채움+brass 글자 동시 발화)와 융기(thumb) recipe는 퇴역했다 — 부활 금지.
    expect(theme).not.toContain("--control-selected-fill");
    expect(theme).not.toContain("--control-selected-rim");
    expect(theme).not.toContain("--control-thumb");
    expect(theme).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--control-focus-ring\);/);
    // 고대비 환경에서는 워시가 걷히므로 선택을 시스템 선택색으로 직접 말한다(리뷰 확인 사항).
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    expect(components).toContain("background: SelectedItem;");
    expect(layout).toContain("background: SelectedItem;");
  });

  it("keeps selected controls stronger than hover and preserves forced-color form state", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const explorer = externalSource(FILE_EXPLORER_CSS_PATH);
    const repository = externalSource(REPOSITORY_CSS_PATH);

    expect(layout).not.toContain(".command-band-mode-seg");
    expect(layout).not.toContain(".command-band-mode-tool");
    expect(source("../../../features/remote-access/client/console-section.css")).toContain('.console-section-row:hover:not([aria-disabled="true"])');
    expect(components).toContain('.fleet-caption-action:hover:not(:disabled):not([aria-pressed="true"])');
    expect(explorer).toContain('.fexp-view-mode button:hover:not(:disabled):not([aria-pressed="true"])');
    expect(repository).toContain(".repository-toggle-btn:hover:not(.is-active)");

    for (const css of [components, repository]) {
      expect(css).toContain("@media (forced-colors: active)");
      expect(css).toContain("appearance: auto;");
    }
  });

  it("keeps Settings, SDK Select, and Font Picker on the shared control recipe", () => {
    const components = source("styles/components.css");
    const terminalSettings = externalSource(TERMINAL_AGENT_CLI_CSS_PATH);
    const fontPicker = externalSource(FONT_PICKER_CSS_PATH);

    for (const selector of [
      ".segmented-option:hover:not(:disabled):not(.is-active)",
      '.fc-select__trigger:hover:not(:disabled):not([aria-expanded="true"])',
      '.fc-select__option[data-active="true"]:not([aria-disabled="true"]):not([aria-selected="true"])',
      // 설정 도움말 '?' 글리프 — hover/open이 같은 컨트롤 레시피를 소비한다(위치 채널, 신호 토큰 금지).
      '.settings-help-tip__glyph:hover:not([aria-expanded="true"])',
      '.settings-help-tip__glyph[aria-expanded="true"]',
    ]) expect(components).toContain(selector);
    for (const token of [
      "var(--control-hover-fill)",
      "var(--control-hover-rim)",
      "var(--control-wash)",
      "var(--control-focus-ring)",
      "var(--control-disabled-opacity)",
    ]) {
      expect(components).toContain(token);
      expect(terminalSettings).toContain(token);
      expect(fontPicker).toContain(token);
    }
    expect(fontPicker).toContain('.fc-font-browser__row:hover:not(:disabled):not(.is-active):not([aria-selected="true"])');
    expect(fontPicker).toContain('@media (forced-colors: active)');
    expect(components).toContain('.fc-settings-toggle:has(.fc-settings-toggle__input:focus-visible)');
    expect(components).toContain('.fc-settings-toggle:has(.fc-settings-toggle__input:disabled)');
  });

  it("keeps one control grammar on the caption band", () => {
    const components = source("styles/components.css");
    const shelf = externalSource(SDK_CAPTION_ACTIONS_PATH);

    const grid = components.match(/\.fleet-caption-action\s*\{[^}]*\}/)?.[0] ?? "";
    expect(grid).toContain("width: 24px;");
    expect(grid).toContain("height: 24px;");
    const svgSize = components.match(/\.fleet-caption-action svg\s*\{[^}]*\}/)?.[0] ?? "";
    expect(svgSize).toContain("width: 14px;");

    // 선택·hover는 theme.css의 control recipe 하나를 소비한다. hover와 focus를 한
    // 선택자로 합치면 마우스를 스칠 때도 외곽 focus ring이 떠 입력 수단의 신호가 사라진다.
    // 불리언 ON = 워시 + 글리프: 면은 극저대비 워시이고 켬은 글리프의 brass가 말한다.
    const pressed = components.match(/\.fleet-caption-action\[aria-pressed="true"\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pressed).toContain("border-color: transparent;");
    expect(pressed).toContain("background: var(--control-wash);");
    expect(pressed).not.toContain("box-shadow");
    expect(pressed).toContain("color: var(--brass-bright);");
    const hover = components.match(/\.fleet-caption-action:hover:not\(:disabled\):not\(\[aria-pressed="true"\]\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hover).toContain("border-color: var(--control-hover-rim);");
    expect(hover).toContain("background: var(--control-hover-fill);");
    expect(hover).not.toContain("outline:");
    const focus = components.match(/\.fleet-caption-action:focus-visible:not\(\[aria-pressed="true"\]\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(focus).toContain("border-color: var(--control-hover-rim);");
    expect(focus).not.toContain("outline: none;");

    // 진행은 aurora(상태)로, 위치는 brass로 — 한 버튼 위에서도 두 채널이 겹치지 않는다.
    const live = components.match(/\.fleet-caption-action-live \{[^}]*\}/)?.[0] ?? "";
    expect(live).toContain("background: var(--aurora);");
    expect(live).not.toContain("--brass");

    // 라벨 없는 마크가 서는 줄이므로 이름표는 전부 같은 말풍선이다 — 브라우저 기본 title은 쓰지 않는다.
    expect(shelf).toContain('className="fleet-caption-slot"');
    expect(shelf).toContain('className="fleet-caption-tip"');
    const tip = components.match(/^\.fleet-caption-tip \{[^}]*\}/m)?.[0] ?? "";
    expect(tip).toContain("right: 0;");
    expect(tip).toContain("pointer-events: none;");

    // 이름표는 겨누는 동안만 뜬다 — 클릭이 남긴 포커스로 열면 눌러도 그 자리에 남는 버튼(전체 칸)에서
    // 풍선이 붙박이가 된다. 키보드로 짚어 온 포커스만 겨눔으로 친다.
    const tipReveal = components.match(/\.fleet-caption-slot:hover \.fleet-caption-tip,\n[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(tipReveal).toContain(":has(:focus-visible)");
    expect(tipReveal).not.toContain(":focus-within");
  });


  it("removes ambient radar, panel pulse, perimeter wake, and anchor surfaces", () => {
    for (const path of OWNED_SOURCES) expect(source(path)).not.toMatch(FORBIDDEN_DECORATION);
  });

  it("keeps glass fallbacks and focus grammar without deprecated accent variables", () => {
    const css = OWNED_SOURCES.filter((path) => path.endsWith(".css")).map(source).join("\n");
    expect(css).not.toMatch(/--op-accent|--chip-accent/);
    // 게이트와 폴백 기본값은 theme.css에 존재해야 한다 — 채널 기본값이 곧 구 불투명 계약이다.
    const theme = source("styles/theme.css");
    expect(theme).toContain("--glass-underlay: var(--ink-deep);");
    expect(theme).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain("background: var(--surface-glass)");
    expect(css).toContain(":focus-visible");
    // brass 채움 버튼은 전용 on-brass 텍스트 티어를 소비한다 — abyss 재결합은 라이트 AA 회귀다.
    expect(css).toMatch(/\.fc-btn--primary \{[^}]*color: var\(--text-on-brass\);/);
  });

  /* 라이트(Whites)는 리퀴드 글래스를 받지 않는다 — 게이트가 극성으로 닫히므로, 라이트 블록에
     유리 재료가 남으면 죽은 리터럴이고, 재료만 지운 채 게이트를 안 닫으면 라이트가 base(다크)
     재료를 상속해 밤빛 유리를 칠한다. */
  it("keeps glass material out of the light theme", () => {
    const theme = source("styles/theme.css");
    // 라이트 블록에는 유리 재료 선언이 한 줄도 없다. 주석은 그 부재를 설명해야 하므로
    // 토큰 이름을 그대로 적는다 — 계약은 산문이 아니라 선언에만 걸린다.
    const whites = theme.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(whites).not.toBe("");
    const whitesDeclarations = whites.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(whitesDeclarations).not.toMatch(/--(?:glass|canvas)-on-/);
  });

  /* 페인 이전과 함께 퇴역한 축소판의 기존 금지만 남긴다. 폭·줄바꿈은 실앱 증거로 검증한다. */
  it("retires the appearance preview when settings moves into the rail", () => {
    const components = source("styles/components.css");
    const settings = source("../../../features/settings/client/sections.tsx");
    expect(components).not.toContain("appearance-preview");
    expect(settings).not.toContain("AppearancePreview");
    expect(source("i18n/messages/pages.ts")).not.toContain("settings.preview.");
  });

  // 다크 유리의 판독 계약 — 유리 뒤가 앱에서 가장 어두운 캔버스라 투과는 명도를 빼기만 한다.
  it("keeps the dark glass pane lit and the terminal field single-layered", () => {
    const theme = source("styles/theme.css");

    // 새 채널 셋의 닫힌-게이트 기본값이 곧 구 불투명 계약이다.
    expect(theme).toContain("--glass-tint-field: var(--surface-panel);");
    expect(theme).toContain("--glass-pane-light: transparent;");
    // 다크는 Ghostty 계열 smoked pane처럼 60% tint로 뒤의 캔버스·겹친 창 윤곽을 통과시킨다.
    // pane-light는 22%만 얹고 terminal도 같은 반투명 tint(panel과 한 장)를 쓴다. 알파는 테마마다 고정이다.
    for (const raw of ["18.5% 0.028 245"]) {
      expect(theme).toContain(`--glass-on-tint-panel: oklch(${raw} / 60%);`);
    }
    expect(theme.match(/--glass-on-tint-terminal:/g)).toHaveLength(1);
    expect(theme).toContain("--glass-on-tint-terminal: var(--glass-on-tint-panel);");
    expect((theme.match(/--glass-on-pane-light: oklch\([^)]+\/ 22%\);/g) ?? []).length).toBe(1);
    // 유리를 받는 테마는 다크뿐이고, 필드를 루트 유리에 넘긴다.
    // 라이트는 게이트 밖이라 재료 자체가 없다(별칭 한 줄도 남기지 않는다).
    expect((theme.match(/--glass-on-tint-field: transparent;/g) ?? []).length).toBe(1);
    expect(theme).not.toMatch(/--glass-on-tint-field: var\(/);
  });

  /* 비운 터미널 필드의 RGB는 검정이 아니라 유리 톤이어야 한다. xterm은 dim(SGR 2)을 배경 워드의
     플래그로 실어 기본 배경 셀에도 배경 사각형을 만들고, 그 사각형만 알파를 1로 강제한다 —
     RGB가 (0,0,0)이면 dim 셀이 유리 위에서 순수 검정으로 드러난다(Claude Code diff 거터 실측). */
  it("clears the dark glass terminal field to a glass-toned floor", () => {
    const theme = source("styles/theme.css");
    const surface = fs.readFileSync(fileURLToPath(TERMINAL_SURFACE_PATH), "utf8");

    // 닫힌 게이트의 기본값은 곧 현행 불투명 계약이다 — floor가 따로 놀면 게이트를 닫아도 색이 갈린다.
    expect(theme).toContain("--glass-tint-terminal-floor: var(--glass-tint-terminal);");
    expect(theme).toContain("--glass-tint-terminal-floor: var(--glass-on-tint-terminal-floor);");
    // Objective 패널용 floor는 60% panel tint를 캔버스 대기광 위에 sRGB alpha 합성한 불투명 근사다.
    expect(theme).toContain("--glass-on-tint-terminal-floor: oklch(17.5% 0.026 245);");

    // Objective은 floor, 독립 Shell은 terminal tint 계산값을 읽어 알파만 0으로 눕힌다.
    expect(surface).toContain('surface === "shell" ? "--glass-tint-terminal" : "--glass-tint-terminal-floor"');
    expect(surface).toContain("return glassFieldClearColor(");
    // 검정 리터럴을 그대로 돌려주면 dim 셀 회귀가 재발한다 — 반환은 폴백 두 곳뿐이다.
    expect((surface.match(/return "rgba\(0, 0, 0, 0\)";/g) ?? []).length).toBe(2);
  });

  /* 베벨·부양·워시·블룸 넷은 라이트 유리 전용 재료였다. 라이트가 게이트에서 빠지면서 어느
     테마도 이 재료를 갖지 않으므로, 게이트는 더 이상 이 채널을 싣지 않고 채널은 base의 중립
     기본값 하나로 산다. 재료 없는 채널에 fallback 다리를 남겨 두면 "여기 라이트 재료가 있다"고
     거짓말하는 죽은 줄이 되고, 반대로 채널까지 지우면 소비처가 통째로 무너진다. */
  it("keeps the bevel, lift, wash and bloom channels neutral now that no theme feeds them", () => {
    const theme = source("styles/theme.css");

    // 채널의 중립 기본값이 곧 이제 모든 테마가 보는 값이다.
    expect(theme).toContain("--glass-bevel: transparent;");
    expect(theme).toContain("--glass-lift: var(--shadow-floating);");

    // 재료도, 그 재료를 싣던 게이트 다리도 남아 있지 않다.
    for (const material of [
      "--glass-on-bevel",
      "--glass-on-lift",
      "--canvas-on-wash-near",
      "--canvas-on-wash-mid",
      "--canvas-on-wash-far",
      "--canvas-on-bloom-aurora",
      "--canvas-on-bloom-brass",
    ]) {
      expect(theme).not.toContain(material);
    }
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
        if (selector.includes(".canvas-mode-title-kicker")) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 글자 color의 brass는 ink 티어다. base --brass는 배경·테두리·도트·비콘 전용이고, 다크 3종은
  // 별칭이라 같아 보이지만 Whites만 L 45%로 갈라진다. color 선언(color-mix 포함)에 base를 쓰면
  // 라이트 대비가 그 자리에서 무너지는데, 다크 화면과 기존 원료 잉크 스캔은 이것을 못 본다.
  it("keeps brass text color on the ink tier", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      for (const declaration of cssDeclarations(masked, "color")) {
        if (!TEXT_BASE_BRASS.test(declaration.value)) continue;
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
    // 모바일 사다리의 단 이름은 theme.css 모바일 구역의 정의에서 읽는다 — 단을 하나 더해도 이 목록을 따로
    // 고칠 일이 없고, 정의되지 않은 이름은 여전히 거부된다.
    const mobileSteps = [...source("styles/theme.css").matchAll(/^\s*--m-fs-([a-z]+)\s*:/gm)].map((match) => match[1]!);
    expect(mobileSteps.length).toBeGreaterThan(0);
    const MOBILE_TYPE_STEP = new RegExp(`var\\(\\s*--m-fs-(?:${[...new Set(mobileSteps)].join("|")})\\s*\\)`);
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
        // 모바일 배치는 Console과 다른 자기 사다리를 갖는다(시안 크기 이름, theme.css 모바일 팔레트
        // 구역에서만 정의). 데스크톱에서는 정의되지 않으므로 모바일 전용 선택자 아래에서만 의미가 있다.
        if (MOBILE_TYPE_STEP.test(value)) return false;
        if (/var\(\s*--font-(?:body|ui|content|code)-size\s*\)/.test(value)) return false;
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

  // 라운드 어휘는 컨트롤(xs)·면(md)·떠 있는 판(lg 팝업 · xl 대화상자 · sheet 모바일 시트)·pill 여섯뿐이다.
  // raw 999px가 살아 있으면 같은 캡슐을 두 이름으로 부르게 되고, 퇴역한 sm이 되살아나면 이름이 다시 값보다 많아진다.
  it("keeps border radius on the named vocabulary", () => {
    const violations: string[] = [];
    for (const file of listProductCssFiles()) {
      const css = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const masked = maskCssCommentsAndStrings(css);
      for (const declaration of cssDeclarations(masked, "border-radius")) {
        if (!/999px|--radius-sm\b/.test(declaration.value)) continue;
        const line = lineAt(css, declaration.index);
        violations.push(`${consoleRelativePath(file)}:${line} ${css.split("\n")[line - 1]!.trim()}`);
      }
      for (const match of masked.matchAll(/var\(\s*--radius-sm\b/g)) {
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
      // markdown/styles.css는 light-dark()의 라이트 쪽 vendored highlight.js 팔레트(github)가 파일 상단
      // doctrine 주석으로 예외 선언된 표면이다. 다크 쪽은 --syntax-* 채널을 쓴다.
      if (file === fileURLToPath(new URL("foundation/markdown/styles.css", CONSOLE_ROOT))) continue;
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

  it("keeps user identity on the chip title ink and off the chip spine and state border channel", () => {
    const chip = source("../../../features/workspace/client/sidebar/objective-records-side-bar-chip.tsx");
    const components = source("styles/components.css");
    const chipIdleBlock = components.match(/\.side-bar-chip\[style\*="--user-accent"\] \.side-bar-chip-name \{[^}]*\}/)?.[0] ?? "";
    const chipActiveBlock = components.match(/\.side-bar-chip\[style\*="--user-accent"\]\.side-bar-chip--active \.side-bar-chip-name \{[^}]*\}/)?.[0] ?? "";

    expect(chip).toContain('{ "--user-accent": accentValue }');
    // 캡션 명판·스파인·미니맵 도트는 캔버스와 함께 떠났다. 정체성은 사이드바 제목 잉크다.
    expect(components).not.toContain("color-mix(in oklch, var(--user-accent) 10%, var(--surface-panel))");
    // 정체성은 보더 채널을 소유하지 않는다 — 보더는 상태(brass/aurora/coral) 전용.
    expect(components).not.toContain("border-color: var(--user-accent)");
    // 사이드바 칩은 3px 좌측 스파인을 쓰지 않는다. 언포커스는 3티어 글자색 쪽으로 섞는다.
    expect(components).not.toContain('.side-bar-chip[style*="--user-accent"]::before');
    expect(chipIdleBlock).toContain("color: color-mix(in oklab, var(--user-accent) 70%, var(--text-tertiary));");
    expect(chipIdleBlock).not.toContain("var(--surface-panel)");
    // hover/active도 원색이 아니라 2티어 글자색 쪽 믹스 — Whites chrome 워시 위 본문 AA의 하한이다.
    expect(chipActiveBlock).toContain("color: color-mix(in oklab, var(--user-accent) 75%, var(--text-secondary));");
    // 소비처는 사이드바 칩·클러스터 행의 제목 잉크 두 단(언포커스·hover/active)뿐이다.
    expect(components.match(/var\(--user-accent\)/g)).toHaveLength(2);
    expect([chip, components].join("\n")).not.toMatch(/--op-accent|--chip-accent/);
  });

  it("keeps no Objective caption owned by a surface that is no longer an Objective", () => {
    // Shell은 Objective 캡션을 갖지 않는다. 이름 마크가 Shell 전용 표식을 되살리면
    // 목록이 다시 종류를 활동 칸에 그린다.
    const nameMark = source("../../../features/execution/client/components/objective-name-mark.tsx");
    expect(nameMark).not.toContain("ShellKindMark");
  });

  it("pins the AI Gateway capability-class grammar — a word in the row's meta line, never a badge or a signal colour", () => {
    // 등급은 Objective 상태가 아니라 프로바이더가 자기 라인업에 대해 주장하는 속성이다.
    // 대문자 테두리 배지로 세우면 이름보다 먼저 읽히고, 신호색을 빌리면 같은 행에서 등급이 상태처럼 읽힌다 —
    // 그래서 등급은 모델 행과 팔레트 항목의 보조 줄 첫 낱말로만 선다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    expect(css).not.toContain(".ai-gateway-class-badge");
    for (const selector of [".ai-gateway-model-meta", ".ai-gateway-palette-hit-hint"]) {
      const rules = [...css.matchAll(new RegExp(`([^{}]*\\${selector}[^{}]*)\\{([^}]*)\\}`, "g"))];
      expect(rules.length).toBeGreaterThan(0);
      for (const [, , body] of rules) {
        expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
        expect(body).not.toContain("text-transform: uppercase");
      }
    }
  });

  it("pins the Objective list-surface mark grammar — activity owns the name-left slot, provider stays off list surfaces", () => {
    // 공급자 마크는 새 Objective의 실행 좌표를 고르는 표면에만 남는다 — 이미 존재하는 Objective을
    // 고르는 목록(사이드바 칩·커맨드 밴드·검색 팔레트·새 세션 '@' 멘션)의 이름 왼쪽 슬롯은
    // 활동 상태가 소유한다. 목록에서 먼저 읽혀야 하는 것은 무엇으로 띄웠는지가 아니라 지금 무엇을
    // 하고 있는지다. 마지막 공용 소비자였던 팔레트가 떠나면서 .objective-provider-mark 대조표는
    // 퇴역했다 — 실행 좌표의 톤은 --launch-provider-tone 축이 맡는다(아래 테스트가 그 축을 고정한다).
    const css = source("styles/components.css");
    const mentionSheet = source("../../../features/workspace/client/conversation/mobile-new-session-sheet.tsx");
    // 행 시작의 셀렉터만 잡는다 — 퇴역 사실을 기록한 독트린 주석이 클래스 이름을 언급해도 무방하다.
    expect(css).not.toMatch(/(^|\n)\.objective-provider-mark/);
    // 목록 표면은 공급자를 세지 않는다 — 그 자리는 활동 상태가 소유한다.
    expect(source("../../../features/workspace/client/sidebar/objective-records-side-bar-chip.tsx")).not.toContain("objective-provider-mark");
    expect(source("chrome/components/objective-search.tsx")).not.toContain("objective-provider-mark");
    expect(mentionSheet).not.toContain("launchProviderGlyph(entry.launchProvider)");
    // 팔레트와 새 세션 '@' 멘션 행은 사이드바 칩과 같은 마크 하나로 상태를 말한다 — 별도 활동
    // 뱃지를 되살리면 같은 사실이 한 행에서 두 번 발화된다.
    expect(source("chrome/components/objective-search.tsx")).toContain("<ObjectiveNameMark");
    expect(source("chrome/components/objective-search.tsx")).toContain("resolveObjectiveMarkVisual");
    expect(source("chrome/components/objective-search.tsx")).not.toContain("objective-search-status--");
    expect(mentionSheet).toContain("<ObjectiveNameMark");
    expect(mentionSheet).toContain("resolveObjectiveMarkVisual");
    expect(mentionSheet).not.toContain("objective-search-status--");
  });

  it("pins the provider tone table as one axis — every gateway provider named on both surfaces", () => {
    // 공급자 색 대조표는 --provider-* 축 하나다. 표에서 빠진 공급자는 컴파일도 렌더도 실패하지
    // 않고 조용히 회색으로 떨어지며, AI Gateway 칩의 경우 톤이 미정의라 color-mix()가 통째로
    // 무효화되어 테두리·배경까지 사라진다 — 같은 공급자가 두 화면에서 다른 마크로 읽힌다.
    const providers = ["antigravity", "codex", "xai"] as const;
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
    // Quota 팝업과 다른 색으로 불린다.
    for (const [, body] of gatewayCss.matchAll(/\.ai-gateway-provider\.is-[a-z]+ \{([^}]*)\}/g)) {
      expect(body).toMatch(/var\(--provider-[a-z]+\)/);
    }

    // Quota 팝업은 Claude Code까지 세므로 한 공급자가 더 많다.
    const quotaCss = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");
    for (const provider of [...providers, "claude"]) {
      expect(quotaCss).toContain(`.quota-provider__mark--${provider} {\n  color: var(--provider-${provider});\n}`);
    }
  });

  it("pins the AI Gateway provider-priority grammar — ink rank only, no signal colour, no brass", () => {
    // 소진 순서는 상태가 아니라 사용자 선호다. 신호색이나 brass를 빌리는 순간 같은 카드의
    // 상태·위치 채널과 충돌해 순위가 활동처럼 읽힌다 — 등급 배지와 같은 잉크 문법을 강제한다.
    // 순위는 로스터 묶음 머리글의 셀렉트로 정하고, 묶음 왼쪽 가장자리 선으로만 되비친다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    const priorityRules = [...css.matchAll(/([^{}]*\.ai-gateway-priority[^{}]*)\{([^}]*)\}/g)];
    expect(priorityRules.length).toBeGreaterThan(0);
    for (const [, , body] of priorityRules) {
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
    }
    const ranked = css.match(/\.ai-gateway-priority-select\.is-ranked \{[^}]*\}/)?.[0] ?? "";
    expect(ranked).toContain("--fc-select-compact-tone: var(--text-primary);");
    const edge = css.match(/\.ai-gateway-provider-group\.is-ranked::before \{[^}]*\}/)?.[0] ?? "";
    expect(edge).toContain("background: var(--text-tertiary);");
    expect(edge).not.toMatch(/var\(--(aurora|warn|coral|positive|brass)[a-z-]*\)/);
  });

  it("pins the AI Gateway effort ladder grammar — the settings segmented text line, multi-select, no disclosure", () => {
    // 강도 사다리는 설정 모달의 범위 선택(평평한 글자 + 밑줄)과 같은 결로 선다. 칩 껍데기를 두르면
    // 같은 화면의 다른 선택지와 말투가 갈린다.
    const css = externalSource(TERMINAL_AGENT_CLI_CSS_PATH).replace(/\r\n/g, "\n");
    const shell = css.match(/^\.ai-gateway-effort \{[^}]*\}/m)?.[0] ?? "";
    // 다섯 칸 사다리는 좁은 설정 카드보다 넓어진다. 한 줄을 고집하거나 넘침을 잘라내면
    // 오른쪽 단계가 카드 밖에서 눌리지 않으므로, 접히기만 하고 감춰지지는 않아야 한다.
    expect(shell).toContain("flex-wrap: wrap;");
    expect(shell).not.toContain("overflow: hidden;");
    expect(shell).not.toContain("border:");

    // 켜진 단계는 사다리 위의 위치이지 Objective 상태가 아니다 — 위치 채널(brass) 밑줄과 잉크 대비로만
    // 말하고 신호색을 빌리지 않는다. 여럿을 켤 수 있으므로 자리(thumb)·테두리 링은 두지 않는다.
    const on = css.match(/\.ai-gateway-effort-level\.is-on \{[^}]*\}/)?.[0] ?? "";
    expect(on).toContain("color: var(--text-primary);");
    expect(on).toContain("text-decoration-color: var(--brass);");
    expect(on).not.toContain("box-shadow");
    for (const [, , body] of css.matchAll(/([^{}]*\.ai-gateway-effort[^{}]*)\{([^}]*)\}/g)) {
      expect(body).not.toMatch(/var\(--(aurora|warn|coral|positive)[a-z-]*\)/);
      expect(body).not.toContain("text-transform: uppercase");
    }

    // 마지막 한 단계는 켜진 채로 잠긴다. 흐려지면 꺼진 것으로 읽히므로 opacity를 내리지 않는다.
    const lockedOn = css.match(/\.ai-gateway-effort-level\.is-on:disabled \{[^}]*\}/)?.[0] ?? "";
    expect(lockedOn).toContain("cursor: not-allowed;");
    expect(lockedOn).not.toContain("opacity");

    // 사다리는 모델 행을 펼친 세부에 한 번만 선다 — 사다리 자체를 다시 접는 표면은 없다.
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

  it("pins the quota legend as a header-bounded disclosure that focus cannot hold open", () => {
    const css = externalSource(QUOTA_CSS_PATH).replace(/\r\n/g, "\n");
    const panel = externalSource(QUOTA_PANEL_PATH).replace(/\r\n/g, "\n");

    // 말풍선의 기준 상자는 버튼이 아니라 팝업 머리다 — 팝업은 좁은 창에서 뷰포트 폭까지
    // 줄어들므로, 버튼에 걸린 고정 폭은 좁은 팝업에서 왼쪽이 잘려 읽히지 않는다.
    const head = css.match(/^\.quota-head \{[^}]*\}/m)?.[0] ?? "";
    expect(head).toContain("position: relative;");
    const legend = css.match(/^\.quota-legend \{[^}]*\}/m)?.[0] ?? "";
    expect(legend).not.toContain("position: relative;");
    const bubble = css.match(/\.quota-legend__bubble \{[^}]*\}/)?.[0] ?? "";
    expect(bubble).toContain("left: 12px;");
    expect(bubble).toContain("right: 12px;");
    expect(bubble).toContain("width: auto;");
    expect(bubble).toContain("max-width: 268px;");

    // 포커스는 표시를 결정하지 않는다 — :focus-within으로 열면 Escape가 상태를 내려도
    // 포커스가 버튼에 남아 말풍선은 보이는 채로 aria-expanded만 false가 되어,
    // 눈에 보이는 것과 접근성 트리가 서로를 부정한다.
    expect(css).not.toMatch(/\.quota-legend[^{}]*:focus-within/);
    expect(panel).toContain("aria-expanded={pinned}");
    expect(panel).toContain('if (event.key !== "Escape") return;');
    expect(panel).toContain("setPinned(false);");
  });

  it("pins the shared panel motion layer and existence choreography grammar", () => {
    const components = source("styles/components.css");
    // 모션 억제 축은 OS의 prefers-reduced-motion 하나다 — 콘솔 설정 축은 퇴역했다.
    expect(components).not.toContain(".reduce-panel-motion");
    // 캔버스 패널·companion·함대 지도·Watch Deck의 등장 안무는 화면과 함께 떠났다.
    expect(components).not.toContain("companion-frame-enter");
    expect(components).not.toContain(".objective-records-canvas.is-fleet-map");
    expect(components).not.toContain("@keyframes panel-enter");
    expect(components).not.toContain(".panel-motion-ghost");
    expect(components).not.toContain(".side-bar-chip.is-arrival-pulse");
  });

  it("pins the dormant resume feedback grammar — pending pulse, error card, and reduced-motion fallback", () => {
    const components = source("styles/components.css");
    // (a) pending pulse는 opacity 2단 맥동 하나뿐 — 새 안무는 keyframe과 사용처가 함께 고정된다.
    expect(components).toContain("@keyframes dormant-resume-pulse");
    expect(components).toContain(".objective-dormant-action--pending {\n  animation: dormant-resume-pulse");
    // (b) 접근성 폭백: pulse는 전용 reduced-motion 블록에서 무효화된다.
    const pendingReducedMotion = components.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.objective-dormant-action--pending \{\s*animation: none;\s*\}\s*\}/)?.[0] ?? "";
    expect(pendingReducedMotion).toContain("animation: none;");
    // (c) 에러 카드 문법: 상태 채널은 signal/neutral 토큰만, 회복 액션의 강조는 brass(focus/hover) 채널만.
    const errorBlock = components.match(/\.objective-dormant--error \{[^}]*\}/)?.[0] ?? "";
    expect(errorBlock).toContain("cursor: default;");
    const errorText = components.match(/\.objective-dormant-error \{[^}]*\}/)?.[0] ?? "";
    expect(errorText).toContain("color: var(--text-secondary);");
    const ghostAction = components.match(/\.objective-dormant-action--ghost \{[^}]*\}/)?.[0] ?? "";
    expect(ghostAction).toContain("color: var(--text-secondary);");
    const ghostHover = components.match(/\.objective-dormant-action--ghost:hover,[^]*?\{[^}]*\}/)?.[0] ?? "";
    expect(ghostHover).toContain("color: var(--brass-bright);");
    // (d) pending/disabled 중에는 hover 강조가 다시 점화하지 않는다 — 쉬는 헤일로(배수 × 10%)에 머문다.
    // 헤일로 세기는 lights-out 배수(--quiet-halo-gain)를 따른다: 다크 0(광 없음), Whites 1.
    const disabledHover = components.match(/\.objective-dormant:disabled:hover \{[^}]*\}/)?.[0] ?? "";
    expect(disabledHover).toContain("var(--brass) calc(var(--quiet-halo-gain) * 10%)");
  });

  it("keeps sidebar status headers in the neutral text channel", () => {
    const components = source("styles/components.css");
    const caption = components.match(/\.side-bar-status-header \{[^}]*\}/)?.[0] ?? "";
    const captionToggle = components.match(/\.side-bar-status-header__toggle \{[^}]*\}/)?.[0] ?? "";
    expect(caption).toMatch(/color: var\(--text-(?:primary|secondary|tertiary|on-brass)\)/);
    expect(caption).toMatch(/font-weight: var\(--weight-(?:regular|medium|bold)\)/);
    expect(caption).toContain("background: transparent;");
    expect(captionToggle).toContain("border-left: 3px solid var(--status-color);");
  });

  it("collapses sidebar chip actions out of layout until hover or focus-within", () => {
    const components = source("styles/components.css");
    const restingActions = components.match(/\.side-bar-chip-close \{[^}]*\}/)?.[0] ?? "";
    const revealedActions = components.match(/\.side-bar-chip:hover \.side-bar-chip-close,\n\.side-bar-chip:focus-within \.side-bar-chip-close \{[^}]*\}/)?.[0] ?? "";

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
    expect(components).toContain("  .side-bar-chip-close {\n    transition-duration: 0.01ms;");
  });

  // 「한 패널만 크게」는 스냅 유지의 전체 칸이 진다 — 옛 최대화 상태를 들고 있는지 묻던 계약은
  // 퇴역했고, 대화 본문이 전체 칸을 쓴다.

  it("pins the Theater-scoped STATUS preference and identity channel grammar", () => {
    const app = source("app/app.tsx");
    const objectiveRecords = source("../../../features/workspace/client/objective-records.tsx");
    const sidebar = source("../../../features/workspace/client/sidebar/objective-records-side-bar.tsx");
    const sideBarStore = source("../../../features/workspace/client/sidebar/objective-records-side-bar-store.ts");
    const idleArrival = source("../../../features/execution/client/objective-marks.ts");
    const chip = source("../../../features/workspace/client/sidebar/objective-records-side-bar-chip.tsx");
    const components = source("styles/components.css");
    const theme = source("styles/theme.css");
    const activity = source("../../../features/execution/client/objective-activity.ts");

    // 조합은 등록부가 정한다(기본 Alt+S, Settings에서 재배정 가능) — 리터럴 키 판정이 되돌아오면 안 된다.
    expect(objectiveRecords).toContain('matchesShortcutCommand(event, "objectives.sort-by-status")');
    expect(objectiveRecords).not.toContain('event.code === "KeyS"');
    expect(objectiveRecords).toContain("toggleTheaterStatusAxis(getViewedTheaterId());");
    // 상태별 보기는 Theater 하나의 표시 선호다. 머리의 chevron 옆 스위치와 단축키가 같은 Theater 를 바꾼다.
    expect(sidebar).not.toContain('className="side-bar-status-axis-toggle"');
    expect(sidebar).not.toContain("objective-records-side-bar-axis");
    expect(sidebar).toContain("<SideBarStatusViewToggle active={statusAxis} theaterId={theater.id} theaterName={displayName} />");
    expect(sidebar).toContain("groupTheaterStatusEntries(");
    expect(sidebar).toContain("<StatusRecoveryShelves");
    // 0건 섹션·선반은 서지 않는다 — 빈 칸이 축을 설명하던 자리는 퇴역했다.
    expect(sidebar).toContain("statusSections.filter((section) => section.entries.length > 0)");
    expect(sidebar).toContain("if (dormantSection.entries.length === 0) return null;");
    expect(components).toMatch(/\.side-bar-theater-row-btn\.side-bar-status-view-toggle\[aria-pressed="true"\] \{[^}]*background: color-mix\(in oklch, var\(--brass-quiet\) 14%, transparent\);/);
    expect(sidebar).toContain("trackObjectiveActivityTransitions({");
    expect(sidebar).toContain("const landedIds = consumeStatusLandings().filter(");
    expect(sidebar).not.toContain("recordStatusTransitions(movedIds);");
    expect(app).toContain("useEffect(() => subscribeObjectiveActivityTracking(), []);");
    expect(sidebar).toContain("if (statusTheaterIds.size === 0) {");
    expect(chip).toContain("reorderEnabled && event.altKey && event.shiftKey");
    // 미확인 도착은 상태 마크와 같은 사실이다(idle + idleArrival = 표시 활동 AWAITING). 칩은 그 사실을
    // 마크 하나로만 말한다 — 우측 점·행 틴트·헤더 카운트 배지는 같은 화면에서의 중복 발화였다.
    expect(chip).not.toContain("side-bar-chip-unseen");
    expect(chip).not.toContain("idleUnseen");
    expect(sidebar).not.toContain("idleUnseen");
    expect(sidebar).not.toContain("side-bar-status-header__unseen");
    // 그룹축·복구 선반이 raw idle을 그리면 도착한 Objective이 축마다 다른 상태를 말한다 — 그래서
    // 모든 사이드바 표면이 마크 축을 읽는다(아래 마크/섹션 계약이 그 배선을 고정한다).
    expect(sideBarStore).not.toContain("let statusAxis =");
    expect(source("../../../features/workspace/client/sidebar/group-collapse-store.ts")).toContain("statusAxis: parsed.statusAxis === true,");
    expect(sideBarStore).toContain("let statusTransitionTicks = new Map<string, number>();");
    expect(idleArrival).toContain("let idleArrivalIds = new Set<string>();");
    expect(sideBarStore).toContain("let previousActivityById = new Map<string, SideBarStatus>();");
    expect(sideBarStore).toContain("let baselinedLiveActivityIds = new Set<string>();");
    expect(sideBarStore).toContain("let pendingStatusLandingIds = new Set<string>();");
    expect(idleArrival).toContain("export function subscribeIdleArrival(");
    expect(sideBarStore).not.toContain("idleUnseenIds");
    expect(sideBarStore).not.toContain("STORAGE_KEY_STATUS");
    expect(sideBarStore).not.toContain("fleet-console.objectiveRecords.status");

    // Doctrine: status-section border/count are signal-owned, while the chip group mark
    // consumes only resolveAccentColor identity values and never repaints the status beacon.
    // The group header does not repeat the circular status glyph; chips and panels already do.
    expect(sidebar).toContain("groupMarkByGroupId.get(entry.objectiveRecord.groupId)");
    expect(components).toMatch(/\.side-bar-status-section--awaiting\s*\{[^}]*--activity-color:\s*var\(--aurora\)/);
    // 미확인 완료는 유휴와 같은 --positive를 받는다 — 색은 "끝난 일"을 말하고, 미확인은 모션이 말한다.
    expect(components).toMatch(/\.side-bar-status-section--idle\s*\{[^}]*--activity-color:\s*var\(--positive\)/);
    expect(components).toMatch(/\.side-bar-status-section--ended\s*\{[^}]*--activity-color:\s*var\(--ink-fog\)/);
    expect(components).toContain("--activity-color: var(--ink-fog);");
    expect(components).not.toContain(".tenant-beacon");
    expect(components).toContain("--status-color: var(--activity-color);");
    expect(components).toContain("border-left: 3px solid var(--status-color);");
    expect(components).not.toMatch(/\.side-bar-status-section \{[^}]*border-left:\s*3px solid var\(--status-color\)/);
    expect(components).toMatch(/\.side-bar-status-header__toggle \{[^}]*border-left:\s*3px solid var\(--status-color\)/);
    expect(components).not.toContain(".side-bar-status-section--background");
    expect(sidebar).not.toContain("side-bar-status-header__dot");
    expect(components).not.toContain(".side-bar-status-header__dot");
    expect(components).toContain("background: var(--group-mark);");
    // 세 단계 아코디언(Theater / Group / Status)은 + 액션과 같은 보더 링으로 hover에
    // 응답한다. Theater의 chevron도 독립 버튼이라 같은 공통 링 선언을 소비한다.
    const theaterActivate = components.match(/\.side-bar-theater-activate \{[^}]*\}/)?.[0] ?? "";
    const theaterDraggingActivate = components.match(/\.side-bar-theater-header--dragging \.side-bar-theater-activate \{[^}]*\}/)?.[0] ?? "";
    const theaterCollapse = components.match(/\.side-bar-theater-collapse-btn,\s*\.side-bar-theater-row-btn\.side-bar-status-view-toggle \{[^}]*\}/)?.[0] ?? "";
    const theaterCollapseChevron = components.match(/\.side-bar-theater-collapse-btn \.side-bar-theater-chevron,\s*\.side-bar-theater-row-btn\.side-bar-status-view-toggle svg \{[^}]*\}/)?.[0] ?? "";
    const theaterRowFocus = components.match(/\.side-bar-theater-row-btn:focus-visible \{[^}]*\}/)?.[0] ?? "";
    const sharedIconHover = components.match(/\.side-bar-theater-row-btn:hover,[\s\S]*?\.side-bar-group-header__toggle:focus-visible \{[^}]*\}/)?.[0] ?? "";
    const statusToggleHover = components.match(/\.side-bar-status-header__toggle:hover \{[^}]*\}/)?.[0] ?? "";
    expect(theaterActivate).toContain("cursor: pointer;");
    expect(theaterActivate).not.toContain("cursor: inherit;");
    expect(theaterDraggingActivate).toContain("cursor: grabbing;");
    expect(theaterCollapse).toContain("width: 22px;");
    expect(theaterCollapseChevron).toContain("width: 16px;");
    expect(theaterCollapseChevron).toContain("height: 16px;");
    expect(theaterRowFocus).toContain("outline: 2px solid var(--brass);");
    expect(theaterRowFocus).not.toContain("--aurora");
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
    // 미확인 완료를 알리는 살아 있는 마크의 공유 점등 모션은 유지한다.
    expect(components).toMatch(/@keyframes status-glyph-blink \{\s*0%,\s*100% \{\s*opacity: 1;/);
    // 마크 축과 섹션 축은 갈라진 채로 각자의 자리에 실린다 — 하나로 합치면 색이 칸을 따라간다.
    expect(activity).toContain('return activity === "idle" && idleArrivalIds.has(objectiveId) ? "unseen" : activity;');
    expect(activity).toContain('return activity === "idle" && idleArrivalIds.has(objectiveId) ? "awaiting" : activity;');
    // 생성 지점은 raw 활동과 마크만 싣는다 — 섹션 승격을 여기서도 해 두면 groupObjectiveRecordsByStatus가
    // 같은 계산을 다시 해 값이 겹치고, 겹친 값은 어느 표면에도 드러나지 않아 틀려도 아무 테스트가 죽지 않는다.
    expect(sidebar).toContain("mark: resolveObjectiveMarkVisual({ activity, objectiveId: objectiveRecord.id, idleArrivalIds }),");
    expect(sidebar).toContain("      status: activity,");
    expect(sidebar).not.toContain("status: resolveObjectiveDisplayActivity({");
    expect(chip).toContain("const markVisual = mark ?? status;");
    expect(components).toContain(".side-bar-status-axis-live-tick {");
    // 대기 틱의 호스트는 Theater 정체성 표식이다 — 전역 스위치 위에서는 어느 Theater인지가 지워진다.
    expect(sidebar).toMatch(/side-bar-theater-anchor[\s\S]{0,400}side-bar-status-axis-live-tick/);
  });

  it("pins the active Theater marker to channels the hover state does not use", () => {
    const components = source("styles/components.css");
    // 위치(어느 Theater가 열려 있나)와 순간(커서가 어디 있나)은 서로 다른 채널을 쓴다. 한때
    // 둘 다 행 배경 채움이었고 값까지 같아(4테마 전부 ΔL 0.000) 호버한 비활성 Theater가
    // 활성보다 강했다 — 호버에만 rim 테두리가 더 붙었기 때문이다.
    const activeSection = components.match(/\.side-bar-theater-section--active \{[^}]*\}/)?.[0] ?? "";
    const headerHover = components.match(/\.side-bar-theater-header:hover,\n\.side-bar-theater-header:focus-visible \{[^}]*\}/)?.[0] ?? "";
    const activeHeader = components.match(/\.side-bar-theater-header\.is-active \{[^}]*\}/)?.[0] ?? "";
    const activeAnchor = components.match(/\.side-bar-theater-header\.is-active \.side-bar-theater-anchor \{[^}]*\}/)?.[0] ?? "";
    const activeName = components.match(/\.side-bar-theater-header\.is-active \.side-bar-theater-name \{[^}]*\}/)?.[0] ?? "";

    // 활성은 구역 왼쪽 2px brass 스파인이 나른다. 헤더가 아니라 구역에 붙으므로 헤더가 스크롤
    // 밖으로 밀려나도 아래 칩들의 소속이 유지된다.
    expect(activeSection).toContain("linear-gradient(var(--brass), var(--brass))");
    expect(activeSection).toContain("2px calc(100% - 8px)");
    // 옛 상하 rim은 목록의 다른 구분선과 같은 무게라 활성 신호로 읽히지 않았다 — 되살아나면
    // 스파인과 두 겹으로 말하게 된다.
    expect(activeSection).not.toContain("border-top");
    expect(activeSection).not.toContain("border-bottom");
    // 스파인은 배경 레이어로 그린다: 이 섹션의 ::before/::after는 드래그 drop 표시가 점유한다.
    expect(components).not.toMatch(/\.side-bar-theater-section--active::(before|after)/);

    // 호버는 배경 채움 하나만 쓴다. 테두리가 돌아오면 다시 활성보다 강해진다.
    expect(headerHover).toContain("background: var(--ink-mid);");
    expect(headerHover).not.toContain("border-color");
    // focus-visible은 자기 brass 테두리를 따로 진다 — 호버에서 테두리를 뺀 것이 포커스 표식을
    // 지우면 안 된다.
    // brass×rim 혼합은 oklab이다 — oklch는 hue를 보간해 Carbon(rim hue 248)에서 보라, Maritime에서
    // 청록으로 새는 테두리를 만든다(실측). --control-open-rim과 같은 공간이다.
    expect(components).toMatch(/\.side-bar-theater-header:focus-visible \{[^}]*border-color: color-mix\(in oklab, var\(--brass\) 55%/);

    // 활성 헤더는 배경 채널을 호버에게 완전히 넘긴다 — 자기 채움을 갖지 않는다(누르면 Inbox 가 열리므로 호버 채움은 다른 행과 같이 받는다).
    expect(activeHeader).not.toContain("background");
    expect(activeHeader).not.toContain("var(--ink-deep)");

    // 가까이서는 배지의 1px brass 링이, 멀리서는 스파인이 같은 사실을 말한다. 배지 면은 Theater
    // 정체성이라 다크는 brass로 칠하지 않는다(lights-out 슬롯). 라이트(Whites)는 슬롯이 지금의 brass
    // 채움과 채움 위 AA를 보장하는 brass 전용 텍스트 티어를 그대로 잇는다.
    expect(activeAnchor).toContain("background: var(--quiet-anchor-active-fill);");
    expect(activeAnchor).toContain("color: var(--quiet-anchor-active-ink);");
    expect(activeAnchor).toContain("box-shadow: inset 0 0 0 1px var(--quiet-anchor-ring);");
    const whitesTheme = source("styles/theme.css").match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(whitesTheme).toContain("--quiet-anchor-active-fill: var(--brass);");
    expect(whitesTheme).toContain("--quiet-anchor-active-ink: var(--text-on-brass);");

    // 이름만 최고 명도로 올린다 — 행 전체를 올리면 활성 Theater의 행 컨트롤이 다른 Theater의
    // 것보다 밝아지는 역전이 생긴다.
    expect(activeName).toContain("color: var(--text-primary);");

    // 배지가 색 전환을 지므로 reduced-motion에서 함께 멎어야 한다.
    const reducedMotion = components.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/)?.[0] ?? "";
    expect(reducedMotion).toMatch(/\.side-bar-theater-anchor \{\s*transition: none;/);
  });

  it("pins the selectable Right Rail panel behavior contract", () => {
    const rail = source("styles/rail.css");
    const rightRail = source("chrome/rail/right-rail.tsx");
    const settingsPane = source("../../../features/settings/client/settings-pane.tsx");
    const railStore = source("chrome/rail/rail-store.ts");
    // K-05 A: 확대 작업면을 보호하는 비모달 오버레이는 승인된 형태다(부유 카드 재질은 유지).
    expect(rail).not.toContain(".right-rail.is-switching");
    expect(rail).toMatch(/\.right-rail \{[^}]*position: absolute;/);
    expect(rail).toMatch(/\.right-rail \{[^}]*border-radius: var\(--radius-md\);/);
    // Doctrine: the slot ::before composites its glass layers over the
    // --glass-underlay channel — its default is the old opaque var(--ink-deep), so with the
    // glass gate closed the slot stays fully opaque, and with the gate open the same channel
    // turns transparent.
    expect(rail).toMatch(/\.right-rail-panel-slot::before \{[^}]*\)\s*,\s*var\(--glass-underlay\);/);
    // Doctrine: keep both WebKit and Firefox track styling so the continuous
    // control communicates its filled range in either engine. The recipe is shared - the
    // plugin sliders are one control grammar living in the settings SDK; the rail keeps only its own layout.
    expect(source("styles/components.css")).toContain(".fleet-slider::-moz-range-progress");
    // 연속값은 SDK 슬라이더 한 문법이다 — 코어 전용 슬라이더 클래스가 되살아나면 두 모양이 된다.
    // 그 문법은 트랙·값·기본값이다: −/+ 스테퍼가 되살아나면 행마다 Tab 정지점이 서너 개로 는다.
    expect(source("styles/components.css")).not.toContain(".settings-slider-field");
    expect(source("styles/components.css")).not.toContain(".fc-settings-slider__stepper");
    // 전면 해도 개편: 설정 페인에서도 push/overlay 스위치는 퇴역했다 — 항상 부유 카드다.
    expect(settingsPane).not.toContain("toggleRailPanelBehavior");
    // 독점 상주 계약: 카드에는 패널 하나만 상주한다 — 단일 activeId가 고정 목록을 대체하고
    // 섹션 접기는 퇴역했다(안 볼 패널은 접는 게 아니라 닫거나 교체한다).
    expect(railStore).toContain("fleet-console.rail.activePanelId");
    expect(railStore).not.toContain("panelBehavior");
    expect(rightRail).not.toContain("toggleRailSectionCollapsed");
    expect(rail).not.toContain(".right-rail-section-toggle");
    expect(rail).not.toContain(".right-rail-section-caret");
    // Doctrine: Objective panels keep a 32px attached caption. The tool panel card has no
    // panel head at all — its settings live behind the gear in the toolbar,
    // so the body owns the whole slot and no chrome can summon itself over it. The retired
    // hover-reveal head is pinned negatively: it fired from the most common pointer path
    // across the panel top and then covered the very controls that path was aiming for.
    expect(rail).not.toContain(".right-rail-panel-head-reveal");
    expect(rail).not.toContain(".right-rail-panel-peek");
    expect(rail).not.toContain("grid-template-rows: 32px minmax(0, 1fr);");
    expect(rightRail).not.toContain("HEAD_REVEAL");
    expect(rightRail).not.toMatch(/onPointerMove=\{(?:hasPanel \? )?handleSlotPointer/);
    // Doctrine: the gear is not a work tool — governing the console and choosing a work tool are
    // different kinds of act — so it stands last in the conversation dock's host menu, not in the
    // plugin tool run. Tools group by scope (Theater-scoped first, Fleet-scoped after them),
    // each scope in plugin composition order. The gear is the settings surface's one door: it opens
    // the settings modal and never appears as a tab.
    const settingsButtonSource = source("chrome/toolbar/settings-button.tsx");
    expect(rightRail).toMatch(/right-rail-tabs[\s\S]*renderRuns\(runsByScope\.theater\)[\s\S]*renderRuns\(runsByScope\.fleet\)/);
    expect(rightRail).not.toContain("right-rail-settings-btn");
    expect(settingsButtonSource).toContain('id="rail-settings-toggle"');
    expect(rightRail).toContain('binding.entry.scope ?? "theater"');
    expect(rightRail).toContain('binding.entry.id !== SETTINGS_RAIL_ENTRY_ID');
    // Doctrine: the gear carries an explicit glyph size. An SVG with only a viewBox fills its
    // button (30px inside the 32px control), which is how it first shipped oversized; plugin
    // icons bring their own sizes but this core-drawn glyph has to state one here.
    expect(rail).toMatch(/\.right-rail-settings-btn svg \{[^}]*width: \d+px;[^}]*height: \d+px;/);
    // Doctrine: one row, one "on" grammar. The gear wears the same active mark as every
    // other tool icon (dark fill, rim-strong border, brass underline) and declares no active
    // rule of its own — it first shipped with a brass-glow fill and a suppressed bar, which
    // read as a different kind of selection sitting right above the panel tabs. That the gear
    // is a door and not a tab is already carried by role/aria, not by a second visual grammar.
    expect(rail).not.toMatch(/\.right-rail-settings-btn\.is-active/);
    expect(rail).toMatch(/\.right-rail-ico\.is-active \{[^}]*background: var\(--ink-deep\);/);
    expect(rail).toMatch(/\.right-rail-ico\.is-active::before \{[^}]*background: var\(--brass\);/);
    // Doctrine: the gear menu is dismantled — no popup portals out of the rail any more,
    // and width reset became direct manipulation on the resize handle itself.
    expect(rightRail).not.toContain("RailSettingsMenu");
    expect(rail).not.toContain(".right-rail-menu");
    expect(rightRail).toContain("onDoubleClick={handleResetCardWidth}");
    expect(rail).toMatch(/\.right-rail \{[^}]*overflow: hidden;/);
    expect(source("chrome/components/command-band-system-cluster.tsx")).toContain('from "./use-menu-button-keyboard.js"');
  });

  it("pins the popup opacity underlay contract", () => {
    const components = source("styles/components.css");
    const layout = source("styles/layout.css");
    const scuttlebuttCss = externalSource(SCUTTLEBUTT_CSS_PATH);
    // 팝업은 공통 팝업 면(--popover-face) 한 장을 칠한다. 이 채널은 다크 유리 게이트와 투명도 축소
    // 폴백 어느 쪽도 덮어쓰지 않으므로 모든 테마에서 불투명이다 — 상주 크롬·패널만 --glass-underlay로 비친다.
    // 옛 바탕층 이름(--float-underlay)은 아직 옮기지 않은 소비처를 위한 별칭으로만 남는다.
    const theme = desktopThemeSource();
    expect(theme).toContain("--popover-face: var(--ink-deep);");
    expect(theme).toContain("--float-underlay: var(--popover-face);");
    const gates = theme.slice(theme.indexOf(':root:not([data-theme="light"]) {'));
    expect(gates).not.toContain("--float-underlay:");
    expect(gates).not.toContain("--popover-face:");
    // 옮긴 팝업은 공통 면을 칠하고, 그 선택자의 어느 규칙도 유리 재료(광택·틴트·원료 표면)를 겹치지 않는다.
    const paintsPopoverFace = (sheet: string, selector: string, face = "--popover-face") => {
      const scoped = selector.replace(/[.:]/g, "\\$&");
      const rules = [...sheet.matchAll(new RegExp(`(?:^|\\n)${scoped} \\{[^}]*\\}`, "g"))].map((match) => match[0]);
      expect(rules.some((rule) => rule.includes(`background: var(${face});`)), selector).toBe(true);
      for (const rule of rules) expect(rule, selector).not.toMatch(/--glass-(?:sheen|tint-)|--surface-glass/);
    };
    for (const selector of [
      ".command-band-system-menu",
      ".group-context-menu-card",
      ".theater-menu",
      ".objective-search-card",
      ".app-toast",
    ]) paintsPopoverFace(components, selector);
    for (const selector of [
      ".whatsnew-card",
      ".commissioning-card",
      ".control-curtain-card",
      ".control-reclaimed-card",
      ".directory-browser-card",
      ".add-host-card",
    ]) paintsPopoverFace(components, selector, "--dialog-face");
    // 온보딩 엔진의 두 표면(엔트리 힌트·투어 카드)은 엔진 시트가 소유하고 같은 채널 계약을 진다.
    const onboardingCss = externalSource(ONBOARDING_CSS_PATH);
    for (const selector of [".onboarding-hint", ".feature-tour-card"]) paintsPopoverFace(onboardingCss, selector);
    // 브레드크럼 스위처 메뉴는 브레드크럼·밴드와 함께 퇴역했다.
    expect(layout).not.toContain(".command-band-menu");
    // Activity Rail의 설정 메뉴는 해체됐다 — 레일에는 포털 팝업 재질이 더는 없다.
    expect(source("styles/rail.css")).not.toContain(".right-rail-menu");
    // 내장 플러그인 팝업도 같은 면을 칠한다 — 신호 소식은 신호색을 불투명 면에 섞는다.
    // Quaker aides float over the Map and other busy surfaces, so every speech surface stays on the opaque popover face.
    for (const selector of [
      ".scuttlebutt-bird-tag",
      ".scuttlebutt-bird-say",
      ".scuttlebutt-answer-bubble",
      ".scuttlebutt-chat-card",
    ]) paintsPopoverFace(scuttlebuttCss, selector);
    expect(scuttlebuttCss).toMatch(/\.scuttlebutt-notice-bubble \{[^}]*background: var\(--scuttlebutt-notice-wash, var\(--popover-face\)\);/);
  });

  it("pins the closed-chrome contracts", () => {
    const app = source("app/app.tsx");
    const theme = source("styles/theme.css");
    const layout = source("styles/layout.css");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");
    expect(app).not.toContain("FocusMode");
    expect(app).not.toContain("is-focus-mode");
    expect(app).not.toContain("GlobalNavigation");
    expect(layout).not.toContain("--console-gnb-height");
    expect(layout).not.toContain("is-focus-mode");
    expect(theme).toContain("--chrome-band-height: 36px;");
    expect(app).not.toContain("warRoomActive");
    expect(app).not.toContain("WarRoomBar");
    // 좌·우 사이드바 모두 접기가 없다 — 접기 컨트롤·엣지 독·픽·⌘B 단축키가 함께 퇴역했다.
    const railPanelSource = source("chrome/rail/right-rail.tsx");
    expect(railPanelSource).not.toContain("right-rail-collapse");
    expect(source("../../../features/workspace/client/sidebar/objective-records-side-bar.tsx")).toContain("<SideBarStatusViewToggle active={statusAxis} theaterId={theater.id} theaterName={displayName} />");
    const sidebar = source("../../../features/workspace/client/sidebar/objective-records-side-bar.tsx");
    expect(sidebar).not.toContain("side-bar-formation-group");
    expect(sidebar).not.toContain("side-bar-theater-add-btn");
    expect(sidebar).toContain('className="side-bar-ghost-theater-row"');
    expect(sidebar).toContain('className="side-bar-ghost-theater-anchor"');
    expect(sidebar).not.toContain('className="side-bar-ghost-theater-row" onClick={openTheaterBrowser} disabled={addingTheater} aria-label');
    expect(sidebar).toContain('aria-label={t("sidebar.list.aria")}');
    expect(components).toContain(".side-bar-ghost-theater-anchor {");
    expect(components).toContain("border: 1px dashed var(--ink-rim);");
    expect(components).not.toContain(".side-bar-formation-group {");
    expect(components).not.toContain(".side-bar-theater-add-btn {");
    const rightRail = source("chrome/rail/right-rail.tsx");
    const railStore = source("chrome/rail/rail-store.ts");
    for (const legacyRightRailCoupling of ["rightRailWidth", "setRightRailWidth", "useRightRailWidth"]) {
      expect(rightRail).not.toContain(legacyRightRailCoupling);
      expect(railStore).not.toContain(legacyRightRailCoupling);
    }
    expect(layout).toContain("@media (prefers-reduced-motion: reduce)");
    // 부유 사이드바 카드는 크롬 틴트를 불투명 언더레이 위에 합성한다 — 유리 게이트가 닫히면
    // 반투명 채널 값이 그대로 남아 전면 캔버스 격자가 카드를 관통하는 결함을 막는다.
    // 투명도는 chrome 틴트의 알파가 진다 — 카드 루트를 내리면 목록 글자까지 사라진다.
    const sideBarBlock = components.match(/^\.objective-records-side-bar \{[^}]*\}/m)?.[0] ?? "";
    const sideBarBeforeBlock = components.match(/\.objective-records-side-bar::before \{[^}]*\}/)?.[0] ?? "";
    expect(sideBarBeforeBlock).toContain("linear-gradient(var(--glass-tint-chrome), var(--glass-tint-chrome)),");
    expect(sideBarBeforeBlock).toContain("var(--glass-underlay);");
    expect(sideBarBlock).not.toContain("opacity:");
    // 레일 Shell은 terminal tint를 칠한다.
    const terminalShellBlock = components.match(/^\.terminal-shell \{[^}]*\}/m)?.[0] ?? "";
    expect(terminalShellBlock).toContain("padding: 0;");
    expect(terminalShellBlock).toContain("background: var(--glass-tint-terminal);");
    // 확대 Shell도 slot 루트에서 terminal tint를 한 번만 합성한다. 확대 표면은 읽는 시트라 바탕층은 팝업 채널(불투명)이다.
    const expandedShellPaneBlock = components.match(/^\.expanded-surface-pane:has\(\.terminal-shell\) \{[^}]*\}/m)?.[0] ?? "";
    expect(expandedShellPaneBlock).toContain("linear-gradient(var(--glass-tint-terminal), var(--glass-tint-terminal)),");
    expect(expandedShellPaneBlock).toContain("var(--float-underlay);");
    const expandedTerminalBlock = components.match(/^\.expanded-surface-pane \.terminal-shell \{[^}]*\}/m)?.[0] ?? "";
    expect(expandedTerminalBlock).toContain("background: transparent;");
    expect(expandedTerminalBlock).toContain("box-shadow: none;");
    // 휴면은 패널 면 위의 상태다 — 톤을 낮추는 베이스 레이어가 돌아오면 창 안에 다른 면이 생긴다.
    const dormantBlock = components.match(/^\.objective-dormant \{[^}]*\}/m)?.[0] ?? "";
    expect(dormantBlock).toContain("background: radial-gradient(");
    expect(dormantBlock).not.toContain("var(--ink-deep)");
    // 캡 접합 규칙은 캡과 함께 원자적으로 퇴역했다 — 남으면 부유 카드의 상단 마감(테두리·
    // 라운드)이 창 모드·도킹 풀스크린에서 잘린 채 남는다(사전 감사 blocker). 카드는 네 변
    // 모두 자기 마감을 가진다.
    expect(components).not.toContain(".objective-records-side-bar.is-expanded,");
    expect(components).not.toMatch(/^\.objective-records-side-bar\.is-expanded \{/m);
    expect(sideBarBlock).toContain("position: absolute;");
    expect(sideBarBlock).toContain("border-radius: var(--radius-md);");
    expect(sideBarBlock).toContain("border: 1px solid var(--surface-rim);");
    expect(components).not.toContain(".float-handle");
    expect(components).not.toContain("focus-mode-reveal");
    // 도구 패널 카드는 켜진 도구가 없으면 폭 0으로 걷힌다 — 접힌 레일(is-closed) 상태는 오른쪽 사이드바와 함께 퇴역했다.
    expect(rail).toContain(".right-rail:not(.is-open) {");
    // aria-pressed가 화면에 흔적을 남기지 않던 회귀를 막는다 — 불리언 토글의 눌림은
    // 워시 + brass 글리프다.
    const pressedBandButtonBlock = layout.match(/\.command-band-button\[aria-pressed="true"\] \{[^}]*\}/)?.[0] ?? "";
    expect(pressedBandButtonBlock).toContain("background: var(--control-wash);");
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

  // 2단 격자와 분할선은 이제 표면이 진다 — 여기서 지키는 것은 그 격자가 아니라 **각 열이
  // 자기 높이에 갇혀 있는가**다. 열 하나가 내용 높이로 자라면 그 안의 목록은 네이티브
  // 스크롤을 잃고 레일 전체가 늘어난다.
  it("bounds the Codex navigator and document columns so long Wiki entry lists keep native scrolling", () => {
    const components = source("styles/components.css");
    const navigatorLayout = externalSource(CODEX_LAYOUT_CSS_PATH);
    const railHostBlock = components.match(/\.codex-rail-host \{[^}]*\}/)?.[0] ?? "";
    const docPaneBlock = components.match(/\.codex-doc-pane \{[^}]*\}/)?.[0] ?? "";
    const hostBlock = components.match(/\.codex-rail-host > \.codex-host \{[^}]*\}/)?.[0] ?? "";
    const navigatorBlock = navigatorLayout.match(/\.codex-navigator \{[^}]*\}/)?.[0] ?? "";
    const navigatorScrollBlock = navigatorLayout.match(/\.codex-navigator-scroll \{[^}]*\}/)?.[0] ?? "";

    expect(railHostBlock).toContain("height: 100%;");
    expect(railHostBlock).toContain("min-height: 0;");
    expect(docPaneBlock).toContain("display: flex;");
    expect(docPaneBlock).toContain("flex-direction: column;");
    expect(docPaneBlock).toContain("min-height: 0;");
    expect(docPaneBlock).toContain("height: 100%;");
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

  it("keeps the mobile palette a complete root overlay that no Console theme can leak into", () => {
    // 모바일 배치는 Console 테마와 독립된 다크/라이트를 루트 속성 쌍으로 얹는다. 데스크톱은
    // data-view-mode가 "mobile"이 아니므로 매치되지 않고, 속성 셋(0,3,0)이라 테마 블록·유리 게이트를
    // 순서와 무관하게 이긴다. 어느 Console 테마가 다시 조율하는 토큰을 빠뜨리면 그 테마 값이 모바일
    // 화면에 섞이므로, 덮음 자체가 계약이다.
    const theme = stripComments(source("styles/theme.css"));
    const declared = (block: string) => new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]!));
    const blocksFor = (selectorPattern: RegExp) => [...theme.matchAll(selectorPattern)].map((match) => match[1]!);
    const mobileRule = /^(:root\[data-view-mode="mobile"\]\[data-mobile-scheme="(?:dark|light)"\](?:,\n:root\[data-view-mode="mobile"\]\[data-mobile-scheme="(?:dark|light)"\])*) \{\n([\s\S]*?)\n\}/gm;
    const schemeTokens = { dark: new Set<string>(), light: new Set<string>() };
    const mTokens = { dark: new Set<string>(), light: new Set<string>() };
    for (const match of theme.matchAll(mobileRule)) {
      const tokens = declared(match[2]!);
      for (const scheme of ["dark", "light"] as const) {
        if (!match[1]!.includes(`[data-mobile-scheme="${scheme}"]`)) continue;
        for (const token of tokens) schemeTokens[scheme].add(token);
        if (!match[1]!.includes(",")) {
          expect(match[2]).toContain(`color-scheme: ${scheme};`);
          for (const token of tokens) if (token.startsWith("--m-")) mTokens[scheme].add(token);
        }
      }
    }
    expect(mTokens.dark.size).toBeGreaterThan(0);
    // 모바일 고유 토큰은 두 극성이 같은 이름 한 벌이다 — 한쪽에만 있으면 다른 극성에서 값이 비어 소비처가 무효가 된다.
    expect([...mTokens.light].sort()).toEqual([...mTokens.dark].sort());

    const themeTuned = new Set<string>();
    for (const block of blocksFor(/^:root\[data-theme="[a-z]+"\](?:,\n:root\[data-theme="[a-z]+"\])* \{\n([\s\S]*?)\n\}/gm)) {
      for (const token of declared(block)) themeTuned.add(token);
    }
    for (const block of blocksFor(/^\s*:root:not\(\[data-theme="light"\]\) \{\n([\s\S]*?)\n\s*\}/gm)) {
      for (const token of declared(block)) themeTuned.add(token);
    }
    // [doctrine] 유리 재료(--glass-on-*)는 게이트를 거쳐서만 화면에 닿고, 모바일은
    // 틴트 채널을 불투명 면에 직접 실어 게이트를 건너뛴다.
    const exempt = (token: string) => /^--glass-on-/.test(token);
    for (const scheme of ["dark", "light"] as const) {
      const missing = [...themeTuned].filter((token) => !exempt(token) && !schemeTokens[scheme].has(token));
      expect(missing, `mobile ${scheme} leaves Console-theme tokens undefined`).toEqual([]);
    }
    // 유리는 모바일에서 닫힌다 — 패널 면이 transparent면 터미널이 유리 경로(투명 필드)를 탄다.
    const panelFace = theme.match(/data-mobile-scheme="light"\] \{[\s\S]*?--glass-panel-face: ([^;]+);/)?.[1] ?? "";
    expect(panelFace).not.toBe("");
    expect(panelFace).not.toBe("transparent");
  });

  it("keeps the dark base tokens and selector while blocking palette escapes", () => {
    const theme = desktopThemeSource();
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    expect(theme).toContain(':root[data-theme="dark"]');
    expect(base).toContain("--ink-abyss: oklch(13% 0.014 245);");
    expect(base).toContain("--brass: oklch(80% 0.085 78);");
    expect(base).toContain("--ink-muted: oklch(64% 0.012 245);");
    expect(base).toContain("--aurora: oklch(77% 0.085 200);");
    expect(base).toContain("--coral: oklch(68% 0.12 25);");
    expect(base).toContain("--warn: oklch(75% 0.08 88);");
    expect(base).toContain("--positive: oklch(76% 0.095 160);");
    expect(base).toContain("--canvas-sea-core: oklch(13% 0.018 245);");
    expect(base).toContain("color-mix(in oklch, var(--brass) 16%, transparent)");
    expect(base).not.toMatch(/--brass(?:-[a-z-]+)?:\s*oklch\([^;]*\b0\.13\b/);
    expect(theme).toContain(':root[data-theme="light"]');
    // 테마는 다크·라이트 둘뿐이다 — 퇴역 팔레트 셀렉터가 되살아나면 저장값 정규화와 어긋난 색이 선다.
    expect(new Set(theme.match(/data-theme="[a-z]+"/g))).toEqual(new Set(['data-theme="dark"', 'data-theme="light"']));
    // 라이트의 대기는 오트밀 웜 뉴트럴(hue 95~100)이다 — 청색(hue 250대) 대기 회귀를 차단한다.
    expect(theme).toContain("--ink-abyss: oklch(97% 0.003 100);");
    expect(theme.match(/^:root \{/gm)).toHaveLength(1);
    // 다크 셀렉터는 첫 페인트 계약만 진다 — 팔레트는 base가 이미 다크라 이 블록은 color-scheme 하나뿐이다.
    const darkBlocks = theme.match(/^:root\[data-theme="dark"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(darkBlocks).toHaveLength(1);
    expect(stripComments(darkBlocks[0]!).match(/^\s{2}[^\n:]+:/gm)).toEqual(["  color-scheme:"]);
    // Light 테마만 팔레트 + 광학(color-scheme/shadow/scrollbar/신호 ink·halo/계기 무게/본문 regular 굵기 보정)을
    // 허용한다. --weight-regular 단일 예외: 밝은 배경의 얇은 스템 광학 보정 — medium/bold 티어 오버라이드는 계속 차단.
    // [doctrine] --gauge-* 는 형상이 아니라 **무게**를 정한다. 종이 위에서 명도는 무게의 반대이므로,
    // 다크의 명도 순서를 그대로 상속하면 채워진 계기의 사다리가 뒤집힌다(실측: 평상 L44.9가 위험 L52.0보다 무거움).
    // 그래서 이 채널만은 라이트가 자기 값으로 분화해야 하며, 형상·타이포 오버라이드 차단은 그대로 유지된다.
    const lightVariantBlocks = theme.match(/^:root\[data-theme="light"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(lightVariantBlocks).toHaveLength(1);
    // [doctrine] --live-sweep-* 는 형상이 아니라 **진폭**을 정한다. 물결의 세기는 두 끝의 명도
    // 간격이고, 명도 스케일은 어두운 끝에서 L*가 압축된다 — 다크의 사다리를 그대로 반전만 하면
    // 라이트의 실측 진폭이 다크의 54%로 죽어 도는 물결이 정지한 줄로 읽힌다. --gauge-* 와 같은
    // 이유의 분화다(종이 위에서는 극성이 바뀌면 같은 값이 같은 뜻을 지지 못한다).
    for (const block of lightVariantBlocks) {
      expect(block).toContain("color-scheme: light;");
      // 주석은 선언이 아니다 — 위 dark 게이트와 같은 규칙이다. 콜론을 담은 설명 한 줄(예: 대비
      // 실측 "4.60:1")이 팔레트 이탈로 오독되면, 근거를 적을수록 게이트가 붉어진다.
      const declarations = stripComments(block).match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        // [doctrine] identity-file·quiet·두 배지 면은 다크 3종 보정(채도 봉투·lights-out)이 라이트로
        // 내려오지 않게 지금의 값을 잇는 자리다 — 사용자 범위가 다크 테마였다(목표 f90ef806).
        expect(declaration.trim()).toMatch(/^(?:--(?:ink|brass|aurora|coral|warn|positive|apex|crest|canvas|surface|hairline|text|id|identity|provider|shadow|scrollbar|gauge|glass|live-sweep|control|dialog|quiet|agent-control-badge|console-use-badge)[a-z-]*|--weight-regular|color-scheme):$/);
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
    // Objective 패널 면 티어 — 두 테마 모두가 값을 가지며 전부 작업면(터미널 필드) 톤이다.
    // Whites는 종이가 최명면이어야 한다: 크롬(96%)보다도, 패널 둘레에서 실측되는 sea 그라디언트
    // (L 94.9~96.6)보다도 밝아야 창이 책상에 녹지 않는다. 프레임 톤(ink-deep 95.5%)으로 내리면
    // 둘레 대비가 0.05까지 무너진 것이 실측으로 확인됐다.
    expect(base).toContain("--surface-panel: var(--ink-deep);");
    expect(theme).not.toContain("--surface-window");
    // 셋째 정의는 대화 중심 화면의 「대화 다크」(데스크톱 다크의 테마 스코프) — 무채 작업면 21.8%(Grok 선택 면 실측).
    expect(theme.match(/--surface-panel:/g)).toHaveLength(3);
    expect(theme).toContain("--surface-panel: oklch(21.8% 0 0);");
    expect(theme).toContain("--surface-panel: oklch(98.2% 0.004 100);");
    expect(theme.match(/--surface-panel: var\(--ink-deep\);/g)).toHaveLength(1);
    // 라이트 종이는 크롬보다 밝다 — 이 부등호가 뒤집히면 시선이 크롬으로 끌리는 극성 역전이다.
    const whitesBlock = theme.slice(theme.indexOf(':root[data-theme="light"]'));
    expect(whitesBlock).toContain("--surface-chrome: oklch(96% 0.004 100);");
    // 얹히는 면은 패널 면에서 한 칸 물러난다 — 다크는 위(ink-mid), 라이트는 아래(ink-deep).
    expect(base).toContain("--surface-panel-raised: var(--ink-mid);");
    expect(whitesBlock).toContain("--surface-panel-raised: var(--ink-deep);");
    expect(theme.match(/--surface-panel-raised:/g)).toHaveLength(2);
    expect(theme).not.toContain("--surface-frame");
    expect(theme).not.toMatch(/#fff(?:fff)?\b/i);
    expect(theme).not.toMatch(/body::(?:before|after)/);
  });

  it("keeps every Objective panel body on the one panel surface", () => {
    const theme = source("styles/theme.css");
    const surface = fs.readFileSync(fileURLToPath(TERMINAL_SURFACE_PATH), "utf8");
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");

    // xterm은 CSS 변수를 못 받으므로 계산값을 읽어 넘긴다 — 이 경로가 사라지면 터미널 필드가
    // 토큰과 갈라져 캡션 이음새가 되살아난다.
    expect(surface).toContain("const rootStyle = getComputedStyle(document.documentElement);");
    expect(surface).toContain('rootStyle.getPropertyValue("--glass-tint-terminal")');
    expect(surface).toContain("...base, background: resolvePanelSurface(");

    // allowTransparency는 상수가 아니라 해석된 배경의 알파에서 파생된다 — 상수 true는 불투명
    // 필드(라이트 종이·게이트 닫힘)에서도 글리프를 투명 위에 그려 GPU가 감마 미보정 sRGB로
    // 재합성하게 만들고, 획 잉크가 18.2% 사라진다(dpr=2 실측). 상수로 되돌리면 그 회귀가 재발한다.
    const options = fs.readFileSync(fileURLToPath(new URL("../features/execution/client/terminal/shared/terminal-options.ts", import.meta.url)), "utf8");
    expect(options).not.toMatch(/^\s*allowTransparency:/m);
    expect(surface).toContain("allowTransparency: terminalFieldIsTranslucent(terminalTheme.background ?? \"\")");
    expect(surface).toContain("terminal.options.allowTransparency = terminalFieldIsTranslucent(terminalTheme.background ?? \"\")");
    // 뷰포트 인라인 배경이 먼저다 — 순서가 뒤집히면 xterm의 :not(.allow-transparency) 규칙이
    // background-color:#000을 한 프레임 드러낸다.
    const applyBlock = surface.slice(surface.indexOf("const applyTerminalTheme = () => {"));
    expect(applyBlock.indexOf("syncTerminalViewportBackground(container, terminalTheme)")).toBeLessThan(
      applyBlock.indexOf("terminal.options.allowTransparency ="),
    );

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
    expect(fallbackOf("DARK_TERMINAL_THEME")).toBe(inkDeepOf(baseTheme));
    expect(fallbackOf("LIGHT_TERMINAL_THEME")).toBe("oklch(98.2% 0.004 100)");

    // 채팅 뷰도 같은 본문이다 — 자기 면(ink-abyss)으로 되돌아가면 채팅 패널만 두 장으로 읽힌다.
    const chatRootBlock = chat.match(/^\.agent-chat \{[^}]*\}/m)?.[0] ?? "";
    expect(chatRootBlock).toContain("background: var(--glass-tint-panel-face);");
    expect(chatRootBlock).not.toContain("--surface-window");
    expect(chatRootBlock).not.toContain("transition: background");
    // 좌측 스파인·노드 띠는 퇴역했다 — 상태는 본문의 시계·접힘 줄·결말 문구가 말한다. 세 표면이
    // 같은 문법을 썼으므로 함께 물러난다.
    expect(chat).not.toContain(".agent-chat-turn-spine");
    expect(chat).not.toContain(".agent-chat-turn-node");
    // 상단 세션 띠바는 여전히 폐기 상태다 — 지속 크롬으로 패널 높이를 쓰면서 누를 것이 없었다.
    expect(chat).not.toContain(".agent-chat-head");
    // 떠 있던 잡 스트립은 폐기됐다 — 로그와 컴포저의 이음새에 걸터앉아 어느 쪽에도 속하지
    // 않았다. 그 뒤를 이은 컴포저 툴 행의 글리프(.agent-chat-composer-work)도 폐기됐다: 카운트도
    // 라벨도 없는 30px 표식이 열리는 순간 사라져, 들어온 문이 나가는 자리에 없었다. 백그라운드
    // 작업은 이제 컴포저 위 in-flow 선반(.agent-chat-ledge)과 대화 위로 떠오르는 시트
    // (.agent-chat-sheet)다.
    const chatView0 = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    const chatComposer0 = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_COMPOSER_PATH), "utf8");
    // 부유 스트립 컨테이너 규칙과 그 마크업은 없다 — orbit·dot·count 부품만 Work 탭 머리가 쓴다.
    expect(chat).not.toMatch(/^\.agent-chat-strip \{/m);
    expect(chat).not.toContain(".agent-chat-strip.is-rest");
    expect(chat).not.toContain(".agent-chat-strip-names");
    expect(chatView0).not.toContain('className="agent-chat-strip"');
    expect(chat).not.toContain(".agent-chat-log.has-strip");
    expect(chatView0).not.toContain("has-strip");
    // 로그 위에 떠 있는 줄은 이제 Follow 하나뿐이다 — 바닥을 놓친 동안에만 서는 일시적 문이다.
    const chatFollowBottom = chat.match(/^\.agent-chat-follow \{[^}]*\}/m)?.[0].match(/bottom: ([^;]+);/)?.[1] ?? "";
    expect(chatFollowBottom).toBe("var(--space-3)");
    // 선반은 컴포저 **표시줄의 가운데 칸**이다 — 자기 행도, 자기 헤어라인도, 자기 measure도 없다.
    // 그 셋은 표시줄이 이미 지고 있고, 선반이 따로 들던 시절에는 잡이 하나라도 태어나면 대화가
    // 33px(32px + 헤어라인)을 영구히 내줬다.
    const ledgeBlock = chat.match(/^\.agent-chat-ledge \{[^}]*\}/m)?.[0] ?? "";
    expect(ledgeBlock).not.toContain("position: absolute");
    expect(ledgeBlock).not.toContain("border-top");
    expect(ledgeBlock).not.toContain("--agent-chat-measure");
    // 표시줄은 세 칸이다: 양 끝(좌표·폭 글리프)은 자기 크기만 쓰고 가운데(선반)가 남는 폭을
    // 가져간다 — 좁아질 때 줄어드는 것은 선반의 제목 하나이고, 두 과녁은 제자리다.
    const composerMetaBlock = chat.match(/^\.agent-chat-composer-meta \{[^}]*\}/m)?.[0] ?? "";
    expect(composerMetaBlock).toContain("display: grid;");
    expect(composerMetaBlock).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    // 한 줄 컴포저 — 입력은 30px 한 줄에서 시작해 여섯 줄까지 자란다(위아래 5px 패딩 포함). rows=3이면
    // 첫 입력 순간 SDK의 scrollHeight가 되튀어 하한이 무효다.
    const compactComposerInputBlock = chat.match(/^\.agent-chat-composer-input \{[^}]*\}/m)?.[0] ?? "";
    expect(compactComposerInputBlock).toContain("min-height: 30px;");
    expect(compactComposerInputBlock).toContain("max-height: calc(1.5em * 6 + 10px);");
    expect(chatComposer0).toContain("rows={1}");
    expect(chatComposer0).not.toContain("rows={3}");
    expect(chatView0).toContain('className={`agent-chat-ledge${running ? "" : " is-rest"}${compact ? " is-compact" : ""}`}');
    // 선반은 잡이 하나라도 태어난 세션에서만 넘긴다 — 컴포저와 구성원 바닥 줄이 같은 노드를 나눠 쓴다.
    expect(chatView0).toContain("const ledgeNode = hasJobs ?");
    expect(chatView0).toContain("ledge={ledgeNode}");
    // 컴포저 글리프는 없다 — 글리프의 카운트는 선반의 말이 되고 그 상태 전체가 여닫는 표면이다.
    expect(chatComposer0).not.toContain("agent-chat-composer-work");
    expect(chat).not.toContain(".agent-chat-composer-work");
    // 별도 보기/접기 동사와 화살표는 없다. 스피너·상태·작업 이름을 담은 한 버튼이 rest에서는
    // 선반의 문장으로 머물다가 hover/focus에 brass로 하이라이트되고, 열림은 rim으로 남는다.
    const ledgeToggleBlock = chat.match(/^\.agent-chat-ledge-toggle \{[^}]*\}/m)?.[0] ?? "";
    expect(ledgeToggleBlock).toContain("background: transparent;");
    expect(ledgeToggleBlock).toContain("border: 1px solid transparent;");
    expect(chat).toMatch(/^\.agent-chat-ledge-toggle:hover \{[^}]*background: var\(--control-rest-hover\);[^}]*color: var\(--brass-ink\);/m);
    expect(chat).toMatch(/^\.agent-chat-ledge-toggle\[aria-expanded="true"\] \{[^}]*border-color: var\(--control-open-rim\);/m);
    expect(chatView0).toContain('className="agent-chat-ledge-toggle"');
    expect(chatView0).not.toContain('{t(open ? "terminal.chat.ledgeHide" : "terminal.chat.ledgeShow")}');
    expect(chatView0).not.toContain('<svg viewBox="0 0 16 16"');
    expect(chatView0).toContain('className="agent-chat-strip-orbit"');
    expect(chatView0).toContain('className="agent-chat-strip-count"');
    expect(chatView0).toContain('className="agent-chat-ledge-name"');
    // 도는 중이면 aurora 오브(공용 키프레임). reduced-motion이 오브와 시트의 상승을 멈춘다.
    const stripOrbitBlock = chat.match(/^\.agent-chat-strip-orbit \{[^}]*\}/m)?.[0] ?? "";
    expect(stripOrbitBlock).toContain("animation: agent-chat-orbit 0.9s linear infinite;");
    expect(chat).toContain(".agent-chat-strip-orbit { animation: none; }");
    expect(chat).toContain(".agent-chat-sheet { animation: none; }");
    // 탭은 폐기됐다. 두 면을 갈아 끼우면 대화가 통째로 사라지는데, 백그라운드 작업은 대화를
    // 대신하는 것이 아니라 대화와 동시에 돈다. 선반의 한 문이 대화 위 시트를 열고, 로그는
    // 자리를 지킨 채 아래층으로만 물러난다.
    expect(chat).not.toContain(".agent-chat-tab");
    expect(chatView0).not.toContain('role="tablist"');
    // 대화 면은 어떤 경로로도 숨지 않는다. 이 표면 전체가 존재하는 이유가 그것이다.
    expect(chatView0).not.toContain("agent-chat-log${view");
    // 스플릿은 폐기됐다 — 옆 컬럼이든 아래 서랍이든 열 때마다 로그의 42%를 가져가는 레이아웃
    // 사건이었다. 시트는 로그의 좌표계(.agent-chat-body) 바닥에 절대배치로 붙어 대화의 아래쪽을
    // 덮는다: 열어도 로그와 컴포저는 한 픽셀도 움직이지 않는다. Follow 칩(z 3)보다 위층.
    expect(chat).not.toContain(".agent-chat-split");
    expect(chat).not.toContain(".agent-chat-grip");
    expect(chatView0).not.toContain("agent-chat-grip");
    const sheetBlock = chat.match(/^\.agent-chat-sheet \{[^}]*\}/m)?.[0] ?? "";
    expect(sheetBlock).toContain("position: absolute;");
    expect(sheetBlock).toContain("bottom: 0;");
    expect(sheetBlock).toContain("z-index: 4;");
    // 시트는 유리 채널을 쓰지 않는다 — 도트린은 CSS 규칙 옆에 적혀 있다. 이 면은 캔버스 위가
    // 아니라 채팅 패널 **안**에 떠오르고, instrument에서 --glass-tint-strong의 합성값이 그 위에
    // 서는 잡 카드(--surface-panel-raised)와 대비 1.00으로 겹쳐 카드가 사라졌다(실측). 채팅
    // 로그와 같은 면을 칠해 단차를 되찾고, 층은 위쪽 헤어라인과 그림자가 말한다.
    expect(sheetBlock).toContain("background: var(--surface-panel);");
    // 계약은 선언에만 건다 — 도트린 주석은 폐기된 토큰 이름을 적어 이유를 남겨야 한다.
    const sheetDeclarations = sheetBlock.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheetDeclarations).not.toContain("--glass-");
    expect(sheetBlock).toContain("border-top: 1px solid var(--hairline-strong);");
    expect(sheetBlock).toContain("box-shadow: var(--shadow-soft);");
    // 접는 문은 시트 안에 있고 버튼이다 — 눌리지 않는 힌트 글자는 닫기 자리에 서지 않는다.
    expect(chatView0).toContain('className="agent-chat-sheet-close"');
    expect(chatView0).not.toContain("sheetEscHint");
    const sheetCloseHover = chat.match(/^\.agent-chat-sheet-grow:hover,\n\.agent-chat-sheet-close:hover \{[^}]*\}/m)?.[0] ?? "";
    expect(sheetCloseHover).toContain("background: var(--control-rest-hover);");
    expect(sheetCloseHover).toContain("color: var(--brass-ink);");
    expect(chat).toContain(".agent-chat-sheet-grow:focus-visible,");
    // 시트가 덮은 대화는 물러날 뿐 숨지 않는다 — display·visibility가 아니라 opacity다.
    expect(chat).toContain(".agent-chat-log.is-shaded { opacity: 0.6; }");
    // 칩 줄의 @container 기준은 여전히 대화 면이고, 패널 루트도 컨테이너로 남는다.
    expect(chatRootBlock).toContain("container-type: inline-size;");
    // 읽기 폭 프리셋은 measure 변수 하나만 갈아끼운다 — 로그 컬럼·하단 스트립·덱 타일 스트립이
    // 전부 이 변수를 경유하므로, 세 값(reading/wide/full)이 표면을 한 몸으로 묶는 계약이다.
    // measure는 ch가 아니라 UI 글자 크기에 자릿수를 곱한 값이라 굵기·서체·테마가 폭을 흔들지 않는다.
    expect(chatRootBlock).toContain("--agent-chat-reading-measure: calc(var(--font-body-size) * 57);");
    expect(chatRootBlock).toContain("--agent-chat-measure: var(--agent-chat-reading-measure);");
    expect(chat).toMatch(/\.agent-chat\[data-reading-width="wide"\] \{\s*--agent-chat-measure: calc\(var\(--agent-chat-reading-measure\) \* 1\.4\);\s*\}/);
    expect(chat).toMatch(/\.agent-chat\[data-reading-width="full"\] \{\s*--agent-chat-measure: 100%;\s*\}/);
    // 쉬는(정착만 남은) 선반은 신호 채널을 쓰지 않는다 — aurora는 "지금 돈다"이고, 정지 도트에는
    // 그 사실이 없다. 중립 도트는 hairline-strong만 쓰고, 쉬는 카운트는 중립 잉크다.
    const stripDotBlock = chat.match(/^\.agent-chat-strip-dot \{[^}]*\}/m)?.[0] ?? "";
    expect(stripDotBlock).toContain("border: 2px solid var(--hairline-strong);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(stripDotBlock).not.toContain(signal);
    }
    expect(chat).toContain(".agent-chat-ledge.is-rest .agent-chat-strip-count { color: var(--text-secondary); }");
    // 완료 과정과 Answer는 한 이음새다. 별도 Answer kicker를 다시 세우지 않고, details가 닫히든
    // 열리든 Answer 표식은 과정과 실제 응답 사이의 경계를 지킨다. 과정이 없는 답만 기존 kicker다.
    expect(chatView0).toContain('className={`agent-chat-fold${leadsToAnswer ? " leads-to-answer" : ""}`}');
    // summary의 실제 소요·결말·백그라운드 작업 수·문맥 증가량을 접근성 이름으로 보존한다.
    // 고정 aria-label을 씌우면 이 가시 상태가 전부 가려진다.
    expect(chatView0).not.toContain('<summary aria-label={t("terminal.chat.foldAria")}>');
    expect(chatView0).toContain('className="agent-chat-completion-handoff"');
    expect(chatView0).toContain('className={`agent-chat-answer${hasSettledWork ? " has-seam" : ""}`}');
    expect(chatView0).toContain('? <span className="agent-chat-sr-only">{t("terminal.chat.answerLabel")}</span>');
    const completionSummaryBlock = chat.match(/^\.agent-chat-fold\.leads-to-answer > summary \{[^}]*\}/m)?.[0] ?? "";
    expect(completionSummaryBlock).toContain("display: flex;");
    expect(completionSummaryBlock).toContain("width: 100%;");
    const completionNodeBlock = chat.match(/^\.agent-chat-completion-node \{[^}]*\}/m)?.[0] ?? "";
    expect(completionNodeBlock).toContain("background: var(--positive);");
    expect(completionNodeBlock).not.toContain("--brass");
    const completionRunningNodeBlock = chat.match(/^\.agent-chat-completion-node\.is-running \{[^}]*\}/m)?.[0] ?? "";
    expect(completionRunningNodeBlock).toContain("background: var(--aurora);");
    const completionRuleBlock = chat.match(/^\.agent-chat-completion-rule \{[^}]*\}/m)?.[0] ?? "";
    expect(completionRuleBlock).toContain("background: var(--hairline);");
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
    // [doctrine] 물결은 "이 줄이 아직 자라고 있다"를 말하므로
    // 색 채널을 하나도 빌리지 않는 명도 스윕이다 — 같은 기법을 쓰는 ULTRACODE 물결이 apex를
    // 쓰는 것과 갈리는 지점이 바로 이것이고, 신호를 빌리면 자라는 줄이 상태색을 지게 된다.
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
    expect(chatLiveTextBlock).toContain("var(--live-sweep-trough) 0%,");
    expect(chatLiveTextBlock).toContain("var(--live-sweep-trough) 100%");
    // 물결의 두 끝은 --text-* 를 직접 물지 않는다. 물결의 세기는 두 끝의 명도 간격인데, 텍스트
    // 사다리를 그대로 쓰면 그 간격이 테마마다 딸려 가고 라이트에서 실측 진폭이 다크의 54%로
    // 죽는다(정지한 줄로 읽힘). 판독 계약(--text-*)과 물결 진폭은 다른 역할이므로 갈라 둔다.
    expect(chatLiveTextBlock).not.toContain("var(--text-tertiary)");
    expect(chatLiveTextBlock).not.toContain("var(--text-primary)");
    // 마루는 두 테마 모두 "가장 진한 잉크"다 — 극성이 갈리면 같은 몸짓이 아니게 된다.
    const themeCssForSweep = source("styles/theme.css");
    expect(themeCssForSweep).toContain("--live-sweep-trough: var(--text-tertiary);");
    expect(themeCssForSweep).toContain("--live-sweep-crest: var(--text-primary);");
    // 라이트만 트러프를 텍스트 사다리에서 한 단 떼어 낸다. 대비의 기준 면은 평평한 패널이 아니라
    // 물결이 실제로 도는 **라이브 행**이다 — "Thinking" 줄은 aurora 4%를 섞은
    // raised(라이트에서 --ink-deep) 위 L93.68%에 앉아 패널보다 어둡다. 패널 기준으로 고른 L55는
    // 그 행에서 4.03:1로 본문 AA 아래였다. L52가 라이브 행 4.58:1 / 패널 5.23:1로 경계(L52.39)
    // 안쪽이다. 트러프는 물결의 3분의 2를 차지하는 휴지 잉크라 판독이 진폭보다 먼저다.
    const whitesSweepBlock = themeCssForSweep.match(/^:root\[data-theme="light"\][^{]*\{[^}]*\}/m)?.[0] ?? "";
    expect(whitesSweepBlock).toContain("--live-sweep-trough: oklch(52% 0.012 95);");
    // 라이브 행의 바탕이 바뀌면 위 대비 계산의 전제가 무너진다 — 채팅 행이 같은 레시피를 쓰는 것이
    // 그 계산의 근거이므로 함께 못박는다.
    // 섞는 공간은 oklab이다 — oklch는 두 색의 색상 호를 걸어 whites에서 aurora 30% 테두리가
    // hue 133(녹회색)으로 떨어졌다(실측). 4% 바탕의 명도(L93.68%)는 두 공간에서 같으므로
    // 위 대비 계산은 그대로 선다.
    const liveRowSurface = "background: color-mix(in oklab, var(--aurora) 4%, var(--surface-panel-raised));";
    expect(chat).not.toContain("color-mix(in oklch, var(--aurora) 30%, var(--hairline))");
    expect(chat).toContain("border-color: color-mix(in oklab, var(--aurora) 30%, var(--hairline));");
    expect(chat).toContain(liveRowSurface);
    // 라이트가 마루를 따로 잡으면 극성 계약이 조용히 갈린다 — 마루는 기본값을 그대로 받는다.
    expect(whitesSweepBlock).not.toContain("--live-sweep-crest:");
    // 진행 중 턴 헤드의 시계는 물결을 지지 않는다 — "이 턴이 아직 살아 있다"는 원장의 라이브
    // 줄 하나가 말한다. 같은 사실을 헤드·집계·생각 행이 동시에 말하던 때에는 링 2개와
    // 애니메이션 6개가 한 화면에 돌았다(실측). 살아 있는 줄은 턴에 하나다.
    expect(chatView0).toContain('<span className="agent-chat-turn-clock" aria-hidden="true">');
    expect(chatView0).toContain('t("terminal.chat.turnWorking"');
    expect(chatView0).not.toContain('<span className="agent-chat-live-text" aria-hidden="true">');
    expect(chat).not.toContain(".agent-chat-turn-head .agent-chat-live-text");
    // "생각 중…"은 상자가 아니라 라이브 줄의 꼬리다 — 상자는 동사·대상·결과의 그릇이고 생각에는
    // 둘 다 없다. 라이브 집계는 앞 링을 달지 않는다. 진행은 물결·동사·생각 표식이 말한다.
    expect(chatView0).not.toContain('<div className="agent-chat-step is-running">\n          <span className="agent-chat-step-orbit"');
    expect(chatView0).toContain("const alive = live && (tails.length > 0 || thinking);");
    expect(chatView0).not.toContain('{alive ? <span className="agent-chat-step-orbit" aria-hidden="true" /> : null}');
    // 생각의 점은 한 칸씩 차오르고 되돌아간다. 바깥 폭은 3칸으로 고정해 줄이 흔들리지 않고,
    // 장식 점은 라이브 리전의 매 박자 재낭독을 막기 위해 접근성 트리에서 빠진다.
    expect(chatView0).toContain('className="agent-chat-thinking-dots" aria-hidden="true"');
    const thinkingDotsBlock = chat.match(/\.agent-chat-thinking-dots > span \{[^}]*\}/)?.[0] ?? "";
    expect(thinkingDotsBlock).toContain("width: 1ch;");
    expect(thinkingDotsBlock).toContain("visibility: hidden;");
    expect(thinkingDotsBlock).not.toContain("opacity");
    expect(chat).toMatch(/\.agent-chat-thinking-dots > span:first-child \{\s*visibility: visible;\s*\}/);
    expect(chat).toMatch(/\.agent-chat-thinking-dots > span:nth-child\(2\) \{\s*animation: agent-chat-thinking-dot-mid 1\.2s steps\(1, end\) infinite;\s*animation-name: var\(--state-motion, agent-chat-thinking-dot-mid\);\s*\}/);
    expect(chat).toMatch(/\.agent-chat-thinking-dots > span:nth-child\(3\) \{\s*animation: agent-chat-thinking-dot-end 1\.2s steps\(1, end\) infinite;\s*animation-name: var\(--state-motion, agent-chat-thinking-dot-end\);\s*\}/);
    expect(chat).toMatch(/@keyframes agent-chat-thinking-dot-mid \{\s*0%, 33\.332% \{ visibility: hidden; \}\s*33\.333%, 100% \{ visibility: visible; \}\s*\}/);
    expect(chat).toMatch(/@keyframes agent-chat-thinking-dot-end \{\s*0%, 66\.665% \{ visibility: hidden; \}\s*66\.666%, 100% \{ visibility: visible; \}\s*\}/);
    expect(chat).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-chat-thinking-dots > span \{\s*animation: none;\s*visibility: visible;\s*\}/);
    // 흐르는 글의 표식 — 캐럿은 secondary 잉크(채널 없음)로 마지막 블록 끝에 서고, 끝단
    // 옅어짐은 알파 마스크다. 둘 다 흐르는 동안만 걸리고 감속 모션에서 점멸·마스크가 걷힌다.
    const chatCaretBlock = chat.match(/\.agent-chat-stream\.is-streaming > :last-child:not\(ol, ul, pre\)::after,[\s\S]*?\}/)?.[0] ?? "";
    expect(chatCaretBlock).toContain("background: var(--text-secondary);");
    expect(chatCaretBlock).toContain("animation: agent-chat-caret 1.1s steps(2, jump-none) infinite;");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--id-"]) {
      expect(chatCaretBlock, signal).not.toContain(signal);
    }
    expect(chat).toMatch(/\.agent-chat-stream\.is-streaming \{[\s\S]*?-webkit-mask-image: linear-gradient\(to bottom, #000 calc\(100% - 1\.6em\), rgb\(0 0 0 \/ 42%\)\);/);
    const chatCaretSeal = chat.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-chat-stream\.is-streaming > pre:last-child > code::after \{\s*animation: none;\s*\}[\s\S]*?\.agent-chat-stream\.is-streaming \{\s*-webkit-mask-image: none;\s*mask-image: none;\s*\}/)?.[0] ?? "";
    expect(chatCaretSeal).not.toBe("");
    const streamedMarkdown = fs.readFileSync(fileURLToPath(new URL("../features/execution/client/agent/streamed-markdown.tsx", import.meta.url)), "utf8");
    expect(streamedMarkdown).toContain('const streamingClass = streaming ? `${className ?? ""} is-streaming`.trim() : className;');
    // 물결 봉인은 모션만 죽이고 줄은 남긴다. `color: transparent`가 남으면 글자가 통째로
    // 사라지므로 그라데이션과 채움을 함께 되돌려야 한다(ULTRACODE 물결과 같은 함정).
    const chatLiveSealBlock = chat.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-chat-live-text \{[^}]*\}/)?.[0] ?? "";
    expect(chatLiveSealBlock).toContain("animation: none;");
    expect(chatLiveSealBlock).toContain("background-image: none;");
    expect(chatLiveSealBlock).toContain("color: var(--text-secondary);");
    // 동사 자리("Thinking")는 `.agent-chat-step-verb`가 같은 특정성으로 뒤에 서서
    // `color: transparent`를 이긴다 — 불투명 잉크가 클립된 그라데이션을 덮어 물결이 두 테마
    // 모두에서 죽는다. 두 클래스를 함께 다는 자리에만 못을 박는다.
    expect(chat).toMatch(
      /\.agent-chat-step-verb\.agent-chat-live-text \{\s*color: transparent;\s*\}/,
    );
    // 그 짝(0,2,0)은 봉인의 기본 채움(0,1,0)도 이기므로 봉인 안에 같은 짝이 서야 한다 —
    // 빠지면 감속 모션에서 `color: transparent`가 살아남아 동사가 통째로 사라진다.
    expect(chat).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-chat-step-verb\.agent-chat-live-text \{\s*color: var\(--text-secondary\);\s*\}/,
    );
    // 잡은 원장 본문에 자기 줄을 갖지 않는다 — 집계의 한 절이 그 수를 말하고, 그 잡으로 가는
    // 문은 집계를 펼쳤을 때 선다. 앵커가 본문에 서던 시절, 완료한 잡이 많은 턴은 꼬리가 결말
    // 칩의 목록이 됐다(✓ 옆에 「완료」를 적는 줄이 잡마다 하나씩).
    const chatJobAnchorBlock = chat.match(/^\.agent-chat-job-anchor \{[^}]*\}/m)?.[0] ?? "";
    expect(chatJobAnchorBlock).toContain("background: none;");
    expect(chatJobAnchorBlock).toContain("border: none;");
    expect(chatJobAnchorBlock).toContain("border-bottom: 1px dashed var(--hairline-strong);");
    // 글자만큼만 넓다 — 블록으로 두면 파선이 패널을 가로질러 구분선으로 읽힌다(실측 적발).
    expect(chatJobAnchorBlock).toContain("width: max-content;");
    expect(chatView0).toContain('className={`agent-chat-job-anchor ${jobStateClass(job)}`}');
    // 잡 절은 예외를 함께 말한다 — 도는 것과 실패한 것을 수 하나에 섞으면 접기가 감추기가 된다.
    expect(chatView0).toContain("agent-chat-tally-jobs-open");
    expect(chatView0).toContain("agent-chat-tally-jobs-fail");
    // 작업 면의 잡은 카드가 아니라 한 줄이다. 카드는 57px에 테두리를 둘러, 열일곱 건이면
    // 62%짜리 시트에 여덟 건이 채 서지 못했다(실측 1,097px).
    expect(chatView0).not.toContain("function JobCard(");
    expect(chatView0).toContain("function JobRow(");
    expect(chat).not.toMatch(/^\.agent-chat-job \{/m);
    const chatJobRowBlock = chat.match(/^\.agent-chat-job-row \{[^}]*\}/m)?.[0] ?? "";
    expect(chatJobRowBlock).toContain("min-height: 28px;");
    expect(chatJobRowBlock).toContain("background: transparent;");
    expect(chatJobRowBlock).toContain("border: 0;");
    // 끝난 잡의 종류 가지. 줄기는 헤어라인 한 겹이고 상태색도 brass도 쥐지 않는다 — 구조를
    // 말하는 선이지 선택을 말하는 띠가 아니다(왼쪽 강조 띠 금지와 같은 규율).
    const chatBranchKidsBlock = chat.match(/^\.agent-chat-work-branch-kids \{[^}]*\}/m)?.[0] ?? "";
    expect(chatBranchKidsBlock).toContain("border-left: 1px solid var(--hairline);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--id-"]) {
      expect(chatBranchKidsBlock).not.toContain(signal);
    }
    // 집계를 펼친 줄기도 같은 규율이다. 잎은 상자를 벗고(33px → 24px) 계열 글자를 스스로 든다 —
    // 줄기를 계열로 가르면 "무엇 다음에 무엇"이 사라지므로 갈래는 시간 하나뿐이다.
    const chatTallyBodyBlock = chat.match(/^\.agent-chat-tally-body \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyBodyBlock).toContain("border-left: 1px solid var(--hairline);");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--id-"]) {
      expect(chatTallyBodyBlock).not.toContain(signal);
    }
    const chatLeafBlock = chat.match(/^\.agent-chat-step\.is-leaf \{[^}]*\}/m)?.[0] ?? "";
    expect(chatLeafBlock).toContain("background: none;");
    expect(chatLeafBlock).toContain("border: 0;");
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
    // 계열 표식은 잡 글리프와 같은 알파벳이다 — 같은 일을 두 면이 다른 기호로 부르면 표식이
    // 어휘가 아니라 장식이 된다. 알파벳은 모노라인 SVG(agent-glyphs.tsx)로 currentColor만 쓰고,
    // 잉크는 줄의 문구 사다리(tertiary, 라이브에서 secondary)에서 온다 — 채널 색은 쥐지 않는다.
    // 물결은 배경 클립이라 아이콘을 통과하지 못하므로 표식은 물결을 타지 않고 고정 잉크로 선다.
    const chatTallyGlyphBlock = chat.match(/^\.agent-chat-tally-glyph \{[^}]*\}/m)?.[0] ?? "";
    expect(chatTallyGlyphBlock).toContain("color: var(--text-tertiary);");
    expect(chatTallyGlyphBlock).toContain("width: 1em;");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass", "--id-"]) {
      expect(chatTallyGlyphBlock, signal).not.toContain(signal);
    }
    expect(chat).toMatch(/\.agent-chat-tally\.is-live \.agent-chat-tally-glyph \{\s*color: var\(--text-secondary\);\s*\}/);
    const agentGlyphs = fs.readFileSync(fileURLToPath(new URL("../features/execution/client/agent/agent-glyphs.tsx", import.meta.url)), "utf8");
    expect(agentGlyphs).toContain('stroke="currentColor"');
    expect(agentGlyphs).not.toMatch(/var\(--(aurora|positive|warn|coral|brass|id-)/);
    for (const family of ["delegate", "run", "workflow", "think"]) {
      expect(agentGlyphs, family).toContain(`${family}: [`);
    }
    const chatView0Glyphs = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    expect(chatView0Glyphs).not.toContain("FAMILY_GLYPHS");
    // 집계 절의 표식도 같은 알파벳에서 온다. 잡 절만 자기 글자가 없어 위임 글자를 빌린다 —
    // 원장의 위임 절과 작업 면의 위임 카드가 이미 쓰는 그 글자다.
    expect(chatView0Glyphs).toContain('<span className="agent-chat-tally-glyph" aria-hidden="true">');
    expect(chatView0Glyphs).toContain('<AgentGlyph name={group.family === AGENT_CHAT_JOB_FAMILY ? "delegate" : group.family} />');
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
    // 쓰는 자리는 읽는 컬럼에 정렬한다 — 상한일 뿐 고정폭이 아니라 좁아지면 따라 줄어든다.
    // 컴포저 상한은 읽기 폭 변수를 그대로 받는다: 넓게 읽는 사람이 정작 긴 지시를 좁은 창에
    // 쓰게 되면 여섯 줄이라는 가시 상한이 그만큼 빨리 닫힌다.
    const composerFrameBlock = chat.match(/^\.agent-chat-composer-frame \{[^}]*\}/m)?.[0] ?? "";
    expect(composerFrameBlock).toContain("max-width: var(--agent-chat-measure);");
    expect(composerFrameBlock).toContain("margin-inline: auto;");
    // 폭은 값 하나다 — 대화와 입력창을 가르는 두 번째 축을 두면 두 상한이 서로를 덮는 순서 싸움이 된다.
    expect(chat).not.toContain("--agent-chat-composer-measure");
    expect(chat).not.toContain("data-composer-width");
    for (const preset of ["wide", "full"]) {
      const presetBlock = chat.match(new RegExp(`\\.agent-chat\\[data-reading-width="${preset}"\\] \\{[^}]*\\}`))?.[0] ?? "";
      expect(presetBlock, preset).toContain("--agent-chat-measure:");
    }
    // 폭 글리프는 첨부·작업과 같은 또래다 — 같은 상자(30px)와 같은 문법(투명 바탕·tertiary 잉크).
    // 상자를 못박지 않으면 한 줄에 선 글리프들이 서로 다른 클릭 과녁을 갖는다.
    const composerWidthBlock = chat.match(/^\.agent-chat-composer-width \{[^}]*\}/m)?.[0] ?? "";
    for (const decl of ["border: 0;", "background: transparent;", "color: var(--text-tertiary);", "padding: 7px;", "width: 30px;", "height: 30px;"]) {
      expect(composerWidthBlock, decl).toContain(decl);
    }
    // 실행 중에는 현재 턴의 중지와 다음 턴의 예약을 분리해 함께 세운다. 중지는 행동이지 오류
    // 상태가 아니므로 중립 잉크를 쓰고, signal token은 빌리지 않는다.
    expect(chat).not.toContain(".agent-chat-stop");
    expect(chatView).not.toContain('className="agent-chat-stop"');
    const composerStopBlock = chat.match(/^\.agent-chat-composer-stop \{[^}]*\}/m)?.[0] ?? "";
    // 중지는 폭 글리프와 같은 자리를 쓴다 — 같은 잉크·같은 패딩·테두리 없는 투명 바탕이라
    // 바에 선 컨트롤들이 한 문법으로 읽힌다. 첨부 입구는 그 행을 떠나 공유 「+」 원
    // (fc-composer-plus)이 입력 왼쪽에 선다. 라벨을 두르면 도는 동안에만 서는 문 하나가 바에서
    // 가장 큰 물건이 되어, 상시로 읽어야 할 좌표와 계기를 밀어낸다.
    // 한 행에 선 글리프 버튼들은 한 문법을 쓴다. 백그라운드 작업 글리프는 이 행을 떠났다 —
    // 그 몫은 컴포저 위 선반(.agent-chat-ledge)이 말로 진다.
    for (const glyph of ["border: 0;", "background: transparent;", "color: var(--text-tertiary);", "padding: 7px;"]) {
      expect(composerStopBlock, glyph).toContain(glyph);
    }
    // 상자는 표식이 아니라 글리프 규격을 따른다 — 이웃이 16px svg를 싣고 있어, 표식 크기를 그대로
    // 상자로 쓰면 같은 패딩에도 버튼만 작아지고 클릭 과녁이 나란히 어긋난다(실측 25 vs 30).
    const stopMarkBlock = chat.match(/^\.agent-chat-composer-stop-mark \{[^}]*\}/m)?.[0] ?? "";
    expect(stopMarkBlock).toContain("width: 16px;");
    expect(stopMarkBlock).toContain("height: 16px;");
    expect(chatComposer).toContain('className="agent-chat-composer-stop"');
    expect(chatComposer).toContain("is-queue");
    // 표식만 남고 라벨은 aria/title이 진다.
    expect(chatComposer).not.toContain("terminal.chat.stopCurrent");
    for (const signal of ["--aurora", "--positive", "--warn", "--coral"]) {
      expect(composerStopBlock, signal).not.toContain(signal);
    }
    // 문맥 계기도 같은 글리프 자리를 쓴다 — 숫자는 팝오버로 가고 원호만 바에 선다. 채움은
    // 압력을 나르는 상태 잉크를 그대로 쓰지만(압력은 상태다), 칩 자신은 알약을 두르지 않는다.
    const ctxChipBlock = chat.match(/^\.agent-chat-ctx-chip \{[^}]*\}/m)?.[0] ?? "";
    expect(ctxChipBlock).toContain("background: transparent;");
    expect(ctxChipBlock).toContain("border: 0;");
    expect(ctxChipBlock).toContain("padding: 7px;");
    expect(chatView).not.toContain("agent-chat-ctx-pct");
    // 예약은 접수 증서이지 상태 경보가 아니다 — 중립 잉크로 사실만 남긴다. 취소만이 파괴
    // 동작이라 coral을 지되, 첨부 제거와 같이 hover/focus에서만 오른다.
    const queueItemBlock = chat.match(/^\.agent-chat-composer-queue-item \{[^}]*\}/m)?.[0] ?? "";
    for (const signal of ["--aurora", "--positive", "--warn", "--coral", "--brass"]) {
      expect(queueItemBlock, signal).not.toContain(signal);
    }
    const queueCancelBlock = chat.match(/^\.agent-chat-composer-queue-cancel \{[^}]*\}/m)?.[0] ?? "";
    expect(queueCancelBlock).toContain("color: var(--text-tertiary);");
    expect(queueCancelBlock).not.toContain("--coral");
    const queueCancelHoverBlock = chat.match(/^\.agent-chat-composer-queue-cancel:hover,\n\.agent-chat-composer-queue-cancel:focus-visible \{[^}]*\}/m)?.[0] ?? "";
    expect(queueCancelHoverBlock).toContain("color: var(--coral);");
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
    // 상주하는 부유 컨트롤만이 자기 몫의 로그 여백을 가진다 — 로그 위에 계속 서 있는 면이라야
    // 바닥까지 내린 마지막 줄을 영구히 가두기 때문이다. 그런 면은 이제 하나도 없다: 작업 스트립은
    // 컴포저 표시줄로 내려갔고, 남은 Follow 칩과 Ctrl+C 안내는 일시적이라 한 번의 스크롤로
    // 칩과 함께 풀려난다. 위쪽 34px(전환 칩 줄)에 이어 아래 45px도 사라져, 읽는 여백 하나가
    // 위아래를 함께 진다 — 마지막 답과 그 답에 이어 쓰는 자리가 메신저 한 화면 안에 든다.
    const chatLogBlock = chat.match(/^\.agent-chat-log \{[^}]*\}/m)?.[0] ?? "";
    const chatLogPadding = chatLogBlock.match(/padding: ([^;]+);/)?.[1] ?? "";
    expect(chatLogPadding.startsWith("var(--space-3) ")).toBe(true);
    expect(chatLogPadding).not.toContain("34px");
    expect(chatLogPadding).not.toContain("45px");
    // 백그라운드 작업 글리프는 컴포저 툴 행(in-flow) 안으로, 중지는 컴포저의 발사 자리로
    // 들어가 더 이상 로그 위에 얹히지 않는다.
    // 로그 위에 얹히는 면은 --surface-panel-raised로만 물러난다 — 잉크 티어를 직접 잡으면
    // 테마마다 다른 방향(다크는 위, 라이트는 아래)이 한 값으로 굳어 한쪽 테마에서 위계가 무너진다.
    // 스크림은 예외다 — ink-abyss 기반 오버레이는 제품 전역 관례이며 패널 면 위계와 무관하다.
    // 개수가 아니라 자리를 고정한다: 이 잉크는 덮는 면(스크림·오버레이)의 background 선언에만
    // 설 수 있고, 패널 본문이 같은 값을 칠하면 여기서 걸린다.
    expect(chat).not.toContain("var(--ink-deep)");
    for (const block of chat.split("}")) {
      if (!block.includes("var(--ink-abyss)")) continue;
      const selector = block.slice(0, block.indexOf("{")).trim();
      expect(selector, selector).toMatch(/-(scrim|interstitial)\b/);
      expect(block, selector).toContain("inset: 0;");
    }
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
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    expect(components).not.toMatch(/font-family:\s*var\(--font-display\)/);
    expect(components).not.toMatch(/data-sidebar-state="(?:rail|list|detail)"/);
    expect(components).not.toContain("global-navigation");
    expect(components).not.toContain("data-signature");
    expect(terminalAgent).not.toContain("data-signature");
  });

  it("keeps the retired carrier identity grammar out of the product", () => {
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const theme = source("styles/theme.css");

    // 캐리어 스트림과 함장 정체성 토큰은 함께 퇴역했다 — 어느 한쪽만 되살아나도 잡는다.
    expect(theme).not.toContain("--captain-");
    expect(theme).not.toContain("--carrier-");
    expect(terminalAgent).not.toContain("data-captain");
  });

  it("keeps the remote NAT endpoint on the established token grammar without warn hover", () => {
    const settings = source("../../../features/remote-access/client/settings-section.tsx");
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

  it("keeps the access-link entry in the console section and out of Settings", () => {
    const consoleSection = source("../../../features/remote-access/client/console-section.tsx");
    const settings = source("../../../features/remote-access/client/settings-section.tsx");
    const dialog = source("../../../features/remote-access/client/add-host-dialog.tsx");

    // 추가는 관리보다 위에 선다 — 목록을 고르러 온 사람이 먼저 만나는 것은 새 콘솔을 붙이는 일이다.
    const addAt = consoleSection.indexOf('t("chrome.hosts.add")');
    const manageAt = consoleSection.indexOf('t("chrome.hosts.manage")');
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
    const systemCluster = source("chrome/components/command-band-system-cluster.tsx");
    const sidebar = source("../../../features/workspace/client/sidebar/objective-records-side-bar.tsx");
    const chip = source("../../../features/workspace/client/sidebar/objective-records-side-bar-chip.tsx");
    const statusIcon = source("../../../features/execution/client/components/objective-status-icon.tsx");
    const nameMark = source("../../../features/execution/client/components/objective-name-mark.tsx");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");

    expect(systemCluster).toContain('className="command-band-system-menu" role="menu"');
    // 설정의 문은 대화 독의 톱니 하나다 — 시스템 메뉴에는 설정 진입이 따로 없다.
    expect(systemCluster).not.toContain("command-band-settings");
    expect(source("chrome/toolbar/settings-button.tsx")).toContain('t("settings.title")');
    expect(systemCluster).toContain('t("chrome.system.keyboardShortcuts")');
    expect(systemCluster).toContain("openWhatsNew");
    expect(components).not.toContain(".command-band-system-cluster {");
    expect(components).not.toContain(".side-bar-brand-foot");

    expect(sidebar).toContain("hasCustomGroups && sectionItems.length + foldItems.length > 0");
    expect(sidebar).toContain("<TheaterAvatar theaterId={theater.id}");
    expect(chip).toContain("side-bar-chip-status");
    // 이름 왼쪽 칸의 조형 선택은 한 모듈이 소유한다 — 표면마다 분기를 다시 적으면 같은 사실이 표면 수만큼의
    // 조형으로 갈라진다. 사이드바 칩과 목록 래퍼는 같은 몽글 아바타 모듈(역할·배정·상태 해석)을 지난다.
    expect(chip).toContain('import { ObjectiveAvatar, mongleStateOfMark } from "../avatars.js"');
    expect(nameMark).toContain('return <ObjectiveStatusIcon objectiveRecord={objectiveRecord} status={status}');
    // 목록 래퍼의 얼굴은 사이드바 칩과 같은 경로(표식 → 묶음 사실)로 고른다 — 종류 분기는 그 위층의 다른 질문이다.
    expect(statusIcon).toContain('import { ObjectiveAvatar, clusterFaceFacts, mongleStateOfMark } from "../../../workspace/client/avatars.js";');
    expect(statusIcon).toContain("mongleStateOfMark(status, clusterFaceFacts(clusters, objectiveRecord.id))");
    // Shell이 Objective을 떠난 뒤로 이 칸에는 활동 비콘만 선다 — 종류 분기가 사라졌다.
    expect(chip).not.toContain("is-attention");
    expect(components).toContain(".side-bar-chip:focus-within .side-bar-chip-close");

    expect(source("../../../features/workspace/client/objective-records.tsx")).toContain("onRename={handleRename}");
    expect(components).not.toContain("border-color: inherit;");
    expect(components).not.toContain("border: 1px solid inherit;");
    expect(components).not.toContain("--uw-tint");
    expect(components).not.toContain("--uw-glow");
    expect(source("styles/theme.css")).not.toContain("--uw-angle");
    expect(source("styles/layout.css")).not.toContain(".command-band-objective-status");
    expect(source("styles/layout.css")).not.toContain(".command-band-objective-attribute");
    expect(rail).not.toContain(".right-rail-icons");
    expect(components).toContain("@keyframes caption-rail-travel");
    expect(components).not.toContain("@keyframes caption-rail-call");
    expect(components).not.toContain("@keyframes caption-rail-tide");
    expect(components).not.toContain("@keyframes caption-rail-pulse");
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
    expect(selectBlock).toContain("font-weight: var(--weight-medium); font-size: var(--t-md); line-height: 1.2; font-family: var(--font-ui);");
    expect(selectBlock).toContain("padding: 0 13px;");
    expect(selectBlock).toContain("box-shadow: inset 0 1px 0 color-mix(in oklch, var(--ink-pearl) 5%, transparent);");
    // 팝업은 공통 팝업 표면이고, 고른 행은 중립 워시 + 본문색 체크다(금색은 포커스 링에만).
    expect(selectBlock).toContain("background: var(--popover-face);");
    expect(selectBlock).toContain(".fc-select__option[aria-selected=\"true\"] { background: var(--wash-selected); }");
    expect(selectBlock).toContain('content: "✓";');
    expect(selectBlock).toContain("font-style: italic;");
    expect(selectBlock).toContain(".fc-select--compact .fc-select__trigger {");
    // compact 트리거는 칩 문법의 모노 티어(11px)를 쓴다 — 본문 14px 옆에서 9px는 라벨이 아니라 흔적이 된다.
    expect(selectBlock).toContain(
      "font-weight: var(--weight-regular);\n  font-size: var(--t-xs);\n  line-height: 1;\n  font-family: var(--font-ui);",
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
    for (const name of ["light"]) {
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
    // 자리는 둘(강도 트랙 값·Chat 좌표 칩)이고 값이 갈라지면 안 된다.
    expect(components).toMatch(
      /@keyframes effort-ultracode-wave \{\s*to \{ background-position: -200% 0; \}\s*\}/,
    );
    expect(components).not.toContain("effort-ultracode-wave 2.6s");
    expect(components.match(/animation: effort-ultracode-wave 1\.9s linear infinite;/g)?.length).toBe(1);
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
    const theme = desktopThemeSource();
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    const whites = theme.slice(theme.indexOf(':root[data-theme="light"]'));

    // 계기 무게는 테마마다 갈리는 값이다 — base가 채널을 열고 라이트가 전부 분화한다.
    // 한 토큰이라도 라이트에서 빠지면 그 자리만 다크의 명도 순서를 상속해 사다리가 부분적으로 뒤집힌다.
    const GAUGE_TOKENS = [
      "--gauge-face", "--gauge-face-lift", "--gauge-face-lift-strong",
      "--gauge-fill", "--gauge-apex", "--gauge-crest", "--gauge-rim",
      "--gauge-texture", "--gauge-drift",
      "--gauge-weight-quiet", "--gauge-weight-warn", "--gauge-weight-critical",
      "--gauge-fill-neutral", "--gauge-fill-warn",
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
    // 설정 슬라이더 손잡이도 같은 계기 면이다 — 면은 --gauge-face로 칠하고, 두 엔진의 손잡이가 모두 그 면을 쓴다.
    const slider = components.match(/^\.fleet-slider \{[^}]*\}/m)?.[0] ?? "";
    expect(slider).toContain("--slider-face: radial-gradient(circle, var(--gauge-face)");
    expect(slider).not.toContain("var(--text-primary)");
    expect(components).toMatch(/^\.fleet-slider::-webkit-slider-thumb \{[^}]*background: var\(--slider-face\);/m);
    expect(components).toMatch(/^\.fleet-slider::-moz-range-thumb \{[^}]*background: var\(--slider-face\);/m);
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

  it("pins the chat composer ultracode grammar — same recognition, apex frame, static border", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const composer = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_COMPOSER_PATH), "utf8");

    // 인식·미러·해제 문법은 공용 부품(execution composer primitives)에서 온다 — 이 조립은
    // 상태와 표식만 진다. 무장은 초안과 해제 여부에서만 나온다.
    expect(composer).toContain('} from "../../composer-primitives/ultracode.js";');
    expect(composer).toContain("const ultracodeArmed = ultracodeTokens.length > 0 && !ultracodeIgnored;");
    expect(composer).toContain('${ultracodeArmed ? " is-ultracode" : ""}');
    // 미러는 한 층이고 구간마다 클래스를 싣는다 — `ultracode` 무장과 덱이 완성한 좌표가 같은
    // textarea 위에 함께 겹치기 때문이다. 층을 둘로 띄우면 스크롤·자동 높이에서 서로 어긋난다.
    expect(composer).toContain('className: "agent-chat-composer-ultracode-token"');
    expect(composer).toContain("renderComposerSpans(draft, highlightSpans)");
    expect(composer).toContain('<p className="agent-chat-composer-ultracode-notice" role="status">');

    // Backspace 해제는 키 반복도, 수식 키가 붙은 삭제(⌥/Ctrl 단어·⌘ 줄)도 먹지 않는다 —
    // 가로채면 방금 친 단어를 지우려던 키가 아무것도 지우지 않는다.
    expect(composer).toContain('event.key === "Backspace" && !event.repeat && ultracodeArmed');
    expect(composer).toContain("&& !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey");

    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 무장 프레임은 apex 채널 하나로만 말한다 — 신호 토큰(aurora/warn/coral/positive)도, 위치
    // 채널(brass)도 빌리지 않는다. 도는 conic 링이 아니라 정지한 테두리다
    // (좌표의 is-ultracode가 이 면에서 이미 내린 결정). apex×중립 혼합은 oklab이다(hue 호 관통 방지).
    // 완성된 좌표는 위치 채널(brass)이고 무장 표식은 apex다. 둘이 한 줄에 함께 설 수 있으므로
    // 색이 갈라져 있어야 구분된다 — 좌표가 apex를 빌리면 무장한 것으로 읽힌다.
    const resolved = block(".agent-chat-composer-resolved-token");
    expect(resolved).toContain("var(--brass)");
    for (const signal of ["--aurora", "--warn", "--coral", "--positive", "--apex"]) {
      expect(resolved, signal).not.toContain(signal);
    }

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

  it("pins the chat maintenance-lane grammar - a command is not a turn", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 정비 명령은 턴 문법을 하나도 빌리지 않는다. 그 문법 전체가 "모델이 생각하고 있다"를
    // 말하는데, 이 동작들은 세션 상태를 즉시 바꾸고 둘은 모델을 아예 부르지 않는다.
    const row = block(".agent-chat-command-row");
    expect(row).toContain("color: var(--text-tertiary);");
    for (const turnish of ["animation", "--id-cerulean", "--apex"]) {
      expect(row, turnish).not.toContain(turnish);
    }

    // 상태는 점 하나가 지고 **모션이 없다** — 맥동은 이 원장에서 "모델이 살아 있다"는 뜻이다.
    const dot = block(".agent-chat-command-dot");
    expect(dot).not.toContain("animation");
    expect(chat).toContain(".agent-chat-command-row.is-running .agent-chat-command-dot { background: var(--aurora); }");
    expect(chat).toContain(".agent-chat-command-row.is-failed .agent-chat-command-dot { background: var(--coral); }");

    // 이름만 brass다 — 컴포저 미러가 해석된 `/이름`을 칠하는 것과 같은 토큰, 같은 뜻.
    expect(block(".agent-chat-command-name")).toContain("color: var(--brass-ink);");
    const detail = block(".agent-chat-command-detail");
    expect(detail).toContain("color: var(--text-tertiary);");
    expect(detail).not.toContain("--brass");

    // 되찾은 문맥은 여러 줄을 나란히 놓고 읽는 수다.
    expect(block(".agent-chat-command-elapsed")).toContain("font-variant-numeric: tabular-nums;");

    // 이 줄도 원장의 한 컬럼에 선다. `margin: 0`으로 쓰면 `.agent-chat-log > *`의 auto를 덮어
    // (같은 특정성, 더 늦은 선언) 이 줄만 패널 왼쪽 끝에 붙는다.
    expect(row).toContain("margin: 0 auto;");

    // 계기는 되찾은 몫을 채운다: 도는 동안 aurora(작업 중), 끝나면 positive(성공).
    expect(block(".agent-chat-command-gauge-fill")).toContain("background: var(--positive);");
    const runningFill = chat.slice(chat.indexOf(".agent-chat-command-row.is-running .agent-chat-command-gauge-fill {"));
    expect(runningFill.slice(0, runningFill.indexOf("}"))).toContain("background: var(--aurora);");

    // 감속 모션에서 왕복은 서되 계기는 남는다 — 띠를 통째로 눕히면 "끝을 모르는 진행"과
    // "아무 일도 없음"이 같은 그림이 된다.
    expect(chat).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.agent-chat-command-row\.is-running \.agent-chat-command-gauge-fill \{\s*animation: none;/);

    // 덱에서 Console로 가는 행. 행선지는 위치이므로 brass가 말하고, 활성 행은 물러나지 않는다.
    const destination = block(".agent-chat-deck-meta.is-console");
    expect(destination).toContain("var(--brass-ink)");
    expect(chat).toContain(".agent-chat-deck-row.is-console:not(.is-active) .agent-chat-deck-name {");

    // 퇴역한 표면이 되살아나지 않게 못박는다 — 명령 결과는 Answer 옆이 아니라 자기 줄에 선다.
    expect(chat).not.toMatch(/^\.agent-chat-command-result \{/m);
    expect(chat).not.toMatch(/^\.agent-chat-reset-seam \{/m);
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

  it("pins the inline chat session-coordinate grammar — no badge, apex only on ultracode content", () => {
    const chat = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_CSS_PATH), "utf8");
    const view = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_VIEW_PATH), "utf8");
    const block = (selector: string): string => {
      const start = chat.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf("}", start));
    };

    // 좌표는 최근 백그라운드 작업 글리프처럼 툴 행에 직접 선다. 별도 배지 표면(테두리·바탕·
    // radius)을 다시 만들지 않고, 상태·위치·정체성 채널도 빌리지 않는다.
    const coordinate = block(".agent-chat-coord");
    expect(coordinate).toContain("border: 0;");
    expect(coordinate).toContain("background: transparent;");
    expect(coordinate).toContain("padding: 0;");
    expect(coordinate).not.toContain("border-radius:");
    const model = block(".agent-chat-coord-model");
    expect(model).toContain("min-width: 0;");
    expect(model).toContain("overflow: hidden;");
    expect(model).toContain("text-overflow: ellipsis;");
    for (const channel of ["--aurora", "--warn", "--coral", "--positive", "--brass", "--id-"]) {
      expect(coordinate, channel).not.toContain(channel);
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

    // ultracode도 바깥 배지를 되살리지 않는다. apex는 별과 강도 글자만 얻고 모델명·행 표면은
    // 중립으로 남는다.
    expect(chat).not.toContain(".agent-chat-coord.is-ultracode {");
    expect(block(".agent-chat-coord.is-ultracode .agent-chat-coord-mark")).toContain("color: var(--apex-ink);");

    // 물결은 모션이므로 감속에서 멈춘다. 그라데이션을 지우면서 채움도 되돌려야 글자가 남는다.
    const reduced = chat.slice(chat.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(
      /\.agent-chat-coord-effort\[data-effort-level="ultra"\] \{[\s\S]*?animation: none;[\s\S]*?-webkit-text-fill-color: var\(--apex-ink\);/,
    );

    // 좌표를 말하는 자리는 이제 이 각인 하나다 — 로그 첫 줄의 태생 기록이 퇴역했으므로
    // 좁은 폭에서도 각인이 물러나지 않는다(물러나면 좌표를 볼 길이 사라진다). 단독·그룹 선택자
    // 모두 막는다: 예전 정규식은 `.hint, .coord`를 놓쳐 숨김이 남아도 green이었다.
    expect(chat).not.toContain(".agent-chat-birth");
    // 판정은 @container 블록 하나 안에서 끝난다 — 블록 밖까지 이어 읽으면 앞선 다른 표면의
    // 좁은 폭 규칙(능력 덱)이 뒤따르는 좌표 규칙의 `display: none`과 엮여 거짓 경보가 난다.
    const containerBlocks = [...chat.matchAll(/@container\s*\([^)]*\)\s*\{/g)].map((match) => {
      let depth = 1;
      let at = match.index + match[0].length;
      for (; at < chat.length && depth > 0; at += 1) {
        if (chat[at] === "{") depth += 1;
        else if (chat[at] === "}") depth -= 1;
      }
      return chat.slice(match.index, at);
    });
    expect(containerBlocks.length).toBeGreaterThan(0);
    for (const container of containerBlocks) {
      expect(container).not.toMatch(/\.agent-chat-coord\s*(?:,|\{)[^}]*display:\s*none;/);
    }

    // 구성원 바닥 줄의 좌표는 사실이지 컨트롤이 아니다 — 구성원의 모델·강도는 지휘관의 축이라
    // 누를 수 있게 그리면 거짓 약속이 된다. 컴포저의 좌표는 채팅 중 모델·강도를 바꾸는 문을 겸하며
    // Objectives 모델·강도 줄과 같은 문법을 쓴다: 테두리·그림자로 틀을 두르지 않고, 누를 수 있다는 사실은
    // hover·열림의 brass 바탕(위치 채널)이 말한다.
    expect(view).toMatch(/<span\s+className=\{`agent-chat-coord\$\{/);
    expect(view).not.toMatch(/className="agent-chat-coord"[\s\S]{0,200}onClick/);
    const control = block(".agent-chat-coord.is-control");
    for (const surface of ["border:", "box-shadow:"]) {
      expect(control, surface).not.toContain(surface);
    }

    // 이름만으로는 같은 자리에 선 두 모델이 어디서 온 것인지 말하지 못한다 — 공급자 글리프가
    // 마크 자리를 잇는다. 색은 정체성 톤이 아니라 배지의 글자 티어를 따른다(좌표는 정체성
    // 채널을 빌리지 않는다).
    const menu = fs.readFileSync(fileURLToPath(TERMINAL_CHAT_COORDINATE_MENU_PATH), "utf8");
    expect(menu).toContain("launchProviderGlyph(coordinates.provider)");
    const glyph = block(".agent-chat-coord-glyph");
    expect(glyph).toContain("color: var(--text-tertiary);");
    for (const channel of ["--id-", "--provider-", "--aurora", "--coral"]) {
      expect(glyph, channel).not.toContain(channel);
    }
  });

  it("pins the persistent apex toggle and the pixel-anchored gap", () => {
    const components = source("styles/components.css");
    // 트랙 원본은 컴포저 블록 패키지(execution composer primitives)에 산다 — features/execution/client/components/effort-track.tsx는
    // 하위호환 재수출 셔임이라 계약이 읽을 소스가 아니다.
    const trackSource = externalSource(new URL("features/execution/client/composer-primitives/effort-track.tsx", CONSOLE_ROOT));

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
    // 끝 앵커는 줄머리로 잡는다 — `.effort-track-shell {`는 앞선 `.objective-launch-effort-menu
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

  it("pins the shared effort track's pointer preview motion", () => {
    const components = source("styles/components.css");
    const launchSlot = source("../../../features/workspace/client/conversation/new-session-launch-slot.tsx");
    const preview = components.match(/\.effort-track-stop\[data-previewed="true"\] \{[^}]*\}/)?.[0] ?? "";
    const knobHover = components.match(/\.effort-track:hover \.effort-track-knob \{[^}]*\}/)?.[0] ?? "";

    // 한 공유 계기가 새 세션 트랙의 hover 문법을 소유한다.
    expect(launchSlot).toContain("<LaunchModelEffort");
    expect(source("../../../features/execution/client/components/launch-model-effort.tsx")).toContain("<EffortTrack");
    expect(preview).toContain("background: var(--brass)");
    expect(preview).toContain("transform: scale(3)");
    expect(knobHover).toContain("transform: scale(1.1)");
    // 모션을 줄인 환경에서도 어떤 단을 가리키는지는 정적인 brass ring으로 남는다.
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.effort-track:hover \.effort-track-knob,[\s\S]*\.effort-track-stop\[data-previewed="true"\] \{\s*transform: none;/);
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.effort-track-stop\[data-previewed="true"\] \{\s*box-shadow: 0 0 0 2px var\(--brass\);/);
  });
});

describe("Pane width class contract", () => {
  const settingsPane = source("../../../features/settings/client/settings-pane.tsx");

  it("keeps the settings pane on the width class instead of an invented pixel", () => {
    // 픽셀을 되살리면 브레이크포인트와 다시 어긋날 수 있다 — 이 페인은 등급으로만 말한다.
    // 등급은 broad — 설정은 열자마자 행이 접히지 않은 한 줄 꼴이어야 한다.
    expect(settingsPane).toContain('widthClass: "broad",');
    expect(settingsPane).not.toMatch(/defaultWidth:\s*\d+/);
  });

  it("keeps the class ladder ordered and above the card floor", () => {
    expect(PANE_WIDTH_CLASS_PX.narrow).toBeGreaterThan(MIN_PANEL_WIDTH);
    expect(PANE_WIDTH_CLASS_PX.standard).toBeGreaterThan(PANE_WIDTH_CLASS_PX.narrow);
    expect(PANE_WIDTH_CLASS_PX.wide).toBeGreaterThan(PANE_WIDTH_CLASS_PX.standard);
    expect(PANE_WIDTH_CLASS_PX.broad).toBeGreaterThan(PANE_WIDTH_CLASS_PX.wide);
  });

  it("lets a declared pixel win over the class and falls back to the host default", () => {
    expect(resolvePaneDefaultWidth({ defaultWidth: 392, widthClass: "wide" })).toBe(392);
    expect(resolvePaneDefaultWidth({ widthClass: "narrow" })).toBe(PANE_WIDTH_CLASS_PX.narrow);
    expect(resolvePaneDefaultWidth({})).toBe(DEFAULT_PANEL_WIDTH);
    expect(resolvePaneDefaultWidth(null)).toBe(DEFAULT_PANEL_WIDTH);
  });
});
